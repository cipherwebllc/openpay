import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  baseSepolia,
  polygonAmoy,
  arbitrumSepolia,
  optimismSepolia,
} from 'viem/chains';

// viem boundary mock: createPublicClient を stub し、各 chain ごとに
// readContract が canned value を返すようにする。balance.ts の SUT は実コード。
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

import {
  readGatewayUnifiedBalance,
  readMultiChainWalletBalances,
  readAllCrossChainBalances,
} from '@/lib/crossChain/balance';
import {
  CIRCLE_DOMAIN_BASE,
  CIRCLE_DOMAIN_POLYGON,
} from '@/lib/crossChain/types';

const ACCOUNT = '0x1234567890123456789012345678901234567890' as const;

beforeEach(() => {
  readContractMocks.clear();
});

describe('lib/crossChain/balance.readMultiChainWalletBalances', () => {
  it('4 chain 全部 success: 各 chain の balance を返す', async () => {
    for (const chain of [
      baseSepolia,
      polygonAmoy,
      arbitrumSepolia,
      optimismSepolia,
    ]) {
      const m = vi.fn().mockResolvedValue(BigInt(chain.id) * 1_000_000n);
      readContractMocks.set(chain.id, m);
    }
    const out = await readMultiChainWalletBalances(ACCOUNT);
    expect(out).toHaveLength(4);
    for (const entry of out) {
      expect(entry.status).toBe('ok');
      if (entry.status === 'ok') {
        expect(entry.balance).toBe(BigInt(entry.target.chainId) * 1_000_000n);
      }
    }
  });

  it('1 chain だけ throw: 他 chain は ok、失敗 chain は error', async () => {
    readContractMocks.set(baseSepolia.id, vi.fn().mockResolvedValue(5n));
    readContractMocks.set(
      polygonAmoy.id,
      vi.fn().mockRejectedValue(new Error('rpc timeout')),
    );
    readContractMocks.set(arbitrumSepolia.id, vi.fn().mockResolvedValue(7n));
    readContractMocks.set(optimismSepolia.id, vi.fn().mockResolvedValue(9n));

    const out = await readMultiChainWalletBalances(ACCOUNT);
    const polygonEntry = out.find(
      (e) => e.target.chainId === polygonAmoy.id,
    );
    expect(polygonEntry?.status).toBe('error');
    if (polygonEntry?.status === 'error') {
      expect(polygonEntry.error).toContain('rpc timeout');
    }
    const baseEntry = out.find((e) => e.target.chainId === baseSepolia.id);
    expect(baseEntry?.status).toBe('ok');
  });

  it('全 chain 失敗: 4 件すべて error 配列を返す (throw しない)', async () => {
    for (const chain of [
      baseSepolia,
      polygonAmoy,
      arbitrumSepolia,
      optimismSepolia,
    ]) {
      readContractMocks.set(
        chain.id,
        vi.fn().mockRejectedValue(new Error('all down')),
      );
    }
    const out = await readMultiChainWalletBalances(ACCOUNT);
    expect(out).toHaveLength(4);
    expect(out.every((e) => e.status === 'error')).toBe(true);
  });

  it('chainResolver injection: テスト用 chain で resolver 上書き', async () => {
    readContractMocks.set(baseSepolia.id, vi.fn().mockResolvedValue(42n));
    readContractMocks.set(polygonAmoy.id, vi.fn().mockResolvedValue(0n));
    readContractMocks.set(arbitrumSepolia.id, vi.fn().mockResolvedValue(0n));
    readContractMocks.set(optimismSepolia.id, vi.fn().mockResolvedValue(0n));
    // resolver を spy で wrap
    const resolverSpy = vi.fn((chainId: number) => {
      const all = [baseSepolia, polygonAmoy, arbitrumSepolia, optimismSepolia];
      const found = all.find((c) => c.id === chainId);
      if (!found) throw new Error(`unknown ${chainId}`);
      return found;
    });
    await readMultiChainWalletBalances(ACCOUNT, resolverSpy);
    // 4 chain それぞれ resolver が呼ばれる
    expect(resolverSpy).toHaveBeenCalledTimes(4);
  });
});

