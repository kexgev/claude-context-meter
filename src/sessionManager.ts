// src/sessionManager.ts
import * as fs from 'fs';
import * as path from 'path';
import { Config, SessionInfo, SessionResult, TokenBreakdown } from './types';
import { decodePath, getProjectName, parseLatestTokenUsage, readFileLines } from './parser';

// ── Constants ─────────────────────────────────────────────────────────────

const EMOJI_RULES: Array<{ keywords: string[]; emoji: string }> = [
  { keywords: ['game', 'trivia', 'puzzle', 'quiz'], emoji: '🎮' },
  { keywords: ['web', 'site', 'frontend', 'react', 'vue', 'next'], emoji: '🌐' },
  { keywords: ['mobile', 'ios', 'android', 'app'], emoji: '📱' },
  { keywords: ['ai', 'ml', 'llm', 'claude', 'gpt', 'model'], emoji: '🤖' },
  { keywords: ['music', 'audio', 'sound', 'beat'], emoji: '🎵' },
  { keywords: ['tool', 'cli', 'script', 'util', 'helper'], emoji: '🔧' },
  { keywords: ['api', 'server', 'backend', 'service'], emoji: '⚙️' },
];

const PALETTE = [
  '#FFB3BA', '#FFDFBA', '#FFFFBA', '#BAFFC9',
  '#BAE1FF', '#D4BAFF', '#FFB3F7', '#B3FFF6',
];

// ── Exported helpers (also tested directly) ───────────────────────────────

const CONTEXT_200K = 200_000;
const CONTEXT_1M = 1_000_000;

/** Claude Code's context env vars, when the VS Code extension host inherits them. */
function contextEnv(): { disable1M: boolean; maxTokens: number | null; disableCompact: boolean } {
  const truthy = (v: string | undefined) => !!v && !['0', 'false', 'no', 'off'].includes(v.toLowerCase());
  const max = Number(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS);
  return {
    disable1M: truthy(process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT),
    maxTokens: Number.isFinite(max) && max > 0 ? max : null,
    disableCompact: truthy(process.env.DISABLE_COMPACT),
  };
}

/**
 * Native context window for a model ID Claude Code recognises, or null when it
 * does not recognise the ID (gateway aliases such as "claude-sonnet-latest",
 * non-Claude models, empty IDs).
 *
 * - Claude 3.x (any family) and Haiku 4.x: 200K.
 * - Opus/Sonnet 4, 4.1, 4.5: 200K.
 * - Opus/Sonnet 4.6: 200K unless the ID carries the `[1m]` suffix.
 * - Opus 4.7+, Sonnet 5+, Haiku 5.5+, Fable/Mythos: 1M. Future versions of these
 *   families are assumed 1M too, so new releases work without an update.
 *
 * Dotted versions ("claude-opus-4.6") are treated like dashed ones; dated
 * suffixes ("-20250514") are never mistaken for a minor version.
 */
function knownContextLimit(model: string): number | null {
  const id = model.toLowerCase().replace(/(\d)\.(\d)/g, '$1-$2');

  // Old naming: claude-3-opus, claude-3-5-sonnet, claude-3-7-sonnet, claude-3-5-haiku
  if (/claude-3(?:-\d)?-(?:opus|sonnet|haiku)/.test(id)) { return CONTEXT_200K; }

  const m = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(id);
  if (!m) { return null; }
  const family = m[1];
  const major = Number(m[2]);
  const minor = m[3] === undefined ? 0 : Number(m[3]);

  if (family === 'haiku') { return major < 5 ? CONTEXT_200K : CONTEXT_1M; }
  if ((family === 'opus' || family === 'sonnet') && major === 4) {
    if (minor < 6) { return CONTEXT_200K; }
    if (minor === 6) { return id.includes('[1m]') ? CONTEXT_1M : CONTEXT_200K; }
    return CONTEXT_1M;
  }
  if ((family === 'opus' || family === 'sonnet') && major < 4) { return CONTEXT_200K; }
  return CONTEXT_1M;
}

