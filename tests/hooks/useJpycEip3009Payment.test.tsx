import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getAddress, type Address, type Hex } from 'viem';
import { polygon } from 'viem/chains';
import type { ReactNode } from 'react';

// wagmi は境界モック。signTypedData の spy で署名要求/解決/拒否/失敗を制御する。
vi.mock('wagmi', () => ({
  useAccount: vi.fn(),
  useWalletClient: vi.fn(),
}));
// logger は境界モック (計測イベントの発火を assert するため)。
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// forwarder は free モード固定 (null)。recover 分岐は本 P1 では検証対象外 (free のみ)。
vi.mock('@/lib/relay/forwarderConfig', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/relay/forwarderConfig')
  >('@/lib/relay/forwarderConfig');
  return {
    ...actual,
    jpycForwarderFor: vi.fn(() => null),
    relayGasFeeValue: vi.fn(() => 2n * 10n ** 18n),
  };
});

import { useAccount, useWalletClient } from 'wagmi';
import { logger } from '@/lib/logger';
import { useJpycEip3009Payment } from '@/hooks/useJpycEip3009Payment';
import { defaultDeploymentForSymbol } from '@/lib/tokens';
import { mockHook } from '../_helpers/wagmiMock';

const jpycDep = defaultDeploymentForSymbol('jpyc');
const MERCHANT: Address = getAddress(
  '0x1111111111111111111111111111111111111111',
);
const CUSTOMER: Address = getAddress(
  '0x9999999999999999999999999999999999999999',
);

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

let signTypedData: ReturnType<typeof vi.fn>;
let fetchSpy: ReturnType<typeof vi.fn>;

function mount(opts?: { signImpl?: () => Promise<Hex> }) {
  signTypedData =
    opts?.signImpl !== undefined
      ? vi.fn(opts.signImpl)
      : vi.fn().mockResolvedValue(`0x${'a'.repeat(130)}` as Hex);
  mockHook(useWalletClient, { data: { signTypedData } });
  mockHook(useAccount, { address: CUSTOMER, chainId: polygon.id });
}

beforeEach(() => {
  vi.clearAllMocks();
  // 成功 relay レスポンス (txHash 確定) を既定にする。
  fetchSpy = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({ ok: true, txHash: `0x${'b'.repeat(64)}` }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
  vi.stubGlobal('fetch', fetchSpy);
});

describe('useJpycEip3009Payment — 署名計測 (sign_requested / completed / rejected / failed)', () => {
  it('署名成功: sign_requested (mode=free) → sign_completed を発火し txHash を返す', async () => {
    mount();
    const { result } = renderHook(() => useJpycEip3009Payment(jpycDep), {
      wrapper: makeWrapper(),
    });

    result.current.mutate({ merchant: MERCHANT, value: 300n * 10n ** 18n });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.txHash).toBe(`0x${'b'.repeat(64)}`);
    expect(result.current.data?.success).toBe(true);

    // 署名要求イベント (mode=free・free mode なので forwarder=null)。
    expect(logger.info).toHaveBeenCalledWith(
      'payment.sign_requested',
      expect.objectContaining({
        path: 'jpyc-relay',
        chainId: polygon.id,
        mode: 'free',
      }),
    );
    // 署名解決イベント。
    expect(logger.info).toHaveBeenCalledWith(
      'payment.sign_completed',
      expect.objectContaining({ path: 'jpyc-relay', chainId: polygon.id }),
    );
    // 実際に署名されたことを確認。
    expect(signTypedData).toHaveBeenCalledOnce();
  });

  it('署名拒否 (user rejected): sign_rejected を info で発火し throw する (sign_failed は出さない)', async () => {
    mount({
      signImpl: () =>
        Promise.reject(new Error('User rejected the request.')),
    });
    const { result } = renderHook(() => useJpycEip3009Payment(jpycDep), {
      wrapper: makeWrapper(),
    });

    result.current.mutate({ merchant: MERCHANT, value: 300n * 10n ** 18n });

    await waitFor(() => expect(result.current.isError).toBe(true));
    // 拒否は想定内なので info で分類。
    expect(logger.info).toHaveBeenCalledWith(
      'payment.sign_rejected',
      expect.objectContaining({
        path: 'jpyc-relay',
        chainId: polygon.id,
        mode: 'free',
      }),
    );
    // 失敗 warn は出さない (拒否は技術失敗ではない)。
    expect(logger.warn).not.toHaveBeenCalledWith(
      'payment.sign_failed',
      expect.anything(),
    );
    // rethrow されて mutation エラーに伝播 (挙動不変・standard fallback の判断は form 側)。
    expect(result.current.error?.message).toMatch(/User rejected/);
    // 署名失敗なので relay へは POST しない。
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('一般エラー: sign_failed を warn で発火し throw する (sign_rejected は出さない)', async () => {
    mount({
      signImpl: () => Promise.reject(new Error('eth_signTypedData_v4 disabled')),
    });
    const { result } = renderHook(() => useJpycEip3009Payment(jpycDep), {
      wrapper: makeWrapper(),
    });

    result.current.mutate({ merchant: MERCHANT, value: 300n * 10n ** 18n });

    await waitFor(() => expect(result.current.isError).toBe(true));
    // 技術失敗は warn (要調査・Sentry)。
    expect(logger.warn).toHaveBeenCalledWith(
      'payment.sign_failed',
      expect.objectContaining({
        path: 'jpyc-relay',
        chainId: polygon.id,
        mode: 'free',
      }),
    );
    // 拒否 info は出さない。
    expect(logger.info).not.toHaveBeenCalledWith(
      'payment.sign_rejected',
      expect.anything(),
    );
    // rethrow される。
    expect(result.current.error?.message).toMatch(/disabled/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
