import 'server-only';

import { kvEval, kvSet } from '@/lib/kv';
import { logger } from '@/lib/logger';
import {
  getPurchaseIntent, isPurchaseIntentSalt, purchasePendingIndexKey, reconcilePurchaseIntent,
  PURCHASE_QUOTE_TTL_SEC, PURCHASE_RECONCILE_BATCH_SIZE,
} from '@/lib/x402/purchaseIntent';
import { rpcCallOptions } from '@/lib/x402/reconcileBudget';
import type { LicenseReconcileChain } from './reconcile';
import { LICENSE_HOLD_INDEX } from './stock';

// 限定在庫 (ライセンス) の押さえのうち validBefore を過ぎたものを、15 分おきの license-mint cron でも照合する
// (日次の store-reconcile だけだと、支払わずに押さえた在庫が最長 1 日売れなくなる)。在庫を戻すかどうかの判定は
// 従来どおり reconcilePurchaseIntent (finalized の期限切れ未使用・取り消しの証明) だけが行い、ここは対象を選ぶだけ。
// あわせて決済待ち (store:intent:pending) と押さえの滞留を見て、閾値を超えたら warn を出す。

// license-mint cron の中での締切 (cron の開始から)。発行 worker (40 秒) の後に残りの時間で回す。maxDuration は 60 秒。
export const LICENSE_HOLD_SWEEP_DEADLINE_MS = 50_000;
export const LICENSE_HOLD_SWEEP_LIMIT = 20;
// 押さえの score は最後に触った時刻 (claim・fail・照合)。claim は quote から validBefore (最長 10 分) より前なので、
// score がこれより古い押さえは必ず validBefore を過ぎている。直近に照合した押さえは次の run に回す。
const SWEEP_IDLE_MS = PURCHASE_QUOTE_TTL_SEC * 1000;
// validBefore からこの時間を過ぎても戻らない押さえは 15 分おきには追わない (日次 cron・status と下の warn に任せる)。
// 期限切れ未使用・取り消しの証明は確定 (数分) の後の最初の照合で済むので、長く残るのは RPC 障害か想定外の on-chain 状態
// (同じ押さえを 15 分ごとに照合し続けて KV のコマンド予算を食う波及を断つ)。
export const LICENSE_HOLD_SWEEP_WINDOW_MS = 6 * 3_600_000;
// score の下限 = 窓 + 1 時間。窓の中の押さえは score ≥ validBefore − 10 分なので必ず範囲に入る。窓を出て照合しなく
// なった押さえは score が更新されず、1 時間で範囲から外れて後ろの押さえの枠を塞がない。
const SWEEP_LOOKBACK_MS = LICENSE_HOLD_SWEEP_WINDOW_MS + 3_600_000;
// 前回の run が最後に処理した (照合した・対象外にした) 押さえの score。押さえの score は claim・fail・照合の状態の
// 書き込みでしか動かず、照合が pending で終わる (finality 待ち・RPC の失敗など) と古いまま残る。範囲の先頭から
// 毎回 20 件を読むと、決着しない押さえが 20 件以上あるか、古い押さえが締切を使い切る run が続くと、それより新しい
// 押さえが 15 分おきには照合されない。次の run はこの続き (score がこれより大きい側) から読み、足りない分を範囲の
// 先頭から読み足す。TTL は範囲 (7 時間) と同じ: それより古い cursor は範囲の外で、使わずに先頭から読む。
export const LICENSE_HOLD_SWEEP_CURSOR_KEY = LICENSE_HOLD_INDEX + ':sweep_cursor';
const SWEEP_CURSOR_TTL_SEC = SWEEP_LOOKBACK_MS / 1000;
// validBefore からこれを過ぎても照合で戻らない押さえを「滞留」として warn に数える。
export const LICENSE_HOLD_STUCK_MS = 3_600_000;
// 照合の窓 (6 時間) と監視の範囲は分ける: 窓を過ぎて照合しなくなった押さえも滞留として数える。
//   - 掃除の対象の範囲 (score が 7 時間以内) にあり、validBefore が窓より古い押さえ = intent を読んだうえで滞留。
//   - score が 7 時間より古い押さえ = 件数 (ZCOUNT) だけで滞留 (intent は読まない)。score は claim の時刻以後に
//     しか書かれず、claim は validBefore の最長 10 分前までなので、validBefore から 6 時間 50 分以上たって戻って
//     いない (戻る・売れると押さえの index から消える)。warn には古い順に最大 3 件の intentSalt を載せる。
const STALE_SAMPLE = 3;

