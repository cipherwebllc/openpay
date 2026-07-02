// Cross-chain の CCTP / Gateway contract に対する **存在確認** guard。
//
// 顧客の wallet は CCTP TokenMessenger に実 USDC を approve してから depositForBurn
// する (lib/crossChain/execute.ts)。approve/send 先のアドレスが EOA / 未 deploy だと
// USDC を吸い出せない / 資金焼失の事故に繋がるため、送信前に「そのアドレスに contract
// code が実在するか」を getCode で確認する最低限の sanity。
//
// ⚠ codehash は **pin しない**。Circle の CCTP/Gateway contract は upgradeable proxy の
// 可能性があり、codehash を pin すると Circle の正当な upgrade で自ら outage を起こす
// (self-inflicted)。ここは存在確認のみ = 低リスクで正しい防御。codehash pin が要る
// Circle Paymaster (permit spender) は別の強い helper assertCirclePaymasterDeployed が
// 担う (lib/circlePermit.ts)。

import type { Address, PublicClient } from 'viem';

// 検証成功のみ module 単位で cache する (`${chainId}:${address.toLowerCase()}`)。
// deploy 済 contract は de-deploy されない前提なので成功結果は再利用してよい。
// 失敗 (未 deploy / RPC 障害) は cache しない = transient RPC error は次回 retry できる。
const verified = new Map<string, true>();
// 同一 key の並行呼び出しを 1 本の getCode に dedupe する in-flight promise cache。
// 成功で verified に移し、失敗 (throw) で evict して次回 retry を許す。
const inflight = new Map<string, Promise<void>>();

function cacheKey(chainId: number, address: Address): string {
  return `${chainId}:${address.toLowerCase()}`;
}

/**
 * `address` に contract code が実在することを検証する。code が空 ('0x' / undefined /
 * length<=2 = EOA / 未 deploy) なら throw する。**codehash は比較しない** (存在確認のみ・
 * 上記モジュールコメント参照)。成功は cache し、in-flight 呼び出しは dedupe する。失敗は
 * cache しない (transient RPC error を次回 retry できるようにする)。
 */
export async function assertContractDeployed(
  client: PublicClient,
  address: Address,
  chainId: number,
): Promise<void> {
  const key = cacheKey(chainId, address);
  if (verified.has(key)) return;

  const existing = inflight.get(key);
  if (existing) return existing;

  const run = (async () => {
    const code = await client.getCode({ address });
    if (!code || code === '0x' || code.length <= 2) {
      throw new Error(
        `cross-chain: contract ${address} on chain ${chainId} に code が無い ` +
          '(EOA / 未 deploy)。CCTP/Gateway の送信先として使えないため中止。',
      );
    }
    verified.set(key, true);
  })();
  inflight.set(key, run);
  try {
    await run;
  } finally {
    // 成功でも失敗でも in-flight からは外す。成功は verified に移り済、失敗は
    // 何も残さない (= 次回 retry) ようにする。
    inflight.delete(key);
  }
}

// test 用: module 単位 cache を reset する。
export function __resetContractDeployedCacheForTest(): void {
  verified.clear();
  inflight.clear();
}
