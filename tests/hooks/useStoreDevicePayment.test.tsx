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
const OTHER_HS = 'ZZZZZZZZZZZZZZZZZZZZZZ';
const SHOP = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const JPYC = getAddress('0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29');
const TX = `0x${'ab'.repeat(32)}`;
const deployment = { chainId: 80002, address: JPYC, decimals: 18 } as unknown as TokenDeployment;
const BILL = 1000n * 10n ** 18n;
const SIG = `0x${'1b'.repeat(65)}`;
const SNAPSHOT = { storeName: 'OpenPay Cafe', items: [{ name: 'カフェラテ', qty: 1, price: '1000' }] };

type Call = { url: string; init?: RequestInit };
let calls: Call[];
let authResponses: (() => Promise<Response>)[];
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
  authResponses = [() => json({ ok: true, idempotent: false })];
  readResponse = () => json({ ok: true, state: 'signed', expiresAt: 0, txHash: null });
  resolveResponse = () => json({ ok: true, state: 'pending' });
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/auth')) return (authResponses.shift() ?? authResponses[0] ?? (() => json({ ok: true })))();
    if (url.endsWith('/resolve')) return resolveResponse();
    return readResponse();
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const of = (suffix: string) => calls.filter((c) => c.url.endsWith(suffix));
const reads = () => calls.filter((c) => /\/handoff\/[^/]+$/.test(c.url) && !c.url.endsWith('/resolve'));
const stored = () => window.localStorage.getItem(STORE_DEVICE_INTENT_KEY);

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
function seedIntent(handoffId: string, validBefore = Math.floor(Date.now() / 1000) + 100) {
  window.localStorage.setItem(
    STORE_DEVICE_INTENT_KEY,
    JSON.stringify({
      v: 3, handoffId, chainId: 80002, from: '0x0000000000000000000000000000000000000def', merchant: SHOP,
      merchantValue: '1', intentSalt: `0x${'22'.repeat(32)}`, validBefore, nonce: `0x${'33'.repeat(32)}`,
      forwarder: FWD, feeReceiver: '0x428483FbA62eDCef1E3a100d3799F6d71759c560',
      snapshot: { storeName: 'Prev Shop', items: [] },
    }),
  );
}

