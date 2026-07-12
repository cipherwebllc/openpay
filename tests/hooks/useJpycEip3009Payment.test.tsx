import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getAddress, type Address, type Hex } from 'viem';
import { polygon } from 'viem/chains';
import type { ReactNode } from 'react';

// wagmi は境界モック。signTypedData の spy で署名要求/解決/拒否/失敗を制御する。
vi.mock('wagmi', () => ({
  useAccount: vi.fn(),
  usePublicClient: vi.fn(),
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
// chainId も受け取り、hook が (value, gasMode, chainId) で呼ぶことを assert 可能にする
// (per-chain floor 汎用化: client は署名 chainId を recoverFeeValue へ渡す)。計算は chainId 非依存。
const recoverFeeMock = vi.fn(
  (billAmount: bigint, gasMode: 'customer' | 'merchant', _chainId: number) => {
    if (gasMode === 'customer') return FLOOR_FEE;
    const pct = (billAmount * 100n) / 10000n;
    return pct > FLOOR_FEE ? pct : FLOOR_FEE;
  },
);
vi.mock('@/lib/relay/recoverFee', () => ({
  recoverFeeValue: (b: bigint, gasMode: 'customer' | 'merchant', chainId: number) =>
    recoverFeeMock(b, gasMode, chainId),
  recoverFeeBps: () => 100,
}));

import { useAccount, usePublicClient, useWalletClient } from 'wagmi';
import { logger } from '@/lib/logger';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { useJpycEip3009Payment } from '@/hooks/useJpycEip3009Payment';
import { defaultDeploymentForSymbol } from '@/lib/tokens';
import {
  isFallbackSafeRelayError,
  isRelayIpRateLimitedError,
  isRelayResponseUnknownError,
} from '@/lib/relay/relayResponseError';
// mobileOrderFee は **実物** (未モック)。feeKind 分岐で hook が実 mobileOrderFeeValue へ委譲し、
// gas-recovery (recoverFeeMock) を呼ばないことを金額 + 未呼出で証明する。
import { mobileOrderFeeValue } from '@/lib/mobileOrderFee';
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
let waitForTransactionReceipt: ReturnType<typeof vi.fn>;

function mount(opts?: { signImpl?: () => Promise<Hex> }) {
  signTypedData =
    opts?.signImpl !== undefined
      ? vi.fn(opts.signImpl)
      : vi.fn().mockResolvedValue(`0x${'a'.repeat(130)}` as Hex);
  mockHook(useWalletClient, { data: { signTypedData } });
  mockHook(useAccount, { address: CUSTOMER, chainId: polygon.id });
  waitForTransactionReceipt = vi.fn().mockResolvedValue({ status: 'success' });
  mockHook(usePublicClient, { waitForTransactionReceipt });
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

describe('useJpycEip3009Payment — relay POST 応答分類 (D1)', () => {
  function submit() {
    mount();
    const rendered = renderHook(() => useJpycEip3009Payment(jpycDep), {
      wrapper: makeWrapper(),
    });
    rendered.result.current.mutate({
      merchant: MERCHANT,
      value: 300n * 10n ** 18n,
    });
    return rendered.result;
  }

  it('unknown→auto→settled txHash→receipt success を通常成功形へ正規化する', async () => {
    vi.useFakeTimers();
    const txHash = `0x${'d'.repeat(64)}` as Hex;
    fetchSpy
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, state: 'settled', txHash })),
      );
    const result = submit();

    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(result.current.recoveryState).toBe('auto');
    expect(result.current.isPending).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(3_000));

    expect(result.current.data).toEqual({ txHash, success: true });
    expect(result.current.recoveryState).toBeNull();
    expect(waitForTransactionReceipt).toHaveBeenCalledWith({
      hash: txHash,
      confirmations: 1,
      timeout: expect.any(Number),
    });
    expect(signTypedData).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('settled txHash の receipt reverted は通常 reverted 形へ正規化して latch を解除する', async () => {
    vi.useFakeTimers();
    const txHash = `0x${'e'.repeat(64)}` as Hex;
    fetchSpy
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, state: 'settled', txHash })),
      );
    const result = submit();
    waitForTransactionReceipt.mockResolvedValueOnce({ status: 'reverted' });

    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(result.current.data).toEqual({ txHash, success: false });
    expect(result.current.recoveryState).toBeNull();
    vi.useRealTimers();
  });

  it('settled txHash:null は indeterminate と同様に次の status まで継続する', async () => {
    vi.useFakeTimers();
    const txHash = `0x${'f'.repeat(64)}` as Hex;
    fetchSpy
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: true, state: 'settled', txHash: null }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, state: 'settled', txHash })),
      );
    const result = submit();

    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(result.current.recoveryState).toBe('auto');
    expect(waitForTransactionReceipt).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    expect(result.current.data).toEqual({ txHash, success: true });
    vi.useRealTimers();
  });

  it('失効前の unused は継続し、deadline で exhausted + latch 維持', async () => {
    vi.useFakeTimers();
    fetchSpy
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, state: 'unused' })),
      );
    const result = submit();

    await act(async () => vi.advanceTimersByTimeAsync(90_001));
    expect(result.current.recoveryState).toBe('exhausted');
    expect(isRelayResponseUnknownError(result.current.error)).toBe(true);
    expect(signTypedData).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('exhausted 後の手動再確認は status を再照会し、失効後 unused が安定すれば latch を解除する', async () => {
    vi.useFakeTimers();
    fetchSpy
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, state: 'indeterminate' })),
      );
    const result = submit();
    await act(async () => vi.advanceTimersByTimeAsync(90_001));
    expect(result.current.recoveryState).toBe('exhausted');
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(result.current.isError).toBe(true);

    const signedPayload = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
    ) as { validBefore: string };
    vi.setSystemTime((Number(signedPayload.validBefore) + 1) * 1000);
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify({ ok: true, state: 'unused' })),
    );
    act(() => result.current.retrySamePayload());
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(result.current.recoveryState).toBe('auto');
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    await act(async () => vi.advanceTimersByTimeAsync(0));

    expect(result.current.error?.message).toBe('relay_unused');
    expect(result.current.recoveryState).toBeNull();
    expect(
      fetchSpy.mock.calls.slice(1).every(([url]) => url === '/api/relay/jpyc/status'),
    ).toBe(true);
    expect(signTypedData).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('status fetch hang は 10s AbortController timeout 後も次の backoff へ進む', async () => {
    vi.useFakeTimers();
    let aborted = false;
    fetchSpy
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockImplementationOnce((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, state: 'indeterminate' })),
      );
    const result = submit();

    await act(async () => vi.advanceTimersByTimeAsync(13_000));
    expect(aborted).toBe(true);
    expect(result.current.recoveryState).toBe('auto');
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('unmount で sleep timer を cleanup し status fetch を開始しない', async () => {
    vi.useFakeTimers();
    fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    mount();
    const rendered = renderHook(() => useJpycEip3009Payment(jpycDep), {
      wrapper: makeWrapper(),
    });
    rendered.result.current.mutate({
      merchant: MERCHANT,
      value: 300n * 10n ** 18n,
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    rendered.unmount();
    await act(async () => vi.advanceTimersByTimeAsync(90_001));
    expect(fetchSpy).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('429 ip_rate_limited → 専用エラー + 同一 payload 再 POST（再署名なし）', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: 'ip_rate_limited' }), {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': '45',
        },
      }),
    );
    const result = submit();

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(isRelayIpRateLimitedError(result.current.error)).toBe(true);
    if (!isRelayIpRateLimitedError(result.current.error)) {
      throw new Error('expected RelayIpRateLimitedError');
    }
    expect(result.current.error.retryAfterSeconds).toBe(45);
    expect(isFallbackSafeRelayError(result.current.error)).toBe(false);
    expect(isRelayResponseUnknownError(result.current.error)).toBe(false);
    expect(signTypedData).toHaveBeenCalledTimes(1);
    const firstBody = (fetchSpy.mock.calls[0][1] as RequestInit).body;

    await act(async () => {
      result.current.retryRelay();
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect((fetchSpy.mock.calls[1][1] as RequestInit).body).toEqual(firstBody);
  });

  it('正常 202 pending → 現行どおり pending result', async () => {
    const txHash = `0x${'c'.repeat(64)}`;
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, pending: true, txHash }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const result = submit();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({
      txHash,
      success: false,
      pending: true,
    });
    expect(result.current.error).toBeNull();
  });

  it('正常 reverted envelope → 現行どおり success:false result', async () => {
    const txHash = `0x${'d'.repeat(64)}`;
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, reverted: true, txHash }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const result = submit();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ txHash, success: false });
    expect(result.current.error).toBeNull();
  });

  it.each([
    [400, 'invalid_payload'],
    [429, 'rate_limited'],
    [502, 'relay_error'],
    [503, 'relay_not_configured'],
  ])(
    '有効な %i {error:string} → fallback-safe server error',
    async (status, error) => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error }), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
      const result = submit();

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error?.message).toBe(error);
      expect(isFallbackSafeRelayError(result.current.error)).toBe(true);
      expect(isRelayResponseUnknownError(result.current.error)).toBe(false);
    },
  );
});

