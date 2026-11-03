'use client';

// 注文リンクの受取チェーンを 2 つ以上にするとき、受取ウォレットが選んだチェーンのどれかでコントラクトのウォレット (Safe など)
// になっていないかをチェーンから確かめる (plans/order-link-multichain.md)。コントラクトのウォレットはチェーンごとに持ち主が
// 違うことがあり、別のチェーンに払われると取り出せないことがある。EIP-7702 で委任した EOA はコードを持つが鍵は同じなので
// EOA として扱う (lib/accountCode.ts)。読めなかったチェーンがあれば「確かめられない」= リンクを作らせない (安全側)。
// 1 つのチェーンのリンクは確かめない (今までと同じ・失敗が 1 つのチェーンのリンクに波及しない)。
// まだデプロイされていないスマートアカウントはコードが無いので通る (限界・ガイドに書く)。

import { useQuery } from '@tanstack/react-query';
import { createPublicClient, type Address } from 'viem';
import { isNonDelegatedContractCode } from '@/lib/accountCode';
import { chainForSlug, chainObjectForId, transportForChain, type ChainSlug } from '@/lib/chains';

export type ReceiverChainCheck =
  /** 確かめない (受取チェーンが 1 つ・受取先が決まっていない)。 */
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ok' }
  /** このチェーンでコントラクトのウォレット。 */
  | { status: 'contract'; chains: ChainSlug[] }
  /** このチェーンで読めなかった。 */
  | { status: 'error'; chains: ChainSlug[] };

type CodeReader = (chain: ChainSlug, address: Address) => Promise<`0x${string}` | undefined>;

const readCode: CodeReader = async (chain, address) => {
  const chainObject = chainObjectForId(chainForSlug(chain).id);
  if (!chainObject) throw new Error(`no chain object: ${chain}`);
  const client = createPublicClient({ chain: chainObject, transport: transportForChain(chainObject.id) });
  return client.getCode({ address });
};

/** チェーンごとにコードを読み、コントラクトのチェーンと読めなかったチェーンを分ける (テストで reader を差し替える)。 */
export async function receiverChainCodes(
  address: Address,
  chains: readonly ChainSlug[],
  reader: CodeReader = readCode,
): Promise<{ contract: ChainSlug[]; failed: ChainSlug[] }> {
  const results = await Promise.allSettled(chains.map((chain) => reader(chain, address)));
  const contract: ChainSlug[] = [];
  const failed: ChainSlug[] = [];
  results.forEach((result, index) => {
    if (result.status === 'rejected') failed.push(chains[index]);
    else if (isNonDelegatedContractCode(result.value)) contract.push(chains[index]);
  });
  return { contract, failed };
}

export function useReceiverChainCheck(receiver: Address | null, chains: readonly ChainSlug[]): ReceiverChainCheck {
  const enabled = receiver !== null && chains.length >= 2;
  const query = useQuery({
    queryKey: ['order-link-receiver-code', receiver?.toLowerCase() ?? '', [...chains].sort().join(',')],
    enabled,
    staleTime: 10 * 60_000,
    retry: 1,
    queryFn: () => receiverChainCodes(receiver as Address, chains),
  });
  if (!enabled) return { status: 'idle' };
  if (query.isPending) return { status: 'checking' };
  if (query.isError) return { status: 'error', chains: [...chains] };
  if (query.data.contract.length > 0) return { status: 'contract', chains: query.data.contract };
  if (query.data.failed.length > 0) return { status: 'error', chains: query.data.failed };
  return { status: 'ok' };
}
