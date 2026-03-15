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
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
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
    if (tokens.total === 0) { continue; } // skip zero-usage sentinel lines

    const model = typeof msg['model'] === 'string' ? msg['model'] : '';
    return { tokens, model };
  }
  return null;
}

/** Read a file and return its lines. Returns [] on read error. */
export function readFileLines(filePath: string): string[] {
  try {
    return fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
  } catch {
    return [];
  }
}
