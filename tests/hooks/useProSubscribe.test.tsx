// useProSubscribe の耐久性 (Codex P1) を検証: 送金確定後の {txHash, chainId, wallet} を
// localStorage に保存し、再マウント (リロード相当) で同 wallet の pending を自動 claim する。
// wagmi と fetch のみ境界モックし、resume ロジックは実コードを通す。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const WALLET = '0x000000000000000000000000000000000000aBcD';
const PENDING_KEY = 'openpay:pro:pendingTx';
const TX = ('0x' + 'a'.repeat(64)) as `0x${string}`;

// wagmi: 接続 wallet を返し、送金系は idle (resume パスのみを駆動)。
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: WALLET, chainId: 137 }),
  useWriteContract: () => ({
    data: undefined,
    isPending: false,
    error: null,
    reset: vi.fn(),
    writeContract: vi.fn(),
  }),
  useWaitForTransactionReceipt: () => ({
    data: undefined,
    isSuccess: false,
    isError: false,
    error: null,
  }),
}));

import { useProSubscribe } from '@/hooks/useProSubscribe';

const deployment = { address: '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29' } as never;

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('useProSubscribe 耐久性 (リロード後 resume)', () => {
  it('同 wallet の pending を再マウントで自動 claim → 成功で localStorage を消す', async () => {
    window.localStorage.setItem(
      PENDING_KEY,
      JSON.stringify({ txHash: TX, chainId: 137, wallet: WALLET }),
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, wallet: WALLET, expiresAt: 1_800_000_000_000 }),
        { status: 200 },
      ),
    );

    const { result } = renderHook(() => useProSubscribe(deployment), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // 永続化された txHash + chainId で subscribe された (live chainId ではなく保存値)。
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ txHash: TX, chainId: 137 });
    // 付与確定で耐久記録は消える。
    expect(window.localStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it('別 wallet の pending は claim しない (fetch しない)', async () => {
    window.localStorage.setItem(
      PENDING_KEY,
      JSON.stringify({
        txHash: TX,
        chainId: 137,
        wallet: '0x000000000000000000000000000000000000FFFF',
      }),
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderHook(() => useProSubscribe(deployment), { wrapper });
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchSpy).not.toHaveBeenCalled();
    // 別 wallet の記録は残す (本人がログインすれば claim できる)。
    expect(window.localStorage.getItem(PENDING_KEY)).not.toBeNull();
  });

  it('恒久失敗 (tx_reverted) は pending を消す (無限 resume しない)', async () => {
    window.localStorage.setItem(
      PENDING_KEY,
      JSON.stringify({ txHash: TX, chainId: 137, wallet: WALLET }),
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'tx_reverted' }), {
        status: 400,
      }),
    );
    const { result } = renderHook(() => useProSubscribe(deployment), { wrapper });
    await waitFor(() => expect(result.current.isSubscribeError).toBe(true));
    expect(window.localStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it('retryable 失敗 (verify_unavailable) は pending を残す (再試行可)', async () => {
    window.localStorage.setItem(
      PENDING_KEY,
      JSON.stringify({ txHash: TX, chainId: 137, wallet: WALLET }),
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'verify_unavailable' }), {
        status: 503,
      }),
    );
    const { result } = renderHook(() => useProSubscribe(deployment), { wrapper });
    await waitFor(() => expect(result.current.isSubscribeError).toBe(true));
    expect(window.localStorage.getItem(PENDING_KEY)).not.toBeNull();
  });
});
