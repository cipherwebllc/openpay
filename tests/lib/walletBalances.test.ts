import { describe, it, expect, vi, beforeEach } from 'vitest';

// viem boundary mock: createPublicClient を stub し、chainId ごとに readContract が
// canned value を返すようにする。walletBalances.ts の SUT は実コードで走らせる。
const readContractMocks = new Map<number, ReturnType<typeof vi.fn>>();

vi.mock('viem', async () => {
  const actual = await vi.importActual<typeof import('viem')>('viem');
  return {
    ...actual,
    createPublicClient: vi.fn((opts: { chain: { id: number } }) => {
      const mock = readContractMocks.get(opts.chain.id);
      if (!mock) {
        throw new Error(
          `test setup: no readContract mock for chainId ${opts.chain.id}`,
        );
      }
      return { readContract: mock };
    }),
  };
});

import { readWalletTokenBalances } from '@/lib/walletBalances';
import { deploymentsForSymbol } from '@/lib/tokens';

const ACCOUNT = '0x1234567890123456789012345678901234567890' as const;

// vitest は NEXT_PUBLIC_NETWORK_ENV=testnet で走るので、deploymentsForSymbol は
// testnet の deployment 一覧を返す。USDC + JPYC の全 chainId を列挙して mock を貼る。
const ALL_DEPLOYMENTS = [
  ...deploymentsForSymbol('usdc'),
  ...deploymentsForSymbol('jpyc'),
];
const ALL_CHAIN_IDS = [...new Set(ALL_DEPLOYMENTS.map((d) => d.chainId))];

function setAllChainsBalance(value: bigint) {
  for (const id of ALL_CHAIN_IDS) {
    readContractMocks.set(id, vi.fn().mockResolvedValue(value));
  }
}

beforeEach(() => {
  readContractMocks.clear();
});

describe('lib/walletBalances.readWalletTokenBalances', () => {
  it('USDC + JPYC の全 deployment を query し ok 残高を返す', async () => {
    setAllChainsBalance(1_000_000n);
    const out = await readWalletTokenBalances(ACCOUNT);

    expect(out).toHaveLength(ALL_DEPLOYMENTS.length);
    expect(out.every((b) => b.status === 'ok')).toBe(true);
    expect(out.some((b) => b.deployment.symbol === 'usdc')).toBe(true);
    expect(out.some((b) => b.deployment.symbol === 'jpyc')).toBe(true);

    // balanceOf が account 引数で呼ばれている
    const anyChainMock = readContractMocks.get(ALL_CHAIN_IDS[0])!;
    expect(anyChainMock).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'balanceOf', args: [ACCOUNT] }),
    );
  });

  it('1 chain が hang → 3s timeout で status=error (0n)、他 chain は ok', async () => {
    setAllChainsBalance(5n);
    const hangChainId = ALL_CHAIN_IDS[0];
    readContractMocks.set(hangChainId, vi.fn(() => new Promise(() => {})));

    vi.useFakeTimers();
    try {
      const p = readWalletTokenBalances(ACCOUNT);
      await vi.advanceTimersByTimeAsync(3_100);
      const out = await p;

      const hung = out.filter((b) => b.deployment.chainId === hangChainId);
      expect(hung.length).toBeGreaterThan(0);
      expect(
        hung.every((b) => b.status === 'error' && b.balance === 0n),
      ).toBe(true);

      const others = out.filter((b) => b.deployment.chainId !== hangChainId);
      expect(others.length).toBeGreaterThan(0);
      expect(others.every((b) => b.status === 'ok')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('symbols で対象トークンを絞れる (usdc のみ)', async () => {
    setAllChainsBalance(10n);
    const out = await readWalletTokenBalances(ACCOUNT, ['usdc']);
    expect(out).toHaveLength(deploymentsForSymbol('usdc').length);
    expect(out.every((b) => b.deployment.symbol === 'usdc')).toBe(true);
  });
});
