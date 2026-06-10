// OpenPay 利用料 (a1) の **収益台帳** (運営=OpenPay 自社の入金記録) + 期間照合。
// settle 成功時に支払いを1回追記し、admin (/admin/billing) が収益確認・freee 用 CSV・支払い照合に使う。
// 真実は on-chain (txHash) + fee-current 状態。本台帳は**レポート用インデックス**で、欠落しても課金/決済は
// 壊さない (undercount=安全側)。server 専用 (KV)。設計: docs/plans/admin-billing-revenue.md。

import type { Address } from 'viem';
import { kvLpush, kvLrange, kvLtrim, kvSet, isKvConfigured } from './kv';
import { logger } from './logger';
import {
  meterPeriod,
  getMeteredMerchants,
  loadUsageInvoice,
} from './billingMeter';

const REVENUE_KEY = 'billing:revenue';
// 入金は店主×月 1 件程度の低頻度なので 1 万件で数年分。超過時は古い側を捨て log で開示。
// 真実は on-chain なので台帳上限は安全 (admin は定期 export 推奨)。
const MAX_REVENUE_EVENTS = 10_000;
// txHash 単位の記録済みマーカー TTL。settle の結果 TTL (SETTLE_RESULT_TTL_SEC=400日) と揃える:
// settle 側で同 txHash が replay 扱いになる期間とこの台帳冪等が同じ寿命を持つことで、
// 「promote 失敗 → ロック失効 → 同 txHash 再提出」が起きてもマーカーがまだ生きていて二重計上を防ぐ。
const REVENUE_RECORDED_TTL_SEC = 400 * 86_400;

export type FeeRevenueEvent = {
  m: string; // merchant (lowercase)
  p: string; // 対象期間 (billed period) 'YYYY-MM'
  v: string; // feeWei (decimal 文字列)
  c: number; // chainId
  t: number; // 入金時刻 (unix ms)
  h: string; // txHash
};

