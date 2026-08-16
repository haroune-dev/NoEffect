import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import {
  EnvironmentReadiness,
  FileReadinessInput,
  ReadinessEnvironment,
  ReadinessSettings,
} from '../../environment/readiness';
import { BrowserDetector } from '../../environment/browserDetection';
import { FAILURE_CODES } from '../../failure/model';

/**
 * Environment-readiness unit tests: the deterministic precedence
 * disabled → unsupported workspace → untrusted workspace → browser,
 * plus the file dimension (unsaved → eligibility).
 */

function defaultSettings(): ReadinessSettings {
  return {
    enabled: true,
    chromiumPath: '',
    analyzeOnType: false,
    ignoredFiles: [],
    maxFileSizeKb: 512,
  };
}

function defaultWorkspace(): { isTrusted: boolean; folders: { scheme: string }[] } {
  return { isTrusted: true, folders: [{ scheme: 'file' }] };
}

function stubSpawn(behaviour: 'ok' | 'fail') {
  const spawnFn = (_cmd: string, _args: string[], _opts: unknown): unknown => {
    const child = new EventEmitter() as EventEmitter & { kill(): void };
    child.kill = () => {};
    if (behaviour === 'ok') {
      process.nextTick(() => child.emit('exit', 0));
    } else {
      process.nextTick(() => child.emit('error', new Error('spawn failed')));
    }
    return child;
  };
  return spawnFn as unknown as typeof spawn;
}

function makeEnv(overrides: {
  settings?: Partial<ReadinessSettings>;
  workspace?: ReturnType<typeof defaultWorkspace>;
  detector?: unknown;
} = {}): ReadinessEnvironment {
  return {
    getSettings: () => ({ ...defaultSettings(), ...overrides.settings }),
    getWorkspace: () => overrides.workspace ?? defaultWorkspace(),
    detector: (overrides.detector ?? new BrowserDetector({ platform: 'aix' })) as BrowserDetector,
  };
}

test('disabled resolves to disabled with the EXTENSION_DISABLED failure', async () => {
  const readiness = new EnvironmentReadiness(makeEnv({ settings: { enabled: false } }));

  const state = await readiness.evaluate();

  assert.equal(state.ready, false);
  assert.equal(state.reason, 'disabled');
  assert.equal(state.failure?.code, FAILURE_CODES.EXTENSION_DISABLED);
});

test('an unsupported workspace scheme blocks with WORKSPACE_UNSUPPORTED', async () => {
  const readiness = new EnvironmentReadiness(
    makeEnv({ workspace: { isTrusted: true, folders: [{ scheme: 'vscode-vfs' }] } })
  );

  const state = await readiness.evaluate();

  assert.equal(state.ready, false);
  assert.equal(state.reason, 'unsupported_workspace');
  assert.equal(state.failure?.code, FAILURE_CODES.WORKSPACE_UNSUPPORTED);
});

test('precedence: disabled wins over an unsupported workspace', async () => {
  const readiness = new EnvironmentReadiness(
    makeEnv({ settings: { enabled: false }, workspace: { isTrusted: true, folders: [{ scheme: 'vscode-vfs' }] } })
  );

  const state = await readiness.evaluate();

  assert.equal(state.reason, 'disabled');
});

test('an untrusted workspace blocks with WORKSPACE_UNTRUSTED', async () => {
  const readiness = new EnvironmentReadiness(makeEnv({ workspace: { isTrusted: false, folders: [{ scheme: 'file' }] } }));

  const state = await readiness.evaluate();

  assert.equal(state.ready, false);
  assert.equal(state.reason, 'untrusted_workspace');
  assert.equal(state.failure?.code, FAILURE_CODES.WORKSPACE_UNTRUSTED);
});

test('an untrusted workspace never reaches browser detection', async () => {
  const detector = {
    detect: async () => {
      throw new Error('detect must not run in an untrusted workspace');
    },
  };
  const readiness = new EnvironmentReadiness(
    makeEnv({
      workspace: { isTrusted: false, folders: [{ scheme: 'file' }] },
      settings: { chromiumPath: '/some/path/chrome' },
      detector,
    })
  );

  const state = await readiness.evaluate();

  assert.equal(state.ready, false);
  assert.equal(state.reason, 'untrusted_workspace');
});

