import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { getAddress, type Hex } from 'viem';

const send = vi.hoisted(() => ({
  verifyDeviceAuth: vi.fn(),
  sendStoreDeviceSettle: vi.fn(),
  readSentMarks: vi.fn(),
  receiptHasSettlement: vi.fn(),
  waitReceipt: vi.fn(),
  getReceipt: vi.fn(),
}));
vi.mock('@/lib/storeDeviceSend', () => ({
  verifyDeviceAuth: send.verifyDeviceAuth,
  sendStoreDeviceSettle: send.sendStoreDeviceSettle,
  readSentMarks: send.readSentMarks,
  receiptHasSettlement: send.receiptHasSettlement,
  createDeviceIo: () => ({ waitReceipt: send.waitReceipt, getReceipt: send.getReceipt }),
}));

import {
  STORE_DEVICE_SESSION_KEY,
  useStoreDeviceRegister,
  type StoreDeviceRegisterInput,
} from '@/hooks/useStoreDeviceRegister';

const SHOP = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const input: StoreDeviceRegisterInput = {
  enabled: true,
  chainId: 80002,
  token: getAddress('0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29'),
  forwarder: getAddress('0x752B7AaD0089286EB7b553d84D05233d80c9FCB4'),
  feeReceiver: getAddress('0x428483FbA62eDCef1E3a100d3799F6d71759c560'),
  gasAddress: getAddress('0x0000000000000000000000000000000000000abc'),
};
const AMOUNT = 1000n * 10n ** 18n;
const ID = 'AbCdEfGhIjKlMnOpQrStUv';
const TOKEN = 'ab'.repeat(32);
const HASH = `0x${'cd'.repeat(32)}` as Hex;
const NONCE = `0x${'33'.repeat(32)}` as Hex;
const AUTH = {
  from: '0x0000000000000000000000000000000000000def',
  merchantValue: AMOUNT.toString(),
  feeValue: '1',
  validAfter: '0',
  validBefore: '9999999999',
  intentSalt: `0x${'11'.repeat(32)}`,
  signature: `0x${'1b'.repeat(65)}`,
  nonce: NONCE,
};
const MARK = {
  handoffId: ID, chainId: 80002, nonce: NONCE, hash: HASH, from: AUTH.from, merchant: SHOP,
  amount: AMOUNT.toString(), validBefore: AUTH.validBefore, intentSalt: AUTH.intentSalt, at: 0,
};