// recover 分岐: forwarder が設定された chain では feeValue = recoverFeeValue(value) を使い、
// payload に gasMode を載せる。client/server は同式 (recoverFeeValue) で feeValue を求める必要が
// あるため (nonce 一致)、ここでは「client が recoverFeeValue を呼び、その値で payload を組む」
// ことを検証する。手数料の負担者は gasMode が決める (customer=上乗せ / merchant=吸収)。
//
// 注: この mock はスケジュールを再実装しているが、表示↔請求↔server の **実 recoverFee 統合**
// (モック撤廃) は tests/lib/recoverFeeConsistency.test.ts が別途カバーする (L2)。ここでは
// hook が payload を recoverFeeValue(value, gasMode) の戻り値で正しく組むことだけを fence する。
// 各ケースで mock が exact (value, gasMode) 引数で呼ばれたことを assert し、hook が独自計算で
// なく recoverFeeValue へ委譲していることを証明する。
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
    // 確定モデル: client は payload の gasMode + 署名 chainId をそのまま recoverFeeValue へ渡す。
    expect(recoverFeeMock).toHaveBeenCalledWith(value, 'customer', polygon.id);
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
    expect(recoverFeeMock).toHaveBeenCalledWith(value, 'merchant', polygon.id);
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
    // 既定 customer でも recoverFeeValue は exact (value, 'customer', chainId) で呼ばれる (delegation 証明)。
    expect(recoverFeeMock).toHaveBeenCalledWith(value, 'customer', polygon.id);
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

