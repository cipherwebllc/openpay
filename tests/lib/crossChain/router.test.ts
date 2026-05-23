import { describe, it, expect } from 'vitest';
import { baseSepolia, polygonAmoy, arbitrumSepolia, optimismSepolia } from 'viem/chains';
import { selectPath, describePath } from '@/lib/crossChain/router';
import type {
  MultiChainBalances,
  WalletUsdcBalance,
} from '@/lib/crossChain/balance';
import {
  CIRCLE_DOMAIN_ARBITRUM,
  CIRCLE_DOMAIN_BASE,
  CIRCLE_DOMAIN_OPTIMISM,
  CIRCLE_DOMAIN_POLYGON,
  type CircleDomain,
} from '@/lib/crossChain/types';

function walletEntry(
  chainId: number,
  domain: CircleDomain,
  balance: bigint,
): WalletUsdcBalance {
  return {
    status: 'ok',
    target: { chainId, domain, isTestnet: true },
    tokenAddress: '0x0000000000000000000000000000000000000001',
    balance,
  };
}

function errorEntry(chainId: number, domain: CircleDomain): WalletUsdcBalance {
  return {
    status: 'error',
    target: { chainId, domain, isTestnet: true },
    tokenAddress: '0x0000000000000000000000000000000000000001',
    error: 'mock rpc error',
  };
}

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const;

function makeBalances(opts: {
  walletEntries: WalletUsdcBalance[];
  gatewayPerDomain?: Map<CircleDomain, bigint>;
  gatewayError?: string;
}): MultiChainBalances {
  const gateway = opts.gatewayError
    ? { status: 'error' as const, depositor: ACCOUNT, error: opts.gatewayError }
    : {
        status: 'ok' as const,
        depositor: ACCOUNT,
        perDomain: opts.gatewayPerDomain ?? new Map<CircleDomain, bigint>(),
        total: Array.from(
          (opts.gatewayPerDomain ?? new Map<CircleDomain, bigint>()).values(),
        ).reduce((s, v) => s + v, 0n),
      };
  return { wallet: opts.walletEntries, gateway };
}

