// src/types.ts

export interface TokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /**
   * Context-window occupancy: input + cacheRead + cacheWrite. Output tokens are
   * excluded, matching how Claude Code computes its own context percentage.
   */
  total: number;
  /** Portion of cacheWrite written with the 1-hour TTL (billed at 2x input). Absent = all 5-minute. */
  cacheWrite1h?: number;
  /** True when the turn ran in fast mode (`usage.speed === "fast"`), billed at 2x standard rates. */
  fast?: boolean;
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
  filePath: string;     // absolute path to the JSONL transcript file
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
  dailyBudget: number;
  showUsage: boolean;
  usageWarningThreshold: number;
  usageDangerThreshold: number;
  usageStaleMinutes: number;
  usageLiveFetch: boolean;
  usageRefreshInterval: number;
}

export interface SessionResult {
  sessions: SessionInfo[];
}
