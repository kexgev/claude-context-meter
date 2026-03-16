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
  // Claude 4.6 family (1M context)
  { pattern: /claude-opus-4-6/,          limit: 1_000_000 },
  { pattern: /claude-sonnet-4-6/,        limit: 1_000_000 },
  // Claude 4.5 family
  { pattern: /claude-sonnet-4-5/,        limit: 1_000_000 },
  { pattern: /claude-haiku-4-5/,         limit:   200_000 },
  // Claude 4 family
  { pattern: /claude-opus-4/,            limit:   200_000 },
  { pattern: /claude-sonnet-4/,          limit:   200_000 },
  // Claude 3.5 family
  { pattern: /claude-3[._-]5-sonnet/,    limit:   200_000 },
  { pattern: /claude-3[._-]5-haiku/,     limit:   200_000 },
  // Claude 3 family
  { pattern: /claude-3-opus/,            limit:   200_000 },
  { pattern: /claude-3-sonnet/,          limit:   200_000 },
  { pattern: /claude-3-haiku/,           limit:   200_000 },
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

export function abbreviateName(projectName: string, config: Config): string {
  if (!config.compactMode) { return projectName; }

  // Rule 1: shortNames override
  if (config.shortNames[projectName] !== undefined) {
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

interface RawSession {
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
 * Scan all JSONL sessions in projectsDir.
 * @param now - injectable timestamp for testing; defaults to Date.now()
 */
export async function scanSessions(
  projectsDir: string,
  config: Config,
  log: (msg: string) => void,
  now?: number,
): Promise<SessionResult> {
  const currentTime = now ?? Date.now();

  const rawSessions: RawSession[] = [];

  // Discover all *.jsonl files
  let projectDirs: string[];
  try {
    projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch (e) {
    log(`[warn] Cannot read projects dir: ${e}`);
    return { sessions: [] };
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

  // Supersession: find newest mtime per projectPath
  const newestMtime = new Map<string, number>();
  for (const s of rawSessions) {
    const prev = newestMtime.get(s.projectPath) ?? 0;
    if (s.mtime.getTime() > prev) { newestMtime.set(s.projectPath, s.mtime.getTime()); }
  }

  // Build sessions[] (non-idle, non-superseded)
  const sessions: SessionInfo[] = [];
  for (const s of rawSessions) {
    if (!s.active) { continue; }
    if (s.mtime.getTime() < (newestMtime.get(s.projectPath) ?? 0)) { continue; }

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
    });
  }

  return { sessions };
}
