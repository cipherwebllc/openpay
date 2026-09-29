// TypeScript 型宣言 — テストから import するとき用。実装は scripts/upstash-usage-watch.mjs。
export const STATS_BASE_URL: string;
export const DOLLARS_PER_COMMAND: number;
export const DEFAULT_CAP_COMMANDS: number;
export const WARN_RATIO: number;
export class WatchError extends Error {
  code: string;
  constructor(code: string);
}
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export function fetchStats(input: { email: string; apiKey: string; dbId: string; fetchImpl?: FetchLike }): Promise<Record<string, unknown>>;
export function dailySeries(stats: unknown): { date: number; count: number }[];
export function projectMonth(stats: unknown, nowMs: number): { monthTotal: number; avgDaily: number; projected: number; basis: string };
export function assess(input: { projected: number; billing: number }, capCommands: number): 'ok' | 'warn' | 'over';
export function watch(deps?: { env?: Record<string, string | undefined>; fetchImpl?: FetchLike; now?: number; log?: (line: string) => void }): Promise<{ level: 'ok' | 'warn' | 'over'; projection: { monthTotal: number; avgDaily: number; projected: number; basis: string }; billing: number; cap: number }>;
export function probe(deps?: { env?: Record<string, string | undefined>; fetchImpl?: FetchLike; now?: () => number; sleep?: (ms: number) => Promise<void>; log?: (line: string) => void; calls?: number; waitMs?: number }): Promise<{ counted: boolean; delta: number; background: number; billingDelta: number }>;
export function main(argv?: string[], deps?: Record<string, unknown>): Promise<number>;
