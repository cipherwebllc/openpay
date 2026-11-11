import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { getAddress, type Address, type Hex } from 'viem';
import { kairos, polygon } from 'viem/chains';
import { Activity, useEffect, useLayoutEffect, useState, type ReactNode } from 'react';

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
vi.mock('@/lib/relay/relayStoredReceipt', () => ({
  waitForStoredRelayReceipt: vi.fn(),
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
import { waitForStoredRelayReceipt } from '@/lib/relay/relayStoredReceipt';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { buildForwarderNonce } from '@/lib/relay/forwarderIntent';
import {
  useJpycEip3009Payment,
  type JpycEip3009Params,
} from '@/hooks/useJpycEip3009Payment';
import { defaultDeploymentForSymbol } from '@/lib/tokens';
import { env } from '@/lib/env';
import {
  isFallbackSafeRelayError,
  isRelayIpRateLimitedError,
  isRelayResponseUnknownError,
} from '@/lib/relay/relayResponseError';
import { relayErrorKey } from '@/lib/relay/relayErrorMessage';
import {
  RELAY_INTENT_PROBE_KEY,
  RELAY_INTENT_STORAGE_KEY,
  type RelayIntentMetadata,
} from '@/lib/paymentIntentStorage';
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
const RESTORED_NONCE = `0x${'7'.repeat(64)}` as Hex;

function restoredRelayIntent(
  overrides: Partial<RelayIntentMetadata> = {},
): RelayIntentMetadata {
  return {
    chainId: jpycDep.chainId,
    from: CUSTOMER,
    merchant: MERCHANT,
    merchantValue: (300n * 10n ** 18n).toString(),
    feeValue: '0',
    nonce: RESTORED_NONCE,
    validBefore: String(Math.floor(Date.now() / 1000) + 900),
    routeKind: 'free',
    issuedAt: Date.now(),
    ...overrides,
  };
}

function storeRelayIntent(intent: RelayIntentMetadata): void {
  window.sessionStorage.setItem(
    RELAY_INTENT_STORAGE_KEY,
    JSON.stringify(intent),
  );
}

async function flushStorageLoad(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// fake timers の下で、結果が出るまで ms ずつ時間を進める。hook の動的 import の解決に要る microtask の数は vitest の版で
// 変わり (読み込み済み module で 2.1.9 は 9・5.0.3 は 16)、順序次第で初回の読み込み (実時間) にもなるので、決まった tick 数を仮定しない。
async function advanceUntil(ms: number, assertion: () => void): Promise<void> {
  await vi.waitFor(async () => {
    await act(async () => vi.advanceTimersByTimeAsync(ms));
    assertion();
  }, { timeout: 2000, interval: 10 });
}

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
// usePublicClient の waitForTransactionReceipt に代入できる形を明示する (型の無い vi.fn は vitest 4 以降で関数の型に
// 代入できない)。戻り値が any なのは、fixture が receipt の一部 ({ status }) だけを返すため。
type WaitForTransactionReceipt = (args: { hash: Hex }) => Promise<any>;
let waitForTransactionReceipt: Mock<WaitForTransactionReceipt>;
const waitForStoredRelayReceiptMock = vi.mocked(
  waitForStoredRelayReceipt,
);

function mount(opts?: { signImpl?: () => Promise<Hex> }) {
  signTypedData =
    opts?.signImpl !== undefined
      ? vi.fn(opts.signImpl)
      : vi.fn().mockResolvedValue(`0x${'a'.repeat(130)}` as Hex);
  mockHook(useWalletClient, { data: { signTypedData } });
  mockHook(useAccount, { address: CUSTOMER, chainId: jpycDep.chainId });
  waitForTransactionReceipt = vi.fn<WaitForTransactionReceipt>().mockResolvedValue({ status: 'success' });
  mockHook(usePublicClient, { waitForTransactionReceipt });
  waitForStoredRelayReceiptMock.mockResolvedValue({ status: 'success' });
}

function setTipMessageFlag(enabled: boolean): void {
  (env as { enableTipMessage: boolean }).enableTipMessage = enabled;
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  window.sessionStorage.clear();
  setTipMessageFlag(false);
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
        chainId: jpycDep.chainId,
        mode: 'free',
      }),
    );
    // 署名解決イベント。
    expect(logger.info).toHaveBeenCalledWith(
      'payment.sign_completed',
      expect.objectContaining({
        path: 'jpyc-relay',
        chainId: jpycDep.chainId,
      }),
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
        chainId: jpycDep.chainId,
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
        chainId: jpycDep.chainId,
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

describe('useJpycEip3009Payment — tipMessage payload isolation', () => {
  beforeEach(() => {
    setTipMessageFlag(true);
  });

  it('free payload は mutation 開始時の非空 tipMessage を固定し、後続編集や logger へ波及させない', async () => {
    let resolveSignature: ((signature: Hex) => void) | undefined;
    mount({
      signImpl: () =>
        new Promise<Hex>((resolve) => {
          resolveSignature = resolve;
        }),
    });
    const { result } = renderHook(() => useJpycEip3009Payment(jpycDep), {
      wrapper: makeWrapper(),
    });
    const privateMessage = 'private-tip-message-before-sign';
    const variables: JpycEip3009Params = {
      merchant: MERCHANT,
      value: 300n * 10n ** 18n,
      tipMessage: privateMessage,
    };

    result.current.mutate(variables);
    await waitFor(() => expect(signTypedData).toHaveBeenCalledOnce());
    variables.tipMessage = 'edited-while-wallet-open';
    await act(async () => {
      resolveSignature?.(`0x${'a'.repeat(130)}` as Hex);
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const body = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(body.tipMessage).toBe(privateMessage);
    expect(JSON.stringify({
      info: vi.mocked(logger.info).mock.calls,
      warn: vi.mocked(logger.warn).mock.calls,
      error: vi.mocked(logger.error).mock.calls,
    })).not.toContain(privateMessage);
  });

  it('空文字の tipMessage は free payload へ追加しない', async () => {
    mount();
    const { result } = renderHook(() => useJpycEip3009Payment(jpycDep), {
      wrapper: makeWrapper(),
    });

    result.current.mutate({
      merchant: MERCHANT,
      value: 300n * 10n ** 18n,
      tipMessage: '',
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const body = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(body).not.toHaveProperty('tipMessage');
  });

  it('flag OFF では tipMessage を relay payload に追加しない', async () => {
    setTipMessageFlag(false);
    mount();
    const { result } = renderHook(() => useJpycEip3009Payment(jpycDep), {
      wrapper: makeWrapper(),
    });

    result.current.mutate({
      merchant: MERCHANT,
      value: 300n * 10n ** 18n,
      tipMessage: 'must-stay-inert',
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const body = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(body).not.toHaveProperty('tipMessage');
  });
});

describe('useJpycEip3009Payment — relay POST 応答分類 (D1)', () => {
  async function submit(overrides: Partial<JpycEip3009Params> = {}) {
    mount();
    const rendered = renderHook(() => useJpycEip3009Payment(jpycDep), {
      wrapper: makeWrapper(),
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    rendered.result.current.mutate({
      merchant: MERCHANT,
      value: 300n * 10n ** 18n,
      ...overrides,
    });
    return rendered.result;
  }

  it('unknown→auto→settled txHash→receipt success を通常成功形へ正規化する', async () => {
    vi.useFakeTimers();
    await import('@/lib/relay/relayIntentRecovery');
    const txHash = `0x${'d'.repeat(64)}` as Hex;
    fetchSpy
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, state: 'settled', txHash })),
      );
    const result = await submit();

    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(result.current.recoveryState).toBe('auto');
    expect(result.current.isPending).toBe(true);
    // recovery engine は bundle 予算のため dynamic chunk。import 解決後に 3s backoff timer が立つ。
    await act(async () => vi.advanceTimersByTimeAsync(0));
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
    const result = await submit();
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
    const result = await submit();

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
    const result = await submit();

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
    const result = await submit();
    await act(async () => vi.advanceTimersByTimeAsync(90_001));
    expect(result.current.recoveryState).toBe('exhausted');
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(result.current.isError).toBe(true);

    const signedPayload = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
    ) as { validBefore: string };
    vi.setSystemTime((Number(signedPayload.validBefore) + 1) * 1000);
    // 期限切れはサーバがチェーン上で証明する (expiry: 'expired')。端末の時計だけでは外さない (下の A6 テスト)。
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify({ ok: true, state: 'unused', expiry: 'expired' })),
    );
    act(() => result.current.retrySamePayload());
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(result.current.recoveryState).toBe('auto');
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await flushStorageLoad();

    expect(result.current.error?.message).toBe('relay_unused');
    expect(result.current.recoveryState).toBeNull();
    expect(
      fetchSpy.mock.calls.slice(1).every(([url]) => url === '/api/relay/jpyc/status'),
    ).toBe(true);
    // status の照会には署名の期限を送り、サーバがチェーン上の期限切れを証明できるようにする
    expect(JSON.parse((fetchSpy.mock.calls.at(-1)![1] as RequestInit).body as string)).toEqual({
      lookup: 'nonce',
      chainId: jpycDep.chainId,
      from: CUSTOMER,
      nonce: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      validBefore: signedPayload.validBefore,
    });
    expect(signTypedData).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  // 第 7 回レビュー A6 (再レビュー反映): ラッチ解除 (= 新しい署名を許す) は「連続 unused かつ最新の応答がチェーン上で
  // 期限切れと証明済み (expiry: 'expired')」のときだけ。端末の時計には戻らない (証明が無い・live なら期限まで unknown)。
  type Unused = { ok: true; state: 'unused'; expiry?: 'expired' | 'live' };
  const unused = (expiry?: 'expired' | 'live'): Unused => ({ ok: true, state: 'unused', ...(expiry ? { expiry } : {}) });
  const FAIL = 'fetch-failure' as const;
  it.each([
    ['端末の時計が進んでいても、証明の無い unused では latch を外さない', +600, [unused(), unused()], false],
    ['端末の時計が進んでいても、チェーン上で期限前 (live) なら latch を外さない', +600, [unused('live'), unused('live')], false],
    ['証明あり → 証明なし (欠落) の順では latch を外さない (最新の応答が expired のときだけ)', +600, [unused('expired'), unused()], false],
    ['証明あり → live の順でも latch を外さない', +600, [unused('expired'), unused('live')], false],
    ['証明あり → fetch 失敗 → 証明あり は連続 unused でないので latch を外さない', +600, [unused('expired'), FAIL, unused('expired')], false],
    ['端末の時計が遅れていても、チェーン上で期限切れと証明されれば latch を外す', -600, [unused(), unused('expired')], true],
  ] as const)('%s', async (_label, deviceOffsetSec, responses, released) => {
    vi.useFakeTimers();
    fetchSpy
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, state: 'indeterminate' })),
      );
    const result = await submit();
    await act(async () => vi.advanceTimersByTimeAsync(90_001));
    expect(result.current.recoveryState).toBe('exhausted');
    await act(async () => vi.advanceTimersByTimeAsync(0));

    const signedPayload = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
    ) as { validBefore: string };
    vi.setSystemTime((Number(signedPayload.validBefore) + deviceOffsetSec) * 1000);
    const queue: (Unused | typeof FAIL)[] = [...responses];
    fetchSpy.mockImplementation(async () => {
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next === FAIL) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify(next));
    });
    act(() => result.current.retrySamePayload());
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    // 3 応答のケースは 3 回目の照会 (backoff 12 秒) まで進める
    if (responses.length > 2) await act(async () => vi.advanceTimersByTimeAsync(12_000));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await flushStorageLoad();

    if (released) {
      expect(result.current.error?.message).toBe('relay_unused');
      expect(result.current.recoveryState).toBeNull();
    } else {
      expect(result.current.error?.message).not.toBe('relay_unused');
      expect(result.current.recoveryState).toBe('auto');
    }
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
    const result = await submit();

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
    setTipMessageFlag(true);
    const privateMessage = 'private-tip-message-for-exact-retry';
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: 'ip_rate_limited' }), {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': '45',
        },
      }),
    );
    const result = await submit({ tipMessage: privateMessage });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(isRelayIpRateLimitedError(result.current.error)).toBe(true);
    if (!isRelayIpRateLimitedError(result.current.error)) {
      throw new Error('expected RelayIpRateLimitedError');
    }
    expect(result.current.error.retryAfterSeconds).toBe(45);
    expect(isFallbackSafeRelayError(result.current.error)).toBe(false);
    expect(isRelayResponseUnknownError(result.current.error)).toBe(false);
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(
      window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY),
    ).toBeNull();
    const firstBody = (fetchSpy.mock.calls[0][1] as RequestInit).body;
    expect(JSON.parse(firstBody as string).tipMessage).toBe(privateMessage);

    await act(async () => {
      result.current.retryRelay();
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect((fetchSpy.mock.calls[1][1] as RequestInit).body).toEqual(firstBody);
    expect(JSON.stringify({
      info: vi.mocked(logger.info).mock.calls,
      warn: vi.mocked(logger.warn).mock.calls,
      error: vi.mocked(logger.error).mock.calls,
    })).not.toContain(privateMessage);
  });

  it('正常 202 pending → 現行どおり pending result', async () => {
    const txHash = `0x${'c'.repeat(64)}`;
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, pending: true, txHash }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const result = await submit();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({
      txHash,
      success: false,
      pending: true,
    });
    expect(result.current.error).toBeNull();

    act(() => {
      result.current.mutate({
        merchant: MERCHANT,
        value: 300n * 10n ** 18n,
      });
    });
    await act(async () => Promise.resolve());
    expect(signTypedData).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('正常 reverted envelope → 現行どおり success:false result', async () => {
    const txHash = `0x${'d'.repeat(64)}`;
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, reverted: true, txHash }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const result = await submit();

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
      const result = await submit();

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error?.message).toBe(error);
      expect(isFallbackSafeRelayError(result.current.error)).toBe(true);
      expect(isRelayResponseUnknownError(result.current.error)).toBe(false);
    },
  );

  // full-review 2026-10-30 F-6 (PR-07): txHash は 0x + 64 桁の hex のときだけ成功・revert・pending の
  // 結果にする。形の崩れた txHash は応答不明 (曖昧 latch) に落ち、nonce の status 照会で確定した hash だけを返す。
  // (どれも空でない文字列なので、旧 isTxHash は通していた。)
  const MALFORMED_TX_HASHES = [
    ['非 hex', `0x${'g'.repeat(64)}`],
    ['63 桁', `0x${'a'.repeat(63)}`],
    ['0x なし', 'a'.repeat(64)],
  ] as const;
  const RELAY_ENVELOPES = [
    ['200 {ok:true}', 200, (txHash: string) => ({ ok: true, txHash })],
    ['200 {reverted:true}', 200, (txHash: string) => ({ ok: false, reverted: true, txHash })],
    ['202 {pending:true}', 202, (txHash: string) => ({ ok: false, pending: true, txHash })],
  ] as const;

  it.each(
    RELAY_ENVELOPES.flatMap(([envelope, status, body]) =>
      MALFORMED_TX_HASHES.map(([label, badHash]) => [envelope, label, status, body, badHash] as const),
    ),
  )(
    '%s の txHash が %s → 結果にせず曖昧 latch → status 照会で確定した hash だけを返す',
    async (_envelope, _label, status, body, badHash) => {
      vi.useFakeTimers();
      await import('@/lib/relay/relayIntentRecovery');
      const settledHash = `0x${'d'.repeat(64)}` as Hex;
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify(body(badHash)), {
            status,
            headers: { 'content-type': 'application/json' },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true, state: 'settled', txHash: settledHash })),
        );
      const result = await submit();

      // 待つ条件は「曖昧 latch に入った」か「結果が出た」のどちらか。形の崩れた hash を結果にしてしまう
      // 実装でも待ちは抜け、下の assertion で落ちる (待ちの timeout で act を残して後続の test を巻き込まない)。
      await advanceUntil(0, () =>
        expect(result.current.recoveryState === 'auto' || result.current.data !== undefined).toBe(true),
      );
      expect(result.current.data).toBeUndefined();
      expect(result.current.recoveryState).toBe('auto');
      expect(window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY)).not.toBeNull();

      await advanceUntil(3_000, () =>
        expect(result.current.data).toEqual({ txHash: settledHash, success: true }),
      );
      expect(fetchSpy.mock.calls[1][0]).toBe('/api/relay/jpyc/status');
      expect(waitForTransactionReceipt).toHaveBeenCalledWith(
        expect.objectContaining({ hash: settledHash }),
      );
      expect(waitForTransactionReceipt).not.toHaveBeenCalledWith(
        expect.objectContaining({ hash: badHash }),
      );
      expect(signTypedData).toHaveBeenCalledOnce();
      expect(window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY)).toBeNull();
      vi.useRealTimers();
    },
  );

  it('大文字を含む 0x + 64 桁の hex は従来どおり成功 (status 照会なし)', async () => {
    const mixedCase = `0x${'aB'.repeat(32)}`;
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, txHash: mixedCase }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const result = await submit();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ txHash: mixedCase, success: true });
    expect(result.current.recoveryState).toBeNull();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  // この PR が保証するのは「形の崩れた txHash を結果にせず、曖昧 latch で再署名を止める」まで。本当に revert した
  // tx は authorization が未使用のまま relay の hash が残るので、status は 'indeterminate' を返し続ける
  // (app/api/relay/jpyc/status/route.ts)。その場合は revert に確定せず、deadline で exhausted になる (既存の限界)。
  it('200 {reverted:true} の崩れた txHash で status が indeterminate のまま → deadline で exhausted・再署名しない・intent を残す', async () => {
    vi.useFakeTimers();
    await import('@/lib/relay/relayIntentRecovery');
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: false, reverted: true, txHash: `0x${'g'.repeat(64)}` }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockImplementation(async () =>
        new Response(JSON.stringify({ ok: true, state: 'indeterminate' })),
      );
    const result = await submit();

    await advanceUntil(0, () =>
      expect(result.current.recoveryState === 'auto' || result.current.data !== undefined).toBe(true),
    );
    expect(result.current.data).toBeUndefined();
    await act(async () => vi.advanceTimersByTimeAsync(90_001));

    expect(result.current.recoveryState).toBe('exhausted');
    expect(isRelayResponseUnknownError(result.current.error)).toBe(true);
    expect(result.current.data).toBeUndefined();
    expect(signTypedData).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
    expect(
      fetchSpy.mock.calls.slice(1).every(([url]) => url === '/api/relay/jpyc/status'),
    ).toBe(true);
    expect(waitForTransactionReceipt).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY)).not.toBeNull();
    vi.useRealTimers();
  });

  // 429 (IP 制限) は broadcast 前の拒否なので intent を復旧 slot から外す。その後の retry は broadcast しうるので、
  // POST の前に intent を保存し直す。保存し直さないと、retry の応答が不明 (崩れた txHash を含む) のまま reload した
  // ときに memory の latch が消え、新しい署名 (新 nonce) で二重払いになる。
  it('429 のあとの retry が崩れた txHash を返しても intent を保存し直し、reload 後は再署名せず status を照会する', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error: 'ip_rate_limited' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '1' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, txHash: `0x${'g'.repeat(64)}` }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    mount();
    const first = renderHook(() => useJpycEip3009Payment(jpycDep), {
      wrapper: makeWrapper(),
    });
    await flushStorageLoad();
    first.result.current.mutate({ merchant: MERCHANT, value: 300n * 10n ** 18n });
    await waitFor(() =>
      expect(isRelayIpRateLimitedError(first.result.current.error)).toBe(true),
    );
    expect(window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY)).toBeNull();

    await act(async () => {
      first.result.current.retryRelay();
    });
    await waitFor(() =>
      expect(isRelayResponseUnknownError(first.result.current.error)).toBe(true),
    );
    expect(first.result.current.data).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const relayNonce = JSON.parse(
      (fetchSpy.mock.calls[1][1] as RequestInit).body as string,
    ).nonce;
    const saved = window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY);
    expect(saved).not.toBeNull();
    expect(JSON.parse(saved!).nonce).toBe(relayNonce);
    first.unmount();

    // reload 相当: memory の latch を失った新しい mount。
    vi.useFakeTimers();
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify({ ok: true, state: 'indeterminate' })),
    );
    const second = renderHook(() => useJpycEip3009Payment(jpycDep), {
      wrapper: makeWrapper(),
    });
    await advanceUntil(0, () => expect(second.result.current.recoveryState).toBe('auto'));
    expect(second.result.current.hasStoredIntent).toBe(true);
    await advanceUntil(3_000, () => expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(3));
    act(() => {
      second.result.current.mutate({ merchant: MERCHANT, value: 300n * 10n ** 18n });
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));

    expect(signTypedData).toHaveBeenCalledOnce();
    const afterReload = fetchSpy.mock.calls.slice(2);
    expect(afterReload.every(([url]) => url === '/api/relay/jpyc/status')).toBe(true);
    expect(JSON.parse((afterReload[0][1] as RequestInit).body as string).nonce).toBe(relayNonce);
    expect(window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY)).not.toBeNull();
    vi.useRealTimers();
  });

  // B-R5: server の free 経路も broadcast 前 read の RPC 障害を recover 経路と同じ
  // JSON 503 preflight_unavailable で返す。client は経路を問わず同一の fallback-safe error に分類し、
  // 曖昧 latch / 自動 status 照会 / intent 保存を残さない (= standard 決済へ切替可能)。
  describe('503 preflight_unavailable は free / recover で同一の fallback-safe 扱い (B-R5)', () => {
    const FORWARDER = getAddress('0x0F4560a777415580F0680F8B56a79B0022C6B848');

    afterEach(() => {
      // 後続 describe の既定 (free モード) を崩さない。
      (jpycForwarderFor as ReturnType<typeof vi.fn>).mockReturnValue(null);
      vi.useRealTimers();
    });

    it.each(['free', 'recover'] as const)(
      '%s 経路の 503 preflight_unavailable → fallback-safe error・latch なし・intent 破棄',
      async (mode) => {
        (jpycForwarderFor as ReturnType<typeof vi.fn>).mockReturnValue(
          mode === 'recover' ? FORWARDER : null,
        );
        fetchSpy.mockResolvedValueOnce(
          new Response(
            JSON.stringify({ ok: false, error: 'preflight_unavailable' }),
            { status: 503, headers: { 'content-type': 'application/json' } },
          ),
        );
        const result = await submit();

        await waitFor(() => expect(result.current.isError).toBe(true));
        const body = JSON.parse(
          (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
        ) as Record<string, unknown>;
        // 経路どおりの payload を POST したこと (free=to/nonce・recover=intentSalt)。
        if (mode === 'free') {
          expect(body).toHaveProperty('nonce');
          expect(body).not.toHaveProperty('intentSalt');
        } else {
          expect(body).toHaveProperty('intentSalt');
          expect(body).not.toHaveProperty('nonce');
        }
        const error = result.current.error!;
        expect(error.message).toBe('preflight_unavailable');
        expect(isFallbackSafeRelayError(error)).toBe(true);
        expect(isRelayResponseUnknownError(error)).toBe(false);
        expect(isRelayIpRateLimitedError(error)).toBe(false);
        // フォームの fallback 文言キー (PaymentForm/CheckoutForm/TipForm 共通)。
        expect(relayErrorKey(error)).toBe('errorRelayGeneric');
        // 曖昧 latch に入らない: status 自動照会なし・intent は破棄・署名は 1 回のみ。
        expect(result.current.recoveryState).toBeNull();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(signTypedData).toHaveBeenCalledTimes(1);
        expect(
          window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY),
        ).toBeNull();
      },
    );

    it('対比: 旧 free 経路の非 JSON 500 (unhandled throw) は応答不明 → 曖昧 latch だった', async () => {
      vi.useFakeTimers();
      await import('@/lib/relay/relayIntentRecovery');
      fetchSpy.mockResolvedValueOnce(
        new Response('Internal Server Error', {
          status: 500,
          headers: { 'content-type': 'text/plain' },
        }),
      );
      const result = await submit();

      await act(async () => vi.advanceTimersByTimeAsync(0));
      // fallback-safe error にならず、同一 payload の status 照会 (auto recovery) に閉じ込められる。
      expect(result.current.recoveryState).toBe('auto');
      expect(result.current.isPending).toBe(true);
      expect(result.current.error).toBeNull();
      expect(
        window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY),
      ).not.toBeNull();
    });
  });
});

