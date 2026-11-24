// src/subscriptionUsage.ts
import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';

/**
 * Subscription limits come from the same place Claude Code's own /usage command
 * reads them: GET /api/oauth/usage, authenticated with the OAuth token Claude
 * Code stores locally.
 *
 * Claude Code has cached the last response in ~/.claude.json under
 * `cachedUsageUtilization`, but it only refreshes that block occasionally — it
 * was measured sitting ~30 minutes stale while the file itself was rewritten
 * every few seconds — and Claude Code 2.1.325 was seen not writing it at all.
 * The cache is therefore only a best-effort fallback for when the live request
 * fails; trusting it alone produces confidently wrong numbers.
 *
 * The endpoint is undocumented and rate-limits frequent polling (HTTP 429). It
 * may change or stop working at Anthropic's discretion, so every failure path
 * degrades to the newest older reading rather than erroring.
 */

const USAGE_HOST = 'api.anthropic.com';
const USAGE_PATH = '/api/oauth/usage';
const REQUEST_TIMEOUT_MS = 10_000;
const KEYCHAIN_TIMEOUT_MS = 5_000;

export type UsageSource = 'live' | 'cache';

export interface UsageLimit {
  kind: string;
  group: string;
  label: string;
  /** Server's display name for a scoped row ("Fable", "Fable · Cowork"); null when unscoped. */
  scope: string | null;
  percent: number;
  resetsAt: Date | null;
  isActive: boolean;
}

export interface UsageSnapshot {
  limits: UsageLimit[];
  fetchedAt: Date;
  ageMs: number;
  source: UsageSource;
  /** Plan name as claude.ai shows it, e.g. "Max (5x)". Null when unknown. */
  plan: string | null;
  /** Why the latest live refresh failed, when this is an older reading. */
  liveError?: string;
}

const KIND_LABELS: Record<string, string> = {
  session: '5-hour',
  weekly_all: 'Week (all models)',
  weekly_opus: 'Week (Opus)',
  weekly_sonnet: 'Week (Sonnet)',
};

/**
 * Server-supplied label for a scoped row, built from `scope.model.display_name`
 * (e.g. "Fable") and `scope.surface.display_name`. The two are independent, so
 * both are kept when present: "Fable · Cowork". Null for unscoped rows.
 */
function scopeName(scope: unknown): string | null {
  if (!scope || typeof scope !== 'object') { return null; }
  const s = scope as Record<string, unknown>;
  const names: string[] = [];
  for (const key of ['model', 'surface']) {
    const name = (s[key] as Record<string, unknown> | null | undefined)?.['display_name'];
    if (typeof name === 'string' && name.trim()) { names.push(name.trim()); }
  }
  return names.length > 0 ? names.join(' · ') : null;
}

/** Readable name for kinds we have not seen, so new limit types still render. */
function labelFor(kind: string, scope?: string | null): string {
  if (scope) {
    if (kind.startsWith('weekly')) { return `Week (${scope})`; }
    if (kind.startsWith('session')) { return `5-hour (${scope})`; }
  }
  if (KIND_LABELS[kind] && !scope) { return KIND_LABELS[kind]; }
  const title = kind
    .split('_')
    .filter(w => w && w !== 'scoped')
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join(' ');
  return scope ? `${title} (${scope})` : title;
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

/** Claude Code's transcript directory. Honors CLAUDE_CONFIG_DIR like the paths above. */
export function resolveProjectsDir(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? path.join(dir, 'projects') : path.join(os.homedir(), '.claude', 'projects');
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
      const scope = scopeName(e['scope']);
      limits.push({
        kind,
        group: typeof e['group'] === 'string' ? e['group'] : kind,
        label: labelFor(kind, scope),
        scope,
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
      { key: 'seven_day_opus', kind: 'weekly_opus', group: 'weekly' },
      { key: 'seven_day_sonnet', kind: 'weekly_sonnet', group: 'weekly' },
    ];
    for (const { key, kind, group } of legacy) {
      const row = utilization[key] as Record<string, unknown> | undefined | null;
      if (!row || typeof row['utilization'] !== 'number') { continue; }
      limits.push({
        kind,
        group,
        label: labelFor(kind),
        scope: null,
        percent: row['utilization'] as number,
        resetsAt: parseDate(row['resets_at']),
        isActive: true,
      });
    }
  }

  if (limits.length === 0) { return null; }

  return {
    limits,
    fetchedAt: new Date(fetchedAtMs),
    ageMs: Math.max(0, now - fetchedAtMs),
    source,
    plan: null,
  };
}

/**
 * Plan name from Claude Code's `subscriptionType` + `rateLimitTier`, matching
 * claude.ai's wording: "Pro", "Max (5x)", "Max (20x)", "Team", ...
 */
export function planLabel(subscriptionType: unknown, rateLimitTier: unknown): string | null {
  if (typeof subscriptionType !== 'string' || !subscriptionType) { return null; }
  const type = subscriptionType.toLowerCase();
  const tier = typeof rateLimitTier === 'string' ? rateLimitTier.toLowerCase() : '';
  if (type === 'max') {
    const mult = /max_(\d+)x/.exec(tier)?.[1];
    return mult ? `Max (${mult}x)` : 'Max';
  }
  return type[0].toUpperCase() + type.slice(1);
}

/**
 * Plan from the last credentials read. The file-watcher path reuses it rather
 * than re-parsing the token-bearing credentials every few seconds.
 */
let lastPlan: string | null = null;

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
    const snapshot = parseUsageCache(fs.readFileSync(configPath, 'utf8'));
    if (snapshot) { snapshot.plan = lastPlan; }
    return snapshot;
  } catch {
    return null;
  }
}