// warn の閾値 (これを超えたら)。
export const PURCHASE_BACKLOG_LIMITS = {
  // 日次 store-reconcile の 1 回の処理数。これを超えると 1 回の cron で捌けない。
  pendingCount: PURCHASE_RECONCILE_BATCH_SIZE,
  // 決済待ちの最古の待ち時間 (= 次の照合予定を過ぎてからの時間)。日次 cron が拾っていれば 24 時間を超えない。
  pendingOldestWaitMs: 26 * 3_600_000,
  // 押さえの件数 (掃除の後)。今の実購入数 (月に数件) では 15 分の時点で 10 を超えることは無い。
  holdCount: 10,
  // validBefore から 1 時間を過ぎても戻らない押さえ (1 件目で warn)。
  stuckHolds: 0,
} as const;

export type PurchaseBacklog = {
  pendingCount: number;
  pendingOldestWaitMs: number;
  holdCount: number;
  stuckHolds: number;
};
export type LicenseHoldSweepResult =
  | {
      ok: true;
      checked: number;
      released: number;
      settled: number;
      pending: number;
      skipped: number;
      storageErrors: number;
      deferred: number;
      // 照合の窓を過ぎた滞留 (掃除の範囲で窓より古い押さえ + score が 7 時間より古い押さえ)。stuckHolds に含む。
      staleHolds: number;
      backlog: PurchaseBacklog;
      exceeded: (keyof PurchaseBacklog)[];
    }
  | { ok: false; error: 'storage_unavailable' | 'sweep_failed' };

// 監視の数と掃除の対象を 1 回の EVAL で読む (読み取りのみ)。空なら EVAL + ZCARD 2 回の 3 コマンド
// (Upstash は EVAL 自体と中の redis.call を数える・DEPLOY_CHECKLIST §14.9c)。押さえが 0 件なら cursor は読まない。
// 押さえがあれば ZRANGEBYSCORE と ZCOUNT (score が 7 時間より古い押さえ) の 2 に、cursor の GET 1 (KEYS[3] を渡した
// ときだけ・数え直しでは渡さない)・cursor が範囲にあって続きが LIMIT に満たなければ範囲の先頭からの
// ZRANGEBYSCORE 1・古い押さえがあれば見本の ZRANGEBYSCORE 1 を足す。cursor の書き込み (SET 1) は EVAL の外で、
// 押さえを処理した run だけ。
// 掃除の対象は member と score を交互に並べて返す (WITHSCORES)。cursor がある run は (cursor, 範囲の末尾] の古い順と、
// 足りない分の [範囲の先頭, cursor] の古い順をこの順に並べる (2 つの範囲は重ならない)。cursor が無い・数字でない・
// 範囲の外なら従来どおり範囲の先頭から読む。score は ms の整数 (stock.ts の ctx.now は整数を検査済み) なので
// 数字だけの値を cursor として使い、そのまま範囲の端に渡す。key の型違いは EVAL の失敗 = storage。
// 読み足しの件数は math.floor で整数にそろえる (本番の Lua 5.1 では `/` の結果も "17" になるが、テストの wasmoon (Lua 5.4)
// では "17.0" になり、Redis の LIMIT は小数を受け付けない・tests/_helpers/redisLua.ts の KNOWN DIVERGENCES 1)。
const SNAPSHOT =
  'local hc=redis.call("ZCARD",KEYS[1]); local holds={}; local stale=0; local sample={}; ' +
  'if hc>0 then local lim=tonumber(ARGV[3]); local cur=false; ' +
  'if KEYS[3] then cur=redis.call("GET",KEYS[3]); ' +
  'if not (cur and string.match(cur,"^%d+$") and tonumber(cur)>=tonumber(ARGV[1]) and tonumber(cur)<=tonumber(ARGV[2])) then cur=false end end; ' +
  'if cur then holds=redis.call("ZRANGEBYSCORE",KEYS[1],"("..cur,ARGV[2],"WITHSCORES","LIMIT",0,lim); ' +
  'if #holds<2*lim then local wrap=redis.call("ZRANGEBYSCORE",KEYS[1],ARGV[1],cur,"WITHSCORES","LIMIT",0,lim-math.floor(#holds/2)); ' +
  'for i=1,#wrap do holds[#holds+1]=wrap[i] end end ' +
  'else holds=redis.call("ZRANGEBYSCORE",KEYS[1],ARGV[1],ARGV[2],"WITHSCORES","LIMIT",0,lim) end; ' +
  'stale=redis.call("ZCOUNT",KEYS[1],"-inf","("..ARGV[1]); ' +
  'if stale>0 then sample=redis.call("ZRANGEBYSCORE",KEYS[1],"-inf","("..ARGV[1],"LIMIT",0,tonumber(ARGV[4])) end end; ' +
  'local pc=redis.call("ZCARD",KEYS[2]); local oldest=""; ' +
  'if pc>0 then oldest=redis.call("ZRANGE",KEYS[2],0,0,"WITHSCORES")[2] end; ' +
  'return {hc,pc,oldest,holds,stale,sample}; ';

