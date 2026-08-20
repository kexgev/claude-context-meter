// src/spendSummary.ts
import { Config } from './types';
import { walkRawSessions } from './sessionManager';
import { calcCost } from './statusBar';

export interface SpendEntry {
  projectName: string;
  model: string;
  cost: number;
  mtime: Date;
}

/**
 * Cost per session is derived from that session's latest usage snapshot —
 * the same approximation the status bar already shows per session (current
 * context composition, not a sum of every historical API call). Consistent
 * methodology, not exact billing.
 */
export function scanAllSessionsForSpend(
  projectsDir: string,
  config: Pick<Config, 'idleTimeout' | 'contextLimit'>,
  log: (msg: string) => void,
): SpendEntry[] {
  return walkRawSessions(projectsDir, config, log)
    .map(s => ({
      projectName: s.projectName,
      model: s.model,
      cost: calcCost(s.tokens, s.model),
      mtime: s.mtime,
    }))
    .filter(e => e.cost > 0);
}

export type SpendRange = 'today' | 'week' | 'all';

function startOf(range: SpendRange): number {
  if (range === 'all') { return 0; }
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  if (range === 'week') { now.setDate(now.getDate() - now.getDay()); }
  return now.getTime();
}

export function filterByRange(entries: SpendEntry[], range: SpendRange): SpendEntry[] {
  const since = startOf(range);
  return entries.filter(e => e.mtime.getTime() >= since);
}

export interface SpendTotals {
  total: number;
  byProject: Array<{ projectName: string; cost: number }>;
}

export function summarize(entries: SpendEntry[]): SpendTotals {
  const byProjectMap = new Map<string, number>();
  let total = 0;
  for (const e of entries) {
    total += e.cost;
    byProjectMap.set(e.projectName, (byProjectMap.get(e.projectName) ?? 0) + e.cost);
  }
  const byProject = [...byProjectMap.entries()]
    .map(([projectName, cost]) => ({ projectName, cost }))
    .sort((a, b) => b.cost - a.cost);
  return { total, byProject };
}
