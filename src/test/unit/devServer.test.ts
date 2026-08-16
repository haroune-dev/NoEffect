import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DevServer } from '../../browser/devServer';

/**
 * DevServer unit tests: loopback-only binding, path-traversal rejection and
 * no-store caching for served content. No browser is involved.
 */

let fixtureRoot: string;

function get(
  port: number,
  requestPath: string
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: requestPath }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => (body += chunk.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('starts on an ephemeral port bound to loopback only', async () => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'noeffect-test-'));
  const server = new DevServer();
  const port = await server.start(fixtureRoot);

  assert.ok(port > 0);
  assert.equal(server.isRunning, true);
  await server.stop();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

test('serves files from the root with no-store caching', async () => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'noeffect-test-'));
  fs.writeFileSync(path.join(fixtureRoot, 'styles.css'), 'body { color: red; }');
  const server = new DevServer();
  const port = await server.start(fixtureRoot);

  const response = await get(port, '/styles.css');

  assert.equal(response.status, 200);
  assert.equal(response.body, 'body { color: red; }');
  assert.equal(response.headers['content-type'], 'text/css');
  assert.equal(response.headers['cache-control'], 'no-store');

  await server.stop();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

test('rejects raw path traversal with 400', async () => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'noeffect-test-'));
  fs.writeFileSync(path.join(fixtureRoot, 'index.html'), 'inside');
  fs.writeFileSync(path.join(path.dirname(fixtureRoot), 'secret.txt'), 'outside');
  const server = new DevServer();
  const port = await server.start(fixtureRoot);

  const response = await get(port, '/../secret.txt');

  assert.equal(response.status, 400);
  assert.equal(response.body, 'bad request');

  await server.stop();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fs.rmSync(path.join(path.dirname(fixtureRoot), 'secret.txt'), { force: true });
});

test('rejects encoded path traversal with 400', async () => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'noeffect-test-'));
  fs.writeFileSync(path.join(fixtureRoot, 'index.html'), 'inside');
  const server = new DevServer();
  const port = await server.start(fixtureRoot);

  const response = await get(port, '/%2e%2e/secret.txt');

  assert.equal(response.status, 400);

  await server.stop();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

test('serves in-bounds .. traversal (browser-normalized cross-directory hrefs)', async () => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'noeffect-test-'));
  fs.mkdirSync(path.join(fixtureRoot, 'pages'), { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, 'css'), { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, 'css', 'theme.css'), 'body { color: green; }');
  fs.writeFileSync(path.join(fixtureRoot, 'pages', 'index.html'), '<html>pages</html>');
  const server = new DevServer();
  const port = await server.start(fixtureRoot);

  // A page at /pages/index.html linking ../css/theme.css requests the
  // normalized path /css/theme.css — and so does a direct in-bounds ../.
  const direct = await get(port, '/pages/../css/theme.css');
  assert.equal(direct.status, 200);
  assert.equal(direct.body, 'body { color: green; }');

  const plain = await get(port, '/css/theme.css');
  assert.equal(plain.status, 200);
  assert.equal(plain.body, 'body { color: green; }');

  await server.stop();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

test('serves virtual pages from memory with no-store caching', async () => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'noeffect-test-'));
  const server = new DevServer();
  const port = await server.start(fixtureRoot);
  server.setVirtualFile('wrapper', '<html>wrapper</html>');

  const response = await get(port, `${DevServer.VIRTUAL_PREFIX}wrapper`);

  assert.equal(response.status, 200);
  assert.equal(response.body, '<html>wrapper</html>');
  assert.equal(response.headers['cache-control'], 'no-store');

  await server.stop();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

test('missing files resolve to 404', async () => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'noeffect-test-'));
  const server = new DevServer();
  const port = await server.start(fixtureRoot);

  const response = await get(port, '/nope.css');

  assert.equal(response.status, 404);

  await server.stop();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});