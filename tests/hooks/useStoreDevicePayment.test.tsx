import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { getAddress } from 'viem';

const w = vi.hoisted(() => ({
  signTypedData: vi.fn(),
  account: { address: '0x0000000000000000000000000000000000000def' as string | undefined, chainId: 80002 as number | undefined },
}));
vi.mock('wagmi', () => ({
  useWalletClient: () => ({ data: { signTypedData: w.signTypedData } }),
  useAccount: () => w.account,
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
const SNAPSHOT = { storeName: 'OpenPay Cafe', items: [{ name: 'カフェラテ', qty: 1, price: '1000' }] };

type Call = { url: string; init?: RequestInit };
let calls: Call[];
let authResponse: () => Promise<Response>;
let readResponse: () => Promise<Response>;
let resolveResponse: () => Promise<Response>;

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(new Date('2026-10-07T03:00:00Z'));
  window.localStorage.clear();
  w.signTypedData.mockReset().mockResolvedValue(SIG);
  w.account = { address: '0x0000000000000000000000000000000000000def', chainId: 80002 };
  calls = [];
  authResponse = () => json({ ok: true, idempotent: false });
  readResponse = () => json({ ok: true, state: 'signed', expiresAt: 0, txHash: null });
  resolveResponse = () => json({ ok: true, state: 'pending' });
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/auth')) return authResponse();
    if (url.endsWith('/resolve')) return resolveResponse();
    return readResponse();
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const resolveCalls = () => calls.filter((c) => c.url.endsWith('/resolve'));

async function payNow(result: { current: ReturnType<typeof useStoreDevicePayment> }) {
  await act(async () => {
    await result.current.pay({ merchant: SHOP, bill: BILL, snapshot: SNAPSHOT });
  });
}
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
const stored = () => window.localStorage.getItem(STORE_DEVICE_INTENT_KEY);

describe('useStoreDevicePayment', () => {
  it('既存 forwarder 宛て・請求額 + 1 wei に署名し、署名した時点で未解決として残してから受け渡しへ', async () => {
    const { result } = renderHook(() => useStoreDevicePayment(deployment, HS));
    await payNow(result);
    const typed = w.signTypedData.mock.calls[0][0];
    expect(typed.primaryType).toBe('ReceiveWithAuthorization');
    expect(typed.message.to).toBe(FWD);
    expect(typed.message.value).toBe(BILL + 1n);
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith('/auth'))!.init!.body))).toMatchObject({
      merchant: SHOP, merchantValue: BILL.toString(), feeValue: '1', signature: SIG,
    });
    expect(result.current.status).toMatchObject({ phase: 'waiting', otherCheckout: false });
    expect(JSON.parse(stored()!)).toMatchObject({ handoffId: HS, merchantValue: BILL.toString(), snapshot: SNAPSHOT });
  });

  it('端末の tx をサーバの判定で確かめて支払い済みにし、未解決の記録を消す', async () => {
    readResponse = () => json({ ok: true, state: 'sent', expiresAt: 0, txHash: TX });
    resolveResponse = () => json({ ok: true, state: 'settled', txHash: TX });
    const { result } = renderHook(() => useStoreDevicePayment(deployment, HS));
    await payNow(result);
    await advance(10);
    expect(JSON.parse(String(resolveCalls()[0].init!.body))).toMatchObject({ txHash: TX, merchantValue: BILL.toString() });
    expect(result.current.status).toMatchObject({ phase: 'success', txHash: TX });
    expect(stored()).toBeNull();
  });

  it('判定が確認中のまま (revert・別の取引) なら支払い済みにも未払いにもしない', async () => {
    readResponse = () => json({ ok: true, state: 'sent', expiresAt: 0, txHash: TX });
    const { result } = renderHook(() => useStoreDevicePayment(deployment, HS));
    await payNow(result);
    await advance(20_000);
    expect(result.current.status.phase).toBe('waiting');
    expect(stored()).not.toBeNull();
  });

  it('期限 + 30 秒までは判定 API を呼ばず (tx が無いとき)、その後は判定の「行われていない」だけで期限切れにする', async () => {
    const { result } = renderHook(() => useStoreDevicePayment(deployment, HS));
    await payNow(result);
    await advance(150_000);
    expect(resolveCalls()).toHaveLength(0);
    resolveResponse = () => json({ ok: true, state: 'expired_unused' });
    await advance(60_000);
    expect(resolveCalls().length).toBeGreaterThan(0);
    expect(result.current.status.phase).toBe('expired');
    expect(stored()).toBeNull();
  });

  it.each([
    ['503 (保存されたか分からない)', () => json({ ok: false, error: 'handoff_unavailable' }, 503)],
    ['読めない応答', () => Promise.resolve(new Response('<html>', { status: 200 }))],
    ['通信断 (2 回とも)', () => Promise.reject(new TypeError('network'))],
    ['使用済み (authorization_used)', () => json({ ok: false, error: 'authorization_used' }, 409)],
  ])('%s → 失敗と言わず確認へ (未解決の記録を残す)', async (_, response) => {
    authResponse = response;
    const { result } = renderHook(() => useStoreDevicePayment(deployment, HS));
    await payNow(result);
    expect(result.current.status.phase).toBe('waiting');
    expect(stored()).not.toBeNull();
  });

  it.each([
    ['insufficient_balance', 400, 'insufficient_balance', false],
    ['fee_value_mismatch', 400, 'server_rejected', false],
    ['expired', 410, 'session_expired', true],
    ['slot_taken', 409, 'session_taken', true],
  ])('預かっていないと確定 (%s) → 未解決の記録を消して理由を出す', async (error, status, reason, blocking) => {
    authResponse = () => json({ ok: false, error }, status);
    const { result } = renderHook(() => useStoreDevicePayment(deployment, HS));
    await payNow(result);
    expect(result.current.status).toEqual({ phase: 'error', reason, blocking });
    expect(stored()).toBeNull();
  });

  it('枠が埋まっていたら、この QR ではもう署名させない', async () => {
    authResponse = () => json({ ok: false, error: 'slot_taken' }, 409);
    const { result } = renderHook(() => useStoreDevicePayment(deployment, HS));
    await payNow(result);
    await payNow(result);
    expect(w.signTypedData).toHaveBeenCalledTimes(1);
  });

  it('別の会計の未解決の支払いがあれば、その確認に戻り、新しい署名を作らない', async () => {
    window.localStorage.setItem(
      STORE_DEVICE_INTENT_KEY,
      JSON.stringify({
        v: 2, handoffId: 'ZZZZZZZZZZZZZZZZZZZZZZ', chainId: 80002,
        from: '0x0000000000000000000000000000000000000def', merchant: SHOP, merchantValue: '1',
        intentSalt: `0x${'22'.repeat(32)}`, validBefore: Math.floor(Date.now() / 1000) + 100,
        nonce: `0x${'33'.repeat(32)}`, snapshot: { items: [] },
      }),
    );
    const { result } = renderHook(() => useStoreDevicePayment(deployment, HS));
    await advance(0);
    expect(result.current.status).toMatchObject({ phase: 'waiting', otherCheckout: true });
    await payNow(result);
    expect(w.signTypedData).not.toHaveBeenCalled();
  });

  it('署名をキャンセルしたら rejected (未解決を残さない)・別ネットワークなら署名を求めない', async () => {
    w.signTypedData.mockRejectedValueOnce(Object.assign(new Error('User rejected'), { code: 4001 }));
    const { result } = renderHook(() => useStoreDevicePayment(deployment, HS));
    await payNow(result);
    expect(result.current.status).toEqual({ phase: 'error', reason: 'rejected', blocking: false });
    expect(stored()).toBeNull();
    w.account = { ...w.account, chainId: 137 };
    const other = renderHook(() => useStoreDevicePayment(deployment, HS));
    await payNow(other.result);
    expect(other.result.current.status).toEqual({ phase: 'error', reason: 'wrong_chain', blocking: false });
    expect(w.signTypedData).toHaveBeenCalledTimes(1);
  });
});
