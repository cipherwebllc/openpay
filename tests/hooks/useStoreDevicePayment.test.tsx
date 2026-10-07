import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { getAddress } from 'viem';

const w = vi.hoisted(() => ({
  signTypedData: vi.fn(),
  readContract: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  account: { address: '0x0000000000000000000000000000000000000def' as string | undefined, chainId: 80002 as number | undefined },
}));
vi.mock('wagmi', () => ({
  useWalletClient: () => ({ data: { signTypedData: w.signTypedData } }),
  useAccount: () => w.account,
  usePublicClient: () => ({ readContract: w.readContract, waitForTransactionReceipt: w.waitForTransactionReceipt }),
}));
const FWD = '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4';
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/forwarderConfig')>()),
  jpycForwarderFor: () => FWD,
}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, feeReceiver: '0x428483FbA62eDCef1E3a100d3799F6d71759c560' } };
});

import { STORE_DEVICE_INTENT_KEY, useStoreDevicePayment } from '@/hooks/useStoreDevicePayment';
import type { TokenDeployment } from '@/lib/tokens';

const HS = 'AbCdEfGhIjKlMnOpQrStUv';
const SHOP = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const JPYC = getAddress('0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29');
const TX = `0x${'ab'.repeat(32)}`;
const deployment = { chainId: 80002, address: JPYC, decimals: 18 } as unknown as TokenDeployment;
const BILL = 1000n * 10n ** 18n;
const SIG = `0x${'1b'.repeat(65)}`;

type FetchCall = { url: string; init?: RequestInit };
let fetchCalls: FetchCall[];
let authResponse: () => Promise<Response>;
let readResponse: () => Promise<Response>;

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(new Date('2026-10-07T03:00:00Z'));
  window.sessionStorage.clear();
  w.signTypedData.mockReset().mockResolvedValue(SIG);
  w.readContract.mockReset();
  w.waitForTransactionReceipt.mockReset();
  w.account = { address: '0x0000000000000000000000000000000000000def', chainId: 80002 };
  fetchCalls = [];
  authResponse = () => json({ ok: true, idempotent: false });
  readResponse = () => json({ ok: true, state: 'signed', expiresAt: 0, txHash: null });
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    fetchCalls.push({ url, init });
    return url.endsWith('/auth') ? authResponse() : readResponse();
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function payNow(result: { current: ReturnType<typeof useStoreDevicePayment> }) {
  await act(async () => {
    await result.current.pay({ merchant: SHOP, bill: BILL });
  });
}

