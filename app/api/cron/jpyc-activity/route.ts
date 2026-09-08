import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requireCronAuth } from '@/lib/cronAuth';
import { kvMget, kvSet, kvSetNxGet } from '@/lib/kv';
import { logger } from '@/lib/logger';
import { sanitizeRpcError } from '@/lib/jpyc/live';
import {
  ACTIVITY_LOCK_KEY, ACTIVITY_MAX_BUCKETS, ACTIVITY_NEWEST_KEY, ACTIVITY_TTL_SEC, ACTIVITY_WINDOW_MS,
  activityBucketKey, activityClient, newestActivityBucket, parseActivityBucket,
  scanActivityBucket, withActivityTimeout, type ActivityBucket,
} from '@/lib/jpyc/activity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: Request): Promise<NextResponse> {
  const started = Date.now();
  // 認証失敗を RPC / KV の利用へ波及させない。
  if (!requireCronAuth(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const runId = new Date(started).toISOString().slice(0, 13);
  const written: number[] = [];
  const failedBuckets: number[] = [];
  let missing: number[] = [];
  let reason = 'scan_incomplete';
  let stage: 'storage' | 'scan' = 'storage';
  const failure = (error: 'storage_error' | 'scan_incomplete') =>
    NextResponse.json({ error }, { status: 503 });
  try {
    const lock = await kvSetNxGet(ACTIVITY_LOCK_KEY, randomUUID(), 55);
    // ok:false と競合を分け、KV 障害を正常なスキップとして隠さない。
    if (!lock.ok) {
      reason = 'storage_error';
      return failure('storage_error');
    }
    if (lock.value !== null) {
      reason = '';
      return NextResponse.json({ skipped: 'locked' });
    }
    stage = 'scan';
    const client = activityClient();
    // finalized 非対応を latest で代替すると未確定イベントを不変キーへ保存してしまう。
    const finalized = await withActivityTimeout(() => client.getBlock({ blockTag: 'finalized' }), 5_000);
    if (finalized.number === null) throw new Error('finalized block number missing');
    const newest = newestActivityBucket(finalized.number);
    // 不正な head による負のバケット走査を隔離する。
    if (newest < ACTIVITY_MAX_BUCKETS - 1) throw new Error('finalized history too short');
    const indices = Array.from({ length: ACTIVITY_MAX_BUCKETS }, (_, offset) => newest - ACTIVITY_MAX_BUCKETS + 1 + offset);
    stage = 'storage';
    const existing = await kvMget(indices.map(activityBucketKey));
    // KV の不正な MGET 応答を「全件存在」や不要な再走査に変えない。
    if (!existing.ok || !Array.isArray(existing.value) || existing.value.length !== indices.length) {
      reason = 'storage_error';
      return failure('storage_error');
    }
    let attempted = 0;
    let boundary: number | null = null;
    let cutoff: number | undefined;
    let later: ActivityBucket | undefined;
    let invalid = false;
    for (let offset = indices.length - 1; offset >= 0; offset--) {
      const index = indices[offset];
      let bucket = parseActivityBucket(existing.value[offset], index);
      if (!bucket) {
        // 境界より古いキーを必要な欠けとして報告しない。歩いた範囲の既知の欠けだけを残す。
        missing.push(index);
        // 遅い RPC が関数寿命を使い切る波及を断つ。失敗も 12 バケットの予算に含める。
        if (Date.now() - started >= 35_000 || attempted >= 12) break;
        attempted++;
        stage = 'scan';
        try {
          bucket = await scanActivityBucket(index, client);
        } catch (error) {
          // 1 バケットの失敗を隣へ波及させず、完成分は保存する。warn は finally の 1 回だけ。
          failedBuckets.push(index);
          reason = sanitizeRpcError(error instanceof Error ? error.message : String(error));
          // N が無いと T を決められないため、古いバケットの走査は次 run に委ねる。
          if (index === newest) break;
          continue;
        }
        stage = 'storage';
        const saved = await kvSet(activityBucketKey(index), JSON.stringify(bucket), { ttlSec: ACTIVITY_TTL_SEC });
        // 書込失敗を進捗と報告しない。次 run は実在するキーから再開する。
        if (!saved.ok || saved.value !== 'OK') {
          reason = 'storage_error';
          return failure('storage_error');
        }
        written.push(index);
        missing = missing.filter((value) => value !== index);
      }
      cutoff ??= Date.parse(bucket.toTimestamp) - ACTIVITY_WINDOW_MS;
      // 保存済みでも overflow / 時刻逆転は完全な窓ではない。既存の reader の窓へ波及させない。
      if (bucket.overflow || (later && bucket.toTimestamp > later.fromTimestamp)) {
        invalid = true;
        reason = 'invalid bucket window';
      }
      later = bucket;
      if (Date.parse(bucket.fromTimestamp) <= cutoff) {
        boundary = index;
        break;
      }
    }
    const complete = boundary !== null && missing.length === 0 && !invalid;
    if (!complete && written.length === 0) return failure('scan_incomplete');
    if (complete) {
      // 最新バケットの部分走査・走査失敗が、reader の既存の完全かつ新鮮な窓を
      // 欠けた窓へ後退させる波及を断つため、必要集合が揃った後だけ N を公開する。
      stage = 'storage';
      const headSaved = await kvSet(ACTIVITY_NEWEST_KEY, String(newest), { ttlSec: ACTIVITY_TTL_SEC });
      if (!headSaved.ok || headSaved.value !== 'OK') {
        reason = 'storage_error';
        return failure('storage_error');
      }
      reason = '';
    }
    return NextResponse.json({
      runId, finalized: finalized.number.toString(), newest, boundary, written, missing,
      elapsedMs: Date.now() - started,
      ...(!complete ? { complete: false } : {}),
    });
  } catch (error) {
    // RPC / KV の例外を未処理終了にせず、run 単位の障害と衛生化した原因を残す。
    reason = sanitizeRpcError(error instanceof Error ? error.message : String(error));
    return failure(stage === 'storage' ? 'storage_error' : 'scan_incomplete');
  } finally {
    // lease は自動失効。遅延 run が次の所有者の lock を解放する波及を作らない。
    if (reason) logger.warn('jpyc.activity.run_incomplete', { written, missing, failedBuckets, reason });
  }
}
