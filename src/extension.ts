// src/extension.ts
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { Config } from './types';
import { scanSessions } from './sessionManager';
import { StatusBarManager } from './statusBar';

let outputChannel: vscode.OutputChannel;
let statusBarMgr: StatusBarManager;
let watcher: vscode.FileSystemWatcher | undefined;

// sessionId → absolute JSONL file path (for click-to-dismiss)
const sessionFilePaths = new Map<string, string>();

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel('Claude Context Bar');

  statusBarMgr = new StatusBarManager(
    () => getConfig(),
    () => sessionFilePaths,
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeContextBar.hideSession', (sessionId: string) => {
      statusBarMgr.hideSession(sessionId);
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('claudeContextBar')) {
        validateThresholds();
        void refresh();
      }
    }),
  );

  validateThresholds();
  setupWatcher(context);
  void refresh();
}

export function deactivate(): void {
  watcher?.dispose();
  statusBarMgr?.dispose();
}

// ── Config ────────────────────────────────────────────────────────────────

function getConfig(): Config {
  const cfg = vscode.workspace.getConfiguration('claudeContextBar');
  return {
    contextLimit: cfg.get<number>('contextLimit', 200000),
    idleTimeout: cfg.get<number>('idleTimeout', 180),
    warningThreshold: cfg.get<number>('warningThreshold', 50),
    dangerThreshold: cfg.get<number>('dangerThreshold', 75),
    compactMode: cfg.get<boolean>('compactMode', false),
    showEmoji: cfg.get<boolean>('showEmoji', true),
    autoColor: cfg.get<boolean>('autoColor', true),
    shortNames: cfg.get<Record<string, string>>('shortNames', {}),
  };
}

function validateThresholds(): void {
  const cfg = vscode.workspace.getConfiguration('claudeContextBar');
  const w = cfg.get<number>('warningThreshold', 50);
  const d = cfg.get<number>('dangerThreshold', 75);
  if (w >= d) {
    outputChannel.appendLine(`[warn] warningThreshold (${w}) must be < dangerThreshold (${d}). Resetting to 50/75.`);
    void cfg.update('warningThreshold', 50, vscode.ConfigurationTarget.Global);
    void cfg.update('dangerThreshold', 75, vscode.ConfigurationTarget.Global);
  }
}

// ── Refresh ───────────────────────────────────────────────────────────────

async function refresh(): Promise<void> {
  const config = getConfig();
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');

  if (!fs.existsSync(projectsDir)) {
    outputChannel.appendLine('[info] ~/.claude/projects not found.');
    statusBarMgr.update([]);
    sessionFilePaths.clear();
    return;
  }

  try {
    const result = await scanSessions(projectsDir, config, msg => outputChannel.appendLine(msg));

    // Rebuild file path map for click-to-dismiss
    sessionFilePaths.clear();
    for (const session of result.sessions) {
      // Re-encode projectPath back to directory name to locate the file
      const encoded = session.projectPath
        .replace(/^([A-Z]{1,2}):\\/, '$1-') // Windows drive
        .replace(/\\/g, '-')
        .replace(/^\//, '-')                // Unix leading slash
        .replace(/\//g, '-');
      const filePath = path.join(projectsDir, encoded, session.id + '.jsonl');
      if (fs.existsSync(filePath)) {
        sessionFilePaths.set(session.id, filePath);
      }
    }

    statusBarMgr.update(result.sessions);
  } catch (err) {
    outputChannel.appendLine(`[error] Refresh failed: ${err}`);
  }
}

// ── File watcher ──────────────────────────────────────────────────────────

function setupWatcher(context: vscode.ExtensionContext): void {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  try {
    const pattern = new vscode.RelativePattern(vscode.Uri.file(projectsDir), '**/*.jsonl');
    watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidCreate(() => void refresh());
    watcher.onDidChange(() => void refresh());
    watcher.onDidDelete(() => void refresh());
    context.subscriptions.push(watcher);
  } catch (err) {
    outputChannel.appendLine(`[warn] File watcher setup failed: ${err}`);
  }
}
