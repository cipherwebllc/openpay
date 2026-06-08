// OpenPay 利用料メーター (S1)。relay route が「実際に中継した」gasless 決済の **店主別出来高** を
// サーバ権威的に KV へ記録する = 将来の月次 OpenPay 利用料 (a1) の唯一の課金根拠。
//
// client 申告の lib/paymentLog (→/api/log/payment) とは **別系統**。あちらはブラウザが POST する
// ため改ざん/抑止が可能で課金根拠に使えない。こちらは relayer 自身が relay 成功時に書くため
// 改ざん不能。設計は docs/plans/merchant-gasless-fee-a1.md (S1)。
//
// 値は wei (18 decimals) を文字列で LPUSH し、集計時に JS bigint で合算する。Redis INCRBY は
// 64-bit 上限で wei 加算が overflow する (1 JPYC = 1e18 wei・~9.2 JPYC で 2^63 超) ため、
// list + JS 合算を採る。副産物として件数と per-tx 内訳 (UI 表示用) も得られる。
// 月 × 店主でキーを分け、~13 か月 TTL で自然失効 (年次請求 + 監査の余裕)。
//
// **本メーターは NEXT_PUBLIC_ENABLE_USAGE_FEE に依存しない** (点灯前の 6 月アルファから volume を
// 貯め始めるため・記録していない過去分には後から課金できない)。課金 (徴収) 側だけが flag で gate。

import type { Address, Hex } from 'viem';
import {
  kvLpush,
  kvLrange,
  kvLlen,
  kvLtrim,
  kvExpire,
  kvSet,
  isKvConfigured,
} from './kv';
import { logger } from './logger';
import {
  buildUsageInvoice,
  resolveUsageFeeBps,
  usageFeeConfig,
  type UsageInvoice,
} from './usageFee';

// 最終書込から ~13 か月保持 (年次請求 + 監査の余裕)。
export const METER_RETENTION_SEC = 60 * 60 * 24 * 400;
// 1 店舗 1 か月あたりの記録上限 (異常膨張ガード)。超過分は古い側を捨てる (undercount=honest)。
export const MAX_EVENTS_PER_PERIOD = 10_000;

// KV に積む 1 件の中継記録 (compact key で容量節約)。
export type MeterEvent = {
  v: string; // value (wei, raw) の decimal 文字列
  c: number; // chainId
  t: number; // unix ms
  h?: Hex; // txHash (監査・任意)
};

