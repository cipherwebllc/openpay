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
export function fetchStats(input: { email: string; apiKey: string; dbId: string; fetchImpl?: FetchLike; timeoutMs?: number }): Promise<Record<string, unknown>>;
export function dailySeries(stats: unknown): { date: number; count: number }[];
export type CommandBreakdown = { rows: { command: string; last: number; first: number; sum: number }[]; totalLast: number; from: number | null; to: number | null; points: number };
export function commandBreakdown(stats: unknown): CommandBreakdown | null;
export function minuteDeltas(stats: unknown): { minute: number; total: number; commands: Record<string, number> }[];
export type Projection = { monthTotal: number; avgDaily: number | null; projected: number | null; basis: string };
export function projectMonth(stats: unknown, nowMs: number): Projection;
export type Assessment = { level: 'ok' | 'warn' | 'over' | 'unknown'; trigger: 'commands' | 'billing' | null };
export function assess(input: { projected: number | null; billing: number | null }, capCommands: number): Assessment;
export function watch(deps?: { env?: Record<string, string | undefined>; fetchImpl?: FetchLike; now?: number; log?: (line: string) => void }): Promise<Assessment & { projection: Projection; billing: number | null; cap: number }>;
export function probe(deps?: { env?: Record<string, string | undefined>; fetchImpl?: FetchLike; now?: () => number; sleep?: (ms: number) => Promise<void>; log?: (line: string) => void; calls?: number; gapMs?: number; waitMs?: number }): Promise<{ verdict: 'counted' | 'not_counted' | 'inconclusive'; controlDelta: number | null; probeDelta: number | null }>;
export function main(argv?: string[], deps?: Record<string, unknown>): Promise<number>;
