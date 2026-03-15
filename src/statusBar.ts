// src/statusBar.ts
import * as vscode from 'vscode';
import * as fs from 'fs';
import { SessionInfo, Config, TokenBreakdown } from './types';
import { abbreviateName } from './sessionManager';

/** 5-char Unicode progress bar. Each block = 20%. Used in status bar item text. */
function buildBar5(pct: number): string {
  const filled = Math.min(5, Math.ceil(pct / 20));
  return '█'.repeat(filled) + '░'.repeat(5 - filled);
}

/** 20-char Unicode progress bar. Each block = 5%. Used in tooltip. */
function buildBar20(pct: number): string {
  const filled = Math.min(20, Math.round(pct / 5));
  return '█'.repeat(filled) + '░'.repeat(20 - filled);
}

/** Abbreviate token counts for status bar text only (not tooltip). */
function fmtK(n: number): string {
  if (n >= 999_500) { return Math.round(n / 100_000) / 10 + 'M'; }
  if (n >= 1_000) { return Math.round(n / 1_000) + 'k'; }
  return String(n);
}

/** Status indicator emoji+label for tooltip. Always shown regardless of cfg.showEmoji. */
function statusEmoji(pct: number, warn: number, danger: number): string {
  if (pct >= danger) { return '🔴 crit'; }
  if (pct >= warn)   { return '🟡 warn'; }
  return '🟢 safe';
}

interface PricingRow { input: number; output: number; cacheRead: number; cacheWrite: number; }

const PRICING: Array<{ pattern: string; rates: PricingRow }> = [
  { pattern: 'claude-opus-4',    rates: { input: 15.00, output: 75.00, cacheRead: 1.50,  cacheWrite: 18.75 } },
  { pattern: 'claude-sonnet-4',  rates: { input:  3.00, output: 15.00, cacheRead: 0.30,  cacheWrite:  3.75 } },
  { pattern: 'claude-haiku-4',   rates: { input:  0.80, output:  4.00, cacheRead: 0.08,  cacheWrite:  1.00 } },
  { pattern: 'opus',             rates: { input: 15.00, output: 75.00, cacheRead: 1.50,  cacheWrite: 18.75 } },
  { pattern: 'sonnet',           rates: { input:  3.00, output: 15.00, cacheRead: 0.30,  cacheWrite:  3.75 } },
  { pattern: 'haiku',            rates: { input:  0.80, output:  4.00, cacheRead: 0.08,  cacheWrite:  1.00 } },
];
const PRICING_FALLBACK: PricingRow = { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 };

/** Calculate USD cost for a token breakdown given a model string. Returns 0 if no tokens. */
export function calcCost(tokens: TokenBreakdown, model: string): number {
  const lower = model.toLowerCase();
  const rates = PRICING.find(p => lower.includes(p.pattern))?.rates ?? PRICING_FALLBACK;
  return (
    tokens.input      * rates.input      +
    tokens.output     * rates.output     +
    tokens.cacheRead  * rates.cacheRead  +
    tokens.cacheWrite * rates.cacheWrite
  ) / 1_000_000;
}

/** Format a USD cost value for display. Returns empty string if cost === 0. */
export function fmtCost(cost: number): string {
  if (cost === 0)  { return ''; }
  if (cost < 0.01) { return '~$0.00'; }
  return `~$${cost.toFixed(2)}`;
}

/** Pure burn rate calculation from a readings buffer. Exported for testing and copy command. */
export function calcBurnRateFromBuffer(
  buf: Array<{ tokens: number; time: number }>,
  tokenLimit: number,
  currentTokens: number,
): { recent: number; avg: number; timeToFull: number } | null {
  if (buf.length < 2) { return null; }
  const oldest = buf[0];
  const newest = buf[buf.length - 1];
  const elapsed = newest.time - oldest.time;
  if (elapsed < 5_000) { return null; }
  const delta = newest.tokens - oldest.tokens;
  if (delta <= 0) { return null; }
  const rate = delta / elapsed * 60_000;
  const timeToFull = rate > 0 ? (tokenLimit - currentTokens) / rate : 0;
  return { recent: rate, avg: rate, timeToFull };
}