/**
 * Context window for a session's model, following Claude Code's rules
 * (https://code.claude.com/docs/en/model-config):
 *
 * - Recognised models use their native window. `CLAUDE_CODE_DISABLE_1M_CONTEXT`
 *   caps them at 200K; `CLAUDE_CODE_MAX_CONTEXT_TOKENS` applies only together
 *   with `DISABLE_COMPACT`.
 * - Unrecognised IDs: 1M with a `[1m]` suffix (unless 1M is disabled), else
 *   `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, else the `contextLimit` setting, which
 *   defaults to the 200K Claude Code assumes.
 */
export function detectTokenLimit(model: string, contextLimit: number): number {
  if (!model) { return contextLimit; }
  const env = contextEnv();
  const known = knownContextLimit(model);

  if (known !== null) {
    if (env.maxTokens !== null && env.disableCompact) { return env.maxTokens; }
    return env.disable1M ? Math.min(known, CONTEXT_200K) : known;
  }
  if (/\[1m\]/i.test(model) && !env.disable1M) { return CONTEXT_1M; }
  return env.maxTokens ?? contextLimit;
}

/**
 * Whether a session that has outgrown its detected window can be assumed to be
 * on the 1M variant: only when nothing in the environment or settings pinned
 * the smaller window on purpose.
 */
export function canPromoteTo1M(model: string, tokenLimit: number): boolean {
  if (!model || tokenLimit !== CONTEXT_200K) { return false; }
  const env = contextEnv();
  return !env.disable1M && env.maxTokens === null;
}

export function assignEmoji(projectName: string): string {
  const lower = projectName.toLowerCase();
  for (const { keywords, emoji } of EMOJI_RULES) {
    if (keywords.some(kw => lower.includes(kw))) { return emoji; }
  }
  return '💻';
}

function djb2Hash(str: string): number {
  let h = 5381;
  for (const c of str) { h = (((h << 5) + h) ^ c.charCodeAt(0)) >>> 0; }
  return h;
}

export function assignColor(projectPath: string, autoColor: boolean): string {
  if (!autoColor) { return ''; }
  const normalized = process.platform === 'win32' ? projectPath.toLowerCase() : projectPath;
  return PALETTE[djb2Hash(normalized) % PALETTE.length];
}

/** Strip Bedrock/cross-region/Vertex decoration for display. Matching logic elsewhere (pricing, context limit) is untouched — this is display-only. */
export function cleanModelName(model: string): string {
  return model
    .replace(/^(?:[a-z0-9-]+\.)?anthropic\./i, '')
    .replace(/\[1m\]$/i, '')
    .replace(/-v\d+:\d+$/, '')
    .replace(/@\d{8}$/, '');
}

export function abbreviateName(projectName: string, config: Config): string {
  if (!config.compactMode) { return projectName; }

  // Rule 1: shortNames override (hasOwnProperty guard prevents prototype pollution)
  if (Object.prototype.hasOwnProperty.call(config.shortNames, projectName)) {
    return config.shortNames[projectName];
  }

  // Rule 2: short enough
  if (projectName.length <= 5) { return projectName; }

  // Rule 3: multi-word → acronym
  if (projectName.includes('-') || projectName.includes('_')) {
    return projectName
      .split(/[-_]/)
      .filter(w => w.length > 0)
      .map(w => w[0].toUpperCase())
      .join('');
  }

  // Rule 4: single long word → first + last 4 chars
  const match = projectName.toLowerCase().match(/^(.).+(.{4})$/);
  if (match) { return match[1].toUpperCase() + match[2]; }

  return projectName;
}

function isAgentOrPlugin(projectPath: string): boolean {
  return projectPath.split(/[/\\]/).some(s => s === 'agents' || s === 'plugins');
}

// ── Main scan function ────────────────────────────────────────────────────

export interface RawSession {
  filePath: string;
  projectPath: string;
  projectName: string;
  id: string;
  mtime: Date;
  tokens: TokenBreakdown;
  model: string;
  tokenLimit: number;
  active: boolean;
}

