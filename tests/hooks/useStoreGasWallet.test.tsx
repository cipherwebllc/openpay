import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { custom } from 'viem';

// RPC は custom transport で受け、全リクエストを記録する (鍵がどの通信にも載らないことの確認用)。
const TX = `0x${'ab'.repeat(32)}`;
const rpc = vi.hoisted(() => ({
  calls: [] as { chainId: number; method: string; params: unknown }[],
  balance: 10n ** 18n,
  balanceByChain: {} as Record<number, bigint>,
  failChains: new Set<number>(),
  code: '0x',
  receiptStatus: '0x1' as string | null,
  chainIds: [80002] as number[],
  // この宛先の残高の応答を止める (古い鍵の読み取りが遅れて返る競合の再現用)。
  hold: null as { address: string; gate: Promise<void> } | null,
}));
// 対象のチェーン (既定は Amoy だけ・複数チェーンのテストで差し替える)。
vi.mock('@/lib/storeDevicePayment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/storeDevicePayment')>()),
  storeDeviceChainIds: () => rpc.chainIds,
}));
vi.mock('@/lib/chains', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chains')>();
  return {
    ...actual,
    transportForChain: (chainId: number) =>
      custom({
        async request({ method, params }: { method: string; params: unknown }) {
          rpc.calls.push({ chainId, method, params });
          if (rpc.failChains.has(chainId)) throw new Error('rpc down');
          switch (method) {
            case 'eth_chainId':
              return `0x${chainId.toString(16)}`;
            case 'eth_getBalance': {
              const hold = rpc.hold;
              if (hold && String((params as unknown[])[0]).toLowerCase() === hold.address.toLowerCase()) {
                await hold.gate;
                return '0x0';
              }
              return `0x${(rpc.balanceByChain[chainId] ?? rpc.balance).toString(16)}`;
            }
            case 'eth_gasPrice':
              return '0x6fc23ac00'; // 30 gwei
            case 'eth_getCode':
              return rpc.code;
            case 'eth_maxPriorityFeePerGas':
              return '0x6fc23ac00';
            case 'eth_getBlockByNumber':
              return { baseFeePerGas: '0x3b9aca00', number: '0x1', timestamp: '0x1', transactions: [] };
            case 'eth_blockNumber':
              return '0x2';
            case 'eth_getTransactionCount':
              return '0x0';
            case 'eth_sendRawTransaction':
              return TX;
            case 'eth_getTransactionReceipt':
              return rpc.receiptStatus === null
                ? null
                : {
                    status: rpc.receiptStatus,
                    transactionHash: TX,
                    blockHash: `0x${'cd'.repeat(32)}`,
                    blockNumber: '0x1',
                    transactionIndex: '0x0',
                    from: '0x0000000000000000000000000000000000000001',
                    to: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
                    cumulativeGasUsed: '0x5208',
                    gasUsed: '0x5208',
                    effectiveGasPrice: '0x1',
                    contractAddress: null,
                    logs: [],
                    logsBloom: `0x${'0'.repeat(512)}`,
                    type: '0x2',
                  };
            default:
              throw new Error(`unexpected ${method}`);
          }
        },
      }),
  };
});

import { useStoreGasWallet } from '@/hooks/useStoreGasWallet';
import { STORE_GAS_WALLET_STORAGE_KEY } from '@/lib/storeGasWallet';

const DEST = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

async function setup() {
  const hook = renderHook(() => useStoreGasWallet());
  await waitFor(() => expect(hook.result.current.hydrated).toBe(true));
  await act(async () => {
    await hook.result.current.create();
  });
  return hook;
}