describe('useJpycEip3009Payment — reload intent 復元', () => {
  it('202 pending 中は公開 metadata だけを保存し EIP-3009 signature を永続化しない', async () => {
    setTipMessageFlag(true);
    const txHash = `0x${'8'.repeat(64)}` as Hex;
    const privateMessage = 'private-tip-message-not-for-session-storage';
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, pending: true, txHash }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    );
    mount();
    const { result } = renderHook(() => useJpycEip3009Payment(jpycDep), {
      wrapper: makeWrapper(),
    });

    result.current.mutate({
      merchant: MERCHANT,
      value: 300n * 10n ** 18n,
      tipMessage: privateMessage,
    });
    await waitFor(() => expect(result.current.data?.pending).toBe(true));

    const postBody = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    const raw = window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(raw).not.toContain(postBody.signature as string);
    expect(postBody.tipMessage).toBe(privateMessage);
    expect(raw).not.toContain(privateMessage);
    expect(postBody.contextKey).toBeUndefined();
    expect(JSON.parse(raw!)).toEqual({
      chainId: jpycDep.chainId,
      from: CUSTOMER,
      merchant: MERCHANT,
      merchantValue: (300n * 10n ** 18n).toString(),
      feeValue: '0',
      nonce: postBody.nonce,
      validBefore: postBody.validBefore,
      routeKind: 'free',
      issuedAt: expect.any(Number),
    });
  });

  it('注文リンクの支払いの指紋 (orderLinkKey) は復旧 intent にだけ残し、relay POST には載せない (第 9 回レビュー G-1)', async () => {
    const orderLinkKey = `0x${'c4'.repeat(32)}` as Hex;
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, pending: true, txHash: `0x${'8'.repeat(64)}` }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    );
    mount();
    const { result } = renderHook(() => useJpycEip3009Payment(jpycDep), {
      wrapper: makeWrapper(),
    });

    result.current.mutate({ merchant: MERCHANT, value: 300n * 10n ** 18n, orderLinkKey });
    await waitFor(() => expect(result.current.data?.pending).toBe(true));

    const rawBody = (fetchSpy.mock.calls[0][1] as RequestInit).body as string;
    expect(rawBody).not.toContain(orderLinkKey);
    expect(JSON.parse(rawBody).orderLinkKey).toBeUndefined();
    const saved = JSON.parse(window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY)!);
    expect(saved.orderLinkKey).toBe(orderLinkKey);
  });

  it('reload 後の復元 intent に注文リンクの支払いの指紋 (orderLinkKey) を戻す', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-25T00:00:00Z'));
    const orderLinkKey = `0x${'c4'.repeat(32)}` as Hex;
    storeRelayIntent(restoredRelayIntent({ orderLinkKey }));
    const txHash = `0x${'9'.repeat(64)}` as Hex;
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, state: 'settled', txHash })),
    );
    mount();
    const { result } = renderHook(() => useJpycEip3009Payment(jpycDep), {
      wrapper: makeWrapper(),
    });

    await advanceUntil(100, () =>
      expect(result.current.data).toEqual({ txHash, success: true }),
    );
    expect(result.current.restoredIntent?.orderLinkKey).toBe(orderLinkKey);
    expect(signTypedData).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('reload 後に nonce status が settled なら再署名せず成功状態を復元する', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-25T00:00:00Z'));
    storeRelayIntent(restoredRelayIntent());
    const txHash = `0x${'9'.repeat(64)}` as Hex;
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, state: 'settled', txHash })),
    );
    mount();
    const { result } = renderHook(() => useJpycEip3009Payment(jpycDep), {
      wrapper: makeWrapper(),
    });

    await flushStorageLoad();
    expect(result.current.recoveryState).toBe('auto');
    await act(async () => vi.advanceTimersByTimeAsync(3_000));

    expect(result.current.data).toEqual({ txHash, success: true });
    expect(result.current.recoveryState).toBeNull();
    expect(signTypedData).not.toHaveBeenCalled();
    expect(waitForTransactionReceipt).toHaveBeenCalledWith({
      hash: txHash,
      confirmations: 1,
      timeout: expect.any(Number),
    });
    expect(JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
    )).toEqual({
      lookup: 'nonce',
      chainId: jpycDep.chainId,
      from: CUSTOMER,
      nonce: RESTORED_NONCE,
      validBefore: expect.stringMatching(/^\d+$/),
    });
    expect(
      window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY),
    ).toBeNull();
    vi.useRealTimers();
  });

  it('reload 後も status 不明なら unknown 状態を復元し再署名を封鎖する', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-25T00:00:00Z'));
    storeRelayIntent(restoredRelayIntent());
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, state: 'indeterminate' })),
    );
    mount();
    const { result } = renderHook(() => useJpycEip3009Payment(jpycDep), {
      wrapper: makeWrapper(),
    });

    await flushStorageLoad();
    await act(async () => vi.advanceTimersByTimeAsync(90_001));

    expect(result.current.recoveryState).toBe('exhausted');
    expect(isRelayResponseUnknownError(result.current.error)).toBe(true);
    expect(result.current.hasStoredIntent).toBe(true);
    act(() => {
      result.current.mutate({
        merchant: MERCHANT,
        value: 300n * 10n ** 18n,
      });
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));

    expect(signTypedData).not.toHaveBeenCalled();
    expect(
      fetchSpy.mock.calls.every(
        ([url]) => url === '/api/relay/jpyc/status',
      ),
    ).toBe(true);
    expect(
      window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY),
    ).not.toBeNull();
  });

  it('validBefore 後の unused が連続確認できれば intent を破棄して新規署名を許可する', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-25T00:00:00Z'));
    storeRelayIntent(
      restoredRelayIntent({
        validBefore: String(Math.floor(Date.now() / 1000) - 1),
      }),
    );
    const newTxHash = `0x${'6'.repeat(64)}` as Hex;
    // 期限切れはサーバがチェーン上で証明する (expiry: 'expired')。端末の時計だけでは破棄しない。
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, state: 'unused', expiry: 'expired' })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, state: 'unused', expiry: 'expired' })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, txHash: newTxHash })),
      );
    mount();
    const { result } = renderHook(() => useJpycEip3009Payment(jpycDep), {
      wrapper: makeWrapper(),
    });
    act(() => {
      result.current.mutate({
        merchant: MERCHANT,
        value: 300n * 10n ** 18n,
      });
    });

    await flushStorageLoad();
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await flushStorageLoad();

    expect(result.current.recoveryState).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.hasStoredIntent).toBe(false);
    expect(result.current.restoredIntent).toBeNull();
    expect(
      window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY),
    ).toBeNull();
    expect(signTypedData).not.toHaveBeenCalled();

    act(() => {
      result.current.mutate({
        merchant: MERCHANT,
        value: 300n * 10n ** 18n,
      });
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));

    expect(signTypedData).toHaveBeenCalledOnce();
    expect(result.current.data).toEqual({ txHash: newTxHash, success: true });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/relay/jpyc/status');
    expect(fetchSpy.mock.calls[1][0]).toBe('/api/relay/jpyc/status');
    expect(fetchSpy.mock.calls[2][0]).toBe('/api/relay/jpyc');
    vi.useRealTimers();
  });

  it('保存 chain が現在 deployment と違っても status を照会し、失効 unused なら解放する', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-25T00:00:00Z'));
    const storedChainId = polygon.id === jpycDep.chainId
      ? 80002
      : polygon.id;
    const storedValidBefore = String(Math.floor(Date.now() / 1000) - 1);
    storeRelayIntent(
      restoredRelayIntent({
        chainId: storedChainId,
        validBefore: storedValidBefore,
      }),
    );
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify({ ok: true, state: 'unused', expiry: 'expired' })),
    );
    mount();
    const { result } = renderHook(
      () => useJpycEip3009Payment(jpycDep),
      { wrapper: makeWrapper() },
    );

    await flushStorageLoad();
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await flushStorageLoad();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchSpy.mock.calls) {
      expect(JSON.parse((init as RequestInit).body as string)).toEqual({
        lookup: 'nonce',
        chainId: storedChainId,
        from: CUSTOMER,
        nonce: RESTORED_NONCE,
        validBefore: storedValidBefore,
      });
    }
    expect(waitForTransactionReceipt).not.toHaveBeenCalled();
    expect(result.current.restoredIntent).toBeNull();
    expect(result.current.hasActiveIntent).toBe(false);
    expect(result.current.error).toBeNull();
    expect(
      window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY),
    ).toBeNull();
    vi.useRealTimers();
  });

  it.each([
    ['success' as const, true],
    ['reverted' as const, false],
  ])(
    '保存 chain が現在 deployment と違う settled receipt (%s) も終端復元して intent を解放する',
    async (receiptStatus, success) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-25T00:00:00Z'));
      const storedChainId =
        jpycDep.chainId === kairos.id ? polygon.id : kairos.id;
      const txHash = `0x${'4'.repeat(64)}` as Hex;
      storeRelayIntent(
        restoredRelayIntent({ chainId: storedChainId }),
      );
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: true, state: 'settled', txHash }),
        ),
      );
      mount();
      waitForStoredRelayReceiptMock.mockResolvedValueOnce({
        status: receiptStatus,
      });
      const { result } = renderHook(
        () => useJpycEip3009Payment(jpycDep),
        { wrapper: makeWrapper() },
      );

      await flushStorageLoad();
      await act(async () => vi.advanceTimersByTimeAsync(3_000));
      await flushStorageLoad();

      expect(waitForTransactionReceipt).not.toHaveBeenCalled();
      expect(waitForStoredRelayReceiptMock).toHaveBeenCalledWith(
        storedChainId,
        txHash,
        expect.any(Number),
      );
      expect(result.current.data).toEqual({ txHash, success });
      expect(result.current.recoveryState).toBeNull();
      expect(result.current.hasActiveIntent).toBe(false);
      expect(
        window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY),
      ).toBeNull();
      vi.useRealTimers();
    },
  );

  it('reload unknown の手動再確認で失効 unused を確認したら restoredIntent も解除する', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-25T00:00:00Z'));
    storeRelayIntent(
      restoredRelayIntent({
        validBefore: String(Math.floor(Date.now() / 1000) + 10),
      }),
    );
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, state: 'indeterminate' })),
    );
    mount();
    const { result } = renderHook(
      () => useJpycEip3009Payment(jpycDep),
      { wrapper: makeWrapper() },
    );

    await flushStorageLoad();
    await act(async () => vi.advanceTimersByTimeAsync(90_001));
    expect(result.current.recoveryState).toBe('exhausted');
    expect(result.current.restoredIntent).not.toBeNull();

    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify({ ok: true, state: 'unused', expiry: 'expired' })),
    );
    act(() => result.current.retrySamePayload());
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await flushStorageLoad();

    expect(result.current.recoveryState).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.restoredIntent).toBeNull();
    expect(result.current.hasActiveIntent).toBe(false);
    vi.useRealTimers();
  });

  it('reload 復元の reverted 後に新規署名すると古い restoredIntent 分類を解除する', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-25T00:00:00Z'));
    storeRelayIntent(restoredRelayIntent());
    const revertedTxHash = `0x${'4'.repeat(64)}` as Hex;
    const newTxHash = `0x${'5'.repeat(64)}` as Hex;
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            state: 'settled',
            txHash: revertedTxHash,
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, txHash: newTxHash })),
      );
    mount();
    waitForTransactionReceipt.mockResolvedValueOnce({ status: 'reverted' });
    const { result } = renderHook(
      () => useJpycEip3009Payment(jpycDep),
      { wrapper: makeWrapper() },
    );

    await flushStorageLoad();
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(result.current.data).toEqual({
      txHash: revertedTxHash,
      success: false,
    });
    expect(result.current.restoredIntent).not.toBeNull();

    act(() => {
      result.current.mutate({
        merchant: MERCHANT,
        value: 300n * 10n ** 18n,
      });
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));

    expect(signTypedData).toHaveBeenCalledOnce();
    expect(result.current.data).toEqual({
      txHash: newTxHash,
      success: true,
    });
    expect(result.current.restoredIntent).toBeNull();
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/relay/jpyc/status');
    expect(fetchSpy.mock.calls[1][0]).toBe('/api/relay/jpyc');
    vi.useRealTimers();
  });
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
// 第 8 回レビュー A-01: relay の tx が revert しても authorization が別の tx で使用済みなら、server は reverted でなく
// 202 pending (txHash なし = makeRespond の {kind:'pending'}) を返す。UI でも失敗にせず intent を保って再署名を封じ、
// status 照会で実際に authorization を使った tx の settled に進むことを固定する (server だけが pending を返し UI が
// 失敗のまま、を緑にしない)。
describe('useJpycEip3009Payment — relay の revert 後に authorization が使用済み (A-01)', () => {
  it('202 pending (txHash なし) → intent を保ち再署名を封鎖 → 再読み込み後の status で別の tx の settled に進む', async () => {
    const OTHER_TX = `0x${'5'.repeat(64)}` as Hex;
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, pending: true, txHash: null }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    );
    mount();
    const first = renderHook(() => useJpycEip3009Payment(jpycDep), {
      wrapper: makeWrapper(),
    });
    await flushStorageLoad();
    first.result.current.mutate({ merchant: MERCHANT, value: 300n * 10n ** 18n });
    await waitFor(() => expect(first.result.current.data?.pending).toBe(true));

    // 失敗 (reverted 形・error) にしない: pending のまま intent を保つ。
    expect(first.result.current.data).toEqual({ txHash: null, success: false, pending: true });
    expect(first.result.current.error).toBeNull();
    expect(first.result.current.hasActiveIntent).toBe(true);
    const posted = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
    ) as { nonce: string; validBefore: string };
    const saved = JSON.parse(
      window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY) as string,
    ) as RelayIntentMetadata | null;
    expect(saved?.nonce).toBe(posted.nonce);

    // 同じ画面での再送は新しい署名も POST もしない (二重払いの封鎖)。
    act(() => {
      first.result.current.mutate({ merchant: MERCHANT, value: 300n * 10n ** 18n });
    });
    await act(async () => Promise.resolve());
    expect(signTypedData).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledOnce();
    first.unmount();

    // 再読み込み: 保存した intent を status で照会し、別の tx の settled + receipt success で成功に進む。
    vi.useFakeTimers();
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, state: 'settled', txHash: OTHER_TX })),
    );
    const second = renderHook(() => useJpycEip3009Payment(jpycDep), {
      wrapper: makeWrapper(),
    });
    await advanceUntil(1_000, () =>
      expect(second.result.current.data).toEqual({ txHash: OTHER_TX, success: true }),
    );
    expect(second.result.current.recoveryState).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1][0]).toBe('/api/relay/jpyc/status');
    expect(JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string)).toEqual({
      lookup: 'nonce',
      chainId: jpycDep.chainId,
      from: CUSTOMER,
      nonce: posted.nonce,
      validBefore: posted.validBefore,
    });
    expect(waitForTransactionReceipt).toHaveBeenCalledWith({
      hash: OTHER_TX,
      confirmations: 1,
      timeout: expect.any(Number),
    });
    expect(signTypedData).toHaveBeenCalledOnce();
    expect(window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY)).toBeNull();
    vi.useRealTimers();
  });
});

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

  it('202 pending は intentSalt でなく署名対象の forwarder nonce を保存する', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, pending: true }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    );
    mount();
    const { result } = renderHook(() => useJpycEip3009Payment(jpycDep), {
      wrapper: makeWrapper(),
    });
    const value = 1_000n * 10n ** 18n;

    result.current.mutate({
      merchant: MERCHANT,
      value,
      gasMode: 'merchant',
    });
    await waitFor(() => expect(result.current.data?.pending).toBe(true));

    const body = lastPostBody();
    const stored = JSON.parse(
      window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY)!,
    ) as RelayIntentMetadata;
    const expectedNonce = buildForwarderNonce(
      {
        from: CUSTOMER,
        merchant: MERCHANT,
        merchantValue: BigInt(body.merchantValue as string),
        feeReceiver: env.feeReceiver as Address,
        feeValue: BigInt(body.feeValue as string),
        validAfter: 0n,
        validBefore: BigInt(body.validBefore as string),
        intentSalt: body.intentSalt as Hex,
      },
      jpycDep.chainId,
      FORWARDER,
    );
    expect(stored.nonce).toBe(expectedNonce);
    expect(stored.nonce).not.toBe(body.intentSalt);
    expect(
      window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY),
    ).not.toContain(body.signature as string);
  });

  // 第 8 回レビュー A-01 (recover / forwarder 経路): relay の tx が revert し、authorization が別の tx で使用済み
  // (または revert のブロックに固定して読めない) とき、server は 202 pending (txHash なし) を返す。forwarder nonce の
  // intent を保って再署名を封じ、再読み込み後の status で別の tx の settled に進むことを固定する。
  it('A-01: 202 pending (txHash なし) → forwarder nonce の intent を保ち再署名を封鎖 → 再読み込み後の status で settled', async () => {
    const OTHER_TX = `0x${'6'.repeat(64)}` as Hex;
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, pending: true, txHash: null }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    );
    mount();
    const first = renderHook(() => useJpycEip3009Payment(jpycDep), {
      wrapper: makeWrapper(),
    });
    await flushStorageLoad();
    const value = 1_000n * 10n ** 18n;
    first.result.current.mutate({ merchant: MERCHANT, value, gasMode: 'merchant' });
    await waitFor(() => expect(first.result.current.data?.pending).toBe(true));

    expect(first.result.current.data).toEqual({ txHash: null, success: false, pending: true });
    expect(first.result.current.error).toBeNull();
    const body = lastPostBody();
    const expectedNonce = buildForwarderNonce(
      {
        from: CUSTOMER,
        merchant: MERCHANT,
        merchantValue: BigInt(body.merchantValue as string),
        feeReceiver: env.feeReceiver as Address,
        feeValue: BigInt(body.feeValue as string),
        validAfter: 0n,
        validBefore: BigInt(body.validBefore as string),
        intentSalt: body.intentSalt as Hex,
      },
      jpycDep.chainId,
      FORWARDER,
    );
    const stored = JSON.parse(
      window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY) as string,
    ) as RelayIntentMetadata | null;
    expect(stored?.nonce).toBe(expectedNonce);
    expect(stored?.routeKind).toBe('recover');

    // 同じ画面での再送は新しい署名も POST もしない。
    act(() => {
      first.result.current.mutate({ merchant: MERCHANT, value, gasMode: 'merchant' });
    });
    await act(async () => Promise.resolve());
    expect(signTypedData).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledOnce();
    first.unmount();

    vi.useFakeTimers();
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, state: 'settled', txHash: OTHER_TX })),
    );
    const second = renderHook(() => useJpycEip3009Payment(jpycDep), {
      wrapper: makeWrapper(),
    });
    await advanceUntil(1_000, () =>
      expect(second.result.current.data).toEqual({ txHash: OTHER_TX, success: true }),
    );
    expect(fetchSpy.mock.calls[1][0]).toBe('/api/relay/jpyc/status');
    expect(JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string)).toEqual({
      lookup: 'nonce',
      chainId: jpycDep.chainId,
      from: CUSTOMER,
      nonce: expectedNonce,
      validBefore: body.validBefore,
    });
    expect(signTypedData).toHaveBeenCalledOnce();
    expect(window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY)).toBeNull();
    vi.useRealTimers();
  });

  it('gasMode=customer (チップ): feeValue=フロア (1% 非適用)・merchantValue=value・payload に gasMode=customer', async () => {
    setTipMessageFlag(true);
    mount();
    const { result } = renderHook(() => useJpycEip3009Payment(jpycDep), {
      wrapper: makeWrapper(),
    });
    const value = 1_000n * 10n ** 18n; // 1000 JPYC: merchant なら 1% = 10 JPYC だが customer はフロア
    const privateMessage = 'private-tip-message-recover';
    result.current.mutate({
      merchant: MERCHANT,
      value,
      gasMode: 'customer',
      tipMessage: privateMessage,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // 確定モデル: client は payload の gasMode + 署名 chainId をそのまま recoverFeeValue へ渡す。
    expect(recoverFeeMock).toHaveBeenCalledWith(
      value,
      'customer',
      jpycDep.chainId,
    );
    const body = lastPostBody();
    expect(body.gasMode).toBe('customer');
    expect(body.tipMessage).toBe(privateMessage);
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
    expect(recoverFeeMock).toHaveBeenCalledWith(
      value,
      'merchant',
      jpycDep.chainId,
    );
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
    expect(recoverFeeMock).toHaveBeenCalledWith(
      value,
      'customer',
      jpycDep.chainId,
    );
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

const ORDER_CONTEXT = { merchant: MERCHANT, chainId: jpycDep.chainId, tokenAddress: jpycDep.address, webhook: `${location.origin}/api/order/notify?h=alice`, totalValue: 1000n * 10n ** 18n };

describe('A2c browser binding', () => {
  it.each(['free', 'recover'] as const)('persists %s opening only after signing and before broadcast; never sends secret to relay; success retains order', async (mode) => {
    const { canonicalOrder, orderBindSalt, orderDigest } = await import('@/lib/orderBind');
    const { latestOrderDelivery } = await import('../_helpers/orderDeliveryView');
    const order = canonicalOrder({ chainId: jpycDep.chainId, tokenAddress: jpycDep.address, merchant: MERCHANT, handle: 'alice', orderId: 'before-sign', items: [{ name: 'Tea', qty: 1, price: '300' }], statusToken: 's'.repeat(43), customerMemo: 'no ice' });
    vi.mocked(jpycForwarderFor).mockReturnValue(mode === 'recover' ? '0x3333333333333333333333333333333333333333' : null);
    mount();
    signTypedData.mockImplementation(async () => {
      expect(latestOrderDelivery().kind).toBe('empty');
      return `0x${'a'.repeat(130)}`;
    });
    const { result } = renderHook(() => useJpycEip3009Payment(jpycDep, { restoreOrderDelivery: true, orderContext: ORDER_CONTEXT }), { wrapper: makeWrapper() });
    result.current.mutate({ merchant: MERCHANT, value: 300n * 10n ** 18n, order });
    await waitFor(() => expect(result.current.data?.success).toBe(true));
    const loaded = latestOrderDelivery();
    expect(loaded.kind).toBe('ready');
    if (loaded.kind !== 'ready') throw new Error('missing order');
    expect(loaded.record.state).toBe('notify-pending');
    const salt = orderBindSalt(orderDigest(order), loaded.record.bind.secret);
    const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(payload[mode === 'recover' ? 'intentSalt' : 'nonce']).toBe(salt);
    expect(fetchSpy.mock.calls[0][1].body).not.toContain(loaded.record.bind.secret);
    expect(sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY)).toBeNull();
    expect(result.current.orderDelivery).toEqual(loaded.record);
  });
});

describe('A2c recovery and storage failure transitions', () => {
  async function fixture(mode: 'free' | 'recover' = 'free') {
    const { bindingFixture } = await import('../_helpers/orderBinding');
    return bindingFixture(mode, { chainId: jpycDep.chainId, tokenAddress: jpycDep.address, merchant: MERCHANT, handle: 'alice', orderId: 'saved-order', items: [{ name: 'Tea', qty: 1, price: '300' }], statusToken: 's'.repeat(43) });
  }
  it('unavailable order storage discards the signature and prevents broadcast', async () => {
    const { ORDER_DELIVERY_KEY } = await import('@/lib/orderDelivery');
    const f = await fixture();
    mount();
    const { result } = renderHook(() => useJpycEip3009Payment(jpycDep, { restoreOrderDelivery: true, orderContext: ORDER_CONTEXT }), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isRestoring).toBe(false));
    const original = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith(ORDER_DELIVERY_KEY)) throw new Error('quota');
      original.call(this, key, value);
    });
    act(() => result.current.mutate({ merchant: MERCHANT, value: 300n * 10n ** 18n, order: f.order }));
    await waitFor(() => expect(result.current.error?.message).toBe('order_binding_storage_unavailable'));
    expect(signTypedData).toHaveBeenCalledOnce(); expect(fetchSpy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
  it.each(['signed', 'notify-pending'] as const)('reload from %s recovers the same authorization even after payment intent was cleared', async (state) => {
    const { saveOrderDelivery, resolveOrderDelivery } = await import('@/lib/orderDelivery'); const { latestOrderDelivery } = await import('../_helpers/orderDeliveryView');
    const f = await fixture('recover');
    const firstHash = `0x${'ab'.repeat(32)}` as Hex;
    const finalHash = `0x${'cd'.repeat(32)}` as Hex;
    saveOrderDelivery(state === 'signed' ? f.record : resolveOrderDelivery(f.record, firstHash));
    vi.useFakeTimers();
    mount();
    fetchSpy.mockImplementation(async () => Response.json({ ok: true, state: 'settled', txHash: finalHash }));
    const { result } = renderHook(() => useJpycEip3009Payment(jpycDep, { restoreOrderDelivery: true, orderContext: { ...ORDER_CONTEXT, totalValue: BigInt(f.record.intent.merchantValue) + BigInt(f.record.intent.feeValue) } }), { wrapper: makeWrapper() });
    await advanceUntil(3000, () => expect(result.current.data).toEqual({ success: true, txHash: finalHash }));
    expect(result.current.orderDelivery?.order).toEqual(f.order);
    expect(result.current.orderDelivery?.bind).toEqual(f.bind);
    expect(result.current.orderDelivery?.txHash).toBe(finalHash);
    expect(latestOrderDelivery().kind).toBe('ready');
    expect(signTypedData).not.toHaveBeenCalled();
    for (const [url, init] of fetchSpy.mock.calls) {
      expect(url).toBe('/api/relay/jpyc/status'); expect(init.body).not.toContain(f.bind.secret);
    }
    vi.useRealTimers();
  });
  it.each(['unused', 'reverted'] as const)('proven %s authorization can discard an unpaid snapshot', async (outcome) => {
    const { saveOrderDelivery } = await import('@/lib/orderDelivery'); const { latestOrderDelivery } = await import('../_helpers/orderDeliveryView');
    const f = await fixture(); saveOrderDelivery(f.record);
    vi.useFakeTimers(); mount();
    fetchSpy.mockImplementation(async () => Response.json(outcome === 'unused' ? { ok: true, state: 'unused', expiry: 'expired' } : { ok: true, state: 'settled', txHash: `0x${'ab'.repeat(32)}` }));
    waitForTransactionReceipt.mockResolvedValue({ status: 'reverted' });
    renderHook(() => useJpycEip3009Payment(jpycDep, { restoreOrderDelivery: true, orderContext: ORDER_CONTEXT }), { wrapper: makeWrapper() });
    await advanceUntil(9000, () => expect(latestOrderDelivery()).toEqual({ kind: 'empty' }));
    expect(signTypedData).not.toHaveBeenCalled(); vi.useRealTimers();
  });
  it('IP retry retains the exact opening and signs once', async () => {
    const { latestOrderDelivery } = await import('../_helpers/orderDeliveryView');
    const f = await fixture(); vi.mocked(jpycForwarderFor).mockReturnValue(null); mount();
    fetchSpy.mockResolvedValueOnce(Response.json({ error: 'ip_rate_limited' }, { status: 429 }));
    const { result } = renderHook(() => useJpycEip3009Payment(jpycDep, { restoreOrderDelivery: true, orderContext: ORDER_CONTEXT }), { wrapper: makeWrapper() });
    act(() => result.current.mutate({ merchant: MERCHANT, value: 300n * 10n ** 18n, order: f.order }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    const saved = result.current.orderDelivery;
    expect(saved).not.toBeNull();
    expect(latestOrderDelivery().kind).toBe('empty');
    fetchSpy.mockImplementationOnce(async () => {
      expect(latestOrderDelivery()).toEqual({ kind: 'ready', record: saved });
      return Response.json({ ok: true, txHash: `0x${'ab'.repeat(32)}` });
    });
    act(() => result.current.retryRelay());
    await waitFor(() => expect(result.current.data?.success).toBe(true));
    expect(signTypedData).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0][1].body).toBe(fetchSpy.mock.calls[1][1].body);
    expect(result.current.orderDelivery?.bind).toEqual(saved?.bind);
  });
  it('pending/unknown retain their saved opening without notification or new authorization', async () => {
    const { latestOrderDelivery } = await import('../_helpers/orderDeliveryView');
    const f = await fixture(); vi.mocked(jpycForwarderFor).mockReturnValue(null); mount();
    fetchSpy.mockResolvedValue(Response.json({ pending: true, txHash: null }, { status: 202 }));
    const { result } = renderHook(() => useJpycEip3009Payment(jpycDep, { restoreOrderDelivery: true, orderContext: ORDER_CONTEXT }), { wrapper: makeWrapper() });
    act(() => result.current.mutate({ merchant: MERCHANT, value: 300n * 10n ** 18n, order: f.order }));
    await waitFor(() => expect(result.current.data?.pending).toBe(true));
    expect(latestOrderDelivery().kind).toBe('ready');
    expect(result.current.orderDelivery?.state).toBe('signed');
    act(() => result.current.mutate({ merchant: MERCHANT, value: 300n * 10n ** 18n, order: f.order }));
    expect(signTypedData).toHaveBeenCalledOnce();
  });
});

it('A2c lost relay response resolves the original opening; a failed resolution write keeps payment successful', async () => {
  const { bindingFixture } = await import('../_helpers/orderBinding');
  const { ORDER_DELIVERY_KEY } = await import('@/lib/orderDelivery'); const { latestOrderDelivery } = await import('../_helpers/orderDeliveryView');
  const f = bindingFixture('free', { chainId: jpycDep.chainId, tokenAddress: jpycDep.address, merchant: MERCHANT, handle: 'alice', orderId: 'unknown', items: [{ name: 'Tea', qty: 1, price: '300' }] });
  vi.mocked(jpycForwarderFor).mockReturnValue(null);
  mount(); vi.useFakeTimers();
  const original = Storage.prototype.setItem;
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key.startsWith(ORDER_DELIVERY_KEY) && JSON.parse(value).state === 'notify-pending') throw new Error('quota');
    original.call(this, key, value);
  });
  fetchSpy.mockImplementation(async (url) => {
    if (url === '/api/relay/jpyc') throw new Error('response lost');
    return Response.json({ ok: true, state: 'settled', txHash: `0x${'ab'.repeat(32)}` });
  });
  const { result } = renderHook(() => useJpycEip3009Payment(jpycDep, { restoreOrderDelivery: true, orderContext: ORDER_CONTEXT }), { wrapper: makeWrapper() });
  await advanceUntil(0, () => expect(result.current.isRestoring).toBe(false));
  act(() => result.current.mutate({ merchant: MERCHANT, value: 300n * 10n ** 18n, order: f.order }));
  // 署名の後・送信の前に保存した開示 (bind) を、応答が失われた後の解決と比べる。
  await advanceUntil(0, () => expect(result.current.orderDelivery?.bind).toBeDefined());
  const opening = result.current.orderDelivery?.bind;
  await advanceUntil(3000, () => expect(result.current.data?.success).toBe(true));
  expect(result.current.orderDelivery?.bind).toEqual(opening);
  expect(result.current.orderDelivery?.state).toBe('notify-pending');
  expect(latestOrderDelivery()).toMatchObject({ kind: 'ready', record: { state: 'signed', bind: opening } });
  expect(signTypedData).toHaveBeenCalledOnce();
  write.mockRestore(); vi.useRealTimers();
});