/**
 * Walk every *.jsonl file under projectsDir and parse its latest token usage.
 * Shared by scanSessions (live status bar, active-only) and the spend summary
 * command (all sessions regardless of idle state).
 * @param now - injectable timestamp for testing; defaults to Date.now()
 */
export function walkRawSessions(
  projectsDir: string,
  config: Pick<Config, 'idleTimeout' | 'contextLimit'>,
  log: (msg: string) => void,
  now?: number,
): RawSession[] {
  const currentTime = now ?? Date.now();
  const rawSessions: RawSession[] = [];

  let projectDirs: string[];
  try {
    projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch (e) {
    log(`[warn] Cannot read projects dir: ${e}`);
    return [];
  }

  for (const encodedDir of projectDirs) {
    const dirPath = path.join(projectsDir, encodedDir);
    let files: string[];
    try {
      files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
    } catch (e) {
      log(`[warn] Cannot read dir ${dirPath}: ${e}`);
      continue;
    }

    const projectPath = decodePath(encodedDir);
    if (isAgentOrPlugin(projectPath)) { continue; }
    const projectName = getProjectName(projectPath);

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      let mtime: Date;
      try { mtime = fs.statSync(filePath).mtime; } catch { continue; }

      const active = (currentTime - mtime.getTime()) / 1000 < config.idleTimeout;
      const id = path.basename(file, '.jsonl');
      const lines = readFileLines(filePath);
      const latest = parseLatestTokenUsage(lines);
      const emptyBreakdown: TokenBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
      const tokens = latest?.tokens ?? emptyBreakdown;
      const model = latest?.model ?? '';
      let tokenLimit = detectTokenLimit(model, config.contextLimit);
      // A session already past the detected window must be running the 1M
      // variant (e.g. Opus 4.6 with [1m] that the transcript does not record).
      if (tokens.total > tokenLimit && canPromoteTo1M(model, tokenLimit)) { tokenLimit = CONTEXT_1M; }

      rawSessions.push({ filePath, projectPath, projectName, id, mtime, tokens, model, tokenLimit, active });
    }
  }

  return rawSessions;
}

/**
 * Scan all JSONL sessions in projectsDir.
 * @param now - injectable timestamp for testing; defaults to Date.now()
 */
export async function scanSessions(
  projectsDir: string,
  config: Config,
  log: (msg: string) => void,
  now?: number,
): Promise<SessionResult> {
  const rawSessions = walkRawSessions(projectsDir, config, log, now);
  if (rawSessions.length === 0) { return { sessions: [] }; }

  // Supersession: find the single newest session per projectPath.
  // Tie-break equal mtimes by id (lexicographically larger wins) so that two
  // files written in the same millisecond don't both render a status bar item.
  const newest = new Map<string, { mtime: number; id: string }>();
  for (const s of rawSessions) {
    const m = s.mtime.getTime();
    const cur = newest.get(s.projectPath);
    if (!cur || m > cur.mtime || (m === cur.mtime && s.id > cur.id)) {
      newest.set(s.projectPath, { mtime: m, id: s.id });
    }
  }

  // Build sessions[] (non-idle, only the single newest per project)
  const sessions: SessionInfo[] = [];
  for (const s of rawSessions) {
    if (!s.active) { continue; }
    if (newest.get(s.projectPath)?.id !== s.id) { continue; }

    const pct = Math.round(s.tokens.total / s.tokenLimit * 1000) / 10;
    sessions.push({
      id: s.id,
      projectPath: s.projectPath,
      projectName: s.projectName,
      emoji: assignEmoji(s.projectName),
      color: assignColor(s.projectPath, config.autoColor),
      model: s.model,
      tokenLimit: s.tokenLimit,
      tokens: s.tokens,
      pct,
      lastUpdate: s.mtime,
      active: true,
      filePath: s.filePath,
    });
  }

  return { sessions };
}
