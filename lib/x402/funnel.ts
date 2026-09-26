import 'server-only';

// vanilla USDC x402 (Base / Arc) の購入ファネル日次カウンタ (外部レビュー裁定 2026-09-17 P1)。
// 「Arc を増やすべきか・商品が悪いのか・支払いのどの段階で落ちるのか」を勘でなく判断するための最小計測。
//
//   key   = x402:funnel:<YYYY-MM-DD> (UTC・1 日 1 ハッシュ・TTL 180 日)
//   field = <stage>|<rail>|<resource の pathname>
//
// リクエストごとの行は残さない (検索クローラの巡回で 402 は大量に出る)。誰が・何を・いくらで買ったかは
// settle 台帳 (lib/x402/settleLedger.ts) が持つ — こちらは「成立しなかった側」の段階別件数だけを補う。
// 記録は応答返却後・no-throw (掟 12/13: 計測障害を決済応答へ波及させない)。KV は money truth ではない。

import { after } from 'next/server';
import { kvEval } from '@/lib/kv';
import { logger } from '@/lib/logger';

export const FUNNEL_STAGES = [
  /** 支払いヘッダ無しの 402 (発見・巡回を含む) */
  'challenge',
  /** 支払いヘッダはあるが形/accepted が合わない */
  'invalid_payload',
  /** facilitator の verify が isValid:false */
  'verify_failed',
  /** 同じ authorization の別 resource 再利用 (409) */
  'conflict',
  /** content が 4xx/5xx (settle しない = 課金なし) */
  'content_error',
  /** facilitator の settle が success:false */
  'settle_failed',
  /** facilitator 障害 (verify/settle の 5xx・timeout → 503) */
  'facilitator_unavailable',
  /** settle 成立 (200 + 商品) */
  'settled',
] as const;

export type FunnelStage = (typeof FUNNEL_STAGES)[number];
/** 'none' = 支払い前で rail が未確定 (challenge / invalid_payload)。 */
export type FunnelRail = 'none' | 'base' | 'arc-gateway';

export const FUNNEL_TTL_SEC = 180 * 24 * 60 * 60;

export function funnelDay(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function funnelKey(day: string): string {
  return `x402:funnel:${day}`;
}

/** resource URL → pathname (query を落として field の種類を有界に保つ)。URL でなければそのまま切り詰める。 */
export function funnelResourcePath(resourceUrl: string): string {
  try {
    return new URL(resourceUrl).pathname.slice(0, 120);
  } catch {
    return resourceUrl.slice(0, 120);
  }
}

export function funnelField(stage: FunnelStage, rail: FunnelRail, resourceUrl: string): string {
  return `${stage}|${rail}|${funnelResourcePath(resourceUrl)}`;
}

// HINCRBY と初回 TTL を 1 EVAL に閉じる (TTL 欠落でハッシュが永久残存する波及を断つ)。
// ⚠️ 補間なしの単一リテラルで書く — minifier が `+` 連結中のテンプレートを壊した実害あり (check-lua-bundle.mjs)。
const FUNNEL_HINCR =
  "local n = redis.call('HINCRBY', KEYS[1], ARGV[1], tonumber(ARGV[3])) if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end return n";

// KV コマンド予算 (Upstash 無料枠・2026-09-26): 1 件の計上は Lua 込みで 3〜4 コマンド。支払い前の 402
// (challenge) は検索クローラの巡回で大量に出るため、10 件に 1 件だけ記録して 10 を足す (期待値は同じ・
// 表示は 10 単位の概数)。支払いを試みた後の段階 (verify 以降) は件数が少なく判断に使うので全件記録する。
export const FUNNEL_CHALLENGE_SAMPLE_RATE = 10;

/** 1 件を計上する。失敗しても throw しない (付帯処理の隔離)。 */
export async function recordFunnel(
  stage: FunnelStage,
  rail: FunnelRail,
  resourceUrl: string,
  random: () => number = Math.random,
): Promise<void> {
  try {
    const sampled = stage === 'challenge';
    if (sampled && random() * FUNNEL_CHALLENGE_SAMPLE_RATE >= 1) return;
    const result = await kvEval<number>(FUNNEL_HINCR, [funnelKey(funnelDay())], [
      funnelField(stage, rail, resourceUrl),
      String(FUNNEL_TTL_SEC),
      String(sampled ? FUNNEL_CHALLENGE_SAMPLE_RATE : 1),
    ]);
    // KV 未構成は既定の開発環境で常に起きるので黙る。構成済みでの失敗だけ warn。
    if (!result.ok && result.reason !== 'unconfigured') {
      logger.warn('x402.funnel.record_failed', { stage, rail });
    }
  } catch {
    logger.warn('x402.funnel.record_failed', { stage, rail });
  }
}

/**
 * 応答返却後に計上を予約する (掟 12: post-response は after())。
 * リクエストスコープ外 (テスト等) では after() が throw するため直接実行に落とす。
 */
export function recordFunnelAfterResponse(stage: FunnelStage, rail: FunnelRail, resourceUrl: string): void {
  try {
    after(() => recordFunnel(stage, rail, resourceUrl));
  } catch {
    void recordFunnel(stage, rail, resourceUrl);
  }
}
