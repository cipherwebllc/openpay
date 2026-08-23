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
  TRANSFER_CHUNK_BLOCKS,
  TRANSFER_WINDOW_BLOCKS,
  allFailed,
  formatCursor,
  parseAddressParam,
  parseChainParam,
  parseCursorParam,
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

  it('limit: 省略=既定・0/負/小数/文字=null・上限超も null (Schema の契約と一致・黙って丸めない)', () => {
    expect(parseLimitParam(null)).toBe(TRANSFERS_DEFAULT_LIMIT);
    expect(parseLimitParam('1')).toBe(1);
    expect(parseLimitParam(String(TRANSFERS_MAX_LIMIT))).toBe(TRANSFERS_MAX_LIMIT);
    expect(parseLimitParam('0')).toBeNull();
    expect(parseLimitParam('-1')).toBeNull();
    expect(parseLimitParam('1.5')).toBeNull();
    expect(parseLimitParam('abc')).toBeNull();
    expect(parseLimitParam(String(TRANSFERS_MAX_LIMIT + 1))).toBeNull();
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
    const failed = rows.filter((r) => r.status === 'unavailable');
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
      expect(rows.find((r) => r.chainId === hang)?.status).toBe('unavailable');
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

  // 公開 RPC の範囲制限 (drpc ≈100 ブロック) に合わせ、窓を 100 ブロックのチャンクで新しい順に読む。
  // mock は「要求範囲に含まれる log だけ返す」= 実 RPC と同じ振る舞い。
  const ALL_LOGS = [
    log(999_990n, 1, ADDR, OTHER, 1n * 10n ** 18n),
    log(999_999n, 0, OTHER, ADDR, 2n * 10n ** 18n),
    log(999_999n, 3, ADDR, OTHER, 3n * 10n ** 18n),
    log(999_500n, 0, ADDR, OTHER, 4n * 10n ** 18n),
  ];
  const rangedGetLogs = () =>
    vi.fn(async (q: { fromBlock: bigint; toBlock: bigint }) =>
      ALL_LOGS.filter((l) => l.blockNumber >= q.fromBlock && l.blockNumber <= q.toBlock),
    );

  it('窓を ≤100 ブロックのチャンクで新しい順に読み、limit に達したら残りを読まない', async () => {
    setAll(() => okClient({ getLogs: rangedGetLogs() }));
    const slug = JPYC_CHAINS[0];
    const r = await readTransfers(slug, { limit: 2 });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.toBlock).toBe('1000000');
    expect(BigInt(r.toBlock) - BigInt(r.fromBlock)).toBe(TRANSFER_WINDOW_BLOCKS[slug]);
    expect(r.items.map((i) => i.valueFormatted)).toEqual(['3', '2']);
    const c = clients.get(chainForSlug(slug).id)!;
    const totalChunks = Number(TRANSFER_WINDOW_BLOCKS[slug] / TRANSFER_CHUNK_BLOCKS) + 1;
    expect(c.getLogs.mock.calls.length).toBeLessThan(totalChunks); // 早期終了
    for (const [q] of c.getLogs.mock.calls as [{ fromBlock: bigint; toBlock: bigint }][]) {
      expect(q.toBlock - q.fromBlock + 1n).toBeLessThanOrEqual(TRANSFER_CHUNK_BLOCKS);
      expect(q.toBlock).toBeLessThanOrEqual(1_000_000n);
      expect(q.fromBlock).toBeGreaterThanOrEqual(1_000_000n - TRANSFER_WINDOW_BLOCKS[slug]);
    }
    // 最初のチャンクは最新ブロックから
    expect((c.getLogs.mock.calls[0][0] as { toBlock: bigint }).toBlock).toBe(1_000_000n);
  });

  it('limit に満たなければ窓全体を読み切り、窓外の log は含めない', async () => {
    setAll(() => okClient({ getLogs: rangedGetLogs() }));
    const slug = JPYC_CHAINS[0];
    const r = await readTransfers(slug, { limit: 100 });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const inWindow = ALL_LOGS.filter((l) => l.blockNumber >= 1_000_000n - TRANSFER_WINDOW_BLOCKS[slug]);
    expect(r.items).toHaveLength(inWindow.length);
    expect(r.items.map((i) => i.valueFormatted)).toEqual(['3', '2', '1', '4'].slice(0, inWindow.length));
    const c = clients.get(chainForSlug(slug).id)!;
    expect(c.getLogs.mock.calls.length).toBe(Number(TRANSFER_WINDOW_BLOCKS[slug] / TRANSFER_CHUNK_BLOCKS) + 1);
  });

  it('address 指定はチャンクごとに from/to の 2 クエリを和集合し重複を除く', async () => {
    const dup = log(999_999n, 0, ADDR, ADDR, 1n);
    setAll(() =>
      okClient({
        getLogs: vi.fn(async (q: { fromBlock: bigint; toBlock: bigint }) =>
          dup.blockNumber >= q.fromBlock && dup.blockNumber <= q.toBlock ? [dup] : [],
        ),
      }),
    );
    const slug = JPYC_CHAINS[0];
    const r = await readTransfers(slug, { limit: 10, address: ADDR });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.items).toHaveLength(1);
    const c = clients.get(chainForSlug(slug).id)!;
    expect(c.getLogs.mock.calls.length % 2).toBe(0);
    expect(c.getLogs.mock.calls[0][0]).toEqual(expect.objectContaining({ args: { from: ADDR } }));
    expect(c.getLogs.mock.calls[1][0]).toEqual(expect.objectContaining({ args: { to: ADDR } }));
  });

  // cursor (P2): 「(block, logIndex) までは見た」を渡すと、それより新しい Transfer だけを返す。
  it('cursor: 形式検証 (省略 undefined / 不正 null / "<block>:<logIndex>" と -1 を受理)', () => {
    expect(parseCursorParam(null)).toBeUndefined();
    expect(parseCursorParam('')).toBeUndefined();
    expect(parseCursorParam('abc')).toBeNull();
    expect(parseCursorParam('12:')).toBeNull();
    expect(parseCursorParam('12:-2')).toBeNull();
    expect(parseCursorParam('999999:3')).toEqual({ block: 999_999n, logIndex: 3 });
    expect(parseCursorParam('999999:-1')).toEqual({ block: 999_999n, logIndex: -1 });
    expect(formatCursor({ block: 5n, logIndex: -1 })).toBe('5:-1');
  });

  it('delta (cursor あり): cursor より新しい分だけを**古い順**に返し、同一 block は logIndex で厳密比較・nextCursor は返した最新位置', async () => {
    setAll(() => okClient({ getLogs: rangedGetLogs() }));
    const slug = JPYC_CHAINS[0];
    // ALL_LOGS: (999999,3) (999999,0) (999990,1) (999500,0)。cursor=(999990,1) → (999999,0) (999999,3) を古い順
    const r = await readTransfers(slug, { limit: 100, cursor: { block: 999_990n, logIndex: 1 } });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.items.map((i) => `${i.blockNumber}:${i.logIndex}`)).toEqual(['999999:0', '999999:3']);
    expect(r.nextCursor).toBe('999999:3');
    expect(r.hasMore).toBe(false);
    expect(r.truncated).toBe(false);
    // 走査は cursor.block から上向き (それより古い block のチャンクは読まない・最初のチャンクが最古)
    const c = clients.get(chainForSlug(slug).id)!;
    const calls = c.getLogs.mock.calls as [{ fromBlock: bigint; toBlock: bigint }][];
    expect(calls[0][0].fromBlock).toBe(999_990n);
    for (const [q] of calls) expect(q.fromBlock).toBeGreaterThanOrEqual(999_990n);
  });

  it('delta: 件数 > limit でも取りこぼさない (limit=1 で 2 回に分けて全件回収・hasMore で継続)', async () => {
    setAll(() => okClient({ getLogs: rangedGetLogs() }));
    const slug = JPYC_CHAINS[0];
    const first = await readTransfers(slug, { limit: 1, cursor: { block: 999_990n, logIndex: 1 } });
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') return;
    expect(first.items.map((i) => `${i.blockNumber}:${i.logIndex}`)).toEqual(['999999:0']); // 最古から
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe('999999:0');
    const second = await readTransfers(slug, { limit: 1, cursor: parseCursorParam(first.nextCursor)! });
    expect(second.status).toBe('ok');
    if (second.status !== 'ok') return;
    expect(second.items.map((i) => `${i.blockNumber}:${i.logIndex}`)).toEqual(['999999:3']);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBe('999999:3');
  });

  it('delta: 何も無ければ items 空・nextCursor は "toBlock:-1" (次回も差分だけ)・hasMore=false', async () => {
    setAll(() => okClient({ getLogs: rangedGetLogs() }));
    const r = await readTransfers(JPYC_CHAINS[0], { limit: 20, cursor: { block: 999_999n, logIndex: 3 } });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.items).toEqual([]);
    expect(r.nextCursor).toBe('1000000:-1');
    expect(r.hasMore).toBe(false);
    expect(r.truncated).toBe(false);
  });

  it('delta: nextCursor は入力 cursor より後退しない (同一 block で 0 件でも既読ログを再取得させない)', async () => {
    setAll(() => okClient({ getLogs: rangedGetLogs() }));
    // toBlock=1000000 と同じ block を cursor に渡し 0 件 → (1000000,-1) < (1000000,5) なので入力を維持
    const r = await readTransfers(JPYC_CHAINS[0], { limit: 20, cursor: { block: 1_000_000n, logIndex: 5 } });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.items).toEqual([]);
    expect(r.nextCursor).toBe('1000000:5');
  });

  it('snapshot (cursor なし): hasMore は「窓内に limit より多い」を表し、nextCursor は最新位置', async () => {
    setAll(() => okClient({ getLogs: rangedGetLogs() }));
    const slug = JPYC_CHAINS[0];
    const r = await readTransfers(slug, { limit: 2 });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.items.map((i) => i.valueFormatted)).toEqual(['3', '2']); // 新しい順
    expect(r.hasMore).toBe(true); // 窓内にあと (999990,1) (999500,0)
    expect(r.nextCursor).toBe('999999:3');
  });

  it('cursor が走査窓より古いと truncated=true (窓の下端までしか読まない)', async () => {
    setAll(() => okClient({ getLogs: rangedGetLogs() }));
    const slug = JPYC_CHAINS[0];
    const r = await readTransfers(slug, { limit: 100, cursor: { block: 1n, logIndex: -1 } });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.truncated).toBe(true);
    expect(BigInt(r.fromBlock)).toBe(1_000_000n - TRANSFER_WINDOW_BLOCKS[slug]);
    // delta は古い順
    expect(r.items.map((i) => i.valueFormatted)).toEqual(['4', '1', '2', '3'].slice(4 - r.items.length));
    const c = clients.get(chainForSlug(slug).id)!;
    for (const [q] of c.getLogs.mock.calls as [{ fromBlock: bigint }][]) {
      expect(q.fromBlock).toBeGreaterThanOrEqual(BigInt(r.fromBlock));
    }
  });

  it('RPC 失敗は throw せず status=error で返す', async () => {
    setAll(() => okClient({ getLogs: vi.fn().mockRejectedValue(new Error('rate limited')) }));
    const r = await readTransfers(JPYC_CHAINS[0], { limit: 5 });
    expect(r.status).toBe('unavailable');
    if (r.status === 'unavailable') {
      // 生のメッセージ ('rate limited' や RPC URL) は応答に出さず、分類コードだけを返す
      expect(r.errorCode).toBe('rpc_unavailable');
      expect(r.retryable).toBe(true);
      expect(JSON.stringify(r)).not.toContain('rate limited');
    }
  });
});
