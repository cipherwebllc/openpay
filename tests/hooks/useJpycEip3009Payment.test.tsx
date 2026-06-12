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
// forwarder の解決と recover 手数料は境界モック。既定は free モード (forwarder=null) で
// 既存の署名計測テストを不変に保ち、recover 分岐テストだけ jpycForwarderFor を差し替える。
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
// recover 手数料は境界モック。client が payload の feeValue/merchantValue を
// recoverFeeValue(value, gasMode) から組むことを検証する (実 env 依存を避け決定論にする)。
// 確定モデル (2026-06-12): gasMode で料金スケジュールが分かれる:
//   merchant (決済): max(2 JPYC, 1% = value/100)。
//   customer (チップ): フロア 2 JPYC のみ (bps 無視)。
const FLOOR_FEE = 2n * 10n ** 18n;
const recoverFeeMock = vi.fn((billAmount: bigint, gasMode: 'customer' | 'merchant') => {
  if (gasMode === 'customer') return FLOOR_FEE;
  const pct = (billAmount * 100n) / 10000n;
  return pct > FLOOR_FEE ? pct : FLOOR_FEE;
});
vi.mock('@/lib/relay/recoverFee', () => ({
  recoverFeeValue: (b: bigint, gasMode: 'customer' | 'merchant') =>
    recoverFeeMock(b, gasMode),
  recoverFeeBps: () => 100,
}));

import { useAccount, useWalletClient } from 'wagmi';
import { logger } from '@/lib/logger';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
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

// recover 分岐: forwarder が設定された chain では feeValue = recoverFeeValue(value) を使い、
// payload に gasMode を載せる。client/server は同式 (recoverFeeValue) で feeValue を求める必要が
// あるため (nonce 一致)、ここでは「client が recoverFeeValue を呼び、その値で payload を組む」
// ことを検証する。手数料の負担者は gasMode が決める (customer=上乗せ / merchant=吸収)。
describe('useJpycEip3009Payment — recover 分岐 (feeValue=recoverFeeValue(value) + gasMode)', () => {
  const FORWARDER = getAddress('0x0F4560a777415580F0680F8B56a79B0022C6B848');

  function lastPostBody(): Record<string, unknown> {
    const call = fetchSpy.mock.calls.at(-1)!;
    return JSON.parse((call[1] as RequestInit).body as string);
  }

  beforeEach(() => {
    // recover モードに倒す。
    (jpycForwarderFor as ReturnType<typeof vi.fn>).mockReturnValue(FORWARDER);
    recoverFeeMock.mockClear();
  });

  it('gasMode=customer (チップ): feeValue=フロア (1% 非適用)・merchantValue=value・payload に gasMode=customer', async () => {
    mount();
    const { result } = renderHook(() => useJpycEip3009Payment(jpycDep), {
      wrapper: makeWrapper(),
    });
    const value = 1_000n * 10n ** 18n; // 1000 JPYC: merchant なら 1% = 10 JPYC だが customer はフロア
    result.current.mutate({ merchant: MERCHANT, value, gasMode: 'customer' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // 確定モデル: client は payload の gasMode をそのまま recoverFeeValue へ渡す。
    expect(recoverFeeMock).toHaveBeenCalledWith(value, 'customer');
    const body = lastPostBody();
    expect(body.gasMode).toBe('customer');
    // customer: 店舗は満額受領 (merchantValue == value)。
    expect(body.merchantValue).toBe(value.toString());
    // チップは 1% を乗せずフロア (= 2 JPYC) のまま。merchant なら 10 JPYC になる額で対比。
    expect(body.feeValue).toBe(FLOOR_FEE.toString());
    // recover モードの署名計測 (mode=recover)。
    expect(logger.info).toHaveBeenCalledWith(
      'payment.sign_requested',
      expect.objectContaining({ mode: 'recover' }),
    );
  });

  it('gasMode=merchant (決済): merchantValue=value−feeValue (feeValue=1%)・payload に gasMode=merchant', async () => {
    mount();
    const { result } = renderHook(() => useJpycEip3009Payment(jpycDep), {
      wrapper: makeWrapper(),
    });
    const value = 1_000n * 10n ** 18n;
    result.current.mutate({ merchant: MERCHANT, value, gasMode: 'merchant' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(recoverFeeMock).toHaveBeenCalledWith(value, 'merchant');
    const body = lastPostBody();
    expect(body.gasMode).toBe('merchant');
    const fee = 10n * 10n ** 18n; // 決済は 1% = 10 JPYC (フロア超過)
    // merchant: 店舗が手数料を吸収 (merchantValue == value − fee)。
    expect(body.merchantValue).toBe((value - fee).toString());
    expect(body.feeValue).toBe(fee.toString());
  });

  it('gasMode 未指定は customer 既定で payload に gasMode=customer が入る', async () => {
    mount();
    const { result } = renderHook(() => useJpycEip3009Payment(jpycDep), {
      wrapper: makeWrapper(),
    });
    const value = 1_000n * 10n ** 18n;
    result.current.mutate({ merchant: MERCHANT, value });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const body = lastPostBody();
    expect(body.gasMode).toBe('customer');
  });

  it('merchant 吸収で merchantValue<=0 (value<=fee) は amount_too_small で throw・POST しない', async () => {
    mount();
    const { result } = renderHook(() => useJpycEip3009Payment(jpycDep), {
      wrapper: makeWrapper(),
    });
    // value=2 JPYC, gasMode=merchant → fee=recoverFeeValue(2 JPYC)=floor 2 JPYC → merchantValue=0。
    result.current.mutate({
      merchant: MERCHANT,
      value: 2n * 10n ** 18n,
      gasMode: 'merchant',
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('amount_too_small');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