/**
 * macOS Keychain item Claude Code stores its login under when there is no
 * credentials file. A custom CLAUDE_CONFIG_DIR gets its own item, suffixed with
 * a hash of the directory — mirrored from Claude Code's own naming.
 */
function keychainServices(): string[] {
  const base = 'Claude Code-credentials';
  const dir = process.env.CLAUDE_CONFIG_DIR;
  if (!dir) { return [base]; }
  const hash = crypto.createHash('sha256').update(dir.normalize('NFC')).digest('hex').substring(0, 8);
  return [`${base}-${hash}`, base];
}

function readKeychain(service: string): Promise<string | null> {
  return new Promise(resolve => {
    try {
      execFile(
        'security',
        ['find-generic-password', '-s', service, '-w'],
        { encoding: 'utf8', timeout: KEYCHAIN_TIMEOUT_MS, windowsHide: true },
        // Output is the secret itself: never logged, errors deliberately dropped.
        (err, stdout) => resolve(err ? null : stdout.trim() || null),
      );
    } catch {
      resolve(null);
    }
  });
}

/**
 * Read Claude Code's stored OAuth record: the credentials file, or on macOS the
 * login Keychain when there is no file.
 *
 * SECURITY: the record holds a live credential. Callers use the access token
 * only as the Authorization header of the usage request and read nothing else
 * but the two plan fields. It is never logged, written, or retained.
 */