it('A2c order chunk failure cannot hide an existing ordinary relay payment intent', async () => {
  vi.doMock('@/lib/orderDelivery', () => { throw new Error('chunk unavailable'); });
  try {
    vi.useFakeTimers();
    storeRelayIntent(restoredRelayIntent()); mount();
    fetchSpy.mockImplementation(async () => Response.json({ ok: true, state: 'settled', txHash: `0x${'ab'.repeat(32)}` }));
    const { result } = renderHook(() => useJpycEip3009Payment(jpycDep, { restoreOrderDelivery: true, orderContext: ORDER_CONTEXT }), { wrapper: makeWrapper() });
    // Module loading uses real microtasks; await the outcome rather than assuming two ticks
    // scheduled the fake recovery timer (worker reuse changes module-cache timing).
    await vi.waitFor(async () => {
      await act(async () => vi.advanceTimersByTimeAsync(3000));
      expect(result.current.data?.success).toBe(true);
    }, { timeout: 2000, interval: 10 });
    expect(result.current.orderDeliveryLoadError).toBe(true);
    expect(signTypedData).not.toHaveBeenCalled();
  } finally {
    vi.doUnmock('@/lib/orderDelivery'); vi.useRealTimers();
  }
});

 it('A2c ordinary payment hooks never restore an undelivered order', async () => {
  const { bindingFixture } = await import('../_helpers/orderBinding');
  const { saveOrderDelivery, resolveOrderDelivery } = await import('@/lib/orderDelivery');
  const f = bindingFixture('free', { chainId: jpycDep.chainId, tokenAddress: jpycDep.address, merchant: MERCHANT, handle: 'alice', orderId: 'old', items: [{ name: 'Tea', qty: 1, price: '300' }] });
  saveOrderDelivery(resolveOrderDelivery(f.record, `0x${'ab'.repeat(32)}`)); mount();
  const { result } = renderHook(() => useJpycEip3009Payment(jpycDep), { wrapper: makeWrapper() });
  await waitFor(() => expect(result.current.isRestoring).toBe(false));
  expect(result.current.orderDelivery).toBeNull();
  expect(result.current.restoredIntent).toBeNull();
  expect(fetchSpy).not.toHaveBeenCalled();
});

