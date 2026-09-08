// JPYC Network Activity の固定バケットを最大 60 個遡り、timestamp で約 24 時間の窓を決める。
//
// 設計の肝:
//   - **finalized 固定バケット**。確定済みブロックだけを扱い、確定後の内容は不変。
//   - **不変キー**。バケット index とキーの対応を固定し、別の範囲や内容に更新しない。
//   - **購入時 RPC ゼロ**。購入時は KV 読み取りと純粋な集計だけで完結する。
//   - **欠け / stale は 503・settle なし**。不完全なデータを課金へ波及させない。
// 参照: plans/jpyc-activity.md

import 'server-only';

import { createPublicClient, formatUnits } from 'viem';
import { polygon } from 'viem/chains';
import { transportForChain } from '@/lib/chains';
import { resolveDeployment } from '@/lib/tokens';
import { kvGet, kvMget } from '@/lib/kv';
import { TRANSFER_CHUNK_BLOCKS, TRANSFER_EVENT } from './live';

export const ACTIVITY_BUCKET_BLOCKS = 1_800n;
export const ACTIVITY_WINDOW_MS = 86_400_000;
export const ACTIVITY_MAX_BUCKETS = 60;
export const ACTIVITY_TTL_SEC = 30 * 60 * 60;
export const ACTIVITY_MAX_ITEMS = 5_000;
export const ACTIVITY_VALIDITY_MS = 4 * 60 * 60 * 1_000;
export const ACTIVITY_LOCK_KEY = 'jpyc:activity:polygon:lock';
// N の toTimestamp から 24h 前に届く境界 M まで、連続した [M, N] が揃った時だけ公開する。
// reader も最大 60 バケットで境界・完全性・鮮度を検証し、ポインタ更新だけでは鮮度を延ばさない。
export const ACTIVITY_NEWEST_KEY = 'jpyc:activity:polygon:newest';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ADDRESS = /^0x[0-9a-f]{40}$/;
const DIGITS = /^[0-9]+$/;

export type ActivityItem = [from: string, to: string, value: string];
export type ActivityBucket = {
  schema: 1;
  chain: 'polygon';
  chainId: 137;
  contract: string;
  index: number;
  fromBlock: string;
  toBlock: string;
  fromTimestamp: string;
  toTimestamp: string;
  eventCount: number;
  items: ActivityItem[];
  overflow: boolean;
};
export type ActivityReason = 'data_unavailable' | 'data_incomplete' | 'data_stale';

export function activityDeployment() {
  const deployment = resolveDeployment('jpyc', 137);
  // testnet の設定を Polygon mainnet の事実として保存する波及を断つ。
  if (!deployment) throw new Error('activity requires Polygon mainnet deployment');
  return deployment;
}

export function activityClient() {
  return createPublicClient({
    chain: polygon,
    // cron の timeout 後に transport の再試行が積み重なる波及を断つ。
    transport: (options) => transportForChain(137)({ ...options, retryCount: 0, timeout: 5_000 }),
  });
}