// モバイル注文 feeKind 分岐: feeKind present のとき feeValue は recoverFeeValue ではなく **実**
// mobileOrderFeeValue(value, feeKind) で求める (経路非依存の一律 %)。recoverFeeMock が呼ばれない
// ことで「mobile 分岐に入り gas-recovery に委譲していない」ことを証明する。
describe('useJpycEip3009Payment — モバイル注文 feeKind (recover=実 mobileOrderFeeValue / free=throw)', () => {
  const FORWARDER = getAddress('0x0F4560a777415580F0680F8B56a79B0022C6B848');

  function lastPostBody(): Record<string, unknown> {
    const call = fetchSpy.mock.calls.at(-1)!;
    return JSON.parse((call[1] as RequestInit).body as string);
  }

  beforeEach(() => {
    (jpycForwarderFor as ReturnType<typeof vi.fn>).mockReturnValue(FORWARDER);
    recoverFeeMock.mockClear();
  });

  it('feeKind=storefront (店舗負担/merchant): feeValue=実 1%・merchantValue=value−fee・payload に feeKind・recoverFeeValue 不呼出', async () => {
    mount();
    const { result } = renderHook(() => useJpycEip3009Payment(jpycDep), {
      wrapper: makeWrapper(),
    });
    const value = 1_000n * 10n ** 18n;
    const fee = mobileOrderFeeValue(value, 'storefront'); // 実 1% = 10 JPYC
    result.current.mutate({
      merchant: MERCHANT,
      value,
      gasMode: 'merchant',
      feeKind: 'storefront',
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const body = lastPostBody();
    // 実 mobileOrderFeeValue で feeValue を組む (定数表 1%)。
    expect(body.feeValue).toBe(fee.toString());
    // 店舗負担: merchantValue = value − fee。
    expect(body.merchantValue).toBe((value - fee).toString());
    // server へ feeKind を渡す (定数表 再計算のヒント)。
    expect(body.feeKind).toBe('storefront');
    // gas-recovery (recoverFeeValue) には委譲しない。
    expect(recoverFeeMock).not.toHaveBeenCalled();
  });

  it('feeKind=preorder (顧客上乗せ/customer): feeValue=実 3% (1% ではない)・merchantValue=value (満額)', async () => {
    mount();
    const { result } = renderHook(() => useJpycEip3009Payment(jpycDep), {
      wrapper: makeWrapper(),
    });
    const value = 1_000n * 10n ** 18n;
    const fee = mobileOrderFeeValue(value, 'preorder'); // 実 3% = 30 JPYC
    expect(fee).toBe(30n * 10n ** 18n); // recover の 1% (10) と区別できる
    result.current.mutate({
      merchant: MERCHANT,
      value,
      gasMode: 'customer',
      feeKind: 'preorder',
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const body = lastPostBody();
    expect(body.feeValue).toBe(fee.toString());
    // 顧客上乗せ: 店舗は満額受領 (merchantValue == value)。
    expect(body.merchantValue).toBe(value.toString());
    expect(body.feeKind).toBe('preorder');
    expect(recoverFeeMock).not.toHaveBeenCalled();
  });

  it('free 経路 (forwarder 未設定) + feeKind: mobile_fee_requires_recover で throw・POST しない (ガスレス素通り穴を塞ぐ)', async () => {
    // この chain だけ forwarder=null (= free) に倒す。free は単一 transfer で fee 分割不可。
    (jpycForwarderFor as ReturnType<typeof vi.fn>).mockReturnValue(null);
    mount();
    const { result } = renderHook(() => useJpycEip3009Payment(jpycDep), {
      wrapper: makeWrapper(),
    });
    result.current.mutate({
      merchant: MERCHANT,
      value: 1_000n * 10n ** 18n,
      gasMode: 'merchant',
      feeKind: 'storefront',
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    // 明示エラーで呼出側 (CheckoutForm) が standard 経路へ fallback できる。
    expect(result.current.error?.message).toBe('mobile_fee_requires_recover');
    expect(isFallbackSafeRelayError(result.current.error)).toBe(true);
    // 手数料を取りこぼす free transfer は実行しない。
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