export class StatusBarManager {
  private readonly items = new Map<string, vscode.StatusBarItem>();
  // Maps sessionId → file mtime at dismiss time. Entries are retained even after idle sessions
  // disappear from sessions[]; this is intentional — if a session reactivates with the same ID,
  // we compare against the original dismiss-time mtime. (Stale entries are small: ~100 bytes each.)
  private readonly hiddenSessions = new Map<string, number>();
  private readonly readings = new Map<string, Array<{ tokens: number; time: number }>>();
  private readonly notified = new Map<string, Set<'warn' | 'crit'>>();
  private lastSessions: SessionInfo[] = [];

  constructor(
    private readonly getConfig: () => Config,
    private readonly getFilePaths: () => Map<string, string>,
  ) {}

  update(sessions: SessionInfo[]): void {
    const cfg = this.getConfig();
    this.lastSessions = sessions;

    // Append to ring buffer for each session
    const now = Date.now();
    for (const session of sessions) {
      const buf = this.readings.get(session.id) ?? [];
      buf.push({ tokens: session.tokens.total, time: now });
      if (buf.length > 5) { buf.shift(); } // FIFO cap at 5
      this.readings.set(session.id, buf);
    }

    // Threshold notifications — clear-then-fire ordering per spec
    for (const session of sessions) {
      const isHidden = this.hiddenSessions.has(session.id);
      if (isHidden) { continue; }

      // Step 1: clear state if pct dropped below warning (e.g. after /compact)
      if (session.pct < cfg.warningThreshold) {
        this.notified.delete(session.id);
        continue;
      }

      // Step 2: fire notifications
      const fired = this.notified.get(session.id) ?? new Set<'warn' | 'crit'>();
      const msg = (pct: number) =>
        `Claude Context Meter: ${session.projectName} is at ${pct}% context (${session.tokens.total.toLocaleString()}/${session.tokenLimit.toLocaleString()} tokens)`;

      if (session.pct >= cfg.dangerThreshold && !fired.has('crit')) {
        void vscode.window.showErrorMessage(msg(session.pct));
        fired.add('crit');
        this.notified.set(session.id, fired);
      } else if (session.pct >= cfg.warningThreshold && !fired.has('warn')) {
        void vscode.window.showWarningMessage(msg(session.pct));
        fired.add('warn');
        this.notified.set(session.id, fired);
      }
    }

    const activeIds = new Set(sessions.map(s => s.id));

    // Dispose items for sessions no longer present
    for (const [id, item] of this.items) {
      if (!activeIds.has(id)) {
        item.dispose();
        // Safe: deleting the current Map key during for...of does not skip other entries (ECMA-262 guarantee).
        this.items.delete(id);
      }
    }

    for (const session of sessions) {
      // Click-to-dismiss: check whether file has new activity since hide
      const hiddenMtime = this.hiddenSessions.get(session.id);
      if (hiddenMtime !== undefined) {
        const filePath = this.getFilePaths().get(session.id);
        if (filePath) {
          try {
            const currentMtime = fs.statSync(filePath).mtime.getTime();
            if (currentMtime > hiddenMtime) {
              this.hiddenSessions.delete(session.id); // new activity — un-hide
            } else {
              continue; // still hidden
            }
          } catch {
            continue;
          }
        } else {
          continue;
        }
      }

      // Create or reuse item
      let item = this.items.get(session.id);
      if (!item) {
        item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        item.command = {
          command: 'claudeContextMeter.hideSession',
          arguments: [session.id],
          title: 'Hide session',
        };
        this.items.set(session.id, item);
      }

      const displayName = abbreviateName(session.projectName, cfg);
      const bar5 = buildBar5(session.pct);
      const { tokens } = session;
      const prefix = cfg.showEmoji ? `${session.emoji} ` : '';
      const cost = calcCost(tokens, session.model);
      const costStr = fmtCost(cost);
      const burn = this.calcBurnRate(session.id, session.tokenLimit, tokens.total);
      const burnStr = burn ? `🔥${(burn.recent / 1000).toFixed(1)}k/m` : '';
      const extras = [costStr, burnStr].filter(Boolean).join(' ');

      item.text = `${prefix}${displayName} ${bar5} ${fmtK(tokens.total)}/${fmtK(session.tokenLimit)} (${session.pct}%)${extras ? ' ' + extras : ''}`;

      item.tooltip = this.buildTooltip(session, cfg);

      if (session.pct >= cfg.dangerThreshold) {
        item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      } else if (session.pct >= cfg.warningThreshold) {
        item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      } else {
        item.backgroundColor = undefined;
      }

      item.color = session.color || undefined;
      item.show();
    }
  }

