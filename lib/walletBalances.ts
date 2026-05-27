// 接続ウォレットの JPYC / USDC をチェーン横断で取得する (各 deployment の balanceOf)。
// lib/crossChain/balance.ts (USDC 専用・cross-chain 決済用) を一般化した独立モジュール。
//
// - 残高は **アプリの RPC transport** (lib/chains.ts transportForChain) 経由で読むため、
//   ウォレットの現 chain に依存しない (chain 切替不要)。
// - 1 chain の RPC hang が他に波及しないよう、各 chain の balanceOf に 3 秒 timeout を
//   かけ Promise.allSettled で集約する (2026-05-26 Phase A で Ethereum L1 公開 RPC の
//   hang を観測したのと同じ対策)。失敗 chain は status:'error' で残し UI 側で skip する。

import { createPublicClient, erc20Abi, type Address } from 'viem';
import { chainObjectForId, transportForChain } from './chains';
import {
  deploymentsForSymbol,
  type TokenDeployment,
  type TokenSymbol,
} from './tokens';

export type TokenChainBalance = {
  deployment: TokenDeployment;
  status: 'ok' | 'error';
  /** raw atomic units (error 時は 0n) */
  balance: bigint;
};

// 各 chain の balanceOf に対する worst-case bound。公開 RPC が hang しても全体の
// 取得が固まらないようにする (balance.ts:WALLET_BALANCE_TIMEOUT_MS と同値)。
const BALANCE_TIMEOUT_MS = 3_000;

async function readOneBalance(
  account: Address,
  deployment: TokenDeployment,
): Promise<bigint> {
  const chain = chainObjectForId(deployment.chainId);
  if (!chain) {
    throw new Error(
      `walletBalances: chain ${deployment.chainId} (${deployment.displaySymbol}) ` +
        'is not in supportedChains',
    );
  }
  const client = createPublicClient({
    chain,
    transport: transportForChain(chain.id),
  });
  const balancePromise = client.readContract({
    address: deployment.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account],
  }) as Promise<bigint>;
  // timeout 後に RPC が遅れて reject しても unhandled rejection にしない
  // (実害は無いが console noise を避ける)。
  balancePromise.catch(() => {});
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`rpc timeout (${BALANCE_TIMEOUT_MS}ms)`)),
      BALANCE_TIMEOUT_MS,
    ),
  );
  return Promise.race([balancePromise, timeoutPromise]);
}

/**
 * 指定 token (default: USDC + JPYC) の全 deployment について account の残高を取得する。
 * deployment 一覧は `deploymentsForSymbol` (NEXT_PUBLIC_NETWORK_ENV に応じた mainnet/
 * testnet の deployment) を使うため、env を跨いだ chain が混入しない。
 */
export async function readWalletTokenBalances(
  account: Address,
  symbols: readonly TokenSymbol[] = ['usdc', 'jpyc'],
): Promise<TokenChainBalance[]> {
  const deployments = symbols.flatMap((symbol) => deploymentsForSymbol(symbol));
  const settled = await Promise.allSettled(
    deployments.map((deployment) => readOneBalance(account, deployment)),
  );
  return settled.map((result, i) =>
    result.status === 'fulfilled'
      ? { deployment: deployments[i], status: 'ok', balance: result.value }
      : { deployment: deployments[i], status: 'error', balance: 0n },
  );
}