export function newestActivityBucket(finalized: bigint): number {
  const index = finalized / ACTIVITY_BUCKET_BLOCKS - 1n;
  // 不正な RPC ブロック番号を丸めて別バケットを走査する波及を断つ。
  if (finalized < 0n || index > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('invalid finalized block');
  return Number(index);
}

export function activityBucketKey(index: number): string {
  return 'jpyc:activity:polygon:b:' + index;
}

export function activityBucketRange(index: number) {
  const fromBlock = BigInt(index) * ACTIVITY_BUCKET_BLOCKS;
  return { fromBlock, toBlock: fromBlock + ACTIVITY_BUCKET_BLOCKS - 1n };
}

export function eligibleActivityTransfer(from: string, to: string, value: bigint): boolean {
  const sender = from.toLowerCase();
  const receiver = to.toLowerCase();
  return value > 0n && sender !== receiver && sender !== ZERO_ADDRESS && receiver !== ZERO_ADDRESS;
}

export async function withActivityTimeout<T>(work: (expired: () => boolean) => Promise<T>, ms: number): Promise<T> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new Error('activity RPC timeout'));
    }, ms);
  });
  try {
    return await Promise.race([work(() => expired), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export async function scanActivityBucket(index: number, client = activityClient()): Promise<ActivityBucket> {
  return withActivityTimeout(async (expired) => {
    const deployment = activityDeployment();
    const { fromBlock, toBlock } = activityBucketRange(index);
    const [from, to] = await Promise.all([
      client.getBlock({ blockNumber: fromBlock }),
      client.getBlock({ blockNumber: toBlock }),
    ]);
    const items: ActivityItem[] = [];
    let eventCount = 0;
    let overflow = false;
    for (let start = fromBlock; start <= toBlock; start += TRANSFER_CHUNK_BLOCKS * 4n) {
      // timeout 済みの走査が遅れて新しい RPC を発行する波及を断つ。
      if (expired()) throw new Error('activity RPC timeout');
      const requests = [];
      for (let offset = 0n; offset < 4n; offset++) {
        const chunkFrom = start + offset * TRANSFER_CHUNK_BLOCKS;
        if (chunkFrom > toBlock) break;
        const chunkTo = chunkFrom + TRANSFER_CHUNK_BLOCKS - 1n;
        requests.push(client.getLogs({
          address: deployment.address, event: TRANSFER_EVENT,
          fromBlock: chunkFrom, toBlock: chunkTo < toBlock ? chunkTo : toBlock,
        }));
      }
      // 1 チャンクの失敗を部分集計として保存しない。進行中の batch も待ってから捨てる。
      const results = await Promise.allSettled(requests);
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason;
        for (const log of result.value) {
          eventCount++;
          const { from: sender, to: receiver, value } = log.args;
          // 不正な decode / removed ログを除外成功に見せず、そのバケットごと隔離する。
          if (log.removed || !sender || !receiver || typeof value !== 'bigint' || value < 0n ||
            !ADDRESS.test(sender.toLowerCase()) || !ADDRESS.test(receiver.toLowerCase())) {
            throw new Error('invalid Transfer log');
          }
          if (!eligibleActivityTransfer(sender, receiver, value) || overflow) continue;
          items.push([sender.toLowerCase(), receiver.toLowerCase(), value.toString()]);
          // 高密度のバケットで KV 上限を超える波及を断つ。切り詰めた合計は販売しない。
          if (items.length > ACTIVITY_MAX_ITEMS) {
            overflow = true;
            items.length = 0;
          }
        }
      }
    }
    const bucket: ActivityBucket = {
      schema: 1, chain: 'polygon', chainId: 137, contract: deployment.address, index,
      fromBlock: fromBlock.toString(), toBlock: toBlock.toString(),
      fromTimestamp: new Date(Number(from.timestamp * 1_000n)).toISOString(),
      toTimestamp: new Date(Number(to.timestamp * 1_000n)).toISOString(),
      eventCount, items, overflow,
    };
    // RPC の不正 timestamp が読めない永続データになる波及を断つ。
    if (!validActivityBucket(bucket, index)) throw new Error('invalid bucket headers');
    return bucket;
  }, 20_000);
}

function finiteIso(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function validActivityBucket(value: unknown, index: number): value is ActivityBucket {
  // JSON / schema / キーの取り違えを集計と課金へ波及させないための境界検証。
  if (!value || typeof value !== 'object' || !Number.isSafeInteger(index) || index < 0) return false;
  const b = value as ActivityBucket;
  const range = activityBucketRange(index);
  return b.schema === 1 && b.chain === 'polygon' && b.chainId === 137 &&
    typeof b.contract === 'string' && b.contract.toLowerCase() === activityDeployment().address.toLowerCase() &&
    b.index === index && typeof b.fromBlock === 'string' && DIGITS.test(b.fromBlock) &&
    typeof b.toBlock === 'string' && DIGITS.test(b.toBlock) &&
    b.fromBlock === range.fromBlock.toString() && b.toBlock === range.toBlock.toString() &&
    finiteIso(b.fromTimestamp) && finiteIso(b.toTimestamp) && b.fromTimestamp <= b.toTimestamp &&
    Number.isSafeInteger(b.eventCount) && b.eventCount >= 0 && typeof b.overflow === 'boolean' &&
    Array.isArray(b.items) && b.items.length <= ACTIVITY_MAX_ITEMS && b.eventCount >= b.items.length &&
    (!b.overflow || (b.items.length === 0 && b.eventCount > ACTIVITY_MAX_ITEMS)) &&
    b.items.every((item) => Array.isArray(item) && item.length === 3 &&
      typeof item[0] === 'string' && ADDRESS.test(item[0]) &&
      typeof item[1] === 'string' && ADDRESS.test(item[1]) &&
      typeof item[2] === 'string' && DIGITS.test(item[2]) &&
      eligibleActivityTransfer(item[0], item[1], BigInt(item[2])));
}

export function parseActivityBucket(raw: string | null, index: number): ActivityBucket | null {
  try {
    const value: unknown = raw === null ? null : JSON.parse(raw);
    return validActivityBucket(value, index) ? value : null;
  } catch {
    // 壊れた KV JSON / deployment 設定を正常な空バケットに変えない。
    return null;
  }
}

export function activityFreshness(toTimestamp: string, now = Date.now()): ActivityReason | null {
  // NaN / 未来の時刻によって stale 検査がすり抜ける波及を断つ。
  if (!finiteIso(toTimestamp) || Date.parse(toTimestamp) > now + 60_000) return 'data_unavailable';
  return now - Date.parse(toTimestamp) > ACTIVITY_VALIDITY_MS ? 'data_stale' : null;
}

export function aggregateActivity(buckets: readonly ActivityBucket[]) {
  // 窓 = 渡された必要集合 [M, N] 全体。境界バケット M (fromTimestamp ≤ T−24h) は丸ごと含める —
  // toTimestamp で再度絞ると境界がバケット末尾に一致した時に M が落ちて 24h を割る (v2.1 裁定)。
  // M〜N の選択と完全性の検証は readActivityWindow が担い、ここは集計だけを行う。
  const sorted = [...buckets].sort((a, b) => a.index - b.index);
  const newest = sorted[sorted.length - 1];
  const selected = sorted;
  const senders = new Set<string>();
  const receivers = new Map<string, { address: string; count: number; volume: bigint }>();
  const values: bigint[] = [];
  let volume = 0n;
  for (const bucket of selected) {
    for (const [from, to, atomic] of bucket.items) {
      const value = BigInt(atomic);
      if (!eligibleActivityTransfer(from, to, value)) continue;
      const address = to.toLowerCase();
      senders.add(from.toLowerCase());
      const receiver = receivers.get(address) ?? { address, count: 0, volume: 0n };
      receiver.count++;
      receiver.volume += value;
      receivers.set(address, receiver);
      values.push(value);
      volume += value;
    }
  }
  values.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const middle = Math.floor(values.length / 2);
  const median = values.length === 0 ? 0n : values.length % 2 === 1
    ? values[middle] : (values[middle - 1] + values[middle]) / 2n;
  const topReceivers = [...receivers.values()].sort((a, b) =>
    b.count - a.count || (a.volume > b.volume ? -1 : a.volume < b.volume ? 1 :
      a.address < b.address ? -1 : a.address > b.address ? 1 : 0),
  ).slice(0, 5).map((r) => ({ ...r, volume: r.volume.toString(), volumeFormatted: formatUnits(r.volume, 18) }));
  return {
    chain: 'polygon' as const, chainId: 137 as const, contract: newest.contract, window: '24h' as const,
    fromBlock: selected[0].fromBlock, toBlock: newest.toBlock,
    fromTimestamp: selected[0].fromTimestamp, toTimestamp: newest.toTimestamp,
    transferCount: values.length, uniqueSenders: senders.size, uniqueReceivers: receivers.size,
    volume: volume.toString(), volumeFormatted: formatUnits(volume, 18),
    medianTransfer: median.toString(), medianTransferFormatted: formatUnits(median, 18), topReceivers,
    definitions: {
      eligible: 'positive-value transfers with distinct sender and receiver, excluding the zero address',
      countUnit: 'events', median: 'floored atomic average for even counts',
    },
    observedAt: newest.toTimestamp,
    expiresAt: new Date(Date.parse(newest.toTimestamp) + ACTIVITY_VALIDITY_MS).toISOString(),
  };
}

export type ActivityWindow = { ok: true; aggregate: ReturnType<typeof aggregateActivity> } |
  { ok: false; reason: ActivityReason };

export async function readActivityWindow(): Promise<ActivityWindow> {
  try {
    const head = await kvGet(ACTIVITY_NEWEST_KEY);
    // storage 障害・未設定・未 bootstrap をゼロ件として販売しない。
    if (!head.ok || typeof head.value !== 'string' || !DIGITS.test(head.value)) return { ok: false, reason: 'data_unavailable' };
    const newest = Number(head.value);
    if (!Number.isSafeInteger(newest) || newest < ACTIVITY_MAX_BUCKETS - 1) return { ok: false, reason: 'data_unavailable' };
    const indices = Array.from({ length: ACTIVITY_MAX_BUCKETS }, (_, offset) => newest - ACTIVITY_MAX_BUCKETS + 1 + offset);
    const result = await kvMget(indices.map(activityBucketKey));
    // MGET の不正形・通信障害を部分的な成功へ波及させない。
    if (!result.ok || !Array.isArray(result.value) || result.value.length !== indices.length) {
      return { ok: false, reason: 'data_unavailable' };
    }
    const buckets: ActivityBucket[] = [];
    for (let offset = indices.length - 1; offset >= 0; offset--) {
      if (result.value[offset] === null) return { ok: false, reason: 'data_incomplete' };
      const bucket = parseActivityBucket(result.value[offset], indices[offset]);
      const later = buckets[buckets.length - 1];
      // 破損・overflow・時刻逆転を完全な集計と見なして課金する波及を断つ。
      if (!bucket || bucket.overflow || (later && bucket.toTimestamp > later.fromTimestamp)) {
        return { ok: false, reason: 'data_unavailable' };
      }
      buckets.push(bucket);
      if (Date.parse(bucket.fromTimestamp) <= Date.parse(buckets[0].toTimestamp) - ACTIVITY_WINDOW_MS) {
        const reason = activityFreshness(buckets[0].toTimestamp);
        if (reason) return { ok: false, reason };
        return { ok: true, aggregate: aggregateActivity(buckets) };
      }
    }
    return { ok: false, reason: 'data_incomplete' };
  } catch {
    // content に例外ハンドラが無い gate へ KV / 集計例外を伝播させず、settle 前の 503 にする。
    return { ok: false, reason: 'data_unavailable' };
  }
}
