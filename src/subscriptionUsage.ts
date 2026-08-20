// src/subscriptionUsage.ts
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';

/**
 * Subscription limits come from the same place Claude Code's own /usage command
 * reads them: GET /api/oauth/usage, authenticated with the OAuth token Claude
 * Code stores locally.
 *
 * Claude Code also caches the last response in ~/.claude.json under
 * `cachedUsageUtilization`, but it only refreshes that block occasionally — it
 * was measured sitting ~30 minutes stale while the file itself was rewritten
 * every few seconds. The cache is therefore only a fallback for when the live
 * request fails; trusting it alone produces confidently wrong numbers.
 *
 * The endpoint is undocumented. It may change or stop working at Anthropic's
 * discretion, so every failure path degrades to the cache rather than erroring.
 */

const USAGE_HOST = 'api.anthropic.com';
const USAGE_PATH = '/api/oauth/usage';
const REQUEST_TIMEOUT_MS = 10_000;

export type UsageSource = 'live' | 'cache';

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
  source: UsageSource;
}

const KIND_LABELS: Record<string, string> = {
  session: 'Session',
  weekly_all: 'Week (all models)',
  weekly_opus: 'Week (Opus)',
  weekly_sonnet: 'Week (Sonnet)',
};

/** Readable name for kinds we have not seen, so new limit types still render. */
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

function resolveCredentialsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir
    ? path.join(dir, '.credentials.json')
    : path.join(os.homedir(), '.claude', '.credentials.json');
}

/**
 * Shared parser. The live endpoint returns exactly the object that the cache
 * stores under `cachedUsageUtilization.utilization`, so both paths land here.
 */
export function parseUtilization(
  utilization: Record<string, unknown>,
  fetchedAtMs: number,
  source: UsageSource,
  now = Date.now(),
): UsageSnapshot | null {
  const limits: UsageLimit[] = [];

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

  // Older Claude Code versions wrote only the legacy keys.
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

  return { limits, fetchedAt: new Date(fetchedAtMs), ageMs: Math.max(0, now - fetchedAtMs), source };
}

/** Parse the cached copy out of ~/.claude.json. Null when absent or mid-write. */
export function parseUsageCache(raw: string, now = Date.now()): UsageSnapshot | null {
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    return null;
  }

  const cached = (root as Record<string, unknown> | null)?.['cachedUsageUtilization'] as
    | Record<string, unknown>
    | undefined;
  const utilization = cached?.['utilization'] as Record<string, unknown> | undefined;
  if (!utilization) { return null; }

  const fetchedAtMs = typeof cached?.['fetchedAtMs'] === 'number' ? (cached['fetchedAtMs'] as number) : now;
  return parseUtilization(utilization, fetchedAtMs, 'cache', now);
}

/** Read the cached snapshot from disk. Only the usage subtree is ever touched. */
export function readCachedUsage(configPath: string): UsageSnapshot | null {
  try {
    // Explicit UTF-8: the locale default corrupts this file on some systems.
    return parseUsageCache(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Read the OAuth access token Claude Code stores locally.
 *
 * SECURITY: the returned value is a live credential. It is used only as the
 * Authorization header on the request below, is never logged, never written
 * anywhere, and is not retained beyond the call that uses it.
 */
function readAccessToken(): string | null {
  try {
    const raw = fs.readFileSync(resolveCredentialsPath(), 'utf8');
    const oauth = (JSON.parse(raw) as Record<string, unknown>)['claudeAiOauth'] as
      | Record<string, unknown>
      | undefined;
    const token = oauth?.['accessToken'];
    if (typeof token !== 'string' || !token) { return null; }
    const expiresAt = oauth?.['expiresAt'];
    if (typeof expiresAt === 'number' && expiresAt <= Date.now()) { return null; }
    return token;
  } catch {
    return null; // no credentials file: API-key users, or not signed in
  }
}

/**
 * Fetch current usage from the authenticated endpoint.
 * Resolves null on any failure so the caller can fall back to the cache.
 */
export function fetchLiveUsage(log: (msg: string) => void): Promise<UsageSnapshot | null> {
  const token = readAccessToken();
  if (!token) { return Promise.resolve(null); }

  return new Promise(resolve => {
    const req = https.request(
      {
        host: USAGE_HOST, // pinned: the token is only ever sent to Anthropic
        path: USAGE_PATH,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
          'User-Agent': 'claude-usage-meter',
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            // Status only. The body is never logged in case it echoes request detail.
            log(`[info] Usage endpoint returned ${res.statusCode}; falling back to cached value.`);
            resolve(null);
            return;
          }
          try {
            const json = JSON.parse(body) as Record<string, unknown>;
            resolve(parseUtilization(json, Date.now(), 'live'));
          } catch {
            log('[info] Usage endpoint returned unparseable data; falling back to cached value.');
            resolve(null);
          }
        });
      },
    );

    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null)); // deliberately unlogged: errors can carry the URL
    req.end();
  });
}

/**
 * Preferred snapshot: live when available, otherwise the local cache.
 * `allowLive` lets users switch off all network access.
 */
export async function getUsageSnapshot(
  configPath: string,
  allowLive: boolean,
  log: (msg: string) => void,
): Promise<UsageSnapshot | null> {
  if (allowLive) {
    const live = await fetchLiveUsage(log);
    if (live) { return live; }
  }
  return readCachedUsage(configPath);
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
