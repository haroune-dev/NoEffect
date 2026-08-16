import * as vscode from 'vscode';

/**
 * Typed representation of the extension's user-configurable settings.
 */
export interface NoEffectSettings {
  enabled: boolean;
  analyzeOnSave: boolean;
  analyzeOnType: boolean;
  debounceMs: number;
  highlightStyle: 'both' | 'iconOnly' | 'dimOnly';
  chromiumPath: string;
  ignoredFiles: string[];
  maxFileSizeKb: number;
  companionSearchDepth: number;
  companionMaxCandidates: number;
  maxCompanions: number;
}

/**
 * Read the current extension settings from the VS Code configuration.
 * Always returns a fully resolved object with defaults applied.
 */
export function getSettings(): NoEffectSettings {
  const config = vscode.workspace.getConfiguration('noEffect');
  const configuredHighlightStyle = config.get<string>('highlightStyle', 'both');

  return {
    enabled: config.get<boolean>('enabled', true),
    analyzeOnSave: config.get<boolean>('analyzeOnSave', true),
    analyzeOnType: config.get<boolean>('analyzeOnType', false),
    debounceMs: config.get<number>('debounceMs', 1500),
    highlightStyle: normaliseHighlightStyle(configuredHighlightStyle),
    chromiumPath: config.get<string>('chromiumPath', ''),
    ignoredFiles: config.get<string[]>('ignoredFiles', []),
    maxFileSizeKb: config.get<number>('maxFileSizeKb', 512),
    companionSearchDepth: config.get<number>('companionSearchDepth', 6),
    companionMaxCandidates: config.get<number>('companionMaxCandidates', 500),
    maxCompanions: config.get<number>('maxCompanions', 3),
  };
}

/**
 * `gutterOnly` was the old setting value. Keep it working for existing user
 * settings while rendering the warning as an inline icon.
 */
function normaliseHighlightStyle(value: string): NoEffectSettings['highlightStyle'] {
  switch (value) {
    case 'iconOnly':
    case 'gutterOnly':
      return 'iconOnly';
    case 'dimOnly':
      return 'dimOnly';
    default:
      return 'both';
  }
}

/**
 * Register a listener that is called whenever NoEffect settings change.
 * Returns a Disposable that can be used to unregister the listener.
 */
export function onSettingsChanged(
  callback: (settings: NoEffectSettings) => void
): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('noEffect')) {
      callback(getSettings());
    }
  });
}