  hideSession(sessionId: string): void {
    const filePath = this.getFilePaths().get(sessionId);
    let mtimeAtHide: number;
    try {
      mtimeAtHide = filePath ? fs.statSync(filePath).mtime.getTime() : Date.now();
    } catch {
      mtimeAtHide = Date.now();
    }
    this.hiddenSessions.set(sessionId, mtimeAtHide);

    const item = this.items.get(sessionId);
    if (item) {
      item.dispose();
      this.items.delete(sessionId);
    }
  }

  calcBurnRate(sessionId: string, tokenLimit: number, currentTokens: number): { recent: number; avg: number; timeToFull: number } | null {
    const buf = this.readings.get(sessionId) ?? [];
    return calcBurnRateFromBuffer(buf, tokenLimit, currentTokens);
  }

  getSessions(): SessionInfo[] {
    return this.lastSessions;
  }

  dispose(): void {
    for (const item of this.items.values()) { item.dispose(); }
    this.items.clear();
    this.readings.clear();
    this.notified.clear();
    this.lastSessions = [];
  }

  private buildTooltip(session: SessionInfo, cfg: Config): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.supportHtml = false;
    const { tokens } = session;
    const bar20 = buildBar20(session.pct);
    const status = statusEmoji(session.pct, cfg.warningThreshold, cfg.dangerThreshold);

    md.appendMarkdown(`**${session.projectName}**\n\n`);
    md.appendMarkdown(`\`${session.model || 'unknown'}\`  ·  ${status} · ${session.pct}%\n\n`);
    md.appendMarkdown(`${bar20}  ${session.pct}%\n`);
    md.appendMarkdown(`${tokens.total.toLocaleString()} / ${session.tokenLimit.toLocaleString()} tokens\n\n`);
    md.appendMarkdown(`---\n\n`);
    md.appendMarkdown(`in: ${tokens.input.toLocaleString()}  ·  out: ${tokens.output.toLocaleString()}  ·  cr: ${tokens.cacheRead.toLocaleString()}  ·  cw: ${tokens.cacheWrite.toLocaleString()}\n\n`);

    const burn = this.calcBurnRate(session.id, session.tokenLimit, tokens.total);
    if (burn) {
      md.appendMarkdown(`🔥 recent: ~${(burn.recent / 1000).toFixed(1)}k/min  ·  avg: ~${(burn.avg / 1000).toFixed(1)}k/min\n`);
      if (burn.timeToFull > 0) {
        md.appendMarkdown(`⏳ ~${Math.round(burn.timeToFull)} min to full\n`);
      }
      md.appendMarkdown(`\n`);
    }

    const cost = calcCost(tokens, session.model);
    if (cost > 0) {
      const rates = PRICING.find(p => session.model.toLowerCase().includes(p.pattern))?.rates ?? PRICING_FALLBACK;
      const inputCost = (tokens.input * rates.input) / 1_000_000;
      const outputCost = (tokens.output * rates.output) / 1_000_000;
      md.appendMarkdown(`💰 cost: $${cost.toFixed(2)}  (in: $${inputCost.toFixed(2)} · out: $${outputCost.toFixed(2)})\n\n`);
    }

    md.appendMarkdown(`*Updated ${session.lastUpdate.toLocaleTimeString()}*`);
    return md;
  }
}
