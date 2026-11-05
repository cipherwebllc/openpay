// 署名なしの照会 (relay status の lookup=nonce) が、RPC の範囲制限で 1 回の検索 (直近 10,000 ブロック) を拒まれたあとの
// 小分けの探索 (lib/relay/authorizationUsedLookup.ts・1 回で最大 60 回の RPC) を始めてよいかを決める (第 9 回レビュー A-3)。
//
// nonce の照会は署名が要らない。オンチェーンで使われた公開の from/nonce と任意の validBefore を送れば、誰でもこの探索を
// 起こせる。IP の limiter (30 回/分) は IP を替えれば避けられ、IP hash が無ければ通る。そこでチェーン単位の共有の予算を
// 置き、この経路の RPC 費用を IP の数によらず上限で抑える。予算を超えたら探索を始めず、呼び出し側は窓が無いときと同じ
// 「結論を出さない」(indeterminate) に戻る (この経路を足す前の nonce の照会と同じ応答)。
//
// 予算と重複の抑止の鍵に、未署名の validBefore は入れない (値を変えて予算や重複の抑止を避けられないように)。

import { randomUUID } from 'node:crypto';
import type { Address, Hex } from 'viem';
import { isKvConfigured, kvEval, kvIncr, kvSet } from '@/lib/kv';
// 「自分が置いた値のときだけ消す」Lua (GET == ARGV[1] なら DEL)。支払いの claim と同じ本文をそのまま使う
// (新しい Lua を足さない・本物の Lua での確認は tests/lib/paymentClaim-lua.test.ts)。
import { RELEASE_PAYMENT_CLAIM_IF_OWNED as RELEASE_IF_OWNED } from '@/lib/paymentClaim';

/**
 * チェーンごとに、固定の 1 分の窓で始めてよい小分けの探索の回数。KV が正常なとき、1 分の窓ごとに探索の開始は 5 回まで、
 * 各探索の helper の呼び出しは最大 60 回 (分の境目では短い間に 10 回始まりうる・最初の広い検索とその他の読み取り・
 * transport の再試行は別・KV が無い/失敗/遅いときは共有の上限も保証しない)。正規の利用は「使われたのに中継の記録
 * (KV の tx hash) が無い・RPC が範囲を制限する」ときだけで、1 件の復旧は下の重複の抑止で 1 分に 2 回まで
 * (client は 3/9/21/45/90 秒に照会する)。
 */
export const NONCE_LOOKUP_NARROW_SEARCH_PER_MINUTE = 5;
/** 同じ (chain, from, nonce) の探索の間隔 (秒)。client の照会の間隔 (3〜45 秒) で同じ探索を繰り返さない。 */
export const NONCE_LOOKUP_NARROW_SEARCH_DEDUP_SEC = 30;
/**
 * 判定 (重複の鍵・予算) を待つ上限 (ミリ秒・断ったときの鍵の解放は含めない = 下の別の上限)。KV は 1 往復ごとに 5 秒まで待つ
 * (lib/kv.ts) ので、直列に待つと小分けの探索の前に client の fetch の期限 (10 秒・lib/relay/relayIntentRecovery.ts) と
 * route の maxDuration (15 秒) を使い切り、決済済みの復旧そのものが時間切れになる。超えたら探索を許す (fail-open)。
 */
export const NONCE_LOOKUP_NARROW_SEARCH_CLAIM_TIMEOUT_MS = 1_200;
const BUDGET_WINDOW_SEC = 60;

export const narrowSearchBudgetKey = (chainId: number, nowMs: number = Date.now()) =>
  `relay:status:narrow:budget:${chainId}:${Math.floor(nowMs / (BUDGET_WINDOW_SEC * 1000))}`;

export const narrowSearchOnceKey = (chainId: number, from: Address, nonce: Hex) =>
  `relay:status:narrow:once:${chainId}:${from.toLowerCase()}:${nonce.toLowerCase()}`;

/**
 * 予算で断った要求が、自分の重複の鍵の解放 (compare-and-delete) を待つ上限 (ミリ秒)。結果 (断る) は解放の前に決まって
 * いて、解放の遅れでは変わらない。待つのは、応答のあとに関数が凍結されて解放が送られないまま残るのを避けるため
 * (掟 12 の after() と同じ趣旨・投げっぱなしにしない)。上限を超えた・失敗したときは、鍵が期限 (30 秒) まで残るだけ。
 */