type SweepHold = { salt: string; score: number };
type Snapshot = { holdCount: number; pendingCount: number; pendingOldestScore: number | null; holds: SweepHold[]; staleCount: number; staleSample: string[] };

// withCursor = 掃除の対象を cursor の続きから読む (最初の読み取り)。数え直しは件数だけを使うので cursor の key を
// 渡さない (cursor を読まず、従来どおり範囲の先頭から読む)。
async function readSnapshot(now: number, withCursor: boolean): Promise<Snapshot | 'storage'> {
  const keys = [LICENSE_HOLD_INDEX, purchasePendingIndexKey()];
  if (withCursor) keys.push(LICENSE_HOLD_SWEEP_CURSOR_KEY);
  const r = await kvEval<unknown>(SNAPSHOT, keys, [
    String(now - SWEEP_LOOKBACK_MS), String(now - SWEEP_IDLE_MS), String(LICENSE_HOLD_SWEEP_LIMIT), String(STALE_SAMPLE),
  ]);
  if (!r.ok || !Array.isArray(r.value)) return 'storage';
  const [hc, pc, oldest, holds, stale, sample] = r.value as unknown[];
  // kvEval は Redis の値の形までしか確かめない。形の違う応答を件数 0 と読んで監視を黙らせない。
  if (typeof hc !== 'number' || typeof pc !== 'number' || typeof stale !== 'number' || (typeof oldest !== 'string' && typeof oldest !== 'number')) return 'storage';
  const list = (value: unknown): string[] | null => {
    const members = value === undefined || value === null ? [] : value;
    return Array.isArray(members) && members.every((m) => typeof m === 'string') ? members as string[] : null;
  };
  // member と score の組。score が数でない応答を cursor に書いて、次の run の読み取りを狂わせない。
  const withScores = (value: unknown): SweepHold[] | null => {
    const flat = value === undefined || value === null ? [] : value;
    if (!Array.isArray(flat) || flat.length % 2 !== 0) return null;
    const pairs: SweepHold[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      const salt: unknown = flat[i]; const raw: unknown = flat[i + 1];
      if (typeof salt !== 'string' || (typeof raw !== 'string' && typeof raw !== 'number') || raw === '') return null;
      const holdScore = Number(raw);
      if (!Number.isFinite(holdScore)) return null;
      pairs.push({ salt, score: holdScore });
    }
    return pairs;
  };
  const holdList = withScores(holds); const staleSample = list(sample);
  if (!holdList || !staleSample) return 'storage';
  const score = oldest === '' ? null : Number(oldest);
  if (score !== null && !Number.isFinite(score)) return 'storage';
  return { holdCount: hc, pendingCount: pc, pendingOldestScore: score, holds: holdList, staleCount: stale, staleSample };
}