async function readOAuthRecord(): Promise<Record<string, unknown> | null> {
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(resolveCredentialsPath(), 'utf8');
  } catch {
    if (process.platform === 'darwin') {
      for (const service of keychainServices()) {
        raw = await readKeychain(service);
        if (raw) { break; }
      }
    }
  }
  if (!raw) { return null; } // API-key users, or not signed in
  try {
    const oauth = (JSON.parse(raw) as Record<string, unknown>)['claudeAiOauth'];
    return oauth && typeof oauth === 'object' ? (oauth as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function accessTokenOf(oauth: Record<string, unknown> | null): string | null {
  const token = oauth?.['accessToken'];
  if (typeof token !== 'string' || !token) { return null; }
  const expiresAt = oauth?.['expiresAt'];
  if (typeof expiresAt === 'number' && expiresAt <= Date.now()) { return null; }
  return token;
}

/** Outcome of one request to the usage endpoint. */
type FetchOutcome =
  | { ok: true; utilization: Record<string, unknown>; snapshot: UsageSnapshot }
  | { ok: false; reason: string; rateLimited?: boolean; retryAfterMs?: number | null };

/**
 * `Retry-After` as milliseconds: either delta-seconds or an HTTP date.
 * Null when absent or unparseable.
 */
export function parseRetryAfter(value: unknown, now = Date.now()): number | null {
  const v = Array.isArray(value) ? value[0] : value;
  if (typeof v !== 'string' || !v.trim()) { return null; }
  if (/^\d+$/.test(v.trim())) { return Number(v.trim()) * 1000; }
  const date = Date.parse(v);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

const MIN_BACKOFF_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;

/**
 * How long to stop polling after a 429. Honors the server's Retry-After;
 * otherwise doubles from five minutes (or two poll intervals) up to an hour.
 */
export function nextBackoffMs(previousMs: number | undefined, retryAfterMs: number | null, intervalMs: number): number {
  if (retryAfterMs !== null && retryAfterMs > 0) {
    return Math.min(MAX_BACKOFF_MS, Math.max(retryAfterMs, intervalMs));
  }
  const base = Math.max(MIN_BACKOFF_MS, intervalMs * 2);
  return Math.min(MAX_BACKOFF_MS, previousMs ? Math.max(base, previousMs * 2) : base);
}

/**
 * Fetch current usage from the authenticated endpoint.
 * Never rejects: failures come back with a reason for the log and tooltip.
 */
function fetchLiveUsage(token: string): Promise<FetchOutcome> {
  return new Promise(resolve => {
    const req = https.request(
      {
        host: USAGE_HOST, // pinned: the token is only ever sent to Anthropic
        path: USAGE_PATH,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
          'User-Agent': 'claude-context-meter',
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode === 429) {
            resolve({
              ok: false,
              reason: 'Usage endpoint rate-limited the request (HTTP 429)',
              rateLimited: true,
              retryAfterMs: parseRetryAfter(res.headers['retry-after']),
            });
            return;
          }
          if (res.statusCode !== 200) {
            // Status only. The body is never logged in case it echoes request detail.
            const hint = res.statusCode === 401 || res.statusCode === 403
              ? ' (sign-in rejected; run /login in Claude Code)'
              : '';
            resolve({ ok: false, reason: `Usage endpoint returned HTTP ${res.statusCode}${hint}` });
            return;
          }
          try {
            const json = JSON.parse(body) as Record<string, unknown>;
            const snapshot = parseUtilization(json, Date.now(), 'live');
            resolve(snapshot
              ? { ok: true, utilization: json, snapshot }
              : { ok: false, reason: 'Usage endpoint returned no limits' });
          } catch {
            resolve({ ok: false, reason: 'Usage endpoint returned unparseable data' });
          }
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, reason: `Usage request timed out after ${REQUEST_TIMEOUT_MS / 1000}s (network, proxy or firewall)` });
    });
    // Only the error code is reported: messages can carry the URL.
    req.on('error', err => {
      const code = (err as NodeJS.ErrnoException).code;
      resolve({ ok: false, reason: `Usage request failed${code ? ` (${code})` : ''}: network, proxy or firewall` });
    });
    req.end();
  });
}

/**
 * State shared by every VS Code window through a small file in the
 * extension's global storage, so N windows make one request per interval
 * between them and all respect the same 429 backoff. It holds only usage
 * percentages and timestamps, never the token.
 */
export interface SharedUsageState {
  live?: { fetchedAtMs: number; utilization: Record<string, unknown> };
  backoffUntilMs?: number;
  backoffMs?: number;
  /** Another window is mid-request until this time. */
  inflightUntilMs?: number;
}

function readShared(file: string | null): SharedUsageState {
  if (!file) { return {}; }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as SharedUsageState) : {};
  } catch {
    return {};
  }
}

function writeShared(file: string | null, state: SharedUsageState): void {
  if (!file) { return; }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Write-then-rename so another window never reads a half-written file.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    // Sharing is an optimisation; each window still works on its own.
  }
}

/** Newest candidate by fetch time, with age recomputed for `now`. Live wins ties. */
export function newestSnapshot(
  candidates: Array<UsageSnapshot | null | undefined>,
  now = Date.now(),
): UsageSnapshot | null {
  let best: UsageSnapshot | null = null;
  for (const c of candidates) {
    if (!c) { continue; }
    const t = c.fetchedAt.getTime();
    const bt = best ? best.fetchedAt.getTime() : -Infinity;
    if (t > bt || (t === bt && c.source === 'live' && best?.source !== 'live')) { best = c; }
  }
  return best ? { ...best, ageMs: Math.max(0, now - best.fetchedAt.getTime()) } : null;
}

const INFLIGHT_CLAIM_MS = REQUEST_TIMEOUT_MS + 5_000;
/** Shared data younger than this share of the poll interval counts as fresh. */
const SHARED_FRESH_RATIO = 0.8;

/** "in 12 min" / "in 1h" for backoff messages. */
function formatIn(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return minutes < 60 ? `in ${minutes} min` : `in ${Math.round(minutes / 60)}h`;
}