describe('useStoreGasWallet', () => {
  beforeEach(() => {
    window.localStorage.clear();
    rpc.calls.length = 0;
    rpc.balance = 10n ** 18n;
    rpc.code = '0x';
    rpc.receiptStatus = '0x1';
    rpc.chainIds = [80002];
    rpc.balanceByChain = {};
    rpc.failChains = new Set();
    rpc.hold = null;
  });

  it('作ると残高とガス価格を読み、鍵は戻り値に載らない', async () => {
    const { result } = await setup();
    await waitFor(() => expect(result.current.chains[0]?.balance).toBe(10n ** 18n));
    expect(result.current.chains[0]).toMatchObject({ chainId: 80002, gasPrice: 30n * 10n ** 9n, readFailed: false });
    expect(JSON.stringify(result.current, (_, v) => (typeof v === 'bigint' ? String(v) : v))).not.toContain(
      JSON.parse(window.localStorage.getItem(STORE_GAS_WALLET_STORAGE_KEY)!).privateKey.slice(2),
    );
  });

  it('残りを戻す: 確定 (receipt 成功) まで待って完了にし、鍵はどの RPC リクエストにも載らない', async () => {
    const { result } = await setup();
    const key = JSON.parse(window.localStorage.getItem(STORE_GAS_WALLET_STORAGE_KEY)!).privateKey as string;
    let res: unknown;
    await act(async () => {
      res = await result.current.withdraw(80002, DEST);
    });
    expect(res).toEqual({ phase: 'confirmed', chainId: 80002, hash: TX });
    expect(result.current.withdrawStatus).toEqual({ phase: 'confirmed', chainId: 80002, hash: TX });
    expect(rpc.calls.some((c) => c.method === 'eth_sendRawTransaction')).toBe(true);
    expect(JSON.stringify(rpc.calls)).not.toContain(key.slice(2));
  });

  it('取り消された (revert) 送金は完了にしない', async () => {
    rpc.receiptStatus = '0x0';
    const { result } = await setup();
    await act(async () => {
      await result.current.withdraw(80002, DEST);
    });
    expect(result.current.withdrawStatus).toEqual({ phase: 'reverted', chainId: 80002, hash: TX });
  });

  it.each([
    ['0x123', 'invalid_address'],
    ['0x833589FCD6eDb6E08f4c7C32D4f71b54bdA02913', 'invalid_address'], // checksum 誤り
    ['0x0000000000000000000000000000000000000000', 'zero_address'],
  ])('戻し先 %s は送らない (%s)', async (to, reason) => {
    const { result } = await setup();
    await act(async () => {
      await result.current.withdraw(80002, to);
    });
    expect(result.current.withdrawStatus).toEqual({ phase: 'rejected', reason });
    expect(rpc.calls.some((c) => c.method === 'eth_sendRawTransaction')).toBe(false);
  });

  it('自分自身・コントラクト・ガス代で残りが無いときは送らない', async () => {
    const { result } = await setup();
    const self = result.current.address!;
    await act(async () => {
      expect(await result.current.withdraw(80002, self)).toEqual({ phase: 'rejected', reason: 'same_address' });
    });
    rpc.code = '0x6080';
    await act(async () => {
      expect(await result.current.withdraw(80002, DEST)).toEqual({ phase: 'rejected', reason: 'contract_recipient' });
    });
    rpc.code = '0x';
    rpc.balance = 1_000n;
    await act(async () => {
      expect(await result.current.withdraw(80002, DEST)).toEqual({ phase: 'rejected', reason: 'insufficient' });
    });
    expect(rpc.calls.some((c) => c.method === 'eth_sendRawTransaction')).toBe(false);
  });

  it('「不明」の間は宛先の入力ミスで状態を上書きせず、消せないまま (届いたか分からない送金の鍵を消させない)', async () => {
    rpc.receiptStatus = null; // receipt が見つからない → 確定待ちの時間切れ → 不明
    const { result } = await setup();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let pending: Promise<unknown> = Promise.resolve();
      act(() => {
        pending = result.current.withdraw(80002, DEST);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
        await pending;
      });
    } finally {
      vi.useRealTimers();
    }
    expect(result.current.withdrawStatus).toEqual({ phase: 'unknown', chainId: 80002, hash: TX });
    expect(result.current.removeBlocked).toBe(true);
    await act(async () => {
      await result.current.withdraw(80002, '0x123');
    });
    expect(result.current.withdrawStatus).toEqual({ phase: 'unknown', chainId: 80002, hash: TX });
    expect(result.current.removeBlocked).toBe(true);
    await act(async () => {
      expect(await result.current.remove()).toBe(false);
    });
    // 残高を更新して receipt が見つかれば、確定に変わり消せるようになる
    rpc.receiptStatus = '0x1';
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.withdrawStatus).toEqual({ phase: 'confirmed', chainId: 80002, hash: TX });
    expect(result.current.removeBlocked).toBe(false);
  });

  it('複数チェーン: 残高はチェーンごと・1 つのチェーンの RPC 障害は他のチェーンを隠さない', async () => {
    rpc.chainIds = [80002, 1001];
    rpc.balanceByChain = { 80002: 10n ** 18n, 1001: 2n * 10n ** 18n };
    rpc.failChains = new Set([80002]);
    const { result } = await setup();
    // 落ちたチェーンの再試行 (viem・約 1 秒) を待たずに、読めたチェーンの残高を出す
    await waitFor(() => expect(result.current.chains[1]?.balance).toBe(2n * 10n ** 18n));
    expect(result.current.chains[0]).toMatchObject({ chainId: 80002, balance: null, readFailed: false });
    await waitFor(() => expect(result.current.chains[0]?.readFailed).toBe(true), { timeout: 5_000 });
    expect(result.current.chains[0]).toMatchObject({ chainId: 80002, balance: null });
    expect(result.current.chains[1]).toMatchObject({ chainId: 1001, readFailed: false });
  });

  it('複数チェーン: 残りを戻すのは選んだチェーンだけ (同じアドレスでも別のチェーンの残高に触れない)', async () => {
    rpc.chainIds = [80002, 1001];
    const { result } = await setup();
    rpc.calls.length = 0;
    await act(async () => {
      expect(await result.current.withdraw(1001, DEST)).toEqual({ phase: 'confirmed', chainId: 1001, hash: TX });
    });
    const sends = rpc.calls.filter((c) => c.method === 'eth_sendRawTransaction');
    expect(sends.map((c) => c.chainId)).toEqual([1001]);
    // いまのネットワークに無いチェーン (testnet で Polygon mainnet) には送らない
    await act(async () => {
      expect(await result.current.withdraw(137, DEST)).toEqual({ phase: 'rejected', reason: 'read_failed' });
    });
  });

  it('新しい会計に使えないチェーン (設定から外した・a1 の点灯) も、残高を読み、残りを戻せる', async () => {
    rpc.chainIds = [80002]; // Kairos・Fuji は使えない
    rpc.balanceByChain = { 80002: 0n, 1001: 3n * 10n ** 18n, 43113: 0n };
    const { result } = await setup();
    await waitFor(() => expect(result.current.chains.find((c) => c.chainId === 1001)?.balance).toBe(3n * 10n ** 18n));
    expect(result.current.chains.map((c) => [c.chainId, c.active])).toEqual([[80002, true], [1001, false], [43113, false]]);
    await act(async () => {
      expect(await result.current.withdraw(1001, DEST)).toEqual({ phase: 'confirmed', chainId: 1001, hash: TX });
    });
  });

  it('読み取りに失敗しても、前に読めた残高は残す (消す前の「先に戻して」を失わない)', async () => {
    const { result } = await setup();
    await waitFor(() => expect(result.current.chains[0]?.balance).toBe(10n ** 18n));
    rpc.failChains = new Set([80002]);
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.chains[0]).toMatchObject({ chainId: 80002, balance: 10n ** 18n, readFailed: true });
  });

  it('作り直した後に、古い鍵の読み取りが遅れて返っても新しい鍵の残高に書かない', async () => {
    const { result } = await setup();
    await waitFor(() => expect(result.current.chains[0]?.balance).toBe(10n ** 18n));
    const oldAddress = result.current.address!;
    let release!: () => void;
    rpc.hold = { address: oldAddress, gate: new Promise<void>((r) => { release = r; }) };
    let stale: Promise<void> = Promise.resolve();
    act(() => {
      stale = result.current.refresh();
    });
    await act(async () => {
      expect(await result.current.remove()).toBe(true);
    });
    rpc.balance = 7n * 10n ** 18n;
    await act(async () => {
      await result.current.create();
    });
    await waitFor(() => expect(result.current.chains[0]?.balance).toBe(7n * 10n ** 18n));
    expect(result.current.address).not.toBe(oldAddress);
    await act(async () => {
      release();
      await stale;
    });
    expect(result.current.chains[0]?.balance).toBe(7n * 10n ** 18n);
  });

  it('消すと鍵も残高表示も消える', async () => {
    const { result } = await setup();
    await act(async () => {
      expect(await result.current.remove()).toBe(true);
    });
    expect(result.current.walletState).toEqual({ state: 'none' });
    expect(window.localStorage.getItem(STORE_GAS_WALLET_STORAGE_KEY)).toBeNull();
  });
});
