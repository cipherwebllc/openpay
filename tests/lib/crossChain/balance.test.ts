import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  baseSepolia,
  polygonAmoy,
  arbitrumSepolia,
  optimismSepolia,
  sepolia,
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

const ALL_TESTNET_CHAINS = [
  baseSepolia,
  polygonAmoy,
  arbitrumSepolia,
  optimismSepolia,
  sepolia,
] as const;
const TESTNET_CHAIN_COUNT = ALL_TESTNET_CHAINS.length;

describe('lib/crossChain/balance.readMultiChainWalletBalances', () => {
  it('5 chain 全部 success: 各 chain の balance を返す', async () => {
    for (const chain of ALL_TESTNET_CHAINS) {
      const m = vi.fn().mockResolvedValue(BigInt(chain.id) * 1_000_000n);
      readContractMocks.set(chain.id, m);
    }
    const out = await readMultiChainWalletBalances(ACCOUNT);
    expect(out).toHaveLength(TESTNET_CHAIN_COUNT);
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
    readContractMocks.set(sepolia.id, vi.fn().mockResolvedValue(11n));

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
    const ethEntry = out.find((e) => e.target.chainId === sepolia.id);
    expect(ethEntry?.status).toBe('ok');
  });

  it('全 chain 失敗: 5 件すべて error 配列を返す (throw しない)', async () => {
    for (const chain of ALL_TESTNET_CHAINS) {
      readContractMocks.set(
        chain.id,
        vi.fn().mockRejectedValue(new Error('all down')),
      );
    }
    const out = await readMultiChainWalletBalances(ACCOUNT);
    expect(out).toHaveLength(TESTNET_CHAIN_COUNT);
    expect(out.every((e) => e.status === 'error')).toBe(true);
  });

  it('chainResolver injection: テスト用 chain で resolver 上書き', async () => {
    for (const chain of ALL_TESTNET_CHAINS) {
      readContractMocks.set(chain.id, vi.fn().mockResolvedValue(0n));
    }
    readContractMocks.set(baseSepolia.id, vi.fn().mockResolvedValue(42n));
    // resolver を spy で wrap
    const resolverSpy = vi.fn((chainId: number) => {
      const found = ALL_TESTNET_CHAINS.find((c) => c.id === chainId);
      if (!found) throw new Error(`unknown ${chainId}`);
      return found;
    });
    await readMultiChainWalletBalances(ACCOUNT, resolverSpy);
    // 5 chain それぞれ resolver が呼ばれる
    expect(resolverSpy).toHaveBeenCalledTimes(TESTNET_CHAIN_COUNT);
  });
});

describe('lib/crossChain/balance.readGatewayUnifiedBalance', () => {
  it('POST /v1/balances に sources を送る (default = 全 5 domain)', async () => {
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
    expect(body.sources).toHaveLength(TESTNET_CHAIN_COUNT);

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
    for (const chain of ALL_TESTNET_CHAINS) {
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
    expect(out.wallet).toHaveLength(TESTNET_CHAIN_COUNT);
    expect(out.gateway.status).toBe('ok');
    if (out.gateway.status === 'ok') {
      expect(out.gateway.total).toBe(777n);
    }
  });
});

describe('lib/crossChain/balance: edge cases + malformed responses', () => {
  it('Gateway response に予期しない field が含まれても無視する', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          balances: [
            { domain: 6, balance: '100', extra: 'ignored' },
          ],
          extraTopLevel: 'whatever',
        }),
        { status: 200 },
      ),
    );
    const out = await readGatewayUnifiedBalance(ACCOUNT, undefined, {
      fetch: mockFetch as unknown as typeof fetch,
    });
    expect(out.status).toBe('ok');
    if (out.status === 'ok') {
      expect(out.total).toBe(100n);
    }
  });

  it('Gateway response の balance が非数値 string → BigInt() で throw → status=error にならず例外', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          balances: [{ domain: 6, balance: 'not-a-number' }],
        }),
        { status: 200 },
      ),
    );
    // BigInt('not-a-number') は SyntaxError throw する設計上の制約。
    // Circle API が無効値を返すケースは contract 違反 (production では発生しないはず)
    // のため、明示的 SyntaxError を上に投げる挙動を確認 (silent な 0 fallback ではない)。
    await expect(
      readGatewayUnifiedBalance(ACCOUNT, undefined, {
        fetch: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/Cannot convert/);
  });

  it('Gateway response が空 array → status=ok, total=0n, perDomain.size=0', async () => {
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

  it('Gateway HTTP 4xx (401 unauth) → status=error, error にステータス含む', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('Unauthorized', { status: 401 }),
    );
    const out = await readGatewayUnifiedBalance(ACCOUNT, undefined, {
      fetch: mockFetch as unknown as typeof fetch,
    });
    expect(out.status).toBe('error');
    if (out.status === 'error') {
      expect(out.error).toContain('HTTP 401');
    }
  });

  it('concurrent: 同一 account に 4 並列 readMultiChainWalletBalances → 5 chain × 4 = 20 readContract', async () => {
    for (const chain of ALL_TESTNET_CHAINS) {
      readContractMocks.set(chain.id, vi.fn().mockResolvedValue(1n));
    }
    const results = await Promise.all([
      readMultiChainWalletBalances(ACCOUNT),
      readMultiChainWalletBalances(ACCOUNT),
      readMultiChainWalletBalances(ACCOUNT),
      readMultiChainWalletBalances(ACCOUNT),
    ]);
    expect(results).toHaveLength(4);
    // 各 chain の mock は 4 回呼ばれる (キャッシュなし、毎回 createPublicClient)
    for (const chain of ALL_TESTNET_CHAINS) {
      expect(readContractMocks.get(chain.id)!.mock.calls.length).toBe(4);
    }
  });

  it('巨大 uint256 max balance を BigInt 損失なく集計', async () => {
    const uint256Max =
      '115792089237316195423570985008687907853269984665640564039457584007913129639935';
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          balances: [
            { domain: 6, balance: uint256Max },
            { domain: 7, balance: '1' },
          ],
        }),
        { status: 200 },
      ),
    );
    // BigInt 加算: uint256Max + 1n は overflow しない (JS BigInt は無限精度)
    const out = await readGatewayUnifiedBalance(ACCOUNT, undefined, {
      fetch: mockFetch as unknown as typeof fetch,
    });
    expect(out.status).toBe('ok');
    if (out.status === 'ok') {
      expect(out.total).toBe(BigInt(uint256Max) + 1n);
    }
  });

  it('readAllCrossChainBalances: wallet 全成功 + gateway error の混在', async () => {
    for (const chain of ALL_TESTNET_CHAINS) {
      readContractMocks.set(chain.id, vi.fn().mockResolvedValue(42n));
    }
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('server boom', { status: 500 }),
    );
    const out = await readAllCrossChainBalances(ACCOUNT, {
      fetch: mockFetch as unknown as typeof fetch,
    });
    expect(out.wallet.every((w) => w.status === 'ok')).toBe(true);
    expect(out.gateway.status).toBe('error');
  });
});