it.each(['prepared', 'terminal'] as const)('A2c %s record cannot block persisting the next signed checkout', async (state) => {
  const { bindingFixture } = await import('../_helpers/orderBinding');
  const { ORDER_DELIVERY_KEY, resolveOrderDelivery, saveOrderDelivery, terminateOrderDelivery } = await import('@/lib/orderDelivery'); const { latestOrderDelivery } = await import('../_helpers/orderDeliveryView');
  const f = bindingFixture('free', { chainId: jpycDep.chainId, tokenAddress: jpycDep.address, merchant: MERCHANT, handle: 'alice', orderId: 'old', items: [{ name: 'Tea', qty: 1, price: '300' }] });
  if (state === 'terminal') {
    const record = resolveOrderDelivery(f.record, `0x${'ab'.repeat(32)}`);
    saveOrderDelivery(record); expect(terminateOrderDelivery(record)).toBe(true);
  } else sessionStorage.setItem(ORDER_DELIVERY_KEY, JSON.stringify({ ...f.record, state: 'prepared' }));
  mount(); vi.mocked(jpycForwarderFor).mockReturnValue(null);
  fetchSpy.mockImplementation(async () => {
    expect(latestOrderDelivery()).toMatchObject({ kind: 'ready', record: { state: 'signed', order: { orderId: 'new' } } });
    return Response.json({ ok: true, txHash: `0x${'cd'.repeat(32)}` });
  });
  const { result } = renderHook(() => useJpycEip3009Payment(jpycDep, { restoreOrderDelivery: true, orderContext: ORDER_CONTEXT }), { wrapper: makeWrapper() });
  await waitFor(() => expect(result.current.isRestoring).toBe(false));
  expect(result.current.restoredIntent).toBeNull(); expect(fetchSpy).not.toHaveBeenCalled();
  act(() => result.current.mutate({ merchant: MERCHANT, value: 300n * 10n ** 18n, order: { ...f.order, orderId: 'new' } }));
  await waitFor(() => expect(result.current.data?.success).toBe(true));
  expect(signTypedData).toHaveBeenCalledOnce();
  expect(latestOrderDelivery()).toMatchObject({ kind: 'ready', record: { state: 'notify-pending', order: { orderId: 'new' } } });
});
it('A2c navigation during a wallet prompt leaves no unsigned record or late broadcast', async () => {
  const { bindingFixture } = await import('../_helpers/orderBinding');
  const { latestOrderDelivery } = await import('../_helpers/orderDeliveryView');
  const f = bindingFixture('free', { chainId: jpycDep.chainId, tokenAddress: jpycDep.address, merchant: MERCHANT, handle: 'alice', orderId: 'unsigned', items: [{ name: 'Tea', qty: 1, price: '300' }] });
  let sign!: (signature: Hex) => void;
  mount({ signImpl: () => new Promise((resolve) => { sign = resolve; }) });
  vi.mocked(jpycForwarderFor).mockReturnValue(null);
  const first = renderHook(() => useJpycEip3009Payment(jpycDep, { restoreOrderDelivery: true, orderContext: ORDER_CONTEXT }), { wrapper: makeWrapper() });
  act(() => first.result.current.mutate({ merchant: MERCHANT, value: 300n * 10n ** 18n, order: f.order }));
  await waitFor(() => expect(signTypedData).toHaveBeenCalledOnce());
  expect(latestOrderDelivery()).toEqual({ kind: 'empty' }); first.unmount();
  await act(async () => sign(`0x${'ab'.repeat(65)}`));
  const next = renderHook(() => useJpycEip3009Payment(jpycDep, { restoreOrderDelivery: true, orderContext: ORDER_CONTEXT }), { wrapper: makeWrapper() });
  await waitFor(() => expect(next.result.current.isRestoring).toBe(false));
  expect(next.result.current.restoredIntent).toBeNull();
  expect(latestOrderDelivery()).toEqual({ kind: 'empty' }); expect(fetchSpy).not.toHaveBeenCalled();
});