// 課金期間キー = UTC 'YYYY-MM'。client/server で同じ境界にするため UTC 固定。
export function meterPeriod(nowMs: number): string {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// 店主アドレスは lowercase 正規化でキー一意性を担保 (checksum 差で別キーにしない)。
export function meterKey(period: string, merchant: Address): string {
  return `meter:${period}:${merchant.toLowerCase()}`;
}

// 期間内に中継実績がある店主の索引 (admin 照合用)。KV に SCAN が無いため自前で持つ。
const merchantIndexKey = (period: string): string => `billing:merchants:${period}`;
// その (period, merchant) を索引に既に入れたかの nx ガード (毎中継 push しないため)。
const merchantSeenKey = (period: string, merchant: Address): string =>
  `billing:midx:${period}:${merchant.toLowerCase()}`;

// 期間 P で中継実績のある店主アドレス (lowercase・重複排除) を返す。admin reconciliation 用。
export async function getMeteredMerchants(period: string): Promise<string[]> {
  if (!isKvConfigured()) return [];
  const r = await kvLrange(merchantIndexKey(period), 0, -1);
  if (!r.ok) return [];
  return [...new Set(r.value.map((s) => s.toLowerCase()))];
}

// relay 成功時に呼ぶ。失敗しても決済応答は壊さない (呼出側で握り潰す前提)。KV 障害時は
// 記録欠落 = undercount となるが、overcharge は起こさない (fail-open・honest)。
export async function recordRelayedVolume(input: {
  chainId: number;
  merchant: Address;
  value: bigint;
  nowMs: number;
  txHash?: Hex;
}): Promise<void> {
  if (process.env.BILLING_METER_DISABLED === '1') return; // 緊急 kill-switch
  if (!isKvConfigured()) return; // KV 無し env は no-op (degrade)
  if (input.value <= 0n) return;

  const period = meterPeriod(input.nowMs);
  const key = meterKey(period, input.merchant);
  const event: MeterEvent = {
    v: input.value.toString(),
    c: input.chainId,
    t: input.nowMs,
    ...(input.txHash ? { h: input.txHash } : {}),
  };

  const r = await kvLpush(key, JSON.stringify(event));
  if (!r.ok) {
    logger.warn('billing.meter.lpush_failed', {
      chainId: input.chainId,
      period,
      reason: r.reason,
    });
    return;
  }
  // 最新書込から TTL を張り直す (自然失効)。
  await kvExpire(key, METER_RETENTION_SEC);

  // admin 照合用の店主索引: その (period, merchant) 初回のみ索引へ追加 (nx ガードで毎中継 push しない)。
  // 索引は補助なので失敗しても課金/決済に影響させない (try/catch)。
  try {
    const seen = await kvSet(merchantSeenKey(period, input.merchant), '1', {
      nx: true,
      ttlSec: METER_RETENTION_SEC,
    });
    if (seen.ok && seen.value !== null) {
      await kvLpush(merchantIndexKey(period), input.merchant.toLowerCase());
      await kvExpire(merchantIndexKey(period), METER_RETENTION_SEC);
    }
  } catch {
    // 索引欠落は reconciliation の取りこぼしになるだけ (課金根拠=meter 本体は無傷)
  }
  // 異常膨張ガード: 上限超過なら古い側 (LPUSH の末尾) を捨てる。silent にせず log で開示。
  if (r.value > MAX_EVENTS_PER_PERIOD) {
    logger.warn('billing.meter.capped', {
      chainId: input.chainId,
      period,
      length: r.value,
      cap: MAX_EVENTS_PER_PERIOD,
    });
    await kvLtrim(key, 0, MAX_EVENTS_PER_PERIOD - 1);
  }
}

// 期間 × 店主の記録を取得 (壊れた entry は skip)。
export async function getMeteredEvents(
  period: string,
  merchant: Address,
): Promise<MeterEvent[]> {
  if (!isKvConfigured()) return [];
  const r = await kvLrange(meterKey(period, merchant), 0, -1);
  if (!r.ok) return [];
  const out: MeterEvent[] = [];
  for (const s of r.value) {
    try {
      const o = JSON.parse(s) as MeterEvent;
      if (
        o &&
        typeof o.v === 'string' &&
        /^[0-9]+$/.test(o.v) &&
        typeof o.c === 'number'
      ) {
        out.push(o);
      }
    } catch {
      // malformed entry は集計から除外 (課金は過少側に倒す)
    }
  }
  // 壊れた entry を黙って捨てない: 件数を開示する (課金メーターのデータ欠落を観測可能に)。
  const dropped = r.value.length - out.length;
  if (dropped > 0) {
    logger.warn('billing.meter.dropped_entries', {
      period,
      dropped,
      total: r.value.length,
    });
  }
  return out;
}

// 件数と出来高合計 (wei) を JS bigint で合算する純関数。v は getMeteredEvents で数値検証済。
export function sumEvents(events: MeterEvent[]): {
  count: number;
  volume: bigint;
} {
  let volume = 0n;
  for (const e of events) volume += BigInt(e.v);
  return { count: events.length, volume };
}

// 期間 × 店主の {件数, 出来高(wei)} を返す (インボイス計算 S2 の入力)。
export async function getMeteredVolume(
  period: string,
  merchant: Address,
): Promise<{ count: number; volume: bigint }> {
  return sumEvents(await getMeteredEvents(period, merchant));
}

// O(1) で期間 × 店主の中継「件数」を返す (LLEN)。関所ゲートの hot-path で「前月に中継があったか」を
// 安価に判定するのに使う (全イベントの LRANGE を避ける)。正確な請求額は loadUsageInvoice 側。
export async function getMeteredCount(
  period: string,
  merchant: Address,
): Promise<number> {
  if (!isKvConfigured()) return 0;
  const r = await kvLlen(meterKey(period, merchant));
  return r.ok ? r.value : 0;
}

// 期間 × 店主のインボイス (メーター × 料率) を組む **単一ソース**。settle (検証) と invoice (表示) が
// 必ず同一額を算出するよう一元化する (ズレ = 「表示額を払ったのに検証で弾かれる」事故を防ぐ)。
export async function loadUsageInvoice(
  period: string,
  merchant: Address,
): Promise<UsageInvoice> {
  const rateBps = resolveUsageFeeBps(period, usageFeeConfig());
  const { count, volume } = await getMeteredVolume(period, merchant);
  return buildUsageInvoice({ period, count, volumeWei: volume, rateBps });
}
