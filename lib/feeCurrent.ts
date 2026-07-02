// OpenPay 利用料 (a1) の「支払い済み状態」を店主 wallet 別に持つ (server 専用・KV TTL)。
// 利用権 tier (basic/pro・退役済) とは **別系統** (残る alpha-bypass フラグは lib/alphaBypass.ts)。月次利用料を払うと fee-current が
// 延長され、relay 関所ゲート (S5) が「current な店主だけガスレス中継する」判定材料にする。
// 設計: docs/plans/merchant-gasless-fee-a1.md (S3)。
//
// bypass: アルファ全開放 (alphaBypass と同じ ALPHA_ENTITLEMENT_BYPASS スイッチ) 中は常に current
// = 徴収しない。点灯は flag ON + ALPHA_ENTITLEMENT_BYPASS=0。
// 値 = JSON {expiresAt, lastPaidPeriod?, lastTxHash?}・KV TTL で自然失効。

import { type Address } from 'viem';
import { kvGet, kvSet } from './kv';
import { entitlementBypass } from './alphaBypass';
import { logger } from './logger';

export type FeeStatus = {
  current: boolean;
  expiresAt: number | null;
  lastPaidPeriod: string | null;
  bypass: boolean;
};

type StoredFee = {
  expiresAt: number;
  lastPaidPeriod?: string;
  lastTxHash?: string;
};

function feeKey(wallet: string): string {
  return `fee:current:${wallet.toLowerCase()}`;
}

function parseStored(raw: string): StoredFee | null {
  try {
    const o = JSON.parse(raw.trim()) as {
      expiresAt?: unknown;
      lastPaidPeriod?: unknown;
      lastTxHash?: unknown;
    };
    const expiresAt = Number(o.expiresAt);
    if (!Number.isFinite(expiresAt)) return null;
    return {
      expiresAt,
      lastPaidPeriod:
        typeof o.lastPaidPeriod === 'string' ? o.lastPaidPeriod : undefined,
      lastTxHash: typeof o.lastTxHash === 'string' ? o.lastTxHash : undefined,
    };
  } catch {
    return null;
  }
}

export async function getFeeStatus(
  wallet: string,
  nowMs: number = Date.now(),
): Promise<FeeStatus> {
  if (entitlementBypass()) {
    return {
      current: true,
      expiresAt: null,
      lastPaidPeriod: null,
      bypass: true,
    };
  }
  const res = await kvGet(feeKey(wallet));
  if (!res.ok || !res.value) {
    return {
      current: false,
      expiresAt: null,
      lastPaidPeriod: null,
      bypass: false,
    };
  }
  const stored = parseStored(res.value);
  if (!stored) {
    return {
      current: false,
      expiresAt: null,
      lastPaidPeriod: null,
      bypass: false,
    };
  }
  return {
    current: stored.expiresAt > nowMs,
    expiresAt: stored.expiresAt,
    lastPaidPeriod: stored.lastPaidPeriod ?? null,
    bypass: false,
  };
}

export async function isFeeCurrent(
  wallet: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  return (await getFeeStatus(wallet, nowMs)).current;
}

// 支払い確定時に呼ぶ (S4)。current を max(既存, expiresAt) に延長し、lastPaidPeriod/txHash を記録。
// expiresAt は period 基準の決定的満了 (lib/feeGate.feeCoverageThrough)。決定的値なので同一支払いの
// 再付与でも max-merge が no-op となり、二重延長 (settle promote 失敗→replay) を防ぐ。
// `ok` は KV 書込成功 (false=未永続化→呼出側で付与失敗扱い)。応答ロス時は読み戻して意図充足を確認する。
export async function grantFeeCurrent(
  wallet: string,
  opts: { expiresAt: number; period?: string; txHash?: string },
  nowMs: number = Date.now(),
): Promise<{ ok: boolean; expiresAt: number }> {
  const fresh = opts.expiresAt;
  let outExpiry = fresh;

  const cur = await kvGet(feeKey(wallet));
  if (cur.ok && cur.value) {
    const stored = parseStored(cur.value);
    if (stored && stored.expiresAt > nowMs) {
      outExpiry = Math.max(stored.expiresAt, fresh);
    }
  }

  const ttlSec = Math.max(1, Math.ceil((outExpiry - nowMs) / 1000));
  const payload = JSON.stringify({
    expiresAt: outExpiry,
    ...(opts.period ? { lastPaidPeriod: opts.period } : {}),
    ...(opts.txHash ? { lastTxHash: opts.txHash } : {}),
  });
  const write = await kvSet(feeKey(wallet), payload, { ttlSec });
  if (write.ok) return { ok: true, expiresAt: outExpiry };

  const readback = await kvGet(feeKey(wallet));
  let persisted = false;
  if (readback.ok && readback.value) {
    const stored = parseStored(readback.value);
    persisted = stored !== null && stored.expiresAt >= outExpiry;
  }
  return { ok: persisted, expiresAt: outExpiry };
}

// --- 期間別「支払い済み」マーカー (古い未収を清算したことを期間粒度で記録する) ---
//
// fee-current (上の expiresAt) は「現行カバレッジ」を表すため、古い期間 (例 4 か月前) を後から
// 清算しても expiresAt は過去なので current にはならない (= 関所ゲートは現行カバレッジで通す)。
// しかしゲートは「lookback 内に未払いの請求期間が残っているか」も見るため、どの期間を清算したかを
// 期間粒度で覚える必要がある。それがこのマーカー。fee-current とは別キーで持つ。
//
// TTL は関所ゲートの lookback (12 か月) を余裕で超える 800 日に置く。マーカーがゲートの lookback
// より先に失効すると「払ったのに未払い扱い」で再遮断されるため、lookback を確実に上回る寿命にする。
export const PAID_MARKER_TTL_SEC = 800 * 86_400;

function paidKey(merchant: string, period: string): string {
  return `billing:paid:${merchant.toLowerCase()}:${period}`;
}

// 期間 period を清算したマーカーを記録する (値 = 清算 tx の txHash・監査用)。settle が grant 後に呼ぶ。
// `ok` は KV 書込成功 (false=未永続化→呼出側で清算失敗扱い・同 txHash で再試行可能)。
export async function markPeriodPaid(
  merchant: Address,
  period: string,
  txHash: string,
): Promise<{ ok: boolean }> {
  const write = await kvSet(paidKey(merchant, period), txHash, {
    ttlSec: PAID_MARKER_TTL_SEC,
  });
  return { ok: write.ok };
}

// periods のうち「支払い済みマーカーが無い」= 未払いの期間だけを返す。
// マーカー読み取り失敗は **支払い済み扱い (fail-open)** とする: 本モジュールは「KV 不調で決済を
// 壊さない」方針 (= 過剰遮断しない) を貫くため、読めない期間を未払いと断じて relay を止めない。
// マーカー無し (= 読めて null) のみ未払いと判定する。
export async function getUnpaidPeriods(
  merchant: Address,
  periods: string[],
): Promise<string[]> {
  const results = await Promise.all(
    periods.map(async (period) => {
      const res = await kvGet(paidKey(merchant, period));
      if (!res.ok) {
        logger.warn('billing.paid_marker.read_failed', {
          period,
          reason: res.reason,
        });
        return null; // fail-open: 読めない期間は未払い扱いにしない
      }
      return res.value === null || res.value === '' ? period : null;
    }),
  );
  return results.filter((p): p is string => p !== null);
}