describe('A2c context and authorization slot isolation', () => {
  async function saved() {
    const { bindingFixture } = await import('../_helpers/orderBinding');
    return bindingFixture('free', { chainId: jpycDep.chainId, tokenAddress: jpycDep.address, merchant: MERCHANT, handle: 'alice', orderId: 'old', items: [{ name: 'Tea', qty: 1, price: '300' }] });
  }
  it.each(['settled', 'receipt-pending'] as const)('changing the mounted checkout detaches a %s restored order', async (phase) => {
    const { saveOrderDelivery, resolveOrderDelivery } = await import('@/lib/orderDelivery');
    const f = await saved(); saveOrderDelivery(resolveOrderDelivery(f.record, `0x${'ab'.repeat(32)}`));
    mount(); vi.useFakeTimers();
    let receipt!: (result: { status: 'success' }) => void;
    if (phase === 'receipt-pending') waitForTransactionReceipt.mockImplementationOnce(() => new Promise((resolve) => { receipt = resolve; }));
    fetchSpy.mockResolvedValue(Response.json({ ok: true, state: 'settled', txHash: `0x${'ab'.repeat(32)}` }));
    const { result, rerender } = renderHook(({ orderId }) => useJpycEip3009Payment(jpycDep, {
      restoreOrderDelivery: true, orderContext: { ...ORDER_CONTEXT, orderId },
    }), { wrapper: makeWrapper(), initialProps: { orderId: 'old' } });
    await vi.waitFor(async () => {
      await act(async () => vi.advanceTimersByTimeAsync(3000));
      expect(waitForTransactionReceipt).toHaveBeenCalledOnce();
    }, { timeout: 2000, interval: 10 });
    if (phase === 'settled') expect(result.current.data?.success).toBe(true);
    // 別の会計に変えた後の読み込み直しが終わってから、遅れて届く receipt でも戻らないことを確かめる。
    rerender({ orderId: 'new' });
    await advanceUntil(0, () => expect(result.current.isRestoring).toBe(false));
    if (phase === 'receipt-pending') await act(async () => receipt({ status: 'success' }));
    expect(result.current.restoredIntent).toBeNull(); expect(result.current.data).toBeUndefined();
    expect(result.current.orderDelivery).toBeNull(); expect(result.current.hasActiveIntent).toBe(false);
    expect(result.current.isPending).toBe(false); expect(result.current.recoveryState).toBeNull();
    expect(signTypedData).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
  it.each([
    { merchant: '0x2222222222222222222222222222222222222222' }, { chainId: 1 },
    { tokenAddress: '0x0000000000000000000000000000000000000def' }, { orderId: 'different' },
    { webhook: 'https://third.example/hook' }, { webhook: `${location.origin}/api/order/notify?h=bob` },
  ])('a mismatched %j context cannot recover completion through either storage slot', async (change) => {
    const { saveOrderDelivery, resolveOrderDelivery } = await import('@/lib/orderDelivery');
    const f = await saved(); const record = resolveOrderDelivery(f.record, `0x${'ab'.repeat(32)}`);
    saveOrderDelivery(record); storeRelayIntent(record.intent); mount();
    const { result } = renderHook(() => useJpycEip3009Payment(jpycDep, { restoreOrderDelivery: true, orderContext: { ...ORDER_CONTEXT, ...change } }), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isRestoring).toBe(false));
    expect(result.current.restoredIntent).toBeNull(); expect(result.current.data).toBeUndefined();
    expect(result.current.orderDelivery).toBeNull(); expect(result.current.hasActiveIntent).toBe(false);
    expect(result.current.backgroundOrderDeliveries).toEqual([record]);
    expect(fetchSpy).not.toHaveBeenCalled(); expect(signTypedData).not.toHaveBeenCalled();
  });
  it('a new mobile order persists and pays without replacing another order’s pending delivery', async () => {
    const { saveOrderDelivery, resolveOrderDelivery, loadOrderDeliveries } = await import('@/lib/orderDelivery');
    const { canonicalOrder } = await import('@/lib/orderBind');
    const f = await saved(); const old = resolveOrderDelivery(f.record, `0x${'ab'.repeat(32)}`);
    saveOrderDelivery(old); mount(); vi.mocked(jpycForwarderFor).mockReturnValue(null);
    const nextOrder = canonicalOrder({ ...f.order, orderId: 'new', handle: 'bob' });
    const { result } = renderHook(() => useJpycEip3009Payment(jpycDep, { restoreOrderDelivery: true, orderContext: { ...ORDER_CONTEXT, orderId: 'new', webhook: `${location.origin}/api/order/notify?h=bob` } }), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isRestoring).toBe(false));
    act(() => result.current.mutate({ merchant: MERCHANT, value: 300n * 10n ** 18n, order: nextOrder }));
    await waitFor(() => expect(result.current.data?.success).toBe(true));
    expect(loadOrderDeliveries().records).toHaveLength(2);
    expect(loadOrderDeliveries().records).toContainEqual(old);
    expect(result.current.orderDelivery?.order.orderId).toBe('new');
    expect(sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY)).toBeNull();
    expect(signTypedData).toHaveBeenCalledOnce();
  });
  it('IP rejection removes the disk record across reload and a retry save failure never POSTS again', async () => {
    const { ORDER_DELIVERY_KEY } = await import('@/lib/orderDelivery'); const { latestOrderDelivery } = await import('../_helpers/orderDeliveryView');
    const f = await saved(); mount(); vi.mocked(jpycForwarderFor).mockReturnValue(null);
    fetchSpy.mockResolvedValueOnce(Response.json({ error: 'ip_rate_limited' }, { status: 429 }));
    const first = renderHook(() => useJpycEip3009Payment(jpycDep, { restoreOrderDelivery: true, orderContext: ORDER_CONTEXT }), { wrapper: makeWrapper() });
    act(() => first.result.current.mutate({ merchant: MERCHANT, value: 300n * 10n ** 18n, order: f.order }));
    await waitFor(() => expect(first.result.current.isError).toBe(true));
    expect(latestOrderDelivery()).toEqual({ kind: 'empty' });
    const original = Storage.prototype.setItem;
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith(ORDER_DELIVERY_KEY)) throw new Error('quota');
      original.call(this, key, value);
    });
    act(() => first.result.current.retryRelay());
    await waitFor(() => expect(first.result.current.error?.message).toBe('order_binding_storage_unavailable'));
    expect(fetchSpy).toHaveBeenCalledOnce(); expect(signTypedData).toHaveBeenCalledOnce();
    write.mockRestore(); first.unmount();
    const next = renderHook(() => useJpycEip3009Payment(jpycDep, { restoreOrderDelivery: true, orderContext: ORDER_CONTEXT }), { wrapper: makeWrapper() });
    await waitFor(() => expect(next.result.current.isRestoring).toBe(false));
    expect(next.result.current.restoredIntent).toBeNull(); expect(next.result.current.hasActiveIntent).toBe(false);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});


