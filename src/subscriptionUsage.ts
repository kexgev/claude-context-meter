// src/subscriptionUsage.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Claude Code caches the payload behind its own `/usage` command in
 * ~/.claude.json under `cachedUsageUtilization`. Reading that file gives us the
 * same session/weekly limits with no credentials, no network request, and no
 * token handling — the cache itself is unauthenticated.
 *
 * It is a cache, not live state: it only refreshes while Claude Code is
 * running, so `fetchedAtMs` is treated as a staleness indicator.
 */

export interface UsageLimit {
  kind: string;
  group: string;
  label: string;
  percent: number;
  resetsAt: Date | null;
  isActive: boolean;
}

export interface UsageSnapshot {
  limits: UsageLimit[];
  fetchedAt: Date;
  ageMs: number;
}

/** Humanized names for the limit kinds we know about. */
const KIND_LABELS: Record<string, string> = {
  session: 'Session',
  weekly_all: 'Week (all models)',
  weekly_opus: 'Week (Opus)',
  weekly_sonnet: 'Week (Sonnet)',
};

/**
 * Fall back to a readable name for kinds we haven't seen, so limit types added
 * by Anthropic still render instead of being dropped.
 */
function labelFor(kind: string): string {
  if (KIND_LABELS[kind]) { return KIND_LABELS[kind]; }
  return kind
    .split('_')
    .filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string') { return null; }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Honors CLAUDE_CONFIG_DIR, which relocates Claude Code's config. */
export function resolveClaudeConfigPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

/**
 * Parse the raw ~/.claude.json contents into a usage snapshot.
 * Pure and side-effect free so it can be unit tested without VS Code.
 * Returns null when there is no usage cache — API-key users have none.
 */
export function parseUsageCache(raw: string, now = Date.now()): UsageSnapshot | null {
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    return null; // torn write — caller keeps the previous snapshot
  }

  const cached = (root as Record<string, unknown> | null)?.['cachedUsageUtilization'] as
    | Record<string, unknown>
    | undefined;
  if (!cached) { return null; }

  const utilization = cached['utilization'] as Record<string, unknown> | undefined;
  if (!utilization) { return null; }

  const limits: UsageLimit[] = [];

  // Preferred shape: the normalized array the /usage UI renders.
  const rawLimits = utilization['limits'];
  if (Array.isArray(rawLimits)) {
    for (const entry of rawLimits) {
      if (!entry || typeof entry !== 'object') { continue; }
      const e = entry as Record<string, unknown>;
      const percent = e['percent'];
      const kind = typeof e['kind'] === 'string' ? e['kind'] : '';
      if (typeof percent !== 'number' || !kind) { continue; }
      limits.push({
        kind,
        group: typeof e['group'] === 'string' ? e['group'] : kind,
        label: labelFor(kind),
        percent,
        resetsAt: parseDate(e['resets_at']),
        isActive: e['is_active'] === true,
      });
    }
  }

  // Fallback for older Claude Code versions that only wrote the legacy keys.
  if (limits.length === 0) {
    const legacy: Array<{ key: string; kind: string; group: string }> = [
      { key: 'five_hour', kind: 'session', group: 'session' },
      { key: 'seven_day', kind: 'weekly_all', group: 'weekly' },
    ];
    for (const { key, kind, group } of legacy) {
      const row = utilization[key] as Record<string, unknown> | undefined | null;
      if (!row || typeof row['utilization'] !== 'number') { continue; }
      limits.push({
        kind,
        group,
        label: labelFor(kind),
        percent: row['utilization'] as number,
        resetsAt: parseDate(row['resets_at']),
        isActive: true,
      });
    }
  }

  if (limits.length === 0) { return null; }

  const fetchedAtMs = typeof cached['fetchedAtMs'] === 'number' ? (cached['fetchedAtMs'] as number) : now;
  return {
    limits,
    fetchedAt: new Date(fetchedAtMs),
    ageMs: Math.max(0, now - fetchedAtMs),
  };
}

/**
 * Read and parse the usage cache. Returns null if the file is missing,
 * unreadable, mid-write, or holds no usage data.
 *
 * Only the cachedUsageUtilization subtree is ever extracted — the rest of
 * ~/.claude.json holds account identifiers we deliberately do not touch.
 */
export function readUsageSnapshot(configPath: string, log: (msg: string) => void): UsageSnapshot | null {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8'); // explicit UTF-8: locale default corrupts this file
  } catch {
    return null;
  }

  const snapshot = parseUsageCache(raw);
  if (!snapshot) { log('[info] No subscription usage data in Claude config.'); }
  return snapshot;
}

/** Highest-percentage limit within a group, or null when the group is absent. */
export function peakOf(snapshot: UsageSnapshot, group: string): UsageLimit | null {
  const inGroup = snapshot.limits.filter(l => l.group === group);
  if (inGroup.length === 0) { return null; }
  return inGroup.reduce((a, b) => (b.percent > a.percent ? b : a));
}

/** Relative age for the tooltip footer, e.g. "2 min ago". */
export function formatAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) { return 'just now'; }
  if (minutes < 60) { return `${minutes} min ago`; }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) { return `${hours}h ago`; }
  return `${Math.floor(hours / 24)}d ago`;
}
