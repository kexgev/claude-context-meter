// src/types.ts

export interface TokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number; // input + output + cacheRead + cacheWrite
}

export interface SessionInfo {
  id: string;           // JSONL file basename without extension
  projectPath: string;  // decoded absolute path, e.g. C:\dev\my-project
  projectName: string;  // last segment of projectPath
  emoji: string;
  color: string;        // pastel hex e.g. "#BAE1FF", or "" if autoColor=false
  model: string;        // raw model string from JSONL
  tokenLimit: number;   // from detectTokenLimit()
  tokens: TokenBreakdown;
  pct: number;          // Math.round(total / limit * 1000) / 10
  lastUpdate: Date;     // fs.stat mtime
  active: boolean;      // (now - mtime) / 1000 < idleTimeout
}

export interface Config {
  contextLimit: number;
  idleTimeout: number;
  warningThreshold: number;
  dangerThreshold: number;
  compactMode: boolean;
  showEmoji: boolean;
  autoColor: boolean;
  shortNames: Record<string, string>;
}

export interface SessionResult {
  sessions: SessionInfo[];
}