interface LiveAttempt {
  snapshot?: UsageSnapshot;
  sharedLive?: UsageSnapshot | null;
  reason: string | null;
}

/**
 * Polls the usage endpoint for one window. A fresh live reading is preferred;
 * when that fails, the newest reading available (this window's last live one,
 * another window's, or Claude Code's cache) is shown with its real age, so one
 * failed poll never swaps minutes-old data for a day-old cache.
 */
export class UsagePoller {
  private lastLive: UsageSnapshot | null = null;
  private lastReason: string | null = null;

  constructor(
    private readonly sharedFile: string | null,
    private readonly log: (msg: string) => void,
  ) {}

  /** `allowLive` false switches off all network access. */
  async poll(configPath: string, allowLive: boolean, intervalMs: number): Promise<UsageSnapshot | null> {
    const oauth = await readOAuthRecord();
    lastPlan = planLabel(oauth?.['subscriptionType'], oauth?.['rateLimitTier']);

    const attempt = await this.tryLive(oauth, allowLive, intervalMs);
    if (attempt.snapshot) {
      this.lastLive = attempt.snapshot;
      this.report(null);
      return { ...attempt.snapshot, plan: lastPlan, liveError: undefined };
    }

    this.report(attempt.reason);
    const best = newestSnapshot([this.lastLive, attempt.sharedLive, readCachedUsage(configPath)]);
    if (best) {
      best.plan = lastPlan;
      best.liveError = attempt.reason ?? undefined;
    }
    return best;
  }

  private async tryLive(
    oauth: Record<string, unknown> | null,
    allowLive: boolean,
    intervalMs: number,
  ): Promise<LiveAttempt> {
    const now = Date.now();
    const shared = readShared(this.sharedFile);
    const sharedLive = shared.live && typeof shared.live.fetchedAtMs === 'number' && shared.live.utilization
      ? parseUtilization(shared.live.utilization, shared.live.fetchedAtMs, 'live', now)
      : null;

    if (!allowLive) { return { sharedLive, reason: 'live fetch is turned off (usageLiveFetch)' }; }

    // Another window fetched recently: reuse its reading instead of asking again.
    if (sharedLive && now - sharedLive.fetchedAt.getTime() < intervalMs * SHARED_FRESH_RATIO) {
      return { snapshot: sharedLive, reason: null };
    }
    if (shared.backoffUntilMs && now < shared.backoffUntilMs) {
      return { sharedLive, reason: `rate-limited by the usage endpoint, next try ${formatIn(shared.backoffUntilMs - now)}` };
    }
    if (shared.inflightUntilMs && now < shared.inflightUntilMs) {
      return { sharedLive, reason: this.lastReason }; // another window is asking right now
    }

    if (!oauth) { return { sharedLive, reason: 'no Claude Code sign-in found' }; }
    const token = accessTokenOf(oauth);
    if (!token) {
      return {
        sharedLive,
        reason: "Claude Code's sign-in token has expired; it renews the next time Claude Code sends a message",
      };
    }

    writeShared(this.sharedFile, { ...shared, inflightUntilMs: now + INFLIGHT_CLAIM_MS });
    const result = await fetchLiveUsage(token);
    const latest = readShared(this.sharedFile);

    if (result.ok) {
      writeShared(this.sharedFile, {
        live: { fetchedAtMs: result.snapshot.fetchedAt.getTime(), utilization: result.utilization },
      });
      return { snapshot: result.snapshot, reason: null };
    }

    if (result.rateLimited) {
      const backoffMs = nextBackoffMs(latest.backoffMs, result.retryAfterMs ?? null, intervalMs);
      writeShared(this.sharedFile, {
        ...latest,
        inflightUntilMs: undefined,
        backoffMs,
        backoffUntilMs: Date.now() + backoffMs,
      });
      return { sharedLive, reason: `${result.reason}, next try ${formatIn(backoffMs)}` };
    }

    writeShared(this.sharedFile, { ...latest, inflightUntilMs: undefined });
    return { sharedLive, reason: result.reason };
  }

  /** Log only when the failure reason changes, so a minute-by-minute poll does not flood the channel. */
  private report(reason: string | null): void {
    if (reason === this.lastReason) { return; }
    if (reason) {
      this.log(`[info] Live usage unavailable: ${reason}. Showing the newest reading available.`);
    } else if (this.lastReason) {
      this.log('[info] Live usage refresh is working again.');
    }
    this.lastReason = reason;
  }
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