type Call = { url: string; init?: RequestInit };
let calls: Call[];
let createRes: () => Promise<Response>;
let readRes: () => Promise<Response>;
let closeRes: () => Promise<Response>;
let resolveRes: () => Promise<Response>;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const nowSec = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(new Date('2026-10-07T03:00:00Z'));
  window.sessionStorage.clear();
  calls = [];
  createRes = () => json({ ok: true, id: ID, token: TOKEN, expiresAt: nowSec() + 600 });
  readRes = () => json({ ok: true, state: 'open', merchant: SHOP, amount: AMOUNT.toString(), auth: null });
  closeRes = () => json({ ok: true, closed: true });
  resolveRes = () => json({ ok: true, state: 'pending' });
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === '/api/register/handoff') return createRes();
    if (url.endsWith('/close')) return closeRes();
    if (url.endsWith('/tx')) return json({ ok: true, txHash: HASH });
    if (url.endsWith('/resolve')) return resolveRes();
    return readRes();
  }));
  send.verifyDeviceAuth.mockReset().mockResolvedValue({ ok: true, value: { params: {}, signature: '0x', nonce: NONCE } });
  send.sendStoreDeviceSettle.mockReset().mockResolvedValue({ kind: 'sent', hash: HASH, mark: MARK });
  send.readSentMarks.mockReset().mockReturnValue({ ok: true, marks: [MARK] });
  send.receiptHasSettlement.mockReset().mockReturnValue(true);
  send.waitReceipt.mockReset().mockResolvedValue({ status: 'success', logs: [] });
  send.getReceipt.mockReset().mockResolvedValue({ status: 'success', logs: [] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const of = (suffix: string) => calls.filter((c) => c.url.endsWith(suffix));
const reads = () => calls.filter((c) => c.url === `/api/register/handoff/${ID}`);
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
async function started(result: { current: ReturnType<typeof useStoreDeviceRegister> }) {
  let s: unknown;
  await act(async () => {
    s = await result.current.start(SHOP, AMOUNT);
  });
  return s;
}

describe('useStoreDeviceRegister (レジ端末: 受け渡し → 確かめて送る → 結果)', () => {
  it('切替 OFF (enabled = false) では通信も effect も起こさない', async () => {
    window.sessionStorage.setItem(STORE_DEVICE_SESSION_KEY, JSON.stringify({ id: ID, token: TOKEN, expiresAt: nowSec() + 600, merchant: SHOP, amount: '1', chainId: 80002 }));
    const { result } = renderHook(() => useStoreDeviceRegister({ ...input, enabled: false }));
    await advance(10_000);
    expect(await result.current.start(SHOP, AMOUNT)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('QR を出すとセッションを作り、トークンはタブ限定に保存して署名を待つ (最初は 3 秒おき)', async () => {
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    expect(await started(result)).toMatchObject({ id: ID, merchant: SHOP, amount: AMOUNT.toString() });
    expect(JSON.parse(String(calls[0].init!.body))).toEqual({ chainId: 80002, merchant: SHOP, amount: AMOUNT.toString() });
    expect(result.current.state).toMatchObject({ phase: 'waiting', stale: false, degraded: false });
    expect(JSON.parse(window.sessionStorage.getItem(STORE_DEVICE_SESSION_KEY)!)).toMatchObject({ id: ID, token: TOKEN });
    await advance(9_000);
    expect(reads()).toHaveLength(3);
    expect((reads()[0].init!.headers as Record<string, string>)['x-store-handoff-token']).toBe(TOKEN);
  });

  it.each([
    [429, 'busy'],
    [503, 'unavailable'],
    [400, 'invalid'],
  ])('作れなかった (%s) → %s・QR は出さない', async (status, reason) => {
    createRes = () => json({ ok: false, error: 'x' }, status);
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    expect(await started(result)).toBeNull();
    expect(result.current.state).toEqual({ phase: 'create_failed', reason });
  });

  it('署名が入ったら確かめて送り、tx を記録し、receipt にこの支払いの Settled があれば「入金を確認」→ 確定', async () => {
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await started(result);
    readRes = () => json({ ok: true, state: 'signed', merchant: SHOP, amount: AMOUNT.toString(), auth: AUTH });
    await advance(3_000);
    expect(send.verifyDeviceAuth).toHaveBeenCalledWith(
      { merchant: SHOP, amount: AMOUNT.toString(), auth: AUTH },
      expect.objectContaining({ merchant: SHOP, amount: AMOUNT, feeReceiver: input.feeReceiver, forwarder: input.forwarder }),
    );
    expect(send.sendStoreDeviceSettle).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(of('/tx')[0].init!.body))).toEqual({ txHash: HASH });
    expect(result.current.state).toMatchObject({ phase: 'received', finalized: false, previous: false });
    expect(window.sessionStorage.getItem(STORE_DEVICE_SESSION_KEY)).toBeNull();
    const readsAfter = reads().length;
    resolveRes = () => json({ ok: true, state: 'settled', txHash: HASH });
    await advance(10_000);
    expect(result.current.state).toMatchObject({ phase: 'received', finalized: true });
    expect(JSON.parse(String(of('/resolve')[0].init!.body))).toMatchObject({ nonce: NONCE, txHash: HASH, merchantValue: AMOUNT.toString() });
    expect(reads().length).toBe(readsAfter); // 送った後は受け渡しを読まない
  });

  it('自分で確かめて外れたら送らない (rejected)', async () => {
    send.verifyDeviceAuth.mockResolvedValue({ ok: false, reason: 'amount_mismatch' });
    readRes = () => json({ ok: true, state: 'signed', merchant: SHOP, amount: AMOUNT.toString(), auth: AUTH });
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await started(result);
    await advance(3_000);
    expect(result.current.state).toEqual({ phase: 'rejected', reason: 'amount_mismatch' });
    expect(send.sendStoreDeviceSettle).not.toHaveBeenCalled();
  });

  it('一時的な理由で送らなかったら「もう一度送る」で同じ署名を送り直せる・新しい QR を出したら使わせない', async () => {
    send.sendStoreDeviceSettle.mockResolvedValueOnce({ kind: 'not_sent', reason: 'rpc' });
    readRes = () => json({ ok: true, state: 'signed', merchant: SHOP, amount: AMOUNT.toString(), auth: AUTH });
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await started(result);
    await advance(3_000);
    expect(result.current.state).toEqual({ phase: 'not_sent', reason: 'rpc', canRetry: true });
    await act(async () => {
      result.current.retry();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(send.sendStoreDeviceSettle).toHaveBeenCalledTimes(2);
    expect(result.current.state).toMatchObject({ phase: 'received' });
  });

  it('使用済み・お客様の残高不足は再送させない', async () => {
    send.sendStoreDeviceSettle.mockResolvedValueOnce({ kind: 'not_sent', reason: 'used' });
    readRes = () => json({ ok: true, state: 'signed', merchant: SHOP, amount: AMOUNT.toString(), auth: AUTH });
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await started(result);
    await advance(3_000);
    expect(result.current.state).toEqual({ phase: 'not_sent', reason: 'used', canRetry: false });
  });

  it('receipt が revert なら reverted・待ち時間切れなら unknown →「いま確認する」で読み直す', async () => {
    send.waitReceipt.mockResolvedValueOnce(null);
    readRes = () => json({ ok: true, state: 'signed', merchant: SHOP, amount: AMOUNT.toString(), auth: AUTH });
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await started(result);
    await advance(3_000);
    expect(result.current.state).toMatchObject({ phase: 'unknown' });
    send.getReceipt.mockResolvedValueOnce({ status: 'reverted', logs: [] });
    await act(async () => {
      await result.current.checkNow();
    });
    expect(result.current.state).toMatchObject({ phase: 'reverted' });
  });

  it('receipt が成功でも、この支払いの Settled が無ければ「入金を確認」と言わない', async () => {
    send.receiptHasSettlement.mockReturnValue(false);
    readRes = () => json({ ok: true, state: 'signed', merchant: SHOP, amount: AMOUNT.toString(), auth: AUTH });
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await started(result);
    await advance(3_000);
    expect(result.current.state).toMatchObject({ phase: 'unknown' });
  });

  it('QR を閉じたら締め切る。締め切る前に署名が入っていたら、それを受け取って送る', async () => {
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await started(result);
    closeRes = () => json({ ok: true, closed: false, auth: AUTH, txHash: null });
    await act(async () => {
      result.current.stop();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(of('/close')).toHaveLength(1);
    expect(send.sendStoreDeviceSettle).toHaveBeenCalledTimes(1);
    expect(result.current.state).toMatchObject({ phase: 'received' });
  });

  it('次の QR を出すときは前のセッションを締め切ってから作る', async () => {
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await started(result);
    await started(result);
    expect(calls.map((c) => c.url.replace(ID, '<id>'))).toEqual([
      '/api/register/handoff',
      '/api/register/handoff/<id>/close',
      '/api/register/handoff',
    ]);
  });

  it('受付時間の残りが少なくなったら QR を薄くし (stale)、署名を預けられない残りで締め切って expired', async () => {
    createRes = () => json({ ok: true, id: ID, token: TOKEN, expiresAt: nowSec() + 230 });
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await started(result);
    await advance(30_000);
    expect(result.current.state).toMatchObject({ phase: 'waiting', stale: true });
    await advance(160_000);
    expect(of('/close')).toHaveLength(1);
    expect(result.current.state).toEqual({ phase: 'expired' });
  });

  it('読み取りが 30 秒続けて失敗したら degraded (通常の QR に切り替えられる)・404 は expired', async () => {
    readRes = () => json({ ok: false }, 503);
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await started(result);
    await advance(33_000);
    expect(result.current.state).toMatchObject({ phase: 'waiting', degraded: true });
    readRes = () => json({ ok: false, error: 'not_found' }, 404);
    await advance(6_000);
    expect(result.current.state).toEqual({ phase: 'expired' });
  });

  it('再読み込み後: 前のタブのセッションを締め切り、署名が入っていれば送る', async () => {
    window.sessionStorage.setItem(STORE_DEVICE_SESSION_KEY, JSON.stringify({ id: ID, token: TOKEN, expiresAt: nowSec() + 300, merchant: SHOP, amount: AMOUNT.toString(), chainId: 80002 }));
    closeRes = () => json({ ok: true, closed: false, auth: AUTH, txHash: null });
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await advance(0);
    expect(of('/close')).toHaveLength(1);
    expect(send.verifyDeviceAuth).toHaveBeenCalledWith(
      { merchant: SHOP, amount: AMOUNT.toString(), auth: AUTH },
      expect.objectContaining({ merchant: SHOP }),
    );
    expect(result.current.state).toMatchObject({ phase: 'received' });
  });

  it('前回の送信の確認が遅れて返っても、新しい会計の「署名待ち」を上書きしない', async () => {
    send.readSentMarks.mockReturnValue({ ok: true, marks: [{ ...MARK, at: Date.now() - 60_000 }] });
    let release!: (v: unknown) => void;
    send.waitReceipt.mockReturnValueOnce(new Promise((r) => { release = r; }));
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await advance(0);
    expect(result.current.state).toMatchObject({ phase: 'sent', previous: true });
    await started(result);
    expect(result.current.state).toMatchObject({ phase: 'waiting' });
    await act(async () => {
      release({ status: 'success', logs: [] });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.state).toMatchObject({ phase: 'waiting' });
  });

  it('送らなかった署名は、再読み込みで自動で処理し直さない (保存したセッションを外す)', async () => {
    send.sendStoreDeviceSettle.mockResolvedValueOnce({ kind: 'not_sent', reason: 'native_insufficient' });
    readRes = () => json({ ok: true, state: 'signed', merchant: SHOP, amount: AMOUNT.toString(), auth: AUTH });
    const first = renderHook(() => useStoreDeviceRegister(input));
    await started(first.result);
    await advance(3_000);
    expect(first.result.current.state).toMatchObject({ phase: 'not_sent', canRetry: true });
    expect(window.sessionStorage.getItem(STORE_DEVICE_SESSION_KEY)).toBeNull();
    first.unmount();
    send.sendStoreDeviceSettle.mockClear();
    const closesBefore = of('/close').length;
    renderHook(() => useStoreDeviceRegister(input));
    await advance(0);
    expect(of('/close').length).toBe(closesBefore);
    expect(send.sendStoreDeviceSettle).not.toHaveBeenCalled();
  });

  it('送った後、次の会計の QR はすぐ作れる (処理済みのセッションを引きずらない)', async () => {
    readRes = () => json({ ok: true, state: 'signed', merchant: SHOP, amount: AMOUNT.toString(), auth: AUTH });
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await started(result);
    await advance(3_000);
    expect(result.current.state).toMatchObject({ phase: 'received' });
    // サーバは送信済みのセッションの締め切りに署名を返す (締め切らない) → 引きずると次の QR を作れない
    closeRes = () => json({ ok: true, closed: false, auth: AUTH, txHash: HASH });
    readRes = () => json({ ok: true, state: 'open', merchant: SHOP, amount: AMOUNT.toString(), auth: null });
    expect(await started(result)).toMatchObject({ id: ID });
    expect(result.current.state).toMatchObject({ phase: 'waiting' });
  });

  it('「いま確認する」の遅れた結果も、新しい会計の表示を上書きしない', async () => {
    send.readSentMarks.mockReturnValue({ ok: true, marks: [{ ...MARK, at: Date.now() - 60_000 }] });
    send.waitReceipt.mockResolvedValueOnce(null);
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await advance(0);
    expect(result.current.state).toMatchObject({ phase: 'unknown', previous: true });
    let release!: (v: unknown) => void;
    send.getReceipt.mockReturnValueOnce(new Promise((r) => { release = r; }));
    let checking!: Promise<void>;
    act(() => {
      checking = result.current.checkNow();
    });
    await started(result);
    await act(async () => {
      release({ status: 'success', logs: [] });
      await checking;
    });
    expect(result.current.state).toMatchObject({ phase: 'waiting' });
  });

  it('切替を OFF にしたら表示を戻し、遅れて返った締め切りの署名も送らない', async () => {
    const { result, rerender } = renderHook((p: StoreDeviceRegisterInput) => useStoreDeviceRegister(p), { initialProps: input });
    await started(result);
    let release!: (v: Response) => void;
    closeRes = () => new Promise<Response>((r) => { release = r; });
    act(() => {
      result.current.stop();
    });
    rerender({ ...input, enabled: false });
    await act(async () => {
      release(new Response(JSON.stringify({ ok: true, closed: false, auth: AUTH }), { status: 200 }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.state).toEqual({ phase: 'idle' });
    expect(send.sendStoreDeviceSettle).not.toHaveBeenCalled();
  });

  it('通常の QR に切り替える前に締め切る: 署名が入っていたら端末が送り、通常の QR は出させない', async () => {
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await started(result);
    closeRes = () => json({ ok: true, closed: false, auth: AUTH, txHash: null });
    let ok!: boolean;
    await act(async () => {
      ok = await result.current.releaseForNormal();
    });
    expect(ok).toBe(false);
    expect(send.sendStoreDeviceSettle).toHaveBeenCalledTimes(1);
  });

  it('通常の QR に切り替える: 締め切れたら出してよい・締め切りの応答が無ければそのセッションは自動で処理しない', async () => {
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await started(result);
    closeRes = () => Promise.reject(new TypeError('net'));
    let ok!: boolean;
    await act(async () => {
      ok = await result.current.releaseForNormal();
    });
    expect(ok).toBe(true);
    expect(window.sessionStorage.getItem(STORE_DEVICE_SESSION_KEY)).toBeNull();
    expect(result.current.state).toEqual({ phase: 'idle' });
  });

  it('QR を閉じた直後に次の QR を出すと、締め切りの応答を待つ (署名が入っていたら新しい QR は出さない)', async () => {
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await started(result);
    closeRes = () => json({ ok: true, closed: false, auth: AUTH, txHash: null });
    act(() => {
      result.current.stop();
    });
    expect(await started(result)).toBeNull();
    expect(send.sendStoreDeviceSettle).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.url === '/api/register/handoff')).toHaveLength(1);
  });

  it('署名を受け取って送り始めた直後 (描画前) に「通常の QR」を求めても出させない・二重に送らない', async () => {
    let release!: (v: unknown) => void;
    send.verifyDeviceAuth.mockReturnValueOnce(new Promise((r) => { release = r; }));
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await started(result);
    // 描画前の古い関数 (署名待ちの state を閉じ込めたもの) を握っておく
    const staleRelease = result.current.releaseForNormal;
    const staleStart = result.current.start;
    const staleDismiss = result.current.dismiss;
    readRes = () => json({ ok: true, state: 'signed', merchant: SHOP, amount: AMOUNT.toString(), auth: AUTH });
    await advance(3_000); // 読み取りが署名を受け取り、確かめ始める (verify が終わらない)
    let ok!: boolean;
    let next!: unknown;
    await act(async () => {
      staleDismiss();
      ok = await staleRelease();
      next = await staleStart(SHOP, AMOUNT);
    });
    expect(ok).toBe(false);
    expect(next).toBeNull();
    expect(result.current.state).toEqual({ phase: 'processing' });
    expect(result.current.busy).toBe(true);
    await act(async () => {
      release({ ok: true, value: { params: {}, signature: '0x', nonce: NONCE } });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(send.sendStoreDeviceSettle).toHaveBeenCalledTimes(1);
    expect(result.current.state).toMatchObject({ phase: 'received' });
  });

  it('QR のボタンの二度押しで受け渡しを二つ作らない', async () => {
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    let a!: unknown;
    let b!: unknown;
    await act(async () => {
      [a, b] = await Promise.all([result.current.start(SHOP, AMOUNT), result.current.start(SHOP, AMOUNT)]);
    });
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(calls.filter((c) => c.url === '/api/register/handoff')).toHaveLength(1);
  });

  it('再読み込み後: 最近送った印があれば、その結果を「前回の送信」として出す', async () => {
    send.readSentMarks.mockReturnValue({ ok: true, marks: [{ ...MARK, at: Date.now() - 60_000 }] });
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await advance(0);
    expect(send.waitReceipt).toHaveBeenCalledWith(HASH, expect.any(Number));
    expect(result.current.state).toMatchObject({ phase: 'received', previous: true });
  });
});
