// Cross-chain payment decision tree (pure logic、実行は useCrossChainPayment 側)。
// Priority: direct (latency 0) > gateway (<500ms、pre-deposit 必須) >
// cctp-v2 (8-20s、walk-in 向け) > onramp (balance なし fallback)。
//
// balance query 全滅時は direct に silent fallback せず "unavailable" を返す
// (silent fallback による wrong path 選択を防ぐ)。

import type {
  GatewayUnifiedBalance,
  MultiChainBalances,
  WalletUsdcBalance,
} from './balance';
import { domainForChainId } from './config';
import type { CircleDomain, CrossChainTarget } from './types';

export type PaymentPath = 'direct' | 'gateway' | 'cctp-v2' | 'onramp';

export type PathDecision =
  | {
      path: 'direct';
      reason: 'target_chain_balance_sufficient';
      targetChainId: number;
      availableAtomic: bigint;
    }
  | {
      path: 'gateway';
      reason: 'gateway_unified_balance_sufficient';
      targetChainId: number;
      destinationDomain: CircleDomain;
      sourceDomain: CircleDomain; // best source domain to burn from
      gatewayBalanceAtomic: bigint;
    }
  | {
      path: 'cctp-v2';
      reason: 'cross_chain_wallet_balance_sufficient';
      targetChainId: number;
      destinationDomain: CircleDomain;
      sourceChainId: number;
      sourceDomain: CircleDomain;
      sourceBalanceAtomic: bigint;
    }
  | {
      path: 'onramp';
      reason: 'no_balance_anywhere';
    }
  | {
      path: 'onramp';
      reason: 'balance_query_unavailable';
      detail: string;
    };

export interface SelectPathArgs {
  /** merchant 着金 chain (PayParams.chain → chainId) */
  targetChainId: number;
  /** 必要額 (atomic USDC = 6 decimals)。amount + 想定 bridge fee 上限を含める */
  requiredAtomic: bigint;
  /** balance.ts readAllCrossChainBalances の戻り値 */
  balances: MultiChainBalances;
}

export function selectPath(args: SelectPathArgs): PathDecision {
  const { targetChainId, requiredAtomic, balances } = args;

  // 1. direct path
  const directEntry = balances.wallet.find(
    (w) => w.target.chainId === targetChainId,
  );
  if (
    directEntry &&
    directEntry.status === 'ok' &&
    directEntry.balance >= requiredAtomic
  ) {
    return {
      path: 'direct',
      reason: 'target_chain_balance_sufficient',
      targetChainId,
      availableAtomic: directEntry.balance,
    };
  }

  const allWalletErrors = balances.wallet.every((w) => w.status === 'error');
  const gatewayErrored = balances.gateway.status === 'error';
  if (allWalletErrors && gatewayErrored) {
    return {
      path: 'onramp',
      reason: 'balance_query_unavailable',
      detail: 'all chain balance + gateway query failed',
    };
  }

  // 2. Gateway path
  const destDomain = domainForChainId(targetChainId);
  if (destDomain !== undefined && balances.gateway.status === 'ok') {
    const total = balances.gateway.total;
    if (total >= requiredAtomic) {
      const sourceDomain = pickBestGatewaySource(
        balances.gateway,
        requiredAtomic,
        destDomain,
      );
      return {
        path: 'gateway',
        reason: 'gateway_unified_balance_sufficient',
        targetChainId,
        destinationDomain: destDomain,
        sourceDomain,
        gatewayBalanceAtomic: total,
      };
    }
  }

  // 3. CCTP V2 path
  if (destDomain !== undefined) {
    const bestCrossChain = pickBestCrossChainWalletBalance(
      balances.wallet,
      targetChainId,
      requiredAtomic,
    );
    if (bestCrossChain !== null) {
      const sourceDomain = domainForChainId(bestCrossChain.target.chainId);
      if (sourceDomain !== undefined) {
        return {
          path: 'cctp-v2',
          reason: 'cross_chain_wallet_balance_sufficient',
          targetChainId,
          destinationDomain: destDomain,
          sourceChainId: bestCrossChain.target.chainId,
          sourceDomain,
          sourceBalanceAtomic: bestCrossChain.balance,
        };
      }
    }
  }

  return { path: 'onramp', reason: 'no_balance_anywhere' };
}

// destination 以外 (= cross-chain) を優先、sufficient balance → 大 balance の
// lexicographic ranking。Gateway は same-chain mint も対応するので最終 fallback は
// destination 自体を返す。
function pickBestGatewaySource(
  gateway: GatewayUnifiedBalance & { status: 'ok' },
  requiredAtomic: bigint,
  destinationDomain: CircleDomain,
): CircleDomain {
  const ranked = Array.from(gateway.perDomain.entries())
    .map(([d, balance]) => ({
      domain: d as CircleDomain,
      balance,
      isDest: d === destinationDomain ? 1 : 0,
      sufficient: balance >= requiredAtomic ? 1 : 0,
    }))
    .sort((a, b) => {
      if (a.isDest !== b.isDest) return a.isDest - b.isDest;
      if (a.sufficient !== b.sufficient) return b.sufficient - a.sufficient;
      return b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0;
    });
  return ranked[0]?.domain ?? destinationDomain;
}

// 最大 balance source を選ぶ (部分 burn 回避 + fee 計算簡略化)。
function pickBestCrossChainWalletBalance(
  wallet: WalletUsdcBalance[],
  targetChainId: number,
  requiredAtomic: bigint,
): { target: CrossChainTarget; balance: bigint } | null {
  const eligible: { target: CrossChainTarget; balance: bigint }[] = [];
  for (const w of wallet) {
    if (w.status !== 'ok') continue;
    if (w.target.chainId === targetChainId) continue;
    if (w.balance >= requiredAtomic) {
      eligible.push({ target: w.target, balance: w.balance });
    }
  }
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));
  return eligible[0];
}

