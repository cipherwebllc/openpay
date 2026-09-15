import 'server-only';

// x402 settle 台帳 (運営向け・1 settle = 1 行)。計測レイヤーの月次カウンタ (lib/metrics) は
// 「何件」しか分からず、外部購入の分析 (2026-09-15) では on-chain の着金先が全 first-party 商品で
// 同一のため「誰が・どの商品を・いくらで」を確定できなかった。その穴を埋める最小の記録:
//   x402:settle:ledger:<YYYY-MM> → LPUSH JSON (月ごとに最大 SETTLE_LEDGER_MAX 行・TTL 400 日)
// 読み出しは運営スクリプト (scripts/settle-ledger-report.mjs) が KV を直接読む。管理 API は作らない。
//
// 掟 12/13: money-path には触れず、応答返却後 (after()) に no-throw で追記するだけ。記録の失敗は
// 決済応答へ波及させない。settle の真実はオンチェーンと facilitator の応答であり、この台帳は
// あくまで運営ヒント (欠損しうる)。

import { after } from 'next/server';
import { kvLpush } from '@/lib/kv';
import { logger } from '@/lib/logger';

export const SETTLE_LEDGER_MAX = 5000;
const SETTLE_LEDGER_TTL_SEC = 400 * 24 * 60 * 60;

export type SettleLedgerSource =
  /** first-party USDC 商品 (標準 x402・CDP facilitator・lib/x402/vanillaGate) */
  | 'usdc-vanilla'
  /** 第三者出品の USDC 面 (dual-rail リレー・lib/x402/dualRailRelay) */
  | 'usdc-dual-rail'
  /** JPYC facilitator settle (app/api/facilitator/settle・first-party と第三者の両方) */
  | 'jpyc-facilitator';

export type SettleLedgerEntry = {
  /** ISO 8601 (UTC)。 */
  at: string;
  source: SettleLedgerSource;
  network: string;
  /** 商品の URL (first-party は絶対 URL・第三者は登録 URL)。 */
  resource: string;
  /** 買い手 (facilitator 応答の payer)。取れなければ null。 */
  payer: string | null;
  payTo: string;
  /** 表示単位の金額 (USDC は 6 桁・JPYC は 18 桁から変換済み)。 */
  amount: string;
  asset: 'USDC' | 'JPYC';
  /** JPYC facilitator の利用料 (表示単位)。USDC 面には無い。 */
  fee?: string;
  tx: string | null;
};

/** UTC 月バケット (lib/metrics と同じ切り方)。 */
export function settleLedgerMonth(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 7);
}

export function settleLedgerKey(month: string): string {
  return `x402:settle:ledger:${month}`;
}

/** atomic 整数文字列 → 表示単位 (末尾ゼロ落とし)。float を経由しない。 */
export function atomicToHuman(atomic: string, decimals: number): string {
  if (!/^[0-9]+$/.test(atomic)) return atomic;
  const padded = atomic.padStart(decimals + 1, '0');
  const int = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}

/** 1 行を追記する。失敗しても throw しない (付帯処理の隔離)。 */
export async function recordSettleLedger(entry: SettleLedgerEntry): Promise<void> {
  try {
    const result = await kvLpush(settleLedgerKey(settleLedgerMonth()), JSON.stringify(entry), {
      trimStart: 0,
      trimStop: SETTLE_LEDGER_MAX - 1,
      ttlSec: SETTLE_LEDGER_TTL_SEC,
    });
    if (!result.ok) {
      logger.warn('x402.settle_ledger.record_failed', { source: entry.source });
    }
  } catch {
    logger.warn('x402.settle_ledger.record_failed', { source: entry.source });
  }
}

/**
 * 応答返却後に追記を予約する (掟 12: post-response は after())。
 * リクエストスコープ外 (テスト等) では after() が throw するため直接実行に落とす。
 */
export function recordSettleLedgerAfterResponse(entry: SettleLedgerEntry): void {
  try {
    after(() => recordSettleLedger(entry));
  } catch {
    void recordSettleLedger(entry);
  }
}