test('a missing browser resolves to browser_not_found', async () => {
  const readiness = new EnvironmentReadiness(makeEnv());

  const state = await readiness.evaluate();

  assert.equal(state.ready, false);
  assert.equal(state.reason, 'browser_not_found');
  assert.equal(state.failure?.code, FAILURE_CODES.CHROMIUM_NOT_FOUND);
});

test('an invalid override path resolves to browser_path_invalid', async () => {
  const detector = new BrowserDetector({ platform: 'aix', existsSync: () => false });
  const readiness = new EnvironmentReadiness(
    makeEnv({ settings: { chromiumPath: '/nope/chrome' }, detector })
  );

  const state = await readiness.evaluate();

  assert.equal(state.reason, 'browser_path_invalid');
  assert.equal(state.failure?.code, FAILURE_CODES.CHROMIUM_PATH_INVALID);
});

test('a probe failure resolves to browser_launch_failed', async () => {
  const detector = new BrowserDetector({ platform: 'linux', spawnFn: stubSpawn('fail') });
  const readiness = new EnvironmentReadiness(makeEnv({ detector }));

  const state = await readiness.evaluate();

  assert.equal(state.reason, 'browser_launch_failed');
  assert.equal(state.failure?.code, FAILURE_CODES.BROWSER_LAUNCH_FAILED);
});

test('a healthy environment resolves to ready', async () => {
  const detector = new BrowserDetector({ platform: 'aix', existsSync: () => true, spawnFn: stubSpawn('ok') });
  const readiness = new EnvironmentReadiness(
    makeEnv({ settings: { chromiumPath: '/usr/bin/chromium' }, detector })
  );

  const state = await readiness.evaluate();

  assert.equal(state.ready, true);
  assert.equal(state.reason, 'ready');
  assert.equal(state.context?.executablePath, '/usr/bin/chromium');
});

test('analyzeOnType surfaces LIVE_ANALYSIS_UNAVAILABLE as a warning on a ready state', async () => {
  const detector = new BrowserDetector({ platform: 'aix', existsSync: () => true, spawnFn: stubSpawn('ok') });
  const readiness = new EnvironmentReadiness(
    makeEnv({ settings: { chromiumPath: '/usr/bin/chromium', analyzeOnType: true }, detector })
  );

  const state = await readiness.evaluate();

  assert.equal(state.ready, true);
  assert.equal(state.warnings[0].code, FAILURE_CODES.LIVE_ANALYSIS_UNAVAILABLE);
});

function fileSet(overrides: Partial<FileReadinessInput> = {}): FileReadinessInput {
  return {
    filePath: '/project/styles.css',
    extension: '.css',
    scheme: 'file',
    sizeBytes: 1024,
    isDirty: false,
    ...overrides,
  };
}

test('fileReadiness: a dirty file requires a save', () => {
  const readiness = new EnvironmentReadiness(makeEnv());

  const state = readiness.fileReadiness(fileSet({ isDirty: true }), defaultSettings());

  assert.equal(state.ready, false);
  assert.equal(state.reason, 'file_requires_save');
  assert.equal(state.failure?.code, FAILURE_CODES.FILE_UNSAVED);
});

test('fileReadiness: an oversized file maps to file_too_large', () => {
  const readiness = new EnvironmentReadiness(makeEnv());

  const state = readiness.fileReadiness(fileSet({ sizeBytes: 512 * 1024 + 1 }), defaultSettings());

  assert.equal(state.reason, 'file_too_large');
  assert.equal(state.failure?.code, FAILURE_CODES.FILE_TOO_LARGE);
});

test('fileReadiness: an ignored file maps to file_ignored with the matched pattern', () => {
  const readiness = new EnvironmentReadiness(makeEnv());

  const state = readiness.fileReadiness(
    fileSet({ filePath: '/project/temp/a.css' }),
    { ...defaultSettings(), ignoredFiles: ['**/temp/**'] }
  );

  assert.equal(state.reason, 'file_ignored');
  assert.equal(state.failure?.code, FAILURE_CODES.FILE_IGNORED);
  assert.equal(state.context?.matchedPattern, '**/temp/**');
});

test('fileReadiness: an eligible file is ready', () => {
  const readiness = new EnvironmentReadiness(makeEnv());

  const state = readiness.fileReadiness(fileSet(), defaultSettings());

  assert.equal(state.ready, true);
  assert.equal(state.reason, 'ready');
});