// lib/jpyc/live の境界と隔離 (掟 13: 1 チェーンの障害を隣へ波及させない) を viem 境界 mock で固定。
// SUT は実コード。createPublicClient を chainId ごとに差し替える (tests/lib/walletBalances と同型)。

import { describe, it, expect, vi, beforeEach } from 'vitest';

type ClientMock = {
  getBlockNumber: ReturnType<typeof vi.fn>;
  readContract: ReturnType<typeof vi.fn>;
  getLogs: ReturnType<typeof vi.fn>;
};
const clients = new Map<number, ClientMock>();

vi.mock('viem', async () => {
  const actual = await vi.importActual<typeof import('viem')>('viem');
  return {
    ...actual,
    createPublicClient: vi.fn((opts: { chain: { id: number } }) => {
      const c = clients.get(opts.chain.id);
      if (!c) throw new Error(`test setup: no client mock for chainId ${opts.chain.id}`);
      return c;
    }),
  };
});

import { JPYC_CHAINS, chainForSlug } from '@/lib/chains';
import {
  TRANSFERS_DEFAULT_LIMIT,
  TRANSFERS_MAX_LIMIT,
  TRANSFER_WINDOW_BLOCKS,
  allFailed,
  parseAddressParam,
  parseChainParam,
  parseLimitParam,
  parseOptionalAddressParam,
  parseRequiredChainParam,
  readBalance,
  readSupply,
  readTransfers,
} from '@/lib/jpyc/live';

const ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const OTHER = '0x9A76ea8Fc0b9f34D34b91d453F2940932C9a7FE0';

function okClient(over: Partial<ClientMock> = {}): ClientMock {
  return {
    getBlockNumber: vi.fn().mockResolvedValue(1_000_000n),
    readContract: vi.fn().mockResolvedValue(5n * 10n ** 18n),
    getLogs: vi.fn().mockResolvedValue([]),
    ...over,
  };
}

function setAll(factory: () => ClientMock = okClient) {
  for (const slug of JPYC_CHAINS) clients.set(chainForSlug(slug).id, factory());
}

beforeEach(() => {
  clients.clear();
});

describe('入力検証 (純関数)', () => {
  it('chain: 省略=全チェーン・既知=1 件・未知=null (大文字は許容)', () => {
    expect(parseChainParam(null)).toEqual([...JPYC_CHAINS]);
    expect(parseChainParam('')).toEqual([...JPYC_CHAINS]);
    expect(parseChainParam('POLYGON')).toEqual(['polygon']);
    expect(parseChainParam('solana')).toBeNull();
    expect(parseRequiredChainParam(null)).toBeNull();
    expect(parseRequiredChainParam('kaia')).toBe('kaia');
  });

  it('address: 必須版は省略も不正も null・任意版は省略 undefined / 不正 null', () => {
    expect(parseAddressParam(null)).toBeNull();
    expect(parseAddressParam('0x123')).toBeNull();
    expect(parseAddressParam(ADDR)).toBe(ADDR);
    expect(parseOptionalAddressParam(null)).toBeUndefined();
    expect(parseOptionalAddressParam('nope')).toBeNull();
    expect(parseOptionalAddressParam(ADDR)).toBe(ADDR);
  });

  it('limit: 省略=既定・0/負/小数/文字=null・上限超は丸める', () => {
    expect(parseLimitParam(null)).toBe(TRANSFERS_DEFAULT_LIMIT);
    expect(parseLimitParam('1')).toBe(1);
    expect(parseLimitParam('0')).toBeNull();
    expect(parseLimitParam('-1')).toBeNull();
    expect(parseLimitParam('1.5')).toBeNull();
    expect(parseLimitParam('abc')).toBeNull();
    expect(parseLimitParam(String(TRANSFERS_MAX_LIMIT + 1))).toBe(TRANSFERS_MAX_LIMIT);
  });

  it('走査窓は全 JPYC チェーンに定義され、正の有限値', () => {
    for (const slug of ['polygon', 'kaia', 'avalanche', 'ethereum'] as const) {
      expect(TRANSFER_WINDOW_BLOCKS[slug]).toBeGreaterThan(0n);
    }
  });
});

describe('readSupply / readBalance', () => {
  it('全チェーン ok: totalSupply と blockNumber を文字列で返す (BigInt を JSON に漏らさない)', async () => {
    setAll();
    const rows = await readSupply(JPYC_CHAINS);
    expect(rows).toHaveLength(JPYC_CHAINS.length);
    for (const r of rows) {
      expect(r.status).toBe('ok');
      if (r.status === 'ok') {
        expect(r.totalSupply).toBe((5n * 10n ** 18n).toString());
        expect(r.totalSupplyFormatted).toBe('5');
        expect(r.blockNumber).toBe('1000000');
      }
    }
    expect(() => JSON.stringify(rows)).not.toThrow();
  });

  it('1 チェーンが reject → その行だけ error・他は ok (隣へ波及させない)', async () => {
    setAll();
    const bad = chainForSlug(JPYC_CHAINS[0]).id;
    clients.set(bad, okClient({ readContract: vi.fn().mockRejectedValue(new Error('boom')) }));
    const rows = await readBalance(ADDR, JPYC_CHAINS);
    const failed = rows.filter((r) => r.status === 'error');
    expect(failed).toHaveLength(1);
    expect(failed[0].chainId).toBe(bad);
    expect(rows.filter((r) => r.status === 'ok')).toHaveLength(JPYC_CHAINS.length - 1);
    expect(allFailed(rows)).toBe(false);
  });

  it('1 チェーンが hang → timeout で error になり全体は返る', async () => {
    setAll();
    const hang = chainForSlug(JPYC_CHAINS[0]).id;
    clients.set(hang, okClient({ getBlockNumber: vi.fn(() => new Promise(() => {})) }));
    vi.useFakeTimers();
    try {
      const p = readSupply(JPYC_CHAINS);
      await vi.advanceTimersByTimeAsync(5_100);
      const rows = await p;
      expect(rows.find((r) => r.chainId === hang)?.status).toBe('error');
    } finally {
      vi.useRealTimers();
    }
  });

  it('全チェーン失敗は allFailed=true (route が 503 にする根拠)', async () => {
    setAll(() => okClient({ readContract: vi.fn().mockRejectedValue(new Error('down')) }));
    const rows = await readSupply(JPYC_CHAINS);
    expect(allFailed(rows)).toBe(true);
  });

  it('balanceOf は指定アドレス引数で呼ばれる', async () => {
    setAll();
    await readBalance(ADDR, [JPYC_CHAINS[0]]);
    const c = clients.get(chainForSlug(JPYC_CHAINS[0]).id)!;
    expect(c.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'balanceOf', args: [ADDR] }),
    );
  });
});

describe('readTransfers', () => {
  const log = (block: bigint, idx: number, from: string, to: string, value: bigint) => ({
    blockNumber: block,
    logIndex: idx,
    transactionHash: `0x${block.toString(16).padStart(64, '0')}`,
    args: { from, to, value },
  });

  it('固定窓で getLogs し、新しい順・limit 件で返す', async () => {
    setAll(() =>
      okClient({
        getLogs: vi.fn().mockResolvedValue([
          log(999_990n, 1, ADDR, OTHER, 1n * 10n ** 18n),
          log(999_999n, 0, OTHER, ADDR, 2n * 10n ** 18n),
          log(999_999n, 3, ADDR, OTHER, 3n * 10n ** 18n),
        ]),
      }),
    );
    const slug = JPYC_CHAINS[0];
    const r = await readTransfers(slug, { limit: 2 });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.toBlock).toBe('1000000');
    expect(BigInt(r.toBlock) - BigInt(r.fromBlock)).toBe(TRANSFER_WINDOW_BLOCKS[slug]);
    expect(r.items.map((i) => i.valueFormatted)).toEqual(['3', '2']);
    const c = clients.get(chainForSlug(slug).id)!;
    expect(c.getLogs).toHaveBeenCalledTimes(1);
    expect(c.getLogs.mock.calls[0][0]).toEqual(
      expect.objectContaining({ fromBlock: 1_000_000n - TRANSFER_WINDOW_BLOCKS[slug], toBlock: 1_000_000n }),
    );
  });

  it('address 指定は from/to の 2 クエリを和集合し重複を除く', async () => {
    const dup = log(999_999n, 0, ADDR, ADDR, 1n);
    setAll(() => okClient({ getLogs: vi.fn().mockResolvedValue([dup]) }));
    const slug = JPYC_CHAINS[0];
    const r = await readTransfers(slug, { limit: 10, address: ADDR });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.items).toHaveLength(1);
    const c = clients.get(chainForSlug(slug).id)!;
    expect(c.getLogs).toHaveBeenCalledTimes(2);
    expect(c.getLogs.mock.calls[0][0]).toEqual(expect.objectContaining({ args: { from: ADDR } }));
    expect(c.getLogs.mock.calls[1][0]).toEqual(expect.objectContaining({ args: { to: ADDR } }));
  });

  it('RPC 失敗は throw せず status=error で返す', async () => {
    setAll(() => okClient({ getLogs: vi.fn().mockRejectedValue(new Error('rate limited')) }));
    const r = await readTransfers(JPYC_CHAINS[0], { limit: 5 });
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.error).toContain('rate limited');
  });
});
