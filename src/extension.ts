// src/extension.ts
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { Config, SessionInfo } from './types';
import { scanSessions, cleanModelName } from './sessionManager';
import { StatusBarManager, calcCost, fmtCost, describePricing } from './statusBar';
import { scanAllSessionsForSpend, filterByRange, summarize, SpendRange } from './spendSummary';

let outputChannel: vscode.OutputChannel;
let statusBarMgr: StatusBarManager;
let watcher: vscode.FileSystemWatcher | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

// sessionId → absolute JSONL file path (for click-to-dismiss)
const sessionFilePaths = new Map<string, string>();

const REFRESH_DEBOUNCE_MS = 150;
const BUDGET_CHECK_INTERVAL_MS = 60_000;

let budgetCheckTimer: ReturnType<typeof setInterval> | undefined;
let lastBudgetAlertDate: string | undefined;

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
    vscode.commands.registerCommand('claudeContextMeter.showSpendSummary', () => {
      void showSpendSummary();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeContextMeter.showDiagnostics', () => {
      showDiagnostics(context);
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

  budgetCheckTimer = setInterval(() => void checkBudget(), BUDGET_CHECK_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(budgetCheckTimer) });
  void checkBudget();

  void showWhatsNewIfUpdated(context);
}

export function deactivate(): void {
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = undefined; }
  if (budgetCheckTimer) { clearInterval(budgetCheckTimer); budgetCheckTimer = undefined; }
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
    return `| ${esc(s.projectName)} | ${esc(cleanModelName(s.model) || 'unknown')} | ${s.tokens.total.toLocaleString()} | ${s.tokenLimit.toLocaleString()} | ${s.pct}% | ${costStr} | ${rateStr} |`;
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

// ── Spend summary ────────────────────────────────────────────────────────

const RANGE_LABELS: Array<{ range: SpendRange; label: string }> = [
  { range: 'today', label: 'Today' },
  { range: 'week', label: 'This Week' },
  { range: 'all', label: 'All Time' },
];

async function showSpendSummary(): Promise<void> {
  const picked = await vscode.window.showQuickPick(
    RANGE_LABELS.map(r => r.label),
    { title: 'Spend summary range', placeHolder: 'Choose a range' },
  );
  if (!picked) { return; }
  const range = RANGE_LABELS.find(r => r.label === picked)!.range;

  const config = getConfig();
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const entries = filterByRange(
    scanAllSessionsForSpend(projectsDir, config, msg => outputChannel.appendLine(msg)),
    range,
  );

  if (entries.length === 0) {
    void vscode.window.showInformationMessage(`No spend recorded for ${picked}.`);
    return;
  }

  const { total, byProject } = summarize(entries);
  const action = await vscode.window.showInformationMessage(
    `${picked}: ~$${total.toFixed(2)} across ${byProject.length} project${byProject.length === 1 ? '' : 's'} (approximate — based on each session's latest context snapshot, not a sum of every historical call)`,
    'Copy breakdown',
  );
  if (action === 'Copy breakdown') {
    const header = '| Project | Cost |\n|---|---|';
    const esc = (s: string) => s.replace(/\|/g, '\\|');
    const rows = byProject.map(p => `| ${esc(p.projectName)} | $${p.cost.toFixed(2)} |`);
    const table = [header, ...rows, `| **Total** | **$${total.toFixed(2)}** |`].join('\n');
    try {
      await vscode.env.clipboard.writeText(table);
      void vscode.window.showInformationMessage('Spend breakdown copied!');
    } catch {
      void vscode.window.showErrorMessage('Failed to copy spend breakdown to clipboard.');
    }
  }
}

async function checkBudget(): Promise<void> {
  const config = getConfig();
  if (config.dailyBudget <= 0) { return; }

  const today = new Date().toDateString();
  if (lastBudgetAlertDate === today) { return; }

  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) { return; }

  const entries = filterByRange(
    scanAllSessionsForSpend(projectsDir, config, msg => outputChannel.appendLine(msg)),
    'today',
  );
  const { total } = summarize(entries);

  if (total > config.dailyBudget) {
    lastBudgetAlertDate = today;
    void vscode.window.showWarningMessage(
      `Claude Context Meter: today's spend (~$${total.toFixed(2)}) has exceeded your daily budget of $${config.dailyBudget.toFixed(2)}.`,
    );
  }
}