describe('A2c background signed-order recovery', () => {
  async function signed() {
    const { bindingFixture } = await import('../_helpers/orderBinding');
    const { saveOrderDelivery } = await import('@/lib/orderDelivery');
    const f = bindingFixture('free', { chainId: jpycDep.chainId, tokenAddress: jpycDep.address, merchant: MERCHANT, handle: 'alice', orderId: 'old', items: [{ name: 'Tea', qty: 1, price: '300' }] });
    const validBefore = String(Math.floor(Date.now() / 1000) + 300);
    const record = { ...f.record, bind: { ...f.bind, validBefore }, intent: { ...f.record.intent, validBefore, issuedAt: Date.now() } };
    expect(saveOrderDelivery(record)).toBe(true); mount(); vi.mocked(jpycForwarderFor).mockReturnValue(null); vi.useFakeTimers();
    return record;
  }
  it('holds a new same-shop signature and resolves the old payment only into background delivery', async () => {
    const record = await signed();
    fetchSpy.mockImplementation(async () => Response.json({ ok: true, state: 'settled', txHash: `0x${'ab'.repeat(32)}` }));
    const { result } = renderHook(() => useJpycEip3009Payment(jpycDep, { restoreOrderDelivery: true, orderContext: { ...ORDER_CONTEXT, orderId: 'new' } }), { wrapper: makeWrapper() });
    await flushStorageLoad();
    act(() => result.current.mutate({ merchant: MERCHANT, value: 300n * 10n ** 18n }));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(signTypedData).not.toHaveBeenCalled();
    await vi.waitFor(async () => {
      await act(async () => vi.advanceTimersByTimeAsync(3000));
      expect(result.current.backgroundOrderDeliveries).toEqual([expect.objectContaining({ state: 'notify-pending', order: record.order })]);
    }, { timeout: 2000, interval: 10 });
    expect(result.current.data).toBeUndefined(); expect(result.current.restoredIntent).toBeNull();
    expect(fetchSpy.mock.calls.every(([url]) => url === '/api/relay/jpyc/status')).toBe(true);
    expect(signTypedData).not.toHaveBeenCalled(); vi.useRealTimers();
  });
  it.each(['expired', 'reverted'])('%s proof abandons a non-matching signed record', async (outcome) => {
    await signed(); const { latestOrderDelivery } = await import('../_helpers/orderDeliveryView');
    if (outcome === 'expired') vi.advanceTimersByTime(300_000);
    waitForTransactionReceipt.mockResolvedValue({ status: 'reverted' });
    fetchSpy.mockImplementation(async () => Response.json(outcome === 'expired' ? { ok: true, state: 'unused', expiry: 'expired' } : { ok: true, state: 'settled', txHash: `0x${'ab'.repeat(32)}` }));
    const { result } = renderHook(() => useJpycEip3009Payment(jpycDep, { restoreOrderDelivery: true, orderContext: { ...ORDER_CONTEXT, orderId: 'new' } }), { wrapper: makeWrapper() });
    await vi.waitFor(async () => {
      await act(async () => vi.advanceTimersByTimeAsync(9000));
      expect(latestOrderDelivery()).toEqual({ kind: 'empty' });
    }, { timeout: 2000, interval: 10 });
    expect(result.current.data).toBeUndefined(); expect(result.current.restoredIntent).toBeNull();
    expect(result.current.orderPaymentHold).toBe(false);
    expect(signTypedData).not.toHaveBeenCalled();
    fetchSpy.mockResolvedValue(Response.json({ ok: true, txHash: `0x${'cd'.repeat(32)}` }));
    act(() => result.current.mutate({ merchant: MERCHANT, value: 300n * 10n ** 18n }));
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(signTypedData).toHaveBeenCalledOnce(); vi.useRealTimers();
  });
  // 第 7 回レビュー A6 (再レビュー反映): 端末の時計で期限を過ぎても、チェーン上でまだ期限前 (live) の間は保留を外さず、
  // 同じ店の新しい署名を許さない。チェーンの期限が過ぎて expired が証明されたら従来どおり放棄して新しい署名を許す。
  it('keeps the same-shop hold while the chain still reports the old signature live, then abandons on proven expiry', async () => {
    const record = await signed(); const { latestOrderDelivery } = await import('../_helpers/orderDeliveryView');
    vi.advanceTimersByTime(300_000);
    let expiry: 'live' | 'expired' = 'live';
    fetchSpy.mockImplementation(async () => Response.json({ ok: true, state: 'unused', expiry }));
    const { result } = renderHook(() => useJpycEip3009Payment(jpycDep, { restoreOrderDelivery: true, orderContext: { ...ORDER_CONTEXT, orderId: 'new' } }), { wrapper: makeWrapper() });
    await advanceUntil(9_000, () => expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(result.current.orderPaymentHold).toBe(true);
    expect(latestOrderDelivery()).toEqual({ kind: 'ready', record });
    act(() => result.current.mutate({ merchant: MERCHANT, value: 300n * 10n ** 18n }));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(signTypedData).not.toHaveBeenCalled();

    expiry = 'expired';
    await vi.waitFor(async () => {
      await act(async () => vi.advanceTimersByTimeAsync(9_000));
      expect(latestOrderDelivery()).toEqual({ kind: 'empty' });
    }, { timeout: 2000, interval: 10 });
    expect(result.current.orderPaymentHold).toBe(false);
    vi.useRealTimers();
  });
  it('unmounting a background receipt reader preserves the unresolved opening', async () => {
    const record = await signed(); const { latestOrderDelivery } = await import('../_helpers/orderDeliveryView');
    let receipt!: (value: { status: 'success' }) => void;
    waitForTransactionReceipt.mockImplementation(() => new Promise((resolve) => { receipt = resolve; }));
    fetchSpy.mockResolvedValue(Response.json({ ok: true, state: 'settled', txHash: `0x${'ab'.repeat(32)}` }));
    const hook = renderHook(() => useJpycEip3009Payment(jpycDep, { restoreOrderDelivery: true, orderContext: { ...ORDER_CONTEXT, orderId: 'new' } }), { wrapper: makeWrapper() });
    await vi.waitFor(async () => {
      await act(async () => vi.advanceTimersByTimeAsync(3000));
      expect(waitForTransactionReceipt).toHaveBeenCalledOnce();
    }, { timeout: 2000, interval: 10 });
    hook.unmount(); await act(async () => receipt({ status: 'success' }));
    expect(latestOrderDelivery()).toEqual({ kind: 'ready', record });
    expect(signTypedData).not.toHaveBeenCalled(); vi.useRealTimers();
  });
});

// 第 9 回レビュー A-4: lastSignedFrom は記録用 (履歴・控え・確認の署名のウォレット) に、この mount の最後の試みで
// 署名を求めた authorization の from を返す。呼び出し側が await を挟んで mutate する間にウォレットを切り替えても、
// 実際の送金元 (payload の from) と一致する。署名・POST の中身は変えない。
describe('useJpycEip3009Payment — 記録用の送金元 lastSignedFrom (第 9 回レビュー A-4)', () => {
  const OTHER: Address = getAddress('0x8888888888888888888888888888888888888888');
  const VALUE = 300n * 10n ** 18n;

  it('mutate の前に B へ切り替えると、署名・POST の from と lastSignedFrom はどれも B。後で A に戻しても B のまま', async () => {
    mount();
    const { result, rerender } = renderHook(() => useJpycEip3009Payment(jpycDep), { wrapper: makeWrapper() });
    await flushStorageLoad();
    await waitFor(() => expect(result.current.isRestoring).toBe(false));
    expect(result.current.lastSignedFrom).toBeUndefined();
    // 呼び出し側の await (admission・注文の束縛の読み込み) の間に B へ切り替えた
    mockHook(useAccount, { address: OTHER, chainId: jpycDep.chainId });
    rerender();
    act(() => result.current.mutate({ merchant: MERCHANT, value: VALUE }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.from).toBe(OTHER);
    expect(signTypedData.mock.calls[0][0].account).toBe(OTHER);
    expect(result.current.lastSignedFrom).toBe(OTHER);
    mockHook(useAccount, { address: CUSTOMER, chainId: jpycDep.chainId });
    rerender();
    expect(result.current.lastSignedFrom).toBe(OTHER);
  });

  it('署名の前に止まった次の試み (未接続) には、前の試みの from を持ち越さない', async () => {
    mount();
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: 'invalid_payload' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const { result, rerender } = renderHook(() => useJpycEip3009Payment(jpycDep), { wrapper: makeWrapper() });
    await flushStorageLoad();
    await waitFor(() => expect(result.current.isRestoring).toBe(false));
    act(() => result.current.mutate({ merchant: MERCHANT, value: VALUE }));
    await waitFor(() => expect(result.current.error?.message).toBe('invalid_payload'));
    expect(result.current.lastSignedFrom).toBe(CUSTOMER);
    mockHook(useAccount, { address: undefined, chainId: undefined });
    rerender();
    act(() => result.current.mutate({ merchant: MERCHANT, value: VALUE }));
    await waitFor(() => expect(result.current.error?.message).toBe('wallet_not_connected'));
    expect(result.current.lastSignedFrom).toBeUndefined();
    expect(signTypedData).toHaveBeenCalledOnce();
  });

  it('同じ payload の再送 (IP 制限の後の retryRelay) では、再送の時の接続先でなく、その payload の from', async () => {
    mount();
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: 'ip_rate_limited' }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const { result, rerender } = renderHook(() => useJpycEip3009Payment(jpycDep), { wrapper: makeWrapper() });
    await flushStorageLoad();
    await waitFor(() => expect(result.current.isRestoring).toBe(false));
    act(() => result.current.mutate({ merchant: MERCHANT, value: VALUE }));
    await waitFor(() => expect(isRelayIpRateLimitedError(result.current.error)).toBe(true));
    mockHook(useAccount, { address: OTHER, chainId: jpycDep.chainId });
    rerender();
    await act(async () => {
      result.current.retryRelay();
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(signTypedData).toHaveBeenCalledOnce();
    expect(JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string).from).toBe(CUSTOMER);
    expect(result.current.lastSignedFrom).toBe(CUSTOMER);
  });
});

// 画面を離れた (unmount した) hook の試みは、署名の後でも POST も復旧の枠 (openpay:relay-intent:v1) の保存もしない。
// 離れて開き直した画面 (新しい hook) で払い直して成立した後で、古い署名の承認や止まっていた再送 (IP 制限の後) が動いても、
// 2 本目を送らず枠も上書きしない (nonce が別なので、送れば両方成立する = 二重払い)。POST を始めた後は取り消さない。
describe('useJpycEip3009Payment — 画面を離れた後の試みは POST も枠の保存もしない (unmount)', () => {
  const VALUE = 300n * 10n ** 18n;
  const PENDING_TX = `0x${'c'.repeat(64)}` as Hex;

  type RelayReply = 'ok' | 'pending' | 'ip_rate_limited';
  // relay POST の応答を順に返す (尽きたら成功)。POST の時点の枠を控える (POST の前に保存しているか・上書きしたか)。
  let relayReplies: RelayReply[] = [];
  let savedAtPost: (string | null)[] = [];

  function relayResponse(reply: RelayReply): Response {
    const headers = { 'content-type': 'application/json' };
    if (reply === 'pending') {
      return new Response(JSON.stringify({ ok: false, pending: true, txHash: PENDING_TX }), { status: 202, headers });
    }
    if (reply === 'ip_rate_limited') {
      return new Response(JSON.stringify({ ok: false, error: 'ip_rate_limited' }), { status: 429, headers });
    }
    return new Response(JSON.stringify({ ok: true, txHash: `0x${'b'.repeat(64)}` }), { status: 200, headers });
  }

  function relayPosts(): Record<string, unknown>[] {
    return fetchSpy.mock.calls
      .filter(([url]) => url === '/api/relay/jpyc')
      .map(([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>);
  }

  function savedIntent(): RelayIntentMetadata | null {
    const raw = window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY);
    return raw === null ? null : (JSON.parse(raw) as RelayIntentMetadata);
  }

  async function mountHook(wrapper: (props: { children: ReactNode }) => ReactNode = makeWrapper()) {
    const view = renderHook(() => useJpycEip3009Payment(jpycDep), { wrapper });
    await waitFor(() => expect(view.result.current.isRestoring).toBe(false));
    return view;
  }

  // 古い hook から遅れて送られるものが無いことを見るための待ち (timer・照会・待ち行列のどれも POST しない)。
  async function settle(): Promise<void> {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
  }

  beforeEach(() => {
    relayReplies = [];
    savedAtPost = [];
    vi.mocked(jpycForwarderFor).mockReturnValue(null);
    mount();
    fetchSpy.mockImplementation(async (url: string) => {
      if (url !== '/api/relay/jpyc') {
        return new Response(JSON.stringify({ ok: true, state: 'indeterminate' }), { status: 200 });
      }
      savedAtPost.push(window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY));
      return relayResponse(relayReplies.shift() ?? 'ok');
    });
  });

  it('通常の支払い: 署名を待つ間に unmount → 開き直した hook で払い直して送信済み → 古い署名が返っても POST も枠の上書きもしない', async () => {
    let resolveOld: (signature: Hex) => void = () => undefined;
    signTypedData.mockImplementationOnce(() => new Promise<Hex>((resolve) => { resolveOld = resolve; }));
    const viewA = await mountHook();
    act(() => viewA.result.current.mutate({ merchant: MERCHANT, value: VALUE }));
    await waitFor(() => expect(signTypedData).toHaveBeenCalledTimes(1));
    viewA.unmount();

    // 開き直した画面で払い直す (送信済み・未確定 = 枠が残る)。
    relayReplies = ['pending'];
    const viewB = await mountHook();
    act(() => viewB.result.current.mutate({ merchant: MERCHANT, value: VALUE * 2n }));
    await waitFor(() => expect(viewB.result.current.data?.pending).toBe(true));
    const freshNonce = signTypedData.mock.calls[1][0].message.nonce as Hex;
    expect(savedIntent()?.nonce).toBe(freshNonce);

    // 古い署名の画面でも承認した。
    await act(async () => {
      resolveOld(`0x${'cd'.repeat(65)}` as Hex);
    });
    await settle();
    expect(relayPosts()).toHaveLength(1);
    expect(relayPosts()[0].value).toBe((VALUE * 2n).toString());
    expect(savedAtPost).toHaveLength(1);
    expect(savedIntent()?.nonce).toBe(freshNonce);
    expect(vi.mocked(logger.info).mock.calls.map(([name]) => name)).toContain('payment.sign_abandoned');
    expect(viewB.result.current.data?.pending).toBe(true);
    viewB.unmount();
  });

  it('recover の部品の読み込みを待つ間に unmount したら、署名を求めず POST も枠の保存もしない', async () => {
    vi.mocked(jpycForwarderFor).mockReturnValue('0x3333333333333333333333333333333333333333');
    let releaseChunk: () => void = () => undefined;
    const chunkGate = new Promise<void>((resolve) => { releaseChunk = resolve; });
    vi.doMock('@/lib/relay/forwarderIntent', async () => {
      await chunkGate;
      return vi.importActual<typeof import('@/lib/relay/forwarderIntent')>('@/lib/relay/forwarderIntent');
    });
    try {
      const view = await mountHook();
      act(() => view.result.current.mutate({ merchant: MERCHANT, value: VALUE }));
      // mutationFn は始まり、recover の部品の読み込みを待っている (まだ署名を求めていない)。
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      expect(view.result.current.isPending).toBe(true);
      expect(signTypedData).not.toHaveBeenCalled();
      view.unmount();
      await act(async () => {
        releaseChunk();
      });
      await settle();
      expect(signTypedData).not.toHaveBeenCalled();
      expect(relayPosts()).toHaveLength(0);
      expect(savedIntent()).toBeNull();
    } finally {
      vi.doUnmock('@/lib/relay/forwarderIntent');
    }
  });

  it('IP 制限 (429) の後の再送が react-query の待ち行列にある間に unmount → 古い再送は POST も枠の保存もしない・開き直した hook は新しい署名で払える', async () => {
    relayReplies = ['ip_rate_limited'];
    const viewA = await mountHook();
    act(() => viewA.result.current.mutate({ merchant: MERCHANT, value: VALUE }));
    await waitFor(() => expect(isRelayIpRateLimitedError(viewA.result.current.error)).toBe(true));
    expect(viewA.result.current.hasActiveIntent).toBe(true);
    expect(savedIntent()).toBeNull();
    const oldNonce = relayPosts()[0].nonce;

    // 再送を始めた (mutation は作ったが mutationFn はまだ) 直後に、同じ tick で画面を離れる。
    act(() => {
      viewA.result.current.retryRelay();
      viewA.unmount();
    });
    await settle();
    expect(relayPosts()).toHaveLength(1);
    expect(savedIntent()).toBeNull();

    // 開き直した画面: 枠は空 (429 は冪等の claim より前の拒否で、その POST は何も動かしていない) → 新しい署名で払える。
    relayReplies = ['pending'];
    const viewB = await mountHook();
    expect(viewB.result.current.hasActiveIntent).toBe(false);
    act(() => viewB.result.current.mutate({ merchant: MERCHANT, value: VALUE * 2n }));
    await waitFor(() => expect(viewB.result.current.data?.pending).toBe(true));
    expect(signTypedData).toHaveBeenCalledTimes(2);
    expect(relayPosts()).toHaveLength(2);
    expect(relayPosts()[1].nonce).not.toBe(oldNonce);
    expect(savedIntent()?.nonce).toBe(relayPosts()[1].nonce);
    await settle();
    expect(relayPosts()).toHaveLength(2);
    expect(savedIntent()?.nonce).toBe(relayPosts()[1].nonce);
    viewB.unmount();
  });

  it('IP 制限 (429) の後の再送が offline で止まっている間に unmount → 開き直した後で online に戻っても、止まっていた再送は POST も枠の保存もしない', async () => {
    // アプリと同じく 1 つの QueryClient を共有する (止まった mutation は QueryClient が online で再開する・app/providers.tsx)。
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
    const shared = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    relayReplies = ['ip_rate_limited'];
    const viewA = await mountHook(shared);
    act(() => viewA.result.current.mutate({ merchant: MERCHANT, value: VALUE }));
    await waitFor(() => expect(isRelayIpRateLimitedError(viewA.result.current.error)).toBe(true));

    onlineManager.setOnline(false);
    try {
      await act(async () => {
        viewA.result.current.retryRelay();
      });
      // offline なので mutationFn は始まらない (POST も無い)。
      expect(qc.getMutationCache().getAll().some((m) => m.state.isPaused)).toBe(true);
      expect(relayPosts()).toHaveLength(1);
      viewA.unmount();
      const viewB = await mountHook(shared);
      // online に戻ると、止まっていた A の再送が再開する → 画面を離れた hook の試みなので何もしない。
      await act(async () => {
        onlineManager.setOnline(true);
        await new Promise((r) => setTimeout(r, 30));
      });
      expect(relayPosts()).toHaveLength(1);
      expect(savedAtPost).toHaveLength(1);
      expect(savedIntent()).toBeNull();

      relayReplies = ['pending'];
      act(() => viewB.result.current.mutate({ merchant: MERCHANT, value: VALUE * 2n }));
      await waitFor(() => expect(viewB.result.current.data?.pending).toBe(true));
      expect(relayPosts()).toHaveLength(2);
      expect(relayPosts()[1].value).toBe((VALUE * 2n).toString());
      expect(savedIntent()?.nonce).toBe(relayPosts()[1].nonce);
      viewB.unmount();
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it.each([
    ['応答が失われた (fetch の失敗)', 'network'],
    ['202 pending', 'pending'],
  ] as const)('POST を始めた後の unmount は取り消さない: %s でも枠が残り、開き直した hook は同じ nonce の照会だけで再署名しない', async (_label, outcome) => {
    let finishPost: () => void = () => undefined;
    fetchSpy.mockImplementation((url: string) => {
      if (url !== '/api/relay/jpyc') {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, state: 'indeterminate' }), { status: 200 }));
      }
      savedAtPost.push(window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY));
      return new Promise<Response>((resolve, reject) => {
        finishPost = () => (outcome === 'network' ? reject(new TypeError('Failed to fetch')) : resolve(relayResponse('pending')));
      });
    });
    const viewA = await mountHook();
    act(() => viewA.result.current.mutate({ merchant: MERCHANT, value: VALUE }));
    await waitFor(() => expect(relayPosts()).toHaveLength(1));
    const nonce = relayPosts()[0].nonce;
    // POST の前に公開 metadata を保存している (送ったかもしれないものの復旧の枠)。
    expect(savedAtPost).toHaveLength(1);
    expect(savedIntent()?.nonce).toBe(nonce);
    viewA.unmount();
    // 送った後の応答の扱いは今までどおり (取り消さない・枠を消さない)。
    await act(async () => {
      finishPost();
    });
    await settle();
    expect((fetchSpy.mock.calls[0][1] as RequestInit).signal).toBeUndefined();
    expect(savedIntent()?.nonce).toBe(nonce);

    const viewB = await mountHook();
    expect(viewB.result.current.restoredIntent?.nonce).toBe(nonce);
    expect(viewB.result.current.hasActiveIntent).toBe(true);
    act(() => viewB.result.current.mutate({ merchant: MERCHANT, value: VALUE }));
    await settle();
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(relayPosts()).toHaveLength(1);
    expect(savedIntent()?.nonce).toBe(nonce);
    viewB.unmount();
  });

  it('StrictMode の mount→unmount→mount の後に押した正当な 1 回目は止めない (署名 1 回・POST 1 回で成立)', async () => {
    // wrapper の中に <StrictMode> を置いても、React 19.2 では初回の mount の effect は 1 回しか走らない (二重に mount しない)。
    // renderHook の reactStrictMode を使う。hook を呼ぶ component の effect は全部まとめて effect→cleanup→effect になるので、
    // 同じ component に置いた見張りの effect で、hook の mount の effect (mountedRef を true に戻す) も二重に走ったことを確かめる。
    const effectRuns: string[] = [];
    const view = renderHook(() => {
      useEffect(() => {
        effectRuns.push('mount');
        return () => {
          effectRuns.push('unmount');
        };
      }, []);
      return useJpycEip3009Payment(jpycDep);
    }, { wrapper: makeWrapper(), reactStrictMode: true });
    await waitFor(() => expect(view.result.current.isRestoring).toBe(false));
    expect(effectRuns).toEqual(['mount', 'unmount', 'mount']);
    act(() => view.result.current.mutate({ merchant: MERCHANT, value: VALUE }));
    await waitFor(() => expect(view.result.current.data?.success).toBe(true));
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(relayPosts()).toHaveLength(1);
    expect(view.result.current.error).toBeNull();
    view.unmount();
  });
});

