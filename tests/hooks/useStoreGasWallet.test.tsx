import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { custom } from 'viem';

// RPC は custom transport で受け、全リクエストを記録する (鍵がどの通信にも載らないことの確認用)。
const TX = `0x${'ab'.repeat(32)}`;
const rpc = vi.hoisted(() => ({
  calls: [] as { method: string; params: unknown }[],
  balance: 10n ** 18n,
  code: '0x',
  receiptStatus: '0x1' as string | null,
}));
vi.mock('@/lib/chains', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chains')>();
  return {
    ...actual,
    transportForChain: () =>
      custom({
        async request({ method, params }: { method: string; params: unknown }) {
          rpc.calls.push({ method, params });
          switch (method) {
            case 'eth_chainId':
              return '0x13882'; // Amoy (testnet)
            case 'eth_getBalance':
              return `0x${rpc.balance.toString(16)}`;
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
  });

  it('作ると残高とガス価格を読み、鍵は戻り値に載らない', async () => {
    const { result } = await setup();
    await waitFor(() => expect(result.current.balance).toBe(10n ** 18n));
    expect(result.current.gasPrice).toBe(30n * 10n ** 9n);
    expect(JSON.stringify(result.current, (_, v) => (typeof v === 'bigint' ? String(v) : v))).not.toContain(
      JSON.parse(window.localStorage.getItem(STORE_GAS_WALLET_STORAGE_KEY)!).privateKey.slice(2),
    );
  });

  it('残りの POL を戻す: 確定 (receipt 成功) まで待って完了にし、鍵はどの RPC リクエストにも載らない', async () => {
    const { result } = await setup();
    const key = JSON.parse(window.localStorage.getItem(STORE_GAS_WALLET_STORAGE_KEY)!).privateKey as string;
    let res: unknown;
    await act(async () => {
      res = await result.current.withdraw(DEST);
    });
    expect(res).toEqual({ phase: 'confirmed', hash: TX });
    expect(result.current.withdrawStatus).toEqual({ phase: 'confirmed', hash: TX });
    expect(rpc.calls.some((c) => c.method === 'eth_sendRawTransaction')).toBe(true);
    expect(JSON.stringify(rpc.calls)).not.toContain(key.slice(2));
  });

  it('取り消された (revert) 送金は完了にしない', async () => {
    rpc.receiptStatus = '0x0';
    const { result } = await setup();
    await act(async () => {
      await result.current.withdraw(DEST);
    });
    expect(result.current.withdrawStatus).toEqual({ phase: 'reverted', hash: TX });
  });

  it.each([
    ['0x123', 'invalid_address'],
    ['0x833589FCD6eDb6E08f4c7C32D4f71b54bdA02913', 'invalid_address'], // checksum 誤り
    ['0x0000000000000000000000000000000000000000', 'zero_address'],
  ])('戻し先 %s は送らない (%s)', async (to, reason) => {
    const { result } = await setup();
    await act(async () => {
      await result.current.withdraw(to);
    });
    expect(result.current.withdrawStatus).toEqual({ phase: 'rejected', reason });
    expect(rpc.calls.some((c) => c.method === 'eth_sendRawTransaction')).toBe(false);
  });

  it('自分自身・コントラクト・ガス代で残りが無いときは送らない', async () => {
    const { result } = await setup();
    const self = result.current.address!;
    await act(async () => {
      expect(await result.current.withdraw(self)).toEqual({ phase: 'rejected', reason: 'same_address' });
    });
    rpc.code = '0x6080';
    await act(async () => {
      expect(await result.current.withdraw(DEST)).toEqual({ phase: 'rejected', reason: 'contract_recipient' });
    });
    rpc.code = '0x';
    rpc.balance = 1_000n;
    await act(async () => {
      expect(await result.current.withdraw(DEST)).toEqual({ phase: 'rejected', reason: 'insufficient' });
    });
    expect(rpc.calls.some((c) => c.method === 'eth_sendRawTransaction')).toBe(false);
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
