// src/statusBar.ts
import * as vscode from 'vscode';
import * as fs from 'fs';
import { SessionInfo, Config, TokenBreakdown } from './types';
import { abbreviateName, cleanModelName } from './sessionManager';
import { UsageLimit, UsageSnapshot, peakOf, formatAge } from './subscriptionUsage';

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

/** Escape markdown special characters to prevent injection in tooltips. */
function escapeMd(s: string): string {
  return s.replace(/[\\`*_[\]()#+\-.!|]/g, '\\$&');
}

/**
 * Sanitize text destined for an inline code span. Markdown does NOT process
 * backslash escapes inside code spans, so escapeMd would render literal
 * backslashes (e.g. `claude\-opus`). Strip backticks instead to keep the span intact.
 */
function escapeCode(s: string): string {
  return s.replace(/`/g, '');
}

/** Status indicator emoji+label for tooltip. Always shown regardless of cfg.showEmoji. */
function statusEmoji(pct: number, warn: number, danger: number): string {
  if (pct >= danger) { return '🔴 crit'; }
  if (pct >= warn)   { return '🟡 warn'; }
  return '🟢 safe';
}

export interface PricingRow { input: number; output: number; cacheRead: number; cacheWrite: number; }

/**
 * cacheRead = 10% of input, cacheWrite = 125% of input (5-minute TTL).
 * The 1-hour TTL write rate is always 2x input and is derived in calcCost.
 */
function rates(input: number, output: number): PricingRow {
  // Rounded so diagnostics print $0.3, not $0.30000000000000004.
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  return { input, output, cacheRead: round(input * 0.1), cacheWrite: round(input * 1.25) };
}

const FABLE_5_2: PricingRow = { input: 8.00, output: 40.00, cacheRead: 0.20, cacheWrite: 10.00 };
const OPUS_5_5: PricingRow = { input: 4.00, output: 20.00, cacheRead: 0.20, cacheWrite: 5.00 };
const SONNET_5_5: PricingRow = { input: 2.00, output: 10.00, cacheRead: 0.10, cacheWrite: 2.50 };
const HAIKU_5_5: PricingRow = rates(0.10, 0.50);
/** Haiku 5.5 bills every token of a request at this tier once the prompt exceeds 100K tokens. */
const HAIKU_5_5_LONG: PricingRow = rates(0.50, 2.50);
const HAIKU_5_5_LONG_THRESHOLD = 100_000;

/**
 * Matched against the normalised model ID (see normaliseModelId); a pattern
 * must not be followed by another digit, so "claude-fable-5-2" never matches a
 * dated "claude-fable-5-20260301" and "claude-opus-4-1" never matches
 * "claude-opus-4-10". First match wins, so more specific IDs must precede the
 * IDs they extend ("claude-fable-5-2" before "claude-fable-5").
 */
const PRICING: Array<{ pattern: string; rates: PricingRow }> = [
  // Fable / Mythos (same model, two names)
  { pattern: 'claude-fable-5-2',  rates: FABLE_5_2 },
  { pattern: 'claude-mythos-5-2', rates: FABLE_5_2 },
  { pattern: 'claude-fable-5-1',  rates: { input: 10.00, output: 50.00, cacheRead: 0.25, cacheWrite: 12.50 } },
  { pattern: 'claude-mythos-5-1', rates: { input: 10.00, output: 50.00, cacheRead: 0.25, cacheWrite: 12.50 } },
  { pattern: 'claude-fable-5',    rates: rates(10.00, 50.00) },
  { pattern: 'claude-mythos-5',   rates: rates(10.00, 50.00) },
  // Opus
  { pattern: 'claude-opus-5-5',   rates: OPUS_5_5 },
  { pattern: 'claude-opus-5',     rates: rates(5.00, 25.00) },
  { pattern: 'claude-opus-4-8',   rates: rates(5.00, 25.00) },
  { pattern: 'claude-opus-4-7',   rates: rates(5.00, 25.00) },
  { pattern: 'claude-opus-4-6',   rates: rates(5.00, 25.00) },
  { pattern: 'claude-opus-4-5',   rates: rates(5.00, 25.00) },
  // Legacy Opus (4.0/4.1, 3) — pre-price-cut $15/$75
  { pattern: 'claude-opus-4-1',   rates: rates(15.00, 75.00) },
  { pattern: 'claude-opus-4',     rates: rates(15.00, 75.00) },
  { pattern: 'claude-3-opus',     rates: rates(15.00, 75.00) },
  // Sonnet — 5.x cut to $2/$10; 5.5 also halved cache reads
  { pattern: 'claude-sonnet-5-5', rates: SONNET_5_5 },
  { pattern: 'claude-sonnet-5',   rates: rates(2.00, 10.00) },
  { pattern: 'claude-sonnet-4',   rates: rates(3.00, 15.00) },
  { pattern: 'claude-3-7-sonnet', rates: rates(3.00, 15.00) },
  { pattern: 'claude-3-5-sonnet', rates: rates(3.00, 15.00) },
  { pattern: 'claude-3-sonnet',   rates: rates(3.00, 15.00) },
  // Haiku
  { pattern: 'claude-haiku-5-5',  rates: HAIKU_5_5 },
  { pattern: 'claude-haiku-4-5',  rates: rates(1.00, 5.00) },
  { pattern: 'claude-3-5-haiku',  rates: rates(0.80, 4.00) },
  { pattern: 'claude-3-haiku',    rates: rates(0.25, 1.25) },
  // Generic family fallbacks for future models not yet listed above:
  // priced as the current generation of each family.
  { pattern: 'fable',             rates: FABLE_5_2 },
  { pattern: 'mythos',            rates: FABLE_5_2 },
  { pattern: 'opus',              rates: OPUS_5_5 },
  { pattern: 'sonnet',            rates: SONNET_5_5 },
  { pattern: 'haiku',             rates: HAIKU_5_5 },
];
const PRICING_MATCHERS = PRICING.map(p => ({ ...p, re: new RegExp(p.pattern.replace(/-/g, '\\-') + '(?!\\d)') }));

/** Unknown models are priced as Opus 5.5, Claude Code's default model on every plan. */
const PRICING_FALLBACK: PricingRow = OPUS_5_5;

/**
 * Lowercase a model ID and turn dotted versions into the dashed form the
 * pricing table uses, so gateway IDs like "claude-opus-4.8" are not mistaken
 * for the legacy "claude-opus-4" row.
 */
export function normaliseModelId(model: string): string {
  return model.toLowerCase().replace(/(\d)\.(\d)/g, '$1-$2');
}

/**
 * Resolve the pricing row for a model, and the tier name it matched under.
 * When tokens are given, request-dependent tiers apply: Haiku 5.5 long-prompt
 * pricing and the 2x fast-mode premium.
 */
export function describePricing(model: string, tokens?: TokenBreakdown): { tier: string; rates: PricingRow } {
  const id = normaliseModelId(model);
  const match = PRICING_MATCHERS.find(p => p.re.test(id));
  let tier = match ? match.pattern : 'fallback (model not recognized, priced as Opus 5.5)';
  let r = match ? match.rates : PRICING_FALLBACK;

  if (tokens && r === HAIKU_5_5 && tokens.input + tokens.cacheRead + tokens.cacheWrite > HAIKU_5_5_LONG_THRESHOLD) {
    r = HAIKU_5_5_LONG;
    tier += ' (prompt > 100K)';
  }
  if (tokens?.fast) {
    r = { input: r.input * 2, output: r.output * 2, cacheRead: r.cacheRead * 2, cacheWrite: r.cacheWrite * 2 };
    tier += ' (fast mode)';
  }
  return { tier, rates: r };
}

/** Calculate USD cost for a token breakdown given a model string. Returns 0 if no tokens. */
export function calcCost(tokens: TokenBreakdown, model: string): number {
  const { rates: r } = describePricing(model, tokens);
  const write1h = Math.min(tokens.cacheWrite1h ?? 0, tokens.cacheWrite);
  const write5m = tokens.cacheWrite - write1h;
  return (
    tokens.input     * r.input      +
    tokens.output    * r.output     +
    tokens.cacheRead * r.cacheRead  +
    write5m          * r.cacheWrite +
    write1h          * r.input * 2
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

/**
 * 10-segment coloured bar for usage limits. Unicode block characters cannot be
 * coloured inside a Markdown tooltip, so severity is carried by the glyph
 * itself: blue while safe, amber approaching the limit, red past it.
 */
function buildUsageBar(pct: number, warn: number, danger: number): string {
  const filled = Math.min(10, Math.round(pct / 10));
  const glyph = pct >= danger ? '\u{1F7E5}' : pct >= warn ? '\u{1F7E7}' : '\u{1F7E6}';
  return glyph.repeat(filled) + '\u2B1C'.repeat(10 - filled);
}

/** Format a reset timestamp in the user's locale, dropping the date when it is today. */
function fmtReset(resetsAt: Date | null): string {
  if (!resetsAt) { return ''; }
  const isToday = resetsAt.toDateString() === new Date().toDateString();
  const time = resetsAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return isToday
    ? `Resets ${time}`
    : `Resets ${resetsAt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

/**
 * One alert slot per limit per window. Scoped rows share a kind
 * ("weekly_scoped") and a reset time, so the scope is part of the key —
 * otherwise a Fable alert would silence every other scoped limit.
 */
function notifyKey(limit: UsageLimit): string {
  return `${limit.kind}:${limit.scope ?? ''}:${limit.resetsAt?.getTime() ?? 'none'}`;
}

/** Tooltip for the account-wide subscription meter: one bar per reported limit. */
function buildUsageTooltip(usage: UsageSnapshot, cfg: Config, stale: boolean): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.supportHtml = false;

  const plan = usage.plan ? `  ·  ${escapeMd(usage.plan)}` : '';
  md.appendMarkdown(`**Claude subscription usage**${plan}\n\n`);

  for (const limit of usage.limits) {
    const status = statusEmoji(limit.percent, cfg.usageWarningThreshold, cfg.usageDangerThreshold);
    md.appendMarkdown(`${escapeMd(limit.label)}  ·  ${status}\n\n`);
    md.appendMarkdown(`${buildUsageBar(limit.percent, cfg.usageWarningThreshold, cfg.usageDangerThreshold)}  **${Math.round(limit.percent)}%** used\n`);
    const reset = fmtReset(limit.resetsAt);
    if (reset) { md.appendMarkdown(`${escapeMd(reset)}\n`); }
    md.appendMarkdown('\n');
  }

  md.appendMarkdown('---\n\n');
  const age = formatAge(usage.ageMs);
  if (usage.source === 'live') {
    md.appendMarkdown(stale
      ? `⚠ Last live update ${age} — may be well behind actual usage`
      : `*Updated ${age}*`);
  } else if (stale) {
    md.appendMarkdown(`⚠ Cached, ${age} — may be well behind actual usage`);
  } else {
    md.appendMarkdown(`*Cached, ${age}*`);
  }
  if (usage.liveError) {
    md.appendMarkdown(`\n\n*Live refresh failing: ${escapeMd(usage.liveError)}*`);
  }
  return md;
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
  // Subscription limits are account-wide, so they get one item of their own
  // rather than being folded into the per-project meters.
  private usageItem: vscode.StatusBarItem | undefined;
  private lastUsage: UsageSnapshot | null = null;
  // Key is limit kind + reset timestamp, so each new window re-arms on its own
  // instead of staying silent after one alert.
  private readonly usageNotified = new Map<string, Set<'warn' | 'crit'>>();

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
        `Claude Code Usage Meter: ${session.projectName} is at ${pct}% context (${session.tokens.total.toLocaleString()}/${session.tokenLimit.toLocaleString()} tokens)`;

      if (session.pct >= cfg.dangerThreshold && !fired.has('crit')) {
        void vscode.window.showErrorMessage(msg(session.pct));
        fired.add('warn'); // also mark warn fired so a later pct drop doesn't spuriously re-fire it
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
        // Prune the burn-rate ring buffer too; it rebuilds from scratch if the
        // session reactivates. (hiddenSessions/notified are intentionally retained.)
        this.readings.delete(id);
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
          command: 'claudeContextMeter.showDetail',
          arguments: [session.id],
          title: 'Show session detail',
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
    this.usageItem?.dispose();
    this.usageItem = undefined;
    this.lastUsage = null;
    this.usageNotified.clear();
    this.readings.clear();
    this.notified.clear();
    this.lastSessions = [];
  }

  getUsage(): UsageSnapshot | null {
    return this.lastUsage;
  }

  /**
   * Render the account-wide subscription meter. Passing null keeps the last
   * good snapshot on screen — ~/.claude.json is rewritten constantly and a
   * read landing mid-write should not make the item flicker away.
   */
  updateUsage(snapshot: UsageSnapshot | null): void {
    const cfg = this.getConfig();
    if (snapshot) { this.lastUsage = snapshot; }
    const usage = this.lastUsage;
    // Age is measured at render time: a kept reading keeps getting older.
    if (usage) { usage.ageMs = Math.max(0, Date.now() - usage.fetchedAt.getTime()); }

    if (!cfg.showUsage || !usage) {
      this.usageItem?.dispose();
      this.usageItem = undefined;
      return;
    }

    if (!this.usageItem) {
      this.usageItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
      this.usageItem.command = { command: 'claudeContextMeter.showUsageDetail', title: 'Show subscription usage' };
    }

    const session = peakOf(usage, 'session');
    const weekly = peakOf(usage, 'weekly');
    const parts = [
      session ? `${Math.round(session.percent)}%` : '',
      weekly ? `${Math.round(weekly.percent)}%w` : '',
    ].filter(Boolean);

    const stale = usage.ageMs > cfg.usageStaleMinutes * 60_000;
    this.usageItem.text = `$(dashboard) Usage ${parts.join(' · ')}${stale ? ' ⚠' : ''}`;
    this.usageItem.tooltip = buildUsageTooltip(usage, cfg, stale);

    // Colour on the worst limit, so a near-full weekly cap is not masked by a
    // fresh session window.
    const peak = Math.max(session?.percent ?? 0, weekly?.percent ?? 0);
    if (peak >= cfg.usageDangerThreshold) {
      this.usageItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (peak >= cfg.usageWarningThreshold) {
      this.usageItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.usageItem.backgroundColor = undefined;
    }

    this.usageItem.show();
    if (!stale) { this.notifyUsage(usage, cfg); } // never alert on an old number
  }

  /**
   * Warn once per limit per window. Subscription caps stop work outright when
   * reached, so going red silently is not enough — but the meter refreshes
   * every 60s and must not nag on every tick.
   */
  private notifyUsage(usage: UsageSnapshot, cfg: Config): void {
    if (usage.source !== 'live') { return; } // never alert on a stale cached number

    for (const limit of usage.limits) {
      const key = notifyKey(limit);
      const fired = this.usageNotified.get(key) ?? new Set<'warn' | 'crit'>();
      const reset = limit.resetsAt ? ` Resets ${fmtReset(limit.resetsAt).replace(/^Resets /, '')}.` : '';

      if (limit.percent >= cfg.usageDangerThreshold && !fired.has('crit')) {
        fired.add('warn'); // suppress a late warn if we jumped straight past danger
        fired.add('crit');
        this.usageNotified.set(key, fired);
        void vscode.window.showErrorMessage(
          `Claude usage: ${limit.label} limit at ${Math.round(limit.percent)}%.${reset}`,
        );
      } else if (limit.percent >= cfg.usageWarningThreshold && !fired.has('warn')) {
        fired.add('warn');
        this.usageNotified.set(key, fired);
        void vscode.window.showWarningMessage(
          `Claude usage: ${limit.label} limit at ${Math.round(limit.percent)}%.${reset}`,
        );
      }
    }

    // Drop keys for windows that have already reset, so the map cannot grow
    // without bound across a long-running session.
    const liveKeys = new Set(usage.limits.map(notifyKey));
    for (const key of this.usageNotified.keys()) {
      if (!liveKeys.has(key)) { this.usageNotified.delete(key); }
    }
  }

  private buildTooltip(session: SessionInfo, cfg: Config): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.supportHtml = false;
    const { tokens } = session;
    const bar20 = buildBar20(session.pct);
    const status = statusEmoji(session.pct, cfg.warningThreshold, cfg.dangerThreshold);

    md.appendMarkdown(`**${escapeMd(session.projectName)}**\n\n`);
    md.appendMarkdown(`\`${escapeCode(cleanModelName(session.model) || 'unknown')}\`  ·  ${status} · ${session.pct}%\n\n`);
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
      const { rates } = describePricing(session.model, tokens);
      const inputCost = (tokens.input * rates.input) / 1_000_000;
      const outputCost = (tokens.output * rates.output) / 1_000_000;
      md.appendMarkdown(`💰 cost: $${cost.toFixed(2)}  (in: $${inputCost.toFixed(2)} · out: $${outputCost.toFixed(2)})\n\n`);
    }

    md.appendMarkdown(`*Updated ${session.lastUpdate.toLocaleTimeString()}*`);
    return md;
  }
}