export const NONCE_LOOKUP_NARROW_SEARCH_RELEASE_TIMEOUT_MS = 500;

type Decision =
  | { allow: true }
  // release: 予算で断ったときに消す自分の重複の鍵 (重複で断ったときは自分の鍵が無いので付けない)。
  | { allow: false; release?: { key: string; token: string } };

/**
 * 小分けの探索を始めてよければ true。同じ nonce を直近に探している・チェーンの予算を超えたら false。
 * no-throw。KV が無い・失敗した・遅いときは true (fail-open): この予算は付帯の RPC 費用の上限で、その保存先の障害や
 * 遅れで決済済みの支払いの復旧 (注文の確定) まで止めない (掟 13)。そのときも 1 回の探索は helper の上限 (60 回・6 秒) で有界。
 */
export async function claimNonceLookupNarrowSearch(
  chainId: number,
  from: Address,
  nonce: Hex,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // KV の遅れを status 本体 (client の fetch の期限・route の maxDuration) へ波及させないための上限。時間切れは許す。
  // 打ち切っても KV の往復そのものは止まらない (後から届く INCR は予算を 1 減らすだけ・鍵は期限で消える)。
  const timeout = new Promise<Decision>((resolve) => {
    timer = setTimeout(() => resolve({ allow: true }), NONCE_LOOKUP_NARROW_SEARCH_CLAIM_TIMEOUT_MS);
  });
  let decision: Decision;
  try {
    decision = await Promise.race([decide(chainId, from, nonce), timeout]);
  } finally {
    clearTimeout(timer);
  }
  // 解放は決定の race の外で、決定が「予算で断る」に定まったときだけ送る。時間切れで許した (探索中の鍵) ときは、
  // あとから decide が予算の超過を返しても解放を送らない (探索中の鍵を消さない)。
  if (!decision.allow && decision.release) await releaseOwnOnceKey(decision.release);
  return decision.allow;
}

async function decide(chainId: number, from: Address, nonce: Hex): Promise<Decision> {
  try {
    if (!isKvConfigured()) return { allow: true };
    // 先に重複を見る (同じ nonce の繰り返しで共有の予算を減らさない)。値は要求ごとの token で、予算で断ったときに
    // 自分の鍵だけを消すのに使う。保存の失敗は fail-open で次へ進む。
    const key = narrowSearchOnceKey(chainId, from, nonce);
    const token = randomUUID();
    const once = await kvSet(key, token, { nx: true, ttlSec: NONCE_LOOKUP_NARROW_SEARCH_DEDUP_SEC });
    if (once.ok && once.value === null) return { allow: false };
    // 期限 (窓 2 つ分) は INCR と同じ往復の EXPIRE NX で付ける (relayGuards.checkReadRateLimit と同じ型)。
    const budget = await kvIncr(narrowSearchBudgetKey(chainId), { initialTtlSec: BUDGET_WINDOW_SEC * 2 });
    if (!budget.ok) return { allow: true };
    if (budget.value <= NONCE_LOOKUP_NARROW_SEARCH_PER_MINUTE) return { allow: true };
    // 予算で断った (探索しない) 要求の重複の鍵は残さない: 残すと次の窓で予算が空いても 30 秒止まり、他人の nonce を
    // 先に照会して止め続けることもできる。解放そのものは呼び出し側が race の外で行う (ここでは送らない)。
    return { allow: false, release: { key, token } };
  } catch {
    // lib/kv は失敗を ok:false で返す契約だが、想定外の例外が status 本体を巻き込むのを断つ (向きは ok:false と同じ)。
    return { allow: true };
  }
}

// 自分の token のときだけ消す (並行する別の要求が置いた鍵は消さない)。上限まで待ち、超えた・失敗したら鍵が期限まで
// 残るだけ (断った結果は変えない・no-throw)。送ったあとに上限を超えても、消すのは探索しない自分の鍵だけ。
async function releaseOwnOnceKey({ key, token }: { key: string; token: string }): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      kvEval<number>(RELEASE_IF_OWNED, [key], [token]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, NONCE_LOOKUP_NARROW_SEARCH_RELEASE_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // 解放の想定外の例外で「断る」を投げる (status 本体の失敗) に変えない。鍵は期限まで残るだけ。
  } finally {
    clearTimeout(timer);
  }
}