/** 15 分おきの license-mint cron から呼ぶ。throw しない (発行 worker の結果と cron の応答へ波及させない)。 */
export async function runLicenseHoldSweep(options: {
  deadline: number;
  now?: number;
  licenseChain?: LicenseReconcileChain;
}): Promise<LicenseHoldSweepResult> {
  try {
    const now = options.now ?? Date.now();
    const snapshot = await readSnapshot(now, true);
    if (snapshot === 'storage') {
      logger.warn('license.hold_sweep_failed', { reason: 'storage' });
      return { ok: false, error: 'storage_unavailable' };
    }
    const summary = { checked: 0, released: 0, settled: 0, pending: 0, skipped: 0, storageErrors: 0, deferred: 0 };
    let stuckHolds = 0;
    // 照合の窓を過ぎた押さえ (score が 7 時間より古い押さえは件数だけ・掃除の範囲のものは下で数える)。
    let staleHolds = snapshot.staleCount;
    // 最後に処理した (照合した・対象外にした) 押さえの score = 次の run の cursor。締切で後回しにした押さえ
    // (締切は一度過ぎると戻らないので末尾に並ぶ) と intent を読めなかった押さえでは進めない = 次の run が先に見る。
    let lastScore: number | null = null;
    for (const { salt, score } of snapshot.holds) {
      // 予算切れは打ち切り (残りは次の run・日次 cron が拾う)。失敗や未払いには変換しない。
      if (rpcCallOptions(options.deadline) === null) { summary.deferred += 1; continue; }
      // 壊れた member の隔離は repairLicenseIndexes (毎時) の役目。ここでは読まずに飛ばす。
      if (!isPurchaseIntentSalt(salt)) { summary.skipped += 1; lastScore = score; continue; }
      const intent = await getPurchaseIntent(salt);
      if (intent === 'storage') { summary.storageErrors += 1; continue; }
      if (
        !intent || intent === 'corrupt' || intent.metadata.productKind !== 'license' ||
        intent.state === 'quoted' || intent.state === 'settled' ||
        (intent.state === 'failed_prebroadcast' &&
          (intent.failureReason === 'authorization_expired_unused' || intent.failureReason === 'authorization_canceled'))
      ) { summary.skipped += 1; lastScore = score; continue; }
      const validBeforeMs = Number(intent.claim.validBefore) * 1000;
      // 期限が来たものだけ (期限前の押さえは購入の途中か、status の照合に任せる)。
      if (!Number.isFinite(validBeforeMs) || validBeforeMs > now) { summary.skipped += 1; lastScore = score; continue; }
      // 窓より古いものは照合しない (日次 cron と status に任せる) が、滞留として数えて warn に出す。
      if (validBeforeMs < now - LICENSE_HOLD_SWEEP_WINDOW_MS) { summary.skipped += 1; lastScore = score; staleHolds += 1; continue; }
      summary.checked += 1; lastScore = score;
      const result = await reconcilePurchaseIntent(salt, {
        now, deadline: options.deadline, ...(options.licenseChain ? { licenseChain: options.licenseChain } : {}),
      });
      if (!result.ok) { summary.storageErrors += 1; continue; }
      if (result.state === 'settled') summary.settled += 1;
      else if (result.state === 'failed_prebroadcast') summary.released += 1;
      else {
        summary.pending += 1;
        if (validBeforeMs + LICENSE_HOLD_STUCK_MS < now) stuckHolds += 1;
      }
    }
    // 処理した押さえがある run だけ cursor を書く (SET 1・押さえが無い run・全部を後回しにした run は書かない)。
    // 書けなくても次の run が前の cursor (か範囲の先頭) から読むだけで、在庫の判定と監視の数には波及しない。
    if (lastScore !== null) {
      const saved = await kvSet(LICENSE_HOLD_SWEEP_CURSOR_KEY, String(lastScore), { ttlSec: SWEEP_CURSOR_TTL_SEC });
      if (!saved.ok) logger.warn('license.hold_sweep_failed', { reason: 'storage', step: 'cursor' });
    }
    // 照合した run だけ数え直す (戻した押さえ・終端にした決済待ちを数えない)。照合しなかった run は最初の読み取りの
    // まま (追加の KV コマンドなし)。数え直しの失敗は最初の読み取りで代える (多めに数える側 = warn を黙らせない)。
    const recount = summary.checked > 0 ? await readSnapshot(now, false) : snapshot;
    const counts = recount === 'storage' ? snapshot : recount;
    const backlog: PurchaseBacklog = {
      pendingCount: counts.pendingCount,
      pendingOldestWaitMs: counts.pendingOldestScore === null ? 0 : Math.max(0, now - counts.pendingOldestScore),
      holdCount: counts.holdCount,
      stuckHolds: stuckHolds + staleHolds,
    };
    const exceeded = (Object.keys(PURCHASE_BACKLOG_LIMITS) as (keyof PurchaseBacklog)[])
      .filter((key) => backlog[key] > PURCHASE_BACKLOG_LIMITS[key]);
    if (exceeded.length > 0) {
      logger.warn('creator_store.purchase_backlog', {
        ...backlog, exceeded, staleHolds, ...(snapshot.staleSample.length > 0 ? { staleSample: snapshot.staleSample } : {}),
      });
    }
    if (summary.storageErrors > 0) logger.warn('license.hold_sweep_failed', { reason: 'storage', storageErrors: summary.storageErrors });
    return { ok: true, ...summary, staleHolds, backlog, exceeded };
  } catch (error) {
    // 掃除・監視の想定外の例外を、同じ cron の発行 worker の結果と応答へ波及させない (在庫の判定は照合の側にある)。
    logger.warn('license.hold_sweep_failed', { reason: 'exception', error });
    return { ok: false, error: 'sweep_failed' };
  }
}