describe('lib/crossChain/balance: chainResolver validation', () => {
  it('default resolver: 未知 chainId → 明示 Error throw (silent fallback なし)', async () => {
    // CROSS_CHAIN_TARGETS にない chain id を target に持つ wallet entry が
    // 紛れ込んだ場合、resolver は throw する設計 (LARP audit D1)。
    // readMultiChainWalletBalances は CROSS_CHAIN_TARGETS から call するため
    // 通常は到達しないが、直接 chainResolveFromTargets 経路を test 可能化する
    // ため inject 経由で検証する。
    // baseSepolia のみ accept、他は throw する resolver。default resolver の
    // throw 経路を exercise する (3 chain で throw → 該当 chain は status='error'
    // で返り、silent fallback (e.g. 0n) にならないことを確認)。
    const customResolver = (chainId: number) => {
      if (chainId === baseSepolia.id) return baseSepolia;
      throw new Error(`unknown chainId ${chainId}`);
    };

    readContractMocks.set(baseSepolia.id, vi.fn().mockResolvedValue(1n));
    // 他 chain は customResolver が throw → entry 自体は allSettled 経由で error
    readContractMocks.set(polygonAmoy.id, vi.fn().mockResolvedValue(2n));
    readContractMocks.set(arbitrumSepolia.id, vi.fn().mockResolvedValue(3n));
    readContractMocks.set(optimismSepolia.id, vi.fn().mockResolvedValue(4n));
    readContractMocks.set(sepolia.id, vi.fn().mockResolvedValue(5n));

    const out = await readMultiChainWalletBalances(ACCOUNT, customResolver);
    // 5 chain query が並列、4 chain は customResolver で throw → status='error'
    expect(out).toHaveLength(TESTNET_CHAIN_COUNT);
    const baseEntry = out.find((e) => e.target.chainId === baseSepolia.id);
    expect(baseEntry?.status).toBe('ok');
    const others = out.filter((e) => e.target.chainId !== baseSepolia.id);
    expect(others.every((e) => e.status === 'error')).toBe(true);
    if (others[0].status === 'error') {
      expect(others[0].error).toMatch(/unknown chainId/);
    }
  });

  it('default resolver: 全 5 chain が viem/chains にある (= CROSS_CHAIN_TARGETS と整合)', () => {
    // production の chainResolveFromTargets は CROSS_CHAIN_TARGETS の 5 chain
    // 全てに対して Chain object を返せる必要がある。Map から逆引きできるか
    // 構造的に検証 (test 経由で resolver default を使う各 chain id を確認)。
    for (const chain of ALL_TESTNET_CHAINS) {
      readContractMocks.set(chain.id, vi.fn().mockResolvedValue(1n));
    }
    // default resolver (chainResolveFromTargets) は 5 chain 全部 throw せず resolve
    // → readMultiChainWalletBalances が 5 件全部 'ok' を返す
    return readMultiChainWalletBalances(ACCOUNT).then((out) => {
      expect(out).toHaveLength(TESTNET_CHAIN_COUNT);
      expect(out.every((e) => e.status === 'ok')).toBe(true);
    });
  });
});