describe('useStoreDevicePayment', () => {
  it('forwarder 宛て・請求額 + 1 wei に署名し、未解決として保存してから受け渡しへ', async () => {
    const { result } = renderHook(() => useStoreDevicePayment(deployment, HS));
    await payNow(result);
    const typed = w.signTypedData.mock.calls[0][0];
    expect(typed.message.to).toBe(FWD);
    expect(typed.message.value).toBe(BILL + 1n);
    expect(JSON.parse(String(of('/auth')[0].init!.body))).toMatchObject({ merchantValue: BILL.toString(), feeValue: '1' });
    expect(result.current.status).toMatchObject({ phase: 'waiting', otherCheckout: false });
    expect(JSON.parse(stored()!)).toMatchObject({ v: 3, handoffId: HS, forwarder: FWD, snapshot: SNAPSHOT });
  });

  it('端末の tx のヒントが出たら KV は読まず、判定を毎回確かめ直して確定で支払い済み', async () => {
    readResponse = () => json({ ok: true, state: 'sent', expiresAt: 0, txHash: TX });
    resolveResponse = () => json({ ok: true, state: 'pending', confirming: true });
    const { result } = renderHook(() => useStoreDevicePayment(deployment, HS));
    await payNow(result);
    await advance(10);
    expect(result.current.status).toMatchObject({ phase: 'waiting', txHint: TX, confirming: true });
    const readsAfterHint = reads().length;
    await advance(10_000);
    expect(reads().length).toBe(readsAfterHint); // ヒント取得後は KV を読まない
    expect(of('/resolve').length).toBeGreaterThanOrEqual(2); // 同じヒントを確かめ直す
    resolveResponse = () => json({ ok: true, state: 'settled', txHash: TX });
    await advance(5_000);
    expect(result.current.status).toMatchObject({ phase: 'success', txHash: TX });
    expect(stored()).toBeNull();
  });

  it('期限 + 30 秒までは (ヒントが無ければ) 判定を呼ばず、その後の「行われていない」で期限切れ', async () => {
    const { result } = renderHook(() => useStoreDevicePayment(deployment, HS));
    await payNow(result);
    await advance(150_000);
    expect(of('/resolve')).toHaveLength(0);
    resolveResponse = () => json({ ok: true, state: 'expired_unused' });
    await advance(60_000);
    expect(result.current.status.phase).toBe('expired');
    expect(stored()).toBeNull();
  });

  it('使用済みで結果を確かめられない → used_unresolved (ロックを外す・支払い済みにはしない)', async () => {
    const { result } = renderHook(() => useStoreDevicePayment(deployment, HS));
    await payNow(result);
    resolveResponse = () => json({ ok: true, state: 'used_unresolved' });
    await advance(200_000);
    expect(result.current.status.phase).toBe('used_unresolved');
    expect(stored()).toBeNull();
  });

  it('期限 + 10 分で自動の確認を止め、「いま確認する」で判定を呼ぶ', async () => {
    const { result } = renderHook(() => useStoreDevicePayment(deployment, HS));
    await payNow(result);
    await advance(800_000);
    expect(result.current.status).toMatchObject({ phase: 'waiting', autoStopped: true });
    const before = of('/resolve').length;
    await advance(120_000);
    expect(of('/resolve').length).toBe(before); // 自動では呼ばない
    resolveResponse = () => json({ ok: true, state: 'expired_unused' });
    await act(async () => {
      result.current.checkNow();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status.phase).toBe('expired');
  });

  it.each([
    ['503', [() => json({ ok: false, error: 'handoff_unavailable' }, 503)]],
    ['読めない応答', [() => Promise.resolve(new Response('<html>', { status: 200 })), () => Promise.resolve(new Response('<html>', { status: 200 }))]],
    ['通信断 2 回', [() => Promise.reject(new TypeError('net')), () => Promise.reject(new TypeError('net'))]],
    ['通信断のあと 404 (最初の送信が預けられた可能性)', [() => Promise.reject(new TypeError('net')), () => json({ ok: false, error: 'not_found' }, 404)]],
    ['通信断のあと 409 枠埋まり (自分の署名で埋まった可能性)', [() => Promise.reject(new TypeError('net')), () => json({ ok: false, error: 'slot_taken' }, 409)]],
    ['使用済み (authorization_used)', [() => json({ ok: false, error: 'authorization_used' }, 409)]],
  ])('%s → 失敗と言わず確認へ (未解決を残す)', async (_, responses) => {
    authResponses = [...responses] as (() => Promise<Response>)[];
    const { result } = renderHook(() => useStoreDevicePayment(deployment, HS));
    await payNow(result);
    expect(result.current.status.phase).toBe('waiting');
    expect(stored()).not.toBeNull();
  });

  it.each([
    ['insufficient_balance', 400, 'insufficient_balance', false],
    ['expired', 410, 'session_expired', true],
    ['slot_taken', 409, 'session_taken', true],
    ['rate_limited', 429, 'busy', false],
  ])('最初の応答で預かっていないと確定 (%s) → 未解決を消して理由を出す', async (error, status, reason, blocking) => {
    authResponses = [() => json({ ok: false, error }, status)];
    const { result } = renderHook(() => useStoreDevicePayment(deployment, HS));
    await payNow(result);
    expect(result.current.status).toEqual({ phase: 'error', reason, blocking });
    expect(stored()).toBeNull();
  });

  it('未解決を保存できない端末では送らない', async () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      const { result } = renderHook(() => useStoreDevicePayment(deployment, HS));
      await payNow(result);
      expect(result.current.status).toEqual({ phase: 'error', reason: 'storage_unavailable', blocking: false });
      expect(of('/auth')).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('別タブが先に未解決を保存していたら、署名せずその確認に入る', async () => {
    const { result } = renderHook(() => useStoreDevicePayment(deployment, HS));
    await advance(0);
    seedIntent(OTHER_HS); // 別タブが保存
    await payNow(result);
    expect(w.signTypedData).not.toHaveBeenCalled();
    expect(result.current.status).toMatchObject({ phase: 'waiting', otherCheckout: true });
  });

  it('別の会計の未解決に結論が出たら previous を出し、この会計は払える', async () => {
    seedIntent(OTHER_HS, Math.floor(Date.now() / 1000) - 100);
    resolveResponse = () => json({ ok: true, state: 'settled', txHash: TX });
    const { result } = renderHook(() => useStoreDevicePayment(deployment, HS));
    await advance(10);
    expect(result.current.status).toMatchObject({ phase: 'previous', outcome: 'success', txHash: TX });
    expect(stored()).toBeNull();
    await payNow(result);
    expect(w.signTypedData).toHaveBeenCalledTimes(1);
  });

  it('署名をキャンセルしたら rejected (未解決を残さない)', async () => {
    w.signTypedData.mockRejectedValueOnce(Object.assign(new Error('User rejected'), { code: 4001 }));
    const { result } = renderHook(() => useStoreDevicePayment(deployment, HS));
    await payNow(result);
    expect(result.current.status).toEqual({ phase: 'error', reason: 'rejected', blocking: false });
    expect(stored()).toBeNull();
  });
});