// 同じ描画のうちの二度押し (main thread が詰まり、isPending を描いた再描画より前に 2 回押された) は 2 つ目の mutation を作らない
// (署名 1 回・POST 1 本)。試み中の印は mutation が終わったとき (成功・失敗・throw のどれでも) に外れ、次の正当な押下・retryRelay・
// retrySamePayload は通る。「2 本目が無い」は待ち時間でなく、MutationCache のどの mutation も終わった (pending でない) のを待ってから
// 見る (作られた mutation の数も数える)。free モードで流す (mutationFn に動的 import が無いので、二度押しで import が重ならない)。
describe('useJpycEip3009Payment — 二度押しは 2 つ目の署名・POST にしない (試み中の印)', () => {
  const VALUE = 300n * 10n ** 18n;
  const SIGNATURE = `0x${'a'.repeat(130)}` as Hex;
  const REVERTED_TX = `0x${'e'.repeat(64)}` as Hex;
  const SETTLED_TX = `0x${'f'.repeat(64)}` as Hex;
  type Relay = ReturnType<typeof useJpycEip3009Payment>;
  let qc: QueryClient;

  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  function relayPosts(): Record<string, unknown>[] {
    return fetchSpy.mock.calls
      .filter(([url]) => url === '/api/relay/jpyc')
      .map(([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>);
  }

  async function mountHook() {
    const view = renderHook(() => useJpycEip3009Payment(jpycDep), { wrapper });
    await waitFor(() => expect(view.result.current.isRestoring).toBe(false));
    return view;
  }

  // MutationCache のどの mutation も終わる (pending でない) まで待ち、作られた mutation の数を返す。
  async function settledMutationCount(): Promise<number> {
    await waitFor(() =>
      expect(qc.getMutationCache().getAll().every((m) => m.state.status !== 'pending')).toBe(true),
    );
    return qc.getMutationCache().getAll().length;
  }

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
    vi.mocked(jpycForwarderFor).mockReturnValue(null);
    mount();
    // 呼ぶたびに新しい成功の応答を返す (既定の 1 つの Response は body を 1 回しか読めず、2 本目の POST が応答不明に見える)。
    fetchSpy.mockImplementation(async () => jsonResponse(200, { ok: true, txHash: `0x${'b'.repeat(64)}` }));
  });

  it('同じ act の中で mutate を 2 回: 署名を求めるのは 1 回・POST は 1 本・mutation は 1 つで、結果は 1 つ目のもの', async () => {
    const view = await mountHook();
    act(() => {
      view.result.current.mutate({ merchant: MERCHANT, value: VALUE });
      view.result.current.mutate({ merchant: MERCHANT, value: VALUE * 3n });
    });
    await waitFor(() => expect(view.result.current.data?.success).toBe(true));
    expect(await settledMutationCount()).toBe(1);
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(relayPosts()).toHaveLength(1);
    expect(relayPosts()[0].value).toBe(VALUE.toString());
    expect(view.result.current.error).toBeNull();
  });

  it('1 回目の署名を待つ間 (mutationFn の途中) の mutate は、新しい署名を求めない', async () => {
    let resolveFirst: (signature: Hex) => void = () => undefined;
    signTypedData.mockImplementationOnce(() => new Promise<Hex>((resolve) => { resolveFirst = resolve; }));
    const view = await mountHook();
    act(() => view.result.current.mutate({ merchant: MERCHANT, value: VALUE }));
    await waitFor(() => expect(signTypedData).toHaveBeenCalledTimes(1));
    expect(view.result.current.isPending).toBe(true);
    act(() => view.result.current.mutate({ merchant: MERCHANT, value: VALUE * 3n }));
    await act(async () => {
      resolveFirst(SIGNATURE);
    });
    await waitFor(() => expect(view.result.current.data?.success).toBe(true));
    expect(await settledMutationCount()).toBe(1);
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(relayPosts()).toHaveLength(1);
    expect(relayPosts()[0].value).toBe(VALUE.toString());
  });

  it.each([
    ['署名の拒否', 'rejected', 1],
    ['revert (relay は成立したが tx が revert)', 'reverted', 2],
    ['通常の失敗 (broadcast 前の構造化 error)', 'server_error', 2],
  ] as const)('1 回目が %s で終わった後の正当な次の押下は、新しい署名で払える (印が外れる)', async (_label, outcome, postsInAll) => {
    if (outcome === 'rejected') signTypedData.mockRejectedValueOnce(new Error('User rejected the request.'));
    if (outcome === 'reverted') fetchSpy.mockResolvedValueOnce(jsonResponse(200, { ok: false, reverted: true, txHash: REVERTED_TX }));
    if (outcome === 'server_error') fetchSpy.mockResolvedValueOnce(jsonResponse(400, { ok: false, error: 'invalid_signature' }));
    const view = await mountHook();
    act(() => view.result.current.mutate({ merchant: MERCHANT, value: VALUE }));
    await waitFor(() => expect(view.result.current.isError || view.result.current.data?.success === false).toBe(true));
    expect(await settledMutationCount()).toBe(1);
    expect(view.result.current.isPending).toBe(false);

    act(() => view.result.current.mutate({ merchant: MERCHANT, value: VALUE }));
    await waitFor(() => expect(view.result.current.data?.success).toBe(true));
    expect(await settledMutationCount()).toBe(2);
    expect(signTypedData).toHaveBeenCalledTimes(2);
    expect(relayPosts()).toHaveLength(postsInAll);
  });

  it('IP 制限 (429) の後の retryRelay と、その再送の応答が失われた後の retrySamePayload も通る (署名は 1 回・同じ payload)', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(429, { ok: false, error: 'ip_rate_limited' }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const view = await mountHook();
    act(() => view.result.current.mutate({ merchant: MERCHANT, value: VALUE }));
    await waitFor(() => expect(isRelayIpRateLimitedError(view.result.current.error)).toBe(true));
    expect(await settledMutationCount()).toBe(1);

    act(() => view.result.current.retryRelay());
    await waitFor(() => expect(isRelayResponseUnknownError(view.result.current.error)).toBe(true));
    expect(view.result.current.recoveryState).toBe('exhausted');
    expect(await settledMutationCount()).toBe(2);
    expect(relayPosts()).toHaveLength(2);
    expect(relayPosts()[1]).toEqual(relayPosts()[0]);

    // 送ったかもしれない再送: 同じ payload の nonce を照会する (署名しない・POST しない)。照会の 1 回目は 3 秒の backoff の後。
    vi.useFakeTimers();
    try {
      fetchSpy.mockImplementation(async () => jsonResponse(200, { ok: true, state: 'settled', txHash: SETTLED_TX }));
      act(() => view.result.current.retrySamePayload());
      await advanceUntil(1_000, () => expect(view.result.current.data).toEqual({ txHash: SETTLED_TX, success: true }));
    } finally {
      vi.useRealTimers();
    }
    expect(await settledMutationCount()).toBe(3);
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(relayPosts()).toHaveLength(2);
    expect(fetchSpy.mock.calls.some(([url]) => url === '/api/relay/jpyc/status')).toBe(true);
  });

  it('入口の payment_cancelled (画面から外れている間に始まった試み) の後も、戻った画面の正当な押下は通る', async () => {
    // Activity の hidden は同じ instance のまま effect を外す (mountedRef が false になる)。visible に戻すと effect が戻る。
    let setMode: (mode: 'visible' | 'hidden') => void = () => undefined;
    function Gate({ children }: { children: ReactNode }) {
      const [mode, set] = useState<'visible' | 'hidden'>('visible');
      setMode = set;
      return (
        <QueryClientProvider client={qc}>
          <Activity mode={mode}>{children}</Activity>
        </QueryClientProvider>
      );
    }
    const view = renderHook(() => useJpycEip3009Payment(jpycDep), { wrapper: Gate });
    await waitFor(() => expect(view.result.current.isRestoring).toBe(false));
    // 押した (mutation は作ったが mutationFn はまだ) 直後に、同じ tick で画面から外れる。
    act(() => {
      view.result.current.mutate({ merchant: MERCHANT, value: VALUE });
      setMode('hidden');
    });
    await waitFor(() => expect(qc.getMutationCache().getAll()).toHaveLength(1));
    expect(await settledMutationCount()).toBe(1);
    expect(qc.getMutationCache().getAll()[0].state.error?.message).toBe('payment_cancelled');
    expect(signTypedData).not.toHaveBeenCalled();

    act(() => setMode('visible'));
    await waitFor(() => expect(view.result.current.isRestoring).toBe(false));
    act(() => view.result.current.mutate({ merchant: MERCHANT, value: VALUE }));
    await waitFor(() => expect(view.result.current.data?.success).toBe(true));
    expect(await settledMutationCount()).toBe(2);
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(relayPosts()).toHaveLength(1);
  });

  // 積んだ押下を流す効果 (storageReady になった commit の useEffect) と、同じ瞬間の押下が重なる。'layout' は効果より前
  // (同じ commit の layout effect) に押す・'passive' は流した直後 (同じ commit の後の effect) に押す。どちらも 1 回だけ。
  it.each([
    ['流す効果より前に押した → 押した方だけ払い、積んだ押下は捨てる', 'layout', 3n],
    ['流した直後に押した → 積んだ押下だけ払う', 'passive', 1n],
  ] as const)('storageReady の前に押したものが流れる瞬間に重ねた押下でも 1 回だけ: %s', async (_label, when, sentMultiplier) => {
    const seen: { relay: Relay | null; pressed: boolean } = { relay: null, pressed: false };
    const overlap = (relay: Relay) => {
      if (relay.isRestoring || seen.pressed) return;
      seen.pressed = true;
      relay.mutate({ merchant: MERCHANT, value: VALUE * 3n });
    };
    function Probe() {
      const relay = useJpycEip3009Payment(jpycDep);
      seen.relay = relay;
      useLayoutEffect(() => {
        if (when === 'layout') overlap(relay);
      });
      useEffect(() => {
        if (when === 'passive') overlap(relay);
      });
      return null;
    }
    render(<Probe />, { wrapper });
    expect(seen.relay?.isRestoring).toBe(true);
    act(() => seen.relay?.mutate({ merchant: MERCHANT, value: VALUE }));
    await waitFor(() => expect(seen.pressed).toBe(true));
    await waitFor(() => expect(seen.relay?.data?.success).toBe(true));
    expect(await settledMutationCount()).toBe(1);
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(relayPosts()).toHaveLength(1);
    expect(relayPosts()[0].value).toBe((VALUE * sentMultiplier).toString());
  });
});

