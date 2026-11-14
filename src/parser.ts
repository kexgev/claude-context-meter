// src/parser.ts
import * as fs from 'fs';
import { TokenBreakdown } from './types';

// ── Path decoding ─────────────────────────────────────────────────────────

/**
 * Decode an encoded Claude project directory name to an absolute path.
 *   "C--dev-project" → "C:\dev\project"
 *   "-Users-name-work"  → "/Users/name/work"
 * Note: hyphens in directory names and path separators encode identically,
 * so this decoding is best-effort for display purposes.
 */
export function decodePath(encodedDirName: string): string {
  const segments = encodedDirName.split('-').filter(s => s !== '');

  // Windows: first segment is exactly one uppercase letter (drive letter)
  if (segments.length > 0 && /^[A-Z]$/.test(segments[0])) {
    return segments[0] + ':\\' + segments.slice(1).join('\\');
  }

  // Unix: encoded name starts with '-' → absolute path from root
  if (encodedDirName.startsWith('-')) {
    return '/' + segments.join('/');
  }

  return encodedDirName;
}

/** Return the last path segment (the project folder name). */
export function getProjectName(projectPath: string): string {
  const parts = projectPath.split(/[/\\]/);
  return parts[parts.length - 1] || projectPath;
}

// ── Token parsing helpers ─────────────────────────────────────────────────

function parseBreakdown(usage: Record<string, unknown>): TokenBreakdown {
  const n = (key: string): number => {
    const v = usage[key];
    return typeof v === 'number' ? v : 0;
  };
  const input = n('input_tokens');
  const output = n('output_tokens');
  const cacheRead = n('cache_read_input_tokens');
  const cacheWrite = n('cache_creation_input_tokens');
  const breakdown: TokenBreakdown = { input, output, cacheRead, cacheWrite, total: input + cacheRead + cacheWrite };

  // Claude Code writes its prompt cache with the 1-hour TTL, which bills at 2x
  // input rather than the 5-minute 1.25x. The split lives in `cache_creation`.
  const creation = usage['cache_creation'];
  if (creation && typeof creation === 'object') {
    const oneHour = (creation as Record<string, unknown>)['ephemeral_1h_input_tokens'];
    if (typeof oneHour === 'number' && oneHour > 0) {
      breakdown.cacheWrite1h = Math.min(oneHour, cacheWrite);
    }
  }
  if (usage['speed'] === 'fast') { breakdown.fast = true; }
  return breakdown;
}

// ── Public API ────────────────────────────────────────────────────────────

export interface ParsedLatest {
  tokens: TokenBreakdown;
  model: string;
}

/**
 * Reverse-scan lines to find the most recent assistant message with token usage.
 * Returns null if no valid usage is found.
 */
export function parseLatestTokenUsage(lines: string[]): ParsedLatest | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i].trim();
    if (!raw) { continue; }
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(raw) as Record<string, unknown>; } catch { continue; }

    if (obj['type'] !== 'assistant') { continue; }
    const msg = obj['message'] as Record<string, unknown> | undefined;
    if (!msg) { continue; }
    const usage = msg['usage'] as Record<string, unknown> | undefined;
    if (!usage) { continue; }

    const tokens = parseBreakdown(usage);
    if (tokens.total === 0 && tokens.output === 0) { continue; } // skip zero-usage sentinel lines

    const model = typeof msg['model'] === 'string' ? msg['model'] : '';
    return { tokens, model };
  }
  return null;
}

/**
 * Read the tail of a file and return its lines. Returns [] on read error.
 * Only the last TAIL_BYTES are read — the parser scans from the end anyway,
 * and this prevents large JSONL files from blocking the extension host.
 */
const TAIL_BYTES = 512 * 1024; // 512 KB

export function readFileLines(filePath: string): string[] {
  try {
    const stat = fs.statSync(filePath);
    const size = stat.size;
    if (size === 0) { return []; }
    const readSize = Math.min(TAIL_BYTES, size);
    const buf = Buffer.alloc(readSize);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, buf, 0, readSize, Math.max(0, size - readSize));
    } finally {
      fs.closeSync(fd);
    }
    return buf.toString('utf-8').split(/\r?\n/);
  } catch {
    return [];
  }
}