describe('lib/crossChain/balance.readGatewayUnifiedBalance', () => {
  it('POST /v1/balances に sources を送る (default = 全 4 domain)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          balances: [
            { domain: 6, balance: '1000000' },
            { domain: 7, balance: '2000000' },
          ],
        }),
        { status: 200 },
      ),
    );
    const out = await readGatewayUnifiedBalance(ACCOUNT, undefined, {
      fetch: mockFetch as unknown as typeof fetch,
    });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain('/v1/balances');
    const body = JSON.parse(init.body);
    expect(body.token).toBe('USDC');
    expect(body.sources).toHaveLength(4);

    expect(out.status).toBe('ok');
    if (out.status === 'ok') {
      expect(out.perDomain.get(CIRCLE_DOMAIN_BASE)).toBe(1_000_000n);
      expect(out.perDomain.get(CIRCLE_DOMAIN_POLYGON)).toBe(2_000_000n);
      expect(out.total).toBe(3_000_000n);
    }
  });

  it('特定 domain だけ問合せ可能', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          balances: [{ domain: 7, balance: '500' }],
        }),
        { status: 200 },
      ),
    );
    await readGatewayUnifiedBalance(ACCOUNT, [CIRCLE_DOMAIN_POLYGON], {
      fetch: mockFetch as unknown as typeof fetch,
    });
    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0]).toEqual({
      domain: CIRCLE_DOMAIN_POLYGON,
      depositor: ACCOUNT,
    });
  });

  it('non-2xx: status=error で error message を含む', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('forbidden', { status: 403 }),
    );
    const out = await readGatewayUnifiedBalance(ACCOUNT, undefined, {
      fetch: mockFetch as unknown as typeof fetch,
    });
    expect(out.status).toBe('error');
    if (out.status === 'error') {
      expect(out.error).toContain('HTTP 403');
      expect(out.error).toContain('forbidden');
    }
  });

  it('balances 配列が空でも success (total=0)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ balances: [] }), { status: 200 }),
    );
    const out = await readGatewayUnifiedBalance(ACCOUNT, undefined, {
      fetch: mockFetch as unknown as typeof fetch,
    });
    expect(out.status).toBe('ok');
    if (out.status === 'ok') {
      expect(out.total).toBe(0n);
      expect(out.perDomain.size).toBe(0);
    }
  });

  it('巨大 balance (uint256 max 級) を BigInt で扱う', async () => {
    const huge = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          balances: [{ domain: 6, balance: huge }],
        }),
        { status: 200 },
      ),
    );
    const out = await readGatewayUnifiedBalance(ACCOUNT, undefined, {
      fetch: mockFetch as unknown as typeof fetch,
    });
    expect(out.status).toBe('ok');
    if (out.status === 'ok') {
      expect(out.total).toBe(BigInt(huge));
    }
  });

  it('baseUrl override 効く', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ balances: [] }), { status: 200 }),
    );
    await readGatewayUnifiedBalance(ACCOUNT, undefined, {
      fetch: mockFetch as unknown as typeof fetch,
      baseUrl: 'https://staging.example.com',
    });
    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://staging.example.com/v1/balances',
    );
  });
});

describe('lib/crossChain/balance.readAllCrossChainBalances', () => {
  it('wallet + gateway を並列で取得', async () => {
    for (const chain of [
      baseSepolia,
      polygonAmoy,
      arbitrumSepolia,
      optimismSepolia,
    ]) {
      readContractMocks.set(chain.id, vi.fn().mockResolvedValue(100n));
    }
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ balances: [{ domain: 6, balance: '777' }] }),
        { status: 200 },
      ),
    );
    const out = await readAllCrossChainBalances(ACCOUNT, {
      fetch: mockFetch as unknown as typeof fetch,
    });
    expect(out.wallet).toHaveLength(4);
    expect(out.gateway.status).toBe('ok');
    if (out.gateway.status === 'ok') {
      expect(out.gateway.total).toBe(777n);
    }
  });
});
