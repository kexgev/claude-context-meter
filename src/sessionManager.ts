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

/**
 * Known Claude model context windows.
 * Patterns are tested against the lowercase model string.
 * First match wins — order from most specific to least.
 */
const MODEL_CONTEXT_LIMITS: { pattern: RegExp; limit: number }[] = [
  // Haiku family — always 200K (catches claude-haiku-*, claude-3-haiku, claude-3-5-haiku)
  { pattern: /claude-(3[._-]5-|3-)?haiku/, limit: 200_000 },
  // Legacy Claude 3 / 3.5 — never had 1M context
  { pattern: /claude-3[._-]5-sonnet/,    limit:   200_000 },
  { pattern: /claude-3-opus/,            limit:   200_000 },
  { pattern: /claude-3-sonnet/,          limit:   200_000 },
  // Catch-all for any other claude-* model (Opus/Sonnet 4.x and beyond) → 1M.
  // Future-proofs new releases (Opus 4.8, 4.9, 5.x, etc.) without code changes.
  { pattern: /claude-/,                  limit: 1_000_000 },
];

export function detectTokenLimit(model: string, contextLimit: number): number {
  const lower = model.toLowerCase();
  for (const { pattern, limit } of MODEL_CONTEXT_LIMITS) {
    if (pattern.test(lower)) { return limit; }
  }
  return contextLimit;
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
    .replace(/^(us|eu|apac)\.anthropic\./, '')
    .replace(/^anthropic\./, '')
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
      const tokenLimit = detectTokenLimit(model, config.contextLimit);

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