// 第 10 回レビュー H-R: 復旧の枠 (openpay:relay-intent:v1) を書けない端末で、束縛しない支払い (/pay・/tip・束縛しない
// /checkout) を枠なしで送らない。枠が無いまま送ると、relay が receipt を待つ間に読み直した画面が未解決の支払いを知らず、
// 新しい署名 (別の nonce) で二重に払える。hook と lib/paymentIntentStorage は実物で、差し替えるのは Storage の境界だけ。
describe('useJpycEip3009Payment — 復旧の枠を書けない端末では束縛しない支払いを送らない (第 10 回レビュー H-R)', () => {
  const VALUE = 300n * 10n ** 18n;
  const FORWARDER = '0x3333333333333333333333333333333333333333' as Address;
  const STORAGE_ERROR = 'intent_storage_unavailable';
  const SIGNATURE = `0x${'a'.repeat(130)}` as Hex;
  const realSetItem = Storage.prototype.setItem;
  const spies: { mockRestore: () => void }[] = [];

  // 当てはまるキーへの書き込みだけを失敗させる ('throw' = 容量超過・保存の禁止 / 'drop' = 投げずに捨てる)。
  function breakSetItem(matches: (key: string) => boolean, how: 'throw' | 'drop' = 'throw') {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (matches(key)) {
        if (how === 'throw') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        return;
      }
      realSetItem.call(this, key, value);
    });
    spies.push(spy);
    return spy;
  }
  // 枠のキーも、署名の前の確かめのキーも書けない端末。
  const relayKeys = (key: string) => key === RELAY_INTENT_STORAGE_KEY || key === RELAY_INTENT_PROBE_KEY;
  // 署名の前の確かめは通るが、枠そのものが書けない (署名を待つ間に書けなくなった・枠のキーだけ壊れている)。
  const slotOnly = (key: string) => key === RELAY_INTENT_STORAGE_KEY;
  const relayPosts = () => fetchSpy.mock.calls.filter(([url]) => url === '/api/relay/jpyc');
  const jsonResponse = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const unavailableLog = (stage: 'probe' | 'save' | 'retry') =>
    ['payment.intent_storage_unavailable', { path: 'jpyc-relay', chainId: jpycDep.chainId, stage }] as const;

  function setRoute(mode: 'free' | 'recover') {
    vi.mocked(jpycForwarderFor).mockReturnValue(mode === 'recover' ? FORWARDER : null);
  }

  async function mountHook(mode: 'free' | 'recover' = 'free') {
    setRoute(mode);
    mount();
    const view = renderHook(() => useJpycEip3009Payment(jpycDep), { wrapper: makeWrapper() });
    await waitFor(() => expect(view.result.current.isRestoring).toBe(false));
    return view;
  }

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    vi.mocked(jpycForwarderFor).mockReturnValue(null);
  });

  it.each(['free', 'recover'] as const)('%s: 枠も確かめのキーも書けない端末 → 署名を求めずに止める (POST 0 回・専用の code・送っていない = fallback-safe な error)', async (mode) => {
    const view = await mountHook(mode);
    breakSetItem(relayKeys);

    act(() => view.result.current.mutate({ merchant: MERCHANT, value: VALUE }));
    await waitFor(() => expect(view.result.current.error?.message).toBe(STORAGE_ERROR));

    expect(signTypedData).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalledWith('payment.sign_requested', expect.anything());
    expect(logger.info).toHaveBeenCalledWith(...unavailableLog('probe'));
    // 送っていないので fallback-safe (保持・照会にしない) + 専用の文言の key。フォームは通常決済への切り替えを案内しない
    // (user 裁定 Q7-1・lib/relay/relayResponseError の isIntentStorageUnavailableError・フォームのテストが固定する)。
    expect(isFallbackSafeRelayError(view.result.current.error)).toBe(true);
    expect(relayErrorKey(view.result.current.error as Error)).toBe('errorRelayStorageUnavailable');
    // 送っていないので、送信済みかもしれない扱い (保持・照会) にしない。
    expect(view.result.current.hasActiveIntent).toBe(false);
    expect(view.result.current.recoveryState).toBeNull();
    expect(window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY)).toBeNull();
  });

  it('束縛しない /checkout (restoreOrderDelivery あり・order なし・注文リンクの指紋つき) も同じく署名の前に止まる', async () => {
    setRoute('free');
    mount();
    const view = renderHook(
      () => useJpycEip3009Payment(jpycDep, { restoreOrderDelivery: true, orderContext: ORDER_CONTEXT }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(view.result.current.isRestoring).toBe(false));
    breakSetItem(relayKeys);

    act(() => view.result.current.mutate({ merchant: MERCHANT, value: VALUE, orderLinkKey: `0x${'a7'.repeat(32)}` as Hex }));
    await waitFor(() => expect(view.result.current.error?.message).toBe(STORAGE_ERROR));
    expect(signTypedData).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['free', 'throw'],
    ['recover', 'throw'],
    ['free', 'drop'],
  ] as const)('%s: 確かめは通るが枠そのものが書けない (%s) → 署名は 1 回・POST 0 回・署名済みの payload を保持しない', async (mode, how) => {
    const view = await mountHook(mode);
    const broken = breakSetItem(slotOnly, how);

    act(() => view.result.current.mutate({ merchant: MERCHANT, value: VALUE }));
    await waitFor(() => expect(view.result.current.error?.message).toBe(STORAGE_ERROR));

    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(...unavailableLog('save'));
    expect(isFallbackSafeRelayError(view.result.current.error)).toBe(true);
    expect(view.result.current.hasActiveIntent).toBe(false);
    expect(window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY)).toBeNull();
    // 保持していないので、同じ payload の再送の入口は何もしない。
    act(() => view.result.current.retryRelay());
    act(() => view.result.current.retrySamePayload());
    await act(async () => Promise.resolve());
    expect(fetchSpy).not.toHaveBeenCalled();

    // 書けるようになった後の次の押下は、捨てた署名の再送ではなく新しい署名から。
    broken.mockRestore();
    act(() => view.result.current.mutate({ merchant: MERCHANT, value: VALUE }));
    await waitFor(() => expect(view.result.current.data?.success).toBe(true));
    expect(signTypedData).toHaveBeenCalledTimes(2);
    expect(relayPosts()).toHaveLength(1);
  });

  it('書けなかったときに枠に残っている別の支払いの記録 (同じ chainId・from・別の nonce) を、いま書いた枠と読み違えない', async () => {
    const view = await mountHook('free');
    // mount の後に置く (hook は復元していない)。書き込みが失敗すると、読み戻しで返るのはこの記録。
    storeRelayIntent(restoredRelayIntent());
    breakSetItem(slotOnly);

    act(() => view.result.current.mutate({ merchant: MERCHANT, value: VALUE }));
    await waitFor(() => expect(view.result.current.error?.message).toBe(STORAGE_ERROR));

    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.parse(window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY) as string).nonce).toBe(RESTORED_NONCE);
  });

  it('sessionStorage そのものに触れない端末 (window.sessionStorage の getter が throw) → 署名を求めずに止める', async () => {
    setRoute('free');
    mount();
    const getter = vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new DOMException('Access is denied for this document.', 'SecurityError');
    });
    spies.push(getter);
    const view = renderHook(() => useJpycEip3009Payment(jpycDep), { wrapper: makeWrapper() });
    await waitFor(() => expect(view.result.current.isRestoring).toBe(false));

    act(() => view.result.current.mutate({ merchant: MERCHANT, value: VALUE }));
    await waitFor(() => expect(view.result.current.error?.message).toBe(STORAGE_ERROR));

    expect(signTypedData).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(view.result.current.hasActiveIntent).toBe(false);
  });

  it('storage の chunk の読み込みに失敗した画面 (storageRef が null) → 画面は止めず、束縛しない支払いは署名を求めずに止める', async () => {
    vi.doMock('@/lib/paymentIntentStorage', () => { throw new Error('chunk unavailable'); });
    try {
      setRoute('free');
      mount();
      const view = renderHook(() => useJpycEip3009Payment(jpycDep), { wrapper: makeWrapper() });
      // 読み込みの失敗で「復元中」のまま止まらない (今までどおり)。
      await waitFor(() => expect(view.result.current.isRestoring).toBe(false));

      act(() => view.result.current.mutate({ merchant: MERCHANT, value: VALUE }));
      await waitFor(() => expect(view.result.current.error?.message).toBe(STORAGE_ERROR));

      expect(signTypedData).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(...unavailableLog('probe'));
    } finally {
      vi.doUnmock('@/lib/paymentIntentStorage');
    }
  });

  it('IP 制限 (429) で保持した payload の再送の前にも枠を確かめる: 書けなくなっていたら再送せず、保持を外す (次は新しい署名)', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(429, { ok: false, error: 'ip_rate_limited' }));
    const view = await mountHook('free');
    act(() => view.result.current.mutate({ merchant: MERCHANT, value: VALUE }));
    await waitFor(() => expect(isRelayIpRateLimitedError(view.result.current.error)).toBe(true));
    expect(view.result.current.hasActiveIntent).toBe(true);
    expect(relayPosts()).toHaveLength(1);

    const broken = breakSetItem(slotOnly);
    act(() => view.result.current.retryRelay());
    await waitFor(() => expect(view.result.current.error?.message).toBe(STORAGE_ERROR));

    expect(relayPosts()).toHaveLength(1);
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(...unavailableLog('retry'));
    // 保持を外す: 残すと hasActiveIntent が立ったままで、次の押下も同じ payload の再送になり、ほかの払い方へも進めない。
    expect(view.result.current.hasActiveIntent).toBe(false);
    expect(isFallbackSafeRelayError(view.result.current.error)).toBe(true);
    expect(window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY)).toBeNull();

    // 書けるようになった後は、捨てた payload の再送ではなく新しい署名 (別の nonce) で払う。
    broken.mockRestore();
    act(() => view.result.current.mutate({ merchant: MERCHANT, value: VALUE }));
    await waitFor(() => expect(view.result.current.data?.success).toBe(true));
    expect(signTypedData).toHaveBeenCalledTimes(2);
    expect(relayPosts()).toHaveLength(2);
    const nonceOf = (call: unknown[]) => (JSON.parse((call[1] as RequestInit).body as string) as { nonce: string }).nonce;
    expect(nonceOf(relayPosts()[1])).not.toBe(nonceOf(relayPosts()[0]));
  });

  it.each(['free', 'recover'] as const)('%s: 保存できる端末では今までどおり払える。枠は署名の後・POST の前に書き、署名の前には書かない (確かめのキーも残さない)', async (mode) => {
    const view = await mountHook(mode);
    const seen: { atSign?: (string | null)[]; atPost?: (string | null)[] } = {};
    const snapshot = () => [
      window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY),
      window.sessionStorage.getItem(RELAY_INTENT_PROBE_KEY),
    ];
    signTypedData.mockImplementation(async () => {
      seen.atSign = snapshot();
      return SIGNATURE;
    });
    fetchSpy.mockImplementation(async () => {
      seen.atPost = snapshot();
      return jsonResponse(200, { ok: true, txHash: `0x${'b'.repeat(64)}` });
    });

    act(() => view.result.current.mutate({ merchant: MERCHANT, value: VALUE }));
    await waitFor(() => expect(view.result.current.data?.success).toBe(true));

    // 署名を待つ間は枠が無い (署名を取りやめて開き直した画面を、送っていない支払いで塞がない)。
    expect(seen.atSign).toEqual([null, null]);
    expect(seen.atPost?.[1]).toBeNull();
    const stored = JSON.parse(seen.atPost?.[0] as string) as RelayIntentMetadata;
    expect(stored).toMatchObject({ chainId: jpycDep.chainId, from: CUSTOMER, merchant: MERCHANT, routeKind: mode });
    if (mode === 'free') {
      const body = JSON.parse((relayPosts()[0][1] as RequestInit).body as string) as { nonce: string };
      expect(stored.nonce).toBe(body.nonce);
    }
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(relayPosts()).toHaveLength(1);
    expect(logger.info).not.toHaveBeenCalledWith('payment.intent_storage_unavailable', expect.anything());
  });

  // 変わらないこと: 画面を離れた試みは今までどおり payment_cancelled で止まり、離れた後に storage へ触れない
  // (署名の前の確かめは、画面にいる試みだけが行う)。
  it('recover の部品の読み込みを待つ間に unmount した試みは、枠を書けない端末でも確かめのキーに触れず payment_cancelled で止まる', async () => {
    setRoute('recover');
    mount();
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    let releaseChunk: () => void = () => undefined;
    const chunkGate = new Promise<void>((resolve) => { releaseChunk = resolve; });
    vi.doMock('@/lib/relay/forwarderIntent', async () => {
      await chunkGate;
      return vi.importActual<typeof import('@/lib/relay/forwarderIntent')>('@/lib/relay/forwarderIntent');
    });
    try {
      const view = renderHook(() => useJpycEip3009Payment(jpycDep), { wrapper });
      await waitFor(() => expect(view.result.current.isRestoring).toBe(false));
      const writes = breakSetItem(relayKeys);
      act(() => view.result.current.mutate({ merchant: MERCHANT, value: VALUE }));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      expect(view.result.current.isPending).toBe(true);
      view.unmount();
      await act(async () => {
        releaseChunk();
      });
      await waitFor(() => expect(qc.getMutationCache().getAll()[0]?.state.status).toBe('error'));
      expect(qc.getMutationCache().getAll()[0].state.error?.message).toBe('payment_cancelled');
      expect(writes.mock.calls.filter(([key]) => relayKeys(key as string))).toHaveLength(0);
      expect(signTypedData).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('@/lib/relay/forwarderIntent');
    }
  });

  // 変わらないこと: 束縛した注文は relay の枠を使わない (自分の slot・order_binding_storage_unavailable で止まる) ので、
  // relay の枠を書けない端末でも今までどおり送る。
  it('束縛した注文は relay の枠が書けなくても今までどおり署名して送る (この確かめの対象外)', async () => {
    const { bindingFixture } = await import('../_helpers/orderBinding');
    const f = bindingFixture('free', { chainId: jpycDep.chainId, tokenAddress: jpycDep.address, merchant: MERCHANT, handle: 'alice', orderId: 'bound-hr', items: [{ name: 'Tea', qty: 1, price: '300' }], statusToken: 's'.repeat(43) });
    setRoute('free');
    mount();
    const view = renderHook(
      () => useJpycEip3009Payment(jpycDep, { restoreOrderDelivery: true, orderContext: ORDER_CONTEXT }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(view.result.current.isRestoring).toBe(false));
    breakSetItem(relayKeys);

    act(() => view.result.current.mutate({ merchant: MERCHANT, value: VALUE, order: f.order }));
    await waitFor(() => expect(view.result.current.data?.success).toBe(true));
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(relayPosts()).toHaveLength(1);
    expect(logger.info).not.toHaveBeenCalledWith('payment.intent_storage_unavailable', expect.anything());
  });

  // user 裁定 Q7-2: 埋め込み (iframe) の中のチップは、呼び出し側 (TipForm) が skipIntentStorageCheck を渡す。枠を書けなくても
  // 今までどおり送る (受容台帳)。枠への書き込みは今までどおり試みる。渡さない呼び出しが止まることは上のテストが固定する。
  async function mountSkippingHook(mode: 'free' | 'recover') {
    setRoute(mode);
    mount();
    const view = renderHook(
      () => useJpycEip3009Payment(jpycDep, { skipIntentStorageCheck: true }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(view.result.current.isRestoring).toBe(false));
    return view;
  }

  it.each(['free', 'recover'] as const)('%s: skipIntentStorageCheck を渡すと、枠も確かめのキーも書けない端末でも今までどおり署名 1 回・POST 1 回で送る', async (mode) => {
    const view = await mountSkippingHook(mode);
    const writes = breakSetItem(relayKeys);

    act(() => view.result.current.mutate({ merchant: MERCHANT, value: VALUE }));
    await waitFor(() => expect(view.result.current.data?.success).toBe(true));

    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(relayPosts()).toHaveLength(1);
    expect(logger.info).not.toHaveBeenCalledWith('payment.intent_storage_unavailable', expect.anything());
    // 署名の前の確かめのキーには触れず、枠への書き込みは今までどおり試みる (書けないまま送る)。
    const keys = writes.mock.calls.map(([key]) => key);
    expect(keys).not.toContain(RELAY_INTENT_PROBE_KEY);
    expect(keys).toContain(RELAY_INTENT_STORAGE_KEY);
  });

  it('skipIntentStorageCheck を渡すと、IP 制限 (429) で保持した payload は、枠を書けなくなっていても今までどおり同じ payload で再送する', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(429, { ok: false, error: 'ip_rate_limited' }));
    const view = await mountSkippingHook('free');
    act(() => view.result.current.mutate({ merchant: MERCHANT, value: VALUE }));
    await waitFor(() => expect(isRelayIpRateLimitedError(view.result.current.error)).toBe(true));
    expect(relayPosts()).toHaveLength(1);

    breakSetItem(slotOnly);
    act(() => view.result.current.retryRelay());
    await waitFor(() => expect(view.result.current.data?.success).toBe(true));

    expect(relayPosts()).toHaveLength(2);
    expect((relayPosts()[1][1] as RequestInit).body).toBe((relayPosts()[0][1] as RequestInit).body);
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalledWith('payment.intent_storage_unavailable', expect.anything());
  });

  // Codex の再現 (SHOULD): 枠を書けたが読み戻しが投げた回は POST しないが、この試みの記録 (まだ送っていない) が枠に残ると、
  // 読めるようになった後に開き直した画面が「送信済みかもしれない」として、署名の期限が証明されるまで支払いを塞いでいた。
  // 書き込みの後の最初の読み戻しだけを投げさせる (書く前の読みと署名の前の確かめは通る)。
  function failSlotReadBackOnce() {
    const realSet = Storage.prototype.setItem;
    const realGet = Storage.prototype.getItem;
    let wroteSlot = false;
    spies.push(vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === RELAY_INTENT_STORAGE_KEY) wroteSlot = true;
      realSet.call(this, key, value);
    }));
    spies.push(vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (key === RELAY_INTENT_STORAGE_KEY && wroteSlot) {
        wroteSlot = false;
        throw new DOMException('Access is denied for this document.', 'SecurityError');
      }
      return realGet.call(this, key);
    }));
  }
  async function reopenAfterStorageRecovers(view: { unmount: () => void }) {
    for (const spy of spies.splice(0)) spy.mockRestore();
    view.unmount();
    const reopened = renderHook(() => useJpycEip3009Payment(jpycDep), { wrapper: makeWrapper() });
    await waitFor(() => expect(reopened.result.current.isRestoring).toBe(false));
    return reopened;
  }

  it('初回: 書けたが読み戻しが投げた → POST せず、この試みの記録を片づける (読めるようになって開き直しても塞がない)', async () => {
    const view = await mountHook('free');
    failSlotReadBackOnce();
    act(() => view.result.current.mutate({ merchant: MERCHANT, value: VALUE }));
    await waitFor(() => expect(view.result.current.error?.message).toBe(STORAGE_ERROR));
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(...unavailableLog('save'));

    const reopened = await reopenAfterStorageRecovers(view);
    expect(window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY)).toBeNull();
    expect(reopened.result.current.hasActiveIntent).toBe(false);
    expect(reopened.result.current.restoredIntent ?? null).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('IP 制限 (429) の後の再送: 書けたが読み戻しが投げた → 再送せず、この試みの記録を片づける (開き直しても塞がない)', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(429, { ok: false, error: 'ip_rate_limited' }));
    const view = await mountHook('free');
    act(() => view.result.current.mutate({ merchant: MERCHANT, value: VALUE }));
    await waitFor(() => expect(isRelayIpRateLimitedError(view.result.current.error)).toBe(true));
    expect(relayPosts()).toHaveLength(1);

    failSlotReadBackOnce();
    act(() => view.result.current.retryRelay());
    await waitFor(() => expect(view.result.current.error?.message).toBe(STORAGE_ERROR));
    expect(relayPosts()).toHaveLength(1);
    expect(logger.info).toHaveBeenCalledWith(...unavailableLog('retry'));

    const reopened = await reopenAfterStorageRecovers(view);
    expect(window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY)).toBeNull();
    expect(reopened.result.current.hasActiveIntent).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // Codex の再現 (MUST): 束縛した注文は relay の枠を使わず自分の slot (lib/orderDelivery) に保存するが、saveOrderDelivery は
  // setItem が投げなければ true を返すので、書き込みを黙って捨てる storage では slot なしで送れていた (開き直して同じ注文を
  // もう一度押すと、署名 2 回・別の authorization で POST 2 回・保存 0 = 両方成立しうる)。送る前に slot を読み戻して止める。
  async function boundOrder(mode: 'free' | 'recover', orderId: string) {
    const { bindingFixture } = await import('../_helpers/orderBinding');
    return bindingFixture(mode, { chainId: jpycDep.chainId, tokenAddress: jpycDep.address, merchant: MERCHANT, handle: 'alice', orderId, items: [{ name: 'Tea', qty: 1, price: '300' }], statusToken: 's'.repeat(43) });
  }
  const renderBound = () => renderHook(
    () => useJpycEip3009Payment(jpycDep, { restoreOrderDelivery: true, orderContext: ORDER_CONTEXT }),
    { wrapper: makeWrapper() },
  );

  it.each(['free', 'recover'] as const)('%s: 束縛した注文の slot への書き込みを黙って捨てる端末 → 送る前に止める。開き直して同じ注文をもう一度押しても送らない', async (mode) => {
    const { ORDER_DELIVERY_KEY } = await import('@/lib/orderDelivery');
    const { latestOrderDelivery } = await import('../_helpers/orderDeliveryView');
    const f = await boundOrder(mode, `bound-drop-${mode}`);
    setRoute(mode);
    mount();
    const first = renderBound();
    await waitFor(() => expect(first.result.current.isRestoring).toBe(false));
    breakSetItem((key) => key.startsWith(ORDER_DELIVERY_KEY), 'drop');

    act(() => first.result.current.mutate({ merchant: MERCHANT, value: VALUE, order: f.order }));
    await waitFor(() => expect(first.result.current.error?.message).toBe('order_binding_storage_unavailable'));
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(relayPosts()).toHaveLength(0);
    first.unmount();

    const second = renderBound();
    await waitFor(() => expect(second.result.current.isRestoring).toBe(false));
    act(() => second.result.current.mutate({ merchant: MERCHANT, value: VALUE, order: f.order }));
    await waitFor(() => expect(second.result.current.error?.message).toBe('order_binding_storage_unavailable'));
    expect(signTypedData).toHaveBeenCalledTimes(2);
    expect(relayPosts()).toHaveLength(0);
    expect(latestOrderDelivery()).toEqual({ kind: 'empty' });
  });

  it('束縛した注文: IP 制限 (429) の後の再送の前にも slot を読み戻す。書き込みを黙って捨てるようになっていたら再送しない', async () => {
    const { ORDER_DELIVERY_KEY } = await import('@/lib/orderDelivery');
    const f = await boundOrder('free', 'bound-drop-retry');
    setRoute('free');
    mount();
    fetchSpy.mockResolvedValueOnce(jsonResponse(429, { ok: false, error: 'ip_rate_limited' }));
    const view = renderBound();
    await waitFor(() => expect(view.result.current.isRestoring).toBe(false));
    act(() => view.result.current.mutate({ merchant: MERCHANT, value: VALUE, order: f.order }));
    await waitFor(() => expect(isRelayIpRateLimitedError(view.result.current.error)).toBe(true));
    expect(relayPosts()).toHaveLength(1);

    breakSetItem((key) => key.startsWith(ORDER_DELIVERY_KEY), 'drop');
    act(() => view.result.current.retryRelay());
    await waitFor(() => expect(view.result.current.error?.message).toBe('order_binding_storage_unavailable'));
    expect(relayPosts()).toHaveLength(1);
    expect(signTypedData).toHaveBeenCalledTimes(1);
  });
});
