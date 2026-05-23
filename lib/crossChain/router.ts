// Cross-chain payment decision tree — buyer の wallet 状態と target chain を
// 元に最適な path を選択する。
//
// Decision priority (= UX 上の好ましさ順):
//   1. direct — buyer が target chain で十分な balance を持つ
//      → 既存 path、追加 latency 0、bridge fee 0
//   2. gateway — buyer が Circle Gateway に pre-deposit 済で unified balance >= 必要額
//      → <500ms instant mint、Gateway 0.5 bps fee + dest gas
//   3. cctp-v2 — buyer が他 chain で十分な ERC20 USDC を持つ
//      → 8-20 秒、CCTP V2 Fast Transfer fee + source gas + dest gas
//   4. onramp — どこにも足りない balance なし
//      → 既存 OnrampCta fallback
//
// 設計判断:
//   - 直接 path を最優先 (現状の UX を 100% 維持、cross-chain は augmentation)
//   - Gateway > CCTP V2 (latency と UX が大きく勝るため)
//   - CCTP V2 の source chain 選択は「最大 balance を持つ chain」(複数 chain
//     に分散していたら一番大きいやつ。fee 最小化と部分 burn 回避)
//   - balance API のエラー時は decision を direct に倒さず、明示的に "unavailable"
//     を返して UI で再 query 促す (silent fallback で wrong path 選択を回避)
//
// 本 module は pure logic、副作用なし。balance.ts の MultiChainBalances を
// 入力して PathDecision を返すだけ。実行は useCrossChainPayment hook 側。

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

/**
 * Decision tree の本体。pure function。
 *
 * 余白 (`safetyBufferAtomic`): bridge fee + destination chain gas 推定の
 * 上乗せ余裕。caller (useCrossChainPayment) で `requiredAtomic = amount + buffer`
 * として渡す前提。本関数はそのまま比較するのみ。
 */
export function selectPath(args: SelectPathArgs): PathDecision {
  const { targetChainId, requiredAtomic, balances } = args;

  // 1. direct path 判定
  const directEntry = findWalletBalance(balances.wallet, targetChainId);
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

  // balance query 全滅は明示 unavailable
  const allWalletErrors = balances.wallet.every((w) => w.status === 'error');
  const gatewayErrored = balances.gateway.status === 'error';
  if (allWalletErrors && gatewayErrored) {
    return {
      path: 'onramp',
      reason: 'balance_query_unavailable',
      detail: 'all chain balance + gateway query failed',
    };
  }

  // 2. Gateway path 判定
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

  // 3. CCTP V2 path 判定
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

  // 4. fallback
  return { path: 'onramp', reason: 'no_balance_anywhere' };
}

function findWalletBalance(
  wallet: WalletUsdcBalance[],
  chainId: number,
): WalletUsdcBalance | undefined {
  return wallet.find((w) => w.target.chainId === chainId);
}

/**
 * Gateway unified balance の中から「source domain として最適」な domain を選ぶ。
 *
 * 優先順位 (高 → 低):
 *   1. destination 以外 + balance >= requiredAtomic
 *   2. destination 以外 + balance > 0  (Gateway 側で複数 source 合成想定、
 *      phase 1 は single source なので不足するが UI には best-effort で表示)
 *   3. destination 自体 (last resort、Gateway は same-chain mint も対応)
 *
 * sort key は (destination 一致 → 後回し, balance 大 → 前) の lexicographic order。
 */
function pickBestGatewaySource(
  gateway: GatewayUnifiedBalance & { status: 'ok' },
  requiredAtomic: bigint,
  destinationDomain: CircleDomain,
): CircleDomain {
  const ranked = Array.from(gateway.perDomain.entries())
    .map(([d, balance]) => ({
      domain: d as CircleDomain,
      balance,
      // tuple ソート: [isDestination, sufficient (大優先), balance (大優先)]
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

/**
 * Buyer の wallet ERC20 balance から「target chain 以外で最大残高を持つ chain」
 * を選ぶ (CCTP V2 source chain として)。
 *
 * 戻り値が null = どの cross-chain にも sufficient な balance なし。
 */
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
  // 最大 balance を持つ chain を優先 (部分 burn 回避、fee 計算が単純)
  eligible.sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));
  return eligible[0];
}

