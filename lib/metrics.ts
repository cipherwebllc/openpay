import 'server-only';

// 運営向けの月次イベントカウンタ (計測レイヤー裁定 2026-08-08 ②)。
// server が観測できる決済系イベントを `metrics:<YYYY-MM>:<kind>` に INCR するだけの
// 最小実装 — ダッシュボードも管理 API も作らず、読み出しは運営スクリプト
// (scripts/metrics-report.mjs) が KV を直接読む。
// ⚠️ これは「server が観測できた範囲」のヒント: standard 決済 (お客様 gas 負担の
// 直接送金) は server を経由しないため含まれない。完全な決済回数はオンチェーンが真実。
// 記録は no-throw (掟 13: 計測障害を決済応答へ波及させない)。

import { after } from 'next/server';
import { kvIncr } from '@/lib/kv';
import { logger } from '@/lib/logger';

export const METRIC_KINDS = [
  // gasless/relay JPYC 決済の中継成功 (決済 QR・レジ・モバイル注文・チップを含む。
  // 利用料支払い tx は除外して配線する)
  'relay_jpyc',
  // x402 facilitator settle 成功 (AI ストア/有料 API)
  'x402_settle',
  // モバイル注文の受注保存成功 (オンチェーン検証済みの注文)
  'order',
  // hosted デジタル商品の購入確定 (finalize 初回のみ)
  'store_purchase',
] as const;

export type MetricKind = (typeof METRIC_KINDS)[number];

/** UTC 月バケット (例 '2026-08')。日本の月次と最大 9 時間ずれるが運営ヒントには十分。 */
export function currentMetricMonth(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 7);
}

export function monthlyMetricKey(kind: MetricKind, month: string): string {
  return `metrics:${month}:${kind}`;
}

/**
 * 応答返却後に計上を予約する (掟 12: post-response は after())。
 * リクエストスコープ外 (テスト等) では after() が throw するため直接実行に落とす —
 * どちらの経路でも計測が決済応答を巻き込まない。
 */
export function recordMetricAfterResponse(kind: MetricKind): void {
  try {
    after(() => recordMetric(kind));
  } catch {
    void recordMetric(kind);
  }
}

/** イベント 1 件を計上する。失敗しても throw しない (付帯処理の隔離)。 */
export async function recordMetric(kind: MetricKind): Promise<void> {
  try {
    const result = await kvIncr(monthlyMetricKey(kind, currentMetricMonth()));
    if (!result.ok) {
      logger.warn('metrics.record_failed', { kind });
    }
  } catch {
    logger.warn('metrics.record_failed', { kind });
  }
}