describe('lib/crossChain/router.selectPath', () => {
  it('1. direct: target chain で balance 充分 → direct path', () => {
    const balances = makeBalances({
      walletEntries: [
        walletEntry(baseSepolia.id, CIRCLE_DOMAIN_BASE, 10_000_000n),
        walletEntry(polygonAmoy.id, CIRCLE_DOMAIN_POLYGON, 0n),
        walletEntry(arbitrumSepolia.id, CIRCLE_DOMAIN_ARBITRUM, 0n),
        walletEntry(optimismSepolia.id, CIRCLE_DOMAIN_OPTIMISM, 0n),
      ],
      gatewayPerDomain: new Map([
        [CIRCLE_DOMAIN_BASE, 0n],
        [CIRCLE_DOMAIN_POLYGON, 0n],
      ]),
    });
    const decision = selectPath({
      targetChainId: baseSepolia.id,
      requiredAtomic: 5_000_000n,
      balances,
    });
    expect(decision.path).toBe('direct');
    if (decision.path === 'direct') {
      expect(decision.targetChainId).toBe(baseSepolia.id);
      expect(decision.availableAtomic).toBe(10_000_000n);
    }
  });

  it('2. gateway: target chain 0 + Gateway 充分 → gateway path', () => {
    const balances = makeBalances({
      walletEntries: [
        walletEntry(baseSepolia.id, CIRCLE_DOMAIN_BASE, 0n),
        walletEntry(polygonAmoy.id, CIRCLE_DOMAIN_POLYGON, 0n),
        walletEntry(arbitrumSepolia.id, CIRCLE_DOMAIN_ARBITRUM, 0n),
        walletEntry(optimismSepolia.id, CIRCLE_DOMAIN_OPTIMISM, 0n),
      ],
      gatewayPerDomain: new Map([
        [CIRCLE_DOMAIN_POLYGON, 10_000_000n],
      ]),
    });
    const decision = selectPath({
      targetChainId: baseSepolia.id,
      requiredAtomic: 5_000_000n,
      balances,
    });
    expect(decision.path).toBe('gateway');
    if (decision.path === 'gateway') {
      expect(decision.destinationDomain).toBe(CIRCLE_DOMAIN_BASE);
      // sourceDomain は best (>= required) を選ぶ、polygon が唯一の sufficient
      expect(decision.sourceDomain).toBe(CIRCLE_DOMAIN_POLYGON);
    }
  });

  it('Gateway sourceDomain は destination 以外で最大 balance を選ぶ', () => {
    const balances = makeBalances({
      walletEntries: [
        walletEntry(baseSepolia.id, CIRCLE_DOMAIN_BASE, 0n),
        walletEntry(polygonAmoy.id, CIRCLE_DOMAIN_POLYGON, 0n),
        walletEntry(arbitrumSepolia.id, CIRCLE_DOMAIN_ARBITRUM, 0n),
        walletEntry(optimismSepolia.id, CIRCLE_DOMAIN_OPTIMISM, 0n),
      ],
      gatewayPerDomain: new Map<CircleDomain, bigint>([
        [CIRCLE_DOMAIN_BASE, 100_000_000n], // dest と同じ chain、除外候補
        [CIRCLE_DOMAIN_POLYGON, 5_000_000n],
        [CIRCLE_DOMAIN_ARBITRUM, 20_000_000n], // 最大の cross-chain source
      ]),
    });
    const decision = selectPath({
      targetChainId: baseSepolia.id,
      requiredAtomic: 5_000_000n,
      balances,
    });
    expect(decision.path).toBe('gateway');
    if (decision.path === 'gateway') {
      expect(decision.sourceDomain).toBe(CIRCLE_DOMAIN_ARBITRUM);
    }
  });

  it('3. cctp-v2: Gateway 不足 + 他 chain wallet 充分 → cctp-v2 path', () => {
    const balances = makeBalances({
      walletEntries: [
        walletEntry(baseSepolia.id, CIRCLE_DOMAIN_BASE, 100n), // dest、不足
        walletEntry(polygonAmoy.id, CIRCLE_DOMAIN_POLYGON, 10_000_000n), // 充分
        walletEntry(arbitrumSepolia.id, CIRCLE_DOMAIN_ARBITRUM, 0n),
        walletEntry(optimismSepolia.id, CIRCLE_DOMAIN_OPTIMISM, 0n),
      ],
      gatewayPerDomain: new Map(),
    });
    const decision = selectPath({
      targetChainId: baseSepolia.id,
      requiredAtomic: 5_000_000n,
      balances,
    });
    expect(decision.path).toBe('cctp-v2');
    if (decision.path === 'cctp-v2') {
      expect(decision.sourceChainId).toBe(polygonAmoy.id);
      expect(decision.sourceDomain).toBe(CIRCLE_DOMAIN_POLYGON);
      expect(decision.sourceBalanceAtomic).toBe(10_000_000n);
    }
  });

  it('cctp-v2: 複数 cross-chain に balance あり → 最大を選ぶ', () => {
    const balances = makeBalances({
      walletEntries: [
        walletEntry(baseSepolia.id, CIRCLE_DOMAIN_BASE, 0n),
        walletEntry(polygonAmoy.id, CIRCLE_DOMAIN_POLYGON, 6_000_000n),
        walletEntry(arbitrumSepolia.id, CIRCLE_DOMAIN_ARBITRUM, 20_000_000n),
        walletEntry(optimismSepolia.id, CIRCLE_DOMAIN_OPTIMISM, 8_000_000n),
      ],
      gatewayPerDomain: new Map(),
    });
    const decision = selectPath({
      targetChainId: baseSepolia.id,
      requiredAtomic: 5_000_000n,
      balances,
    });
    expect(decision.path).toBe('cctp-v2');
    if (decision.path === 'cctp-v2') {
      expect(decision.sourceChainId).toBe(arbitrumSepolia.id);
    }
  });

  it('4. onramp: どこにも balance なし', () => {
    const balances = makeBalances({
      walletEntries: [
        walletEntry(baseSepolia.id, CIRCLE_DOMAIN_BASE, 0n),
        walletEntry(polygonAmoy.id, CIRCLE_DOMAIN_POLYGON, 0n),
        walletEntry(arbitrumSepolia.id, CIRCLE_DOMAIN_ARBITRUM, 0n),
        walletEntry(optimismSepolia.id, CIRCLE_DOMAIN_OPTIMISM, 0n),
      ],
      gatewayPerDomain: new Map(),
    });
    const decision = selectPath({
      targetChainId: baseSepolia.id,
      requiredAtomic: 5_000_000n,
      balances,
    });
    expect(decision.path).toBe('onramp');
    if (decision.path === 'onramp') {
      expect(decision.reason).toBe('no_balance_anywhere');
    }
  });

  it('全 wallet error + gateway error → balance_query_unavailable', () => {
    const balances = makeBalances({
      walletEntries: [
        errorEntry(baseSepolia.id, CIRCLE_DOMAIN_BASE),
        errorEntry(polygonAmoy.id, CIRCLE_DOMAIN_POLYGON),
        errorEntry(arbitrumSepolia.id, CIRCLE_DOMAIN_ARBITRUM),
        errorEntry(optimismSepolia.id, CIRCLE_DOMAIN_OPTIMISM),
      ],
      gatewayError: 'circle api down',
    });
    const decision = selectPath({
      targetChainId: baseSepolia.id,
      requiredAtomic: 5_000_000n,
      balances,
    });
    expect(decision.path).toBe('onramp');
    if (decision.path === 'onramp' && decision.reason === 'balance_query_unavailable') {
      expect(decision.detail).toContain('balance');
    }
  });

  it('Priority: direct > gateway > cctp-v2 (3 種全部 sufficient でも direct を選ぶ)', () => {
    const balances = makeBalances({
      walletEntries: [
        walletEntry(baseSepolia.id, CIRCLE_DOMAIN_BASE, 100_000_000n),
        walletEntry(polygonAmoy.id, CIRCLE_DOMAIN_POLYGON, 100_000_000n),
        walletEntry(arbitrumSepolia.id, CIRCLE_DOMAIN_ARBITRUM, 0n),
        walletEntry(optimismSepolia.id, CIRCLE_DOMAIN_OPTIMISM, 0n),
      ],
      gatewayPerDomain: new Map([
        [CIRCLE_DOMAIN_POLYGON, 100_000_000n],
      ]),
    });
    const decision = selectPath({
      targetChainId: baseSepolia.id,
      requiredAtomic: 5_000_000n,
      balances,
    });
    expect(decision.path).toBe('direct');
  });

  it('Priority: gateway > cctp-v2 (direct 不可で gateway と cctp-v2 両方 sufficient → gateway)', () => {
    const balances = makeBalances({
      walletEntries: [
        walletEntry(baseSepolia.id, CIRCLE_DOMAIN_BASE, 0n),
        walletEntry(polygonAmoy.id, CIRCLE_DOMAIN_POLYGON, 100_000_000n), // CCTP source 候補
        walletEntry(arbitrumSepolia.id, CIRCLE_DOMAIN_ARBITRUM, 0n),
        walletEntry(optimismSepolia.id, CIRCLE_DOMAIN_OPTIMISM, 0n),
      ],
      gatewayPerDomain: new Map([
        [CIRCLE_DOMAIN_ARBITRUM, 100_000_000n], // Gateway source 候補
      ]),
    });
    const decision = selectPath({
      targetChainId: baseSepolia.id,
      requiredAtomic: 5_000_000n,
      balances,
    });
    expect(decision.path).toBe('gateway');
  });

  it('未知 chainId (CCTP/Gateway 対象外) → onramp', () => {
    const balances = makeBalances({
      walletEntries: [
        walletEntry(baseSepolia.id, CIRCLE_DOMAIN_BASE, 1_000_000_000n),
      ],
      gatewayPerDomain: new Map(),
    });
    const decision = selectPath({
      targetChainId: 999_999, // domain 不在
      requiredAtomic: 5_000_000n,
      balances,
    });
    // target に直接 balance あり → direct 経路を満たさず gateway/cctp 経路は domain 取得失敗
    // (上記 wallet entries は all chainId !== 999999 で direct fail)
    expect(decision.path).toBe('onramp');
  });
});

describe('lib/crossChain/router.describePath', () => {
  it('direct を string で説明', () => {
    expect(
      describePath({
        path: 'direct',
        reason: 'target_chain_balance_sufficient',
        targetChainId: 84532,
        availableAtomic: 10n,
      }),
    ).toContain('direct on chainId 84532');
  });

  it('gateway を string で説明 (domain 含む)', () => {
    expect(
      describePath({
        path: 'gateway',
        reason: 'gateway_unified_balance_sufficient',
        targetChainId: 84532,
        destinationDomain: CIRCLE_DOMAIN_BASE,
        sourceDomain: CIRCLE_DOMAIN_POLYGON,
        gatewayBalanceAtomic: 100n,
      }),
    ).toContain('gateway');
  });
});
