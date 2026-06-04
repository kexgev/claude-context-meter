// src/extension.ts
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { Config, SessionInfo } from './types';
import { scanSessions } from './sessionManager';
import { StatusBarManager, calcCost, fmtCost } from './statusBar';

let outputChannel: vscode.OutputChannel;
let statusBarMgr: StatusBarManager;
let watcher: vscode.FileSystemWatcher | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

// sessionId → absolute JSONL file path (for click-to-dismiss)
const sessionFilePaths = new Map<string, string>();

const REFRESH_DEBOUNCE_MS = 150;

/**
 * Coalesce bursts of file-watcher events into a single refresh. Without this,
 * a flurry of JSONL writes spawns overlapping async refresh() calls, and the
 * sessionFilePaths.clear() inside refresh() can momentarily empty the map
 * (a click landing in that window would find no path).
 */
function scheduleRefresh(): void {
  if (refreshTimer) { clearTimeout(refreshTimer); }
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    void refresh();
  }, REFRESH_DEBOUNCE_MS);
}

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel('Claude Context Meter');

  statusBarMgr = new StatusBarManager(
    () => getConfig(),
    () => sessionFilePaths,
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeContextMeter.hideSession', (sessionId: string) => {
      statusBarMgr.hideSession(sessionId);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeContextMeter.copyStats', async () => {
      const sessions = statusBarMgr.getSessions();
      if (sessions.length === 0) {
        void vscode.window.showInformationMessage('No active Claude sessions.');
        return;
      }
      await copyStatsTable(sessions);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeContextMeter.showDetail', (sessionId: string) => {
      void showSessionDetail(sessionId);
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('claudeContextMeter')) {
        validateThresholds();
        scheduleRefresh();
      }
    }),
  );

  validateThresholds();
  setupWatcher(context);
  void refresh();
}

export function deactivate(): void {
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = undefined; }
  watcher?.dispose();
  statusBarMgr?.dispose();
}

// ── Session detail popup ────────────────────────────────────────────────────

/** Build a markdown stats table for the given sessions and copy it to the clipboard. */
async function copyStatsTable(sessions: SessionInfo[]): Promise<void> {
  const header = '| Project | Model | Tokens | Limit | % | Cost | Rate |\n|---|---|---|---|---|---|---|';
  const esc = (s: string) => s.replace(/\|/g, '\\|'); // prevent markdown table injection
  const rows = sessions.map(s => {
    const cost = calcCost(s.tokens, s.model);
    const costStr = cost > 0 ? fmtCost(cost).replace('~', '') : '—';
    const burn = statusBarMgr.calcBurnRate(s.id, s.tokenLimit, s.tokens.total);
    const rateStr = burn ? `${(burn.recent / 1000).toFixed(1)}k/min` : '—';
    return `| ${esc(s.projectName)} | ${esc(s.model || 'unknown')} | ${s.tokens.total.toLocaleString()} | ${s.tokenLimit.toLocaleString()} | ${s.pct}% | ${costStr} | ${rateStr} |`;
  });

  const table = [header, ...rows].join('\n');
  try {
    await vscode.env.clipboard.writeText(table);
    void vscode.window.showInformationMessage('Context stats copied!');
  } catch {
    void vscode.window.showErrorMessage('Failed to copy stats to clipboard.');
  }
}

interface DetailAction extends vscode.QuickPickItem {
  action: 'hide' | 'open' | 'copy';
}

/** Click handler for a status bar item: show a quick-pick with stats summary + actions. */
async function showSessionDetail(sessionId: string): Promise<void> {
  const session = statusBarMgr.getSessions().find(s => s.id === sessionId);
  if (!session) {
    void vscode.window.showInformationMessage('Session no longer active.');
    return;
  }

  const cost = calcCost(session.tokens, session.model);
  const costStr = cost > 0 ? fmtCost(cost).replace('~', '') : '—';
  const burn = statusBarMgr.calcBurnRate(session.id, session.tokenLimit, session.tokens.total);
  const burnStr = burn ? `🔥${(burn.recent / 1000).toFixed(1)}k/min` : '';
  const summary = [
    `${session.tokens.total.toLocaleString()}/${session.tokenLimit.toLocaleString()} (${session.pct}%)`,
    costStr !== '—' ? `$${costStr}` : '',
    burnStr,
  ].filter(Boolean).join('  ·  ');

  const filePath = sessionFilePaths.get(sessionId);
  const items: DetailAction[] = [
    { action: 'hide', label: '$(eye-closed) Hide', description: 'Dismiss until next session activity' },
  ];
  if (filePath) {
    items.push({ action: 'open', label: '$(go-to-file) Open transcript', description: 'Open the .jsonl conversation file' });
  }
  items.push({ action: 'copy', label: '$(copy) Copy stats', description: 'Copy this session as a markdown row' });

  const picked = await vscode.window.showQuickPick(items, {
    title: `${session.projectName} — ${summary}`,
    placeHolder: 'Choose an action',
  });
  if (!picked) { return; }

  switch (picked.action) {
    case 'hide':
      statusBarMgr.hideSession(sessionId);
      break;
    case 'open':
      if (filePath) {
        try {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
          await vscode.window.showTextDocument(doc, { preview: true });
        } catch {
          void vscode.window.showErrorMessage('Failed to open transcript file.');
        }
      }
      break;
    case 'copy':
      await copyStatsTable([session]);
      break;
  }
}

// ── Config ────────────────────────────────────────────────────────────────

function getConfig(): Config {
  const cfg = vscode.workspace.getConfiguration('claudeContextMeter');
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
  const cfg = vscode.workspace.getConfiguration('claudeContextMeter');
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

    // Rebuild file path map for click-to-dismiss using the real path from the scan
    // (reconstructing it from projectPath is lossy — the Windows drive colon and any
    //  '.'/special chars collapse to '-' during encoding and can't be reversed).
    sessionFilePaths.clear();
    for (const session of result.sessions) {
      sessionFilePaths.set(session.id, session.filePath);
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
    watcher.onDidCreate(() => scheduleRefresh());
    watcher.onDidChange(() => scheduleRefresh());
    watcher.onDidDelete(() => scheduleRefresh());
    context.subscriptions.push(watcher);
  } catch (err) {
    outputChannel.appendLine(`[warn] File watcher setup failed: ${err}`);
  }
}
