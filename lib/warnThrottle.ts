// 同じ名前の警告を、この関数の instance の中で 60 秒に 1 回までにする。
//
// 何の波及を断つための防御か (掟 13): KV で数える IP ごとの制限を置かない公開の GET (/api/discovery/[id]・
// /api/x402/relay/requirements) では、失敗 (掲載の読み取りの失敗・JPYC / USDC の要件を作れない設定の不正) が
// 続くあいだ、logger.warn が request の数だけ Sentry の event になる (lib/logger.ts)。それを instance ごとに
// 60 秒に 1 回へ断つ。
// 最初の 1 回は必ず出す (失敗に気づけなくしない)。抑えた回の fields は捨てる (何が壊れたかは最初の 1 回で分かる)。
// 抑えるのは log だけで、呼ぶ側の応答は変えない。
//
// key は下の型に並べた固定の名前だけ (request から来る値を key にしない = Map が育たない)。
import { logger } from '@/lib/logger';

export type ThrottledWarnEvent =
  | 'x402.discovery.read_failed'
  | 'x402.discovery.requirements_failed'
  | 'x402.dualrail.accepts_failed';

export const WARN_THROTTLE_INTERVAL_MS = 60_000;

// 名前ごとの、最後に「出した」時刻 (抑えた回では進めない = 失敗が続いても 60 秒ごとに出る)。
const lastWarnedAt = new Map<ThrottledWarnEvent, number>();

export function warnThrottled(event: ThrottledWarnEvent, fields?: Record<string, unknown>): void {
  const now = Date.now();
  const last = lastWarnedAt.get(event);
  if (last !== undefined && now - last < WARN_THROTTLE_INTERVAL_MS) return;
  lastWarnedAt.set(event, now);
  logger.warn(event, fields);
}

// test 用: module 単位の記録を消す。
export function __resetWarnThrottleForTest(): void {
  lastWarnedAt.clear();
}