describe('useStoreDevicePayment', () => {
  it('既存 forwarder 宛て・請求額 + 1 wei に署名し、受け渡しへ渡して送信待ちに入る', async () => {
    const { result } = renderHook(() => useStoreDevicePayment(deployment, HS));
    await payNow(result);
    const typed = w.signTypedData.mock.calls[0][0];
    expect(typed.primaryType).toBe('ReceiveWithAuthorization');
    expect(typed.message.to).toBe(FWD);
    expect(typed.message.value).toBe(BILL + 1n);
    const auth = fetchCalls.find((c) => c.url.endsWith('/auth'))!;
    expect(auth.url).toBe(`/api/register/handoff/${HS}/auth`);
    expect(JSON.parse(String(auth.init!.body))).toMatchObject({
      merchant: SHOP,
      merchantValue: BILL.toString(),
      feeValue: '1',
      signature: SIG,
    });
    expect(result.current.status.phase).toBe('waiting');
    expect(JSON.parse(window.sessionStorage.getItem(STORE_DEVICE_INTENT_KEY)!)).toMatchObject({ handoffId: HS });
  });

  it('お店の端末が送った tx の receipt 成功で完了し、待ちの情報を消す', async () => {
    readResponse = () => json({ ok: true, state: 'sent', expiresAt: 0, txHash: TX });
    w.waitForTransactionReceipt.mockResolvedValue({ status: 'success' });
    const { result } = renderHook(() => useStoreDevicePayment(deployment, HS));
    await payNow(result);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(result.current.status).toEqual({ phase: 'success', txHash: TX });
    expect(window.sessionStorage.getItem(STORE_DEVICE_INTENT_KEY)).toBeNull();
  });

  it('期限 + 30 秒を過ぎても送られず、チェーンで未使用なら「お支払いは行われていません」', async () => {
    w.readContract.mockResolvedValue(false);
    const { result } = renderHook(() => useStoreDevicePayment(deployment, HS));
    await payNow(result);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150_000);
    });
    expect(result.current.status.phase).toBe('waiting');
    expect(w.readContract).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });
    expect(w.readContract).toHaveBeenCalled();
    expect(result.current.status).toEqual({ phase: 'expired' });
  });

  it('期限後に使用済みなら支払い済み・チェーンを読めないうちは「行われていない」と言わない', async () => {
    w.readContract.mockRejectedValueOnce(new Error('rpc down')).mockResolvedValue(true);
    const { result } = renderHook(() => useStoreDevicePayment(deployment, HS));
    await payNow(result);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(185_000);
    });
    // 1 回目の読み取りは失敗 → 待ちのまま、次の読み取りで使用済み → 支払い済み
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(result.current.status).toEqual({ phase: 'success', txHash: null });
  });

  it.each([
    ['insufficient_balance', 400, 'insufficient_balance'],
    ['slot_taken', 409, 'session_taken'],
    ['expired', 410, 'session_expired'],
    ['fee_value_mismatch', 400, 'server_rejected'],
  ])('受け渡しが %s を返したら、待ちの情報を消して理由を出す', async (error, status, reason) => {
    authResponse = () => json({ ok: false, error }, status);
    const { result } = renderHook(() => useStoreDevicePayment(deployment, HS));
    await payNow(result);
    expect(result.current.status).toEqual({ phase: 'error', reason });
    expect(window.sessionStorage.getItem(STORE_DEVICE_INTENT_KEY)).toBeNull();
  });

  it('使用済みの署名 (authorization_used) は支払い済みとして扱う', async () => {
    authResponse = () => json({ ok: false, error: 'authorization_used' }, 409);
    const { result } = renderHook(() => useStoreDevicePayment(deployment, HS));
    await payNow(result);
    expect(result.current.status).toEqual({ phase: 'success', txHash: null });
  });

  it('応答を受け取れないときは 1 回だけ送り直し、それでもだめなら失敗とは言わず待ちに入る', async () => {
    authResponse = () => Promise.reject(new TypeError('network'));
    const { result } = renderHook(() => useStoreDevicePayment(deployment, HS));
    await payNow(result);
    expect(fetchCalls.filter((c) => c.url.endsWith('/auth'))).toHaveLength(2);
    expect(result.current.status.phase).toBe('waiting');
  });

  it('署名をキャンセルしたら rejected・別ネットワークなら wrong_chain (署名を求めない)', async () => {
    w.signTypedData.mockRejectedValueOnce(Object.assign(new Error('User rejected'), { code: 4001 }));
    const { result } = renderHook(() => useStoreDevicePayment(deployment, HS));
    await payNow(result);
    expect(result.current.status).toEqual({ phase: 'error', reason: 'rejected' });
    w.account = { ...w.account, chainId: 137 };
    const other = renderHook(() => useStoreDevicePayment(deployment, HS));
    await payNow(other.result);
    expect(other.result.current.status).toEqual({ phase: 'error', reason: 'wrong_chain' });
    expect(w.signTypedData).toHaveBeenCalledTimes(1);
  });

  it('再読み込み: 同じ会計で署名済みなら、新しい署名を作らずに待ちへ戻る', async () => {
    window.sessionStorage.setItem(
      STORE_DEVICE_INTENT_KEY,
      JSON.stringify({ v: 1, handoffId: HS, chainId: 80002, from: '0x0000000000000000000000000000000000000def', nonce: `0x${'11'.repeat(32)}`, validBefore: Math.floor(Date.now() / 1000) + 100 }),
    );
    const { result } = renderHook(() => useStoreDevicePayment(deployment, HS));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status.phase).toBe('waiting');
    expect(w.signTypedData).not.toHaveBeenCalled();
  });
});
