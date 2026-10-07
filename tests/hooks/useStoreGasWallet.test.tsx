import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { custom } from 'viem';

// RPC は custom transport で受け、全リクエストを記録する (鍵がどの通信にも載らないことの確認用)。
const rpc = vi.hoisted(() => ({
  calls: [] as { method: string; params: unknown }[],
  balance: 10n ** 18n,
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
            case 'eth_estimateGas':
              return '0x5208'; // 21000
            case 'eth_maxPriorityFeePerGas':
              return '0x6fc23ac00';
            case 'eth_getBlockByNumber':
              return { baseFeePerGas: '0x3b9aca00', number: '0x1', timestamp: '0x1', transactions: [] };
            case 'eth_getTransactionCount':
              return '0x0';
            case 'eth_sendRawTransaction':
              return `0x${'ab'.repeat(32)}`;
            default:
              throw new Error(`unexpected ${method}`);
          }
        },
      }),
  };
});

import { useStoreGasWallet } from '@/hooks/useStoreGasWallet';
import { loadStoreGasWallet } from '@/lib/storeGasWallet';

describe('useStoreGasWallet', () => {
  beforeEach(() => {
    window.localStorage.clear();
    rpc.calls.length = 0;
    rpc.balance = 10n ** 18n;
  });

  it('作ると残高とガス価格を読む', async () => {
    const { result } = renderHook(() => useStoreGasWallet());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.wallet).toBeNull();
    act(() => {
      result.current.create();
    });
    await waitFor(() => expect(result.current.balance).toBe(10n ** 18n));
    expect(result.current.gasPrice).toBe(30n * 10n ** 9n);
  });

  it('残りの POL を戻す: 署名済み tx を送り、鍵はどの RPC リクエストにも載らない', async () => {
    const { result } = renderHook(() => useStoreGasWallet());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    act(() => {
      result.current.create();
    });
    const key = loadStoreGasWallet()!.privateKey;
    let res: Awaited<ReturnType<typeof result.current.withdraw>> | undefined;
    await act(async () => {
      res = await result.current.withdraw('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    });
    expect(res).toEqual({ ok: true, hash: `0x${'ab'.repeat(32)}` });
    expect(rpc.calls.some((c) => c.method === 'eth_sendRawTransaction')).toBe(true);
    const serialized = JSON.stringify(rpc.calls);
    expect(serialized).not.toContain(key.slice(2));
  });

  it('戻し先の形が違う・自分自身・ガス代で残りが無いときは送らない', async () => {
    const { result } = renderHook(() => useStoreGasWallet());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    act(() => {
      result.current.create();
    });
    const self = loadStoreGasWallet()!.address;
    await act(async () => {
      expect(await result.current.withdraw('0x123')).toEqual({ ok: false, reason: 'invalid_address' });
      expect(await result.current.withdraw(self)).toEqual({ ok: false, reason: 'same_address' });
    });
    rpc.balance = 1_000n;
    await act(async () => {
      expect(await result.current.withdraw('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toEqual({
        ok: false,
        reason: 'insufficient',
      });
    });
    expect(rpc.calls.some((c) => c.method === 'eth_sendRawTransaction')).toBe(false);
  });

  it('消すと鍵も残高表示も消える', async () => {
    const { result } = renderHook(() => useStoreGasWallet());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    act(() => {
      result.current.create();
    });
    act(() => {
      result.current.remove();
    });
    expect(result.current.wallet).toBeNull();
    expect(loadStoreGasWallet()).toBeNull();
  });
});
