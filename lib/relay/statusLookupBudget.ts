// 署名なしの照会 (relay status の lookup=nonce) が、RPC の範囲制限で 1 回の検索 (直近 10,000 ブロック) を拒まれたあとの
// 小分けの探索 (lib/relay/authorizationUsedLookup.ts・1 回で最大 60 回の RPC) を始めてよいかを決める (第 9 回レビュー A-3)。
//
// nonce の照会は署名が要らない。オンチェーンで使われた公開の from/nonce と任意の validBefore を送れば、誰でもこの探索を
// 起こせる。IP の limiter (30 回/分) は IP を替えれば避けられ、IP hash が無ければ通る。そこでチェーン単位の共有の予算を
// 置き、この経路の RPC 費用を IP の数によらず上限で抑える。予算を超えたら探索を始めず、呼び出し側は窓が無いときと同じ
// 「結論を出さない」(indeterminate) に戻る (この経路を足す前の nonce の照会と同じ応答)。
//
// 予算と重複の抑止の鍵に、未署名の validBefore は入れない (値を変えて予算や重複の抑止を避けられないように)。

import type { Address, Hex } from 'viem';
import { isKvConfigured, kvIncr, kvSet } from '@/lib/kv';

/**
 * チェーンごとに 1 分あたり始めてよい小分けの探索の回数。1 回は最大 60 回の RPC なので、この経路の RPC は
 * チェーンごとに 1 分あたり最大 300 回。正規の利用は「使われたのに中継の記録 (KV の tx hash) が無い・RPC が
 * 範囲を制限する」ときだけで、1 件の復旧は下の重複の抑止で 1 分に 2 回まで (client は 3/9/21/45/90 秒に照会する)。
 */
export const NONCE_LOOKUP_NARROW_SEARCH_PER_MINUTE = 5;
/** 同じ (chain, from, nonce) の探索の間隔 (秒)。client の照会の間隔 (3〜45 秒) で同じ探索を繰り返さない。 */
export const NONCE_LOOKUP_NARROW_SEARCH_DEDUP_SEC = 30;
const BUDGET_WINDOW_SEC = 60;

export const narrowSearchBudgetKey = (chainId: number, nowMs: number = Date.now()) =>
  `relay:status:narrow:budget:${chainId}:${Math.floor(nowMs / (BUDGET_WINDOW_SEC * 1000))}`;

export const narrowSearchOnceKey = (chainId: number, from: Address, nonce: Hex) =>
  `relay:status:narrow:once:${chainId}:${from.toLowerCase()}:${nonce.toLowerCase()}`;

/**
 * 小分けの探索を始めてよければ true。同じ nonce を直近に探した・チェーンの予算を超えたら false。
 * no-throw。KV が無い・失敗したときは true (fail-open): この予算は付帯の RPC 費用の上限で、その保存先の障害で
 * 決済済みの支払いの復旧 (注文の確定) まで止めない (掟 13)。そのときも 1 回の探索は helper の上限 (60 回・6 秒) で有界。
 */
export async function claimNonceLookupNarrowSearch(
  chainId: number,
  from: Address,
  nonce: Hex,
): Promise<boolean> {
  try {
    if (!isKvConfigured()) return true;
    // 先に重複を見る (同じ nonce の繰り返しで共有の予算を減らさない)。保存の失敗は fail-open で次へ進む。
    const once = await kvSet(narrowSearchOnceKey(chainId, from, nonce), '1', {
      nx: true,
      ttlSec: NONCE_LOOKUP_NARROW_SEARCH_DEDUP_SEC,
    });
    if (once.ok && once.value === null) return false;
    // 期限 (窓 2 つ分) は INCR と同じ往復の EXPIRE NX で付ける (relayGuards.checkReadRateLimit と同じ型)。
    const budget = await kvIncr(narrowSearchBudgetKey(chainId), { initialTtlSec: BUDGET_WINDOW_SEC * 2 });
    if (!budget.ok) return true;
    return budget.value <= NONCE_LOOKUP_NARROW_SEARCH_PER_MINUTE;
  } catch {
    // lib/kv は失敗を ok:false で返す契約だが、想定外の例外が status 本体を巻き込むのを断つ (向きは ok:false と同じ)。
    return true;
  }
}