// ── Diagnostics ──────────────────────────────────────────────────────────

/**
 * Dump the running version and everything that feeds a cost/context calculation
 * to the output channel. Answers "which version is actually active?" — VS Code
 * can leave a newer version extracted but unregistered, and pins .vsix installs
 * so they never auto-update, both of which are invisible without this.
 */
function showDiagnostics(context: vscode.ExtensionContext): void {
  const cfg = getConfig();
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const sessions = statusBarMgr.getSessions();

  const lines: string[] = [
    '─'.repeat(60),
    'Claude Context Meter — Diagnostics',
    '─'.repeat(60),
    `Extension version : ${context.extension.packageJSON.version}`,
    `VS Code version   : ${vscode.version}`,
    `Platform          : ${process.platform} (${process.arch}), Node ${process.versions.node}`,
    `Transcripts dir   : ${projectsDir}`,
    `  exists          : ${fs.existsSync(projectsDir)}`,
    '',
    `Active sessions   : ${sessions.length}`,
  ];

  for (const s of sessions) {
    const { tier, rates } = describePricing(s.model);
    lines.push(
      '',
      `  ${s.projectName}`,
      `    model (raw)     : ${s.model || '(none detected)'}`,
      `    model (display) : ${cleanModelName(s.model) || '(none)'}`,
      `    context limit   : ${s.tokenLimit.toLocaleString()} tokens`,
      `    usage           : ${s.tokens.total.toLocaleString()} (${s.pct}%)`,
      `    tokens          : in ${s.tokens.input.toLocaleString()} · out ${s.tokens.output.toLocaleString()} · cache-read ${s.tokens.cacheRead.toLocaleString()} · cache-write ${s.tokens.cacheWrite.toLocaleString()}`,
      `    pricing tier    : ${tier}`,
      `    rates /MTok     : in $${rates.input} · out $${rates.output} · cache-read $${rates.cacheRead} · cache-write $${rates.cacheWrite}`,
      `    cost            : $${calcCost(s.tokens, s.model).toFixed(2)}`,
      `    transcript      : ${s.filePath}`,
    );
  }

  lines.push(
    '',
    'Settings',
    `  contextLimit     : ${cfg.contextLimit}`,
    `  idleTimeout      : ${cfg.idleTimeout}s`,
    `  warningThreshold : ${cfg.warningThreshold}%`,
    `  dangerThreshold  : ${cfg.dangerThreshold}%`,
    `  dailyBudget      : ${cfg.dailyBudget === 0 ? 'disabled' : '$' + cfg.dailyBudget}`,
    `  compactMode      : ${cfg.compactMode}`,
    `  showEmoji        : ${cfg.showEmoji}`,
    `  autoColor        : ${cfg.autoColor}`,
    '─'.repeat(60),
  );

  outputChannel.appendLine(lines.join('\n'));
  outputChannel.show(true);
}

/**
 * Show a one-time notification after the extension updates to a new version, so
 * existing users find out about new features instead of never noticing them.
 * Silent on first ever install — a brand-new user does not need a changelog.
 */
async function showWhatsNewIfUpdated(context: vscode.ExtensionContext): Promise<void> {
  const current = String(context.extension.packageJSON.version);
  const previous = context.globalState.get<string>('lastVersion');

  await context.globalState.update('lastVersion', current);
  if (!previous || previous === current) { return; }

  const action = await vscode.window.showInformationMessage(
    `Claude Context Meter updated to ${current} — corrected pricing for current Claude models, plus spend summaries and daily budget alerts.`,
    'See what changed',
  );
  if (action === 'See what changed') {
    void vscode.env.openExternal(
      vscode.Uri.parse('https://github.com/kexgev/claude-context-meter/blob/master/CHANGELOG.md'),
    );
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
    dailyBudget: cfg.get<number>('dailyBudget', 0),
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