// settle 成功時に **1 回だけ** 呼ぶ。失敗しても確定済みの決済を壊さない (try/catch・undercount=honest)。
export async function recordFeeRevenue(input: {
  merchant: Address;
  period: string;
  feeWei: bigint;
  chainId: number;
  txHash: string;
  paidAtMs: number;
}): Promise<void> {
  try {
    if (!isKvConfigured()) return;
    // txHash 単位の NX 冪等マーカーを LPUSH の前に立てる。settle 側 (route) の promote (ロック→
    // 結果昇格) が失敗するとロックが短命のまま失効し、同 txHash 再提出が claim を取り直して
    // verify/grant (冪等) を経て本関数を再実行しうる。LPUSH 自体は無防備なので、ここで二重計上を断つ。
    // マーカー先行の理由: 「マーカー成功 → LPUSH 失敗」は台帳の **欠落** (undercount=本モジュール
    // の文書化済み安全側) に倒れる。逆順 (LPUSH 先) だと LPUSH 後・マーカー前の crash で二重計上が復活する。
    const markerKey = `billing:revenue:recorded:${input.chainId}:${input.txHash.toLowerCase()}`;
    const marker = await kvSet(markerKey, '1', {
      nx: true,
      ttlSec: REVENUE_RECORDED_TTL_SEC,
    });
    if (!marker.ok) {
      // KV 不調。台帳欠落は決済を壊さない (undercount=安全側) ので LPUSH せず諦める。
      logger.warn('billing.revenue.marker_failed', { reason: marker.reason });
      return;
    }
    if (marker.value !== 'OK') {
      // 記録済み (promote 失敗後の再提出 replay 等)。二重計上しない。
      logger.info('billing.revenue.duplicate_skip', {
        chainId: input.chainId,
        txHash: input.txHash,
      });
      return;
    }
    const event: FeeRevenueEvent = {
      m: input.merchant.toLowerCase(),
      p: input.period,
      v: input.feeWei.toString(),
      c: input.chainId,
      t: input.paidAtMs,
      h: input.txHash,
    };
    const r = await kvLpush(REVENUE_KEY, JSON.stringify(event));
    if (!r.ok) {
      logger.warn('billing.revenue.lpush_failed', { reason: r.reason });
      return;
    }
    if (r.value > MAX_REVENUE_EVENTS) {
      logger.warn('billing.revenue.capped', {
        length: r.value,
        cap: MAX_REVENUE_EVENTS,
      });
      await kvLtrim(REVENUE_KEY, 0, MAX_REVENUE_EVENTS - 1);
    }
  } catch (e) {
    logger.warn('billing.revenue.record_failed', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function parseEvent(s: string): FeeRevenueEvent | null {
  try {
    const o = JSON.parse(s) as FeeRevenueEvent;
    if (
      o &&
      typeof o.m === 'string' &&
      typeof o.p === 'string' &&
      typeof o.v === 'string' &&
      /^[0-9]+$/.test(o.v) &&
      typeof o.c === 'number' &&
      typeof o.t === 'number' &&
      typeof o.h === 'string'
    ) {
      return o;
    }
  } catch {
    // malformed は除外
  }
  return null;
}

// 入金イベント全件 (新しい順=LPUSH 先頭)。壊れた entry は skip し件数を開示。
export async function getFeeRevenueEvents(): Promise<FeeRevenueEvent[]> {
  if (!isKvConfigured()) return [];
  const r = await kvLrange(REVENUE_KEY, 0, -1);
  if (!r.ok) return [];
  const out: FeeRevenueEvent[] = [];
  for (const s of r.value) {
    const e = parseEvent(s);
    if (e) out.push(e);
  }
  const dropped = r.value.length - out.length;
  if (dropped > 0) {
    logger.warn('billing.revenue.dropped_entries', {
      dropped,
      total: r.value.length,
    });
  }
  return out;
}

export type RevenueSummary = {
  totalWei: bigint;
  count: number;
  byBilledPeriod: Array<{ period: string; count: number; feeWei: bigint }>;
  byPaymentMonth: Array<{ month: string; count: number; feeWei: bigint }>;
};

// 純: 入金イベント → 合計 + 対象期間別 + 入金月別 (入金日基準)。降順 (新しい期間/月が上)。
export function summarizeRevenue(events: FeeRevenueEvent[]): RevenueSummary {
  let totalWei = 0n;
  const billed = new Map<string, { count: number; feeWei: bigint }>();
  const paidMonth = new Map<string, { count: number; feeWei: bigint }>();
  for (const e of events) {
    const wei = BigInt(e.v);
    totalWei += wei;
    const b = billed.get(e.p) ?? { count: 0, feeWei: 0n };
    b.count += 1;
    b.feeWei += wei;
    billed.set(e.p, b);
    const pm = meterPeriod(e.t);
    const m = paidMonth.get(pm) ?? { count: 0, feeWei: 0n };
    m.count += 1;
    m.feeWei += wei;
    paidMonth.set(pm, m);
  }
  const desc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);
  return {
    totalWei,
    count: events.length,
    byBilledPeriod: [...billed.entries()]
      .sort((a, b) => desc(a[0], b[0]))
      .map(([period, v]) => ({ period, ...v })),
    byPaymentMonth: [...paidMonth.entries()]
      .sort((a, b) => desc(a[0], b[0]))
      .map(([month, v]) => ({ month, ...v })),
  };
}

export type ReconciliationRow = {
  merchant: string;
  billedFeeWei: bigint;
  paid: boolean;
  txHash: string | null;
  paidAtMs: number | null;
};

// 期間 P の照合: 請求した店主 (メーター索引) を列挙し、各々の請求額 (loadUsageInvoice) と
// 入金済みか (台帳に (merchant, P) の入金があるか) を突合する。未払い = billedFeeWei>0 && !paid。
// 未払いを上に、その中は請求額の大きい順に並べる (取りこぼしの目視を容易に)。
export async function loadReconciliation(
  period: string,
  events: FeeRevenueEvent[],
): Promise<ReconciliationRow[]> {
  const merchants = await getMeteredMerchants(period);
  // 同 (merchant, period) は最新 (LPUSH 先頭=配列の先) を採用。
  const paidIndex = new Map<string, FeeRevenueEvent>();
  for (const e of events) {
    if (e.p === period && !paidIndex.has(e.m)) paidIndex.set(e.m, e);
  }
  const rows: ReconciliationRow[] = [];
  for (const m of merchants) {
    const inv = await loadUsageInvoice(period, m as Address);
    const paidEvent = paidIndex.get(m.toLowerCase());
    rows.push({
      merchant: m.toLowerCase(),
      billedFeeWei: inv.feeWei,
      paid: !!paidEvent,
      txHash: paidEvent?.h ?? null,
      paidAtMs: paidEvent?.t ?? null,
    });
  }
  rows.sort(
    (a, b) =>
      Number(a.paid) - Number(b.paid) ||
      (b.billedFeeWei > a.billedFeeWei ? 1 : b.billedFeeWei < a.billedFeeWei ? -1 : 0),
  );
  return rows;
}
