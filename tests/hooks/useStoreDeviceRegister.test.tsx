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
  createDeviceIo: vi.fn(),
  createDeviceWatchIo: vi.fn(),
}));
vi.mock('@/lib/storeDeviceSend', () => ({
  verifyDeviceAuth: send.verifyDeviceAuth,
  sendStoreDeviceSettle: send.sendStoreDeviceSettle,
  readSentMarks: send.readSentMarks,
  receiptHasSettlement: send.receiptHasSettlement,
  createDeviceIo: send.createDeviceIo,
  createDeviceWatchIo: send.createDeviceWatchIo,
}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: { ...actual.env, networkEnv: 'testnet', feeReceiver: '0x428483FbA62eDCef1E3a100d3799F6d71759c560' },
  };
});
// チェーンごとに別の forwarder (どのチェーンの値で確かめ・送ったかを見分ける)。Fuji は未設定 (= 対象外)。
const fwd = vi.hoisted(() => ({
  80002: '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4',
  1001: '0x0000000000000000000000000000000000000F01',
}) as Record<number, string>);
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/forwarderConfig')>()),
  jpycForwarderFor: (chainId: number) => fwd[chainId] ?? null,
}));

import {
  STORE_DEVICE_SESSION_KEY,
  useStoreDeviceRegister,
  type StoreDeviceRegisterInput,
} from '@/hooks/useStoreDeviceRegister';

const SHOP = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const input: StoreDeviceRegisterInput = {
  enabled: true,
  gasAddress: getAddress('0x0000000000000000000000000000000000000abc'),
};
const FWD = getAddress(fwd[80002]);
const FWD_KAIROS = getAddress(fwd[1001]);
const FEE = getAddress('0x428483FbA62eDCef1E3a100d3799F6d71759c560');
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
  const io = () => ({ waitReceipt: send.waitReceipt, getReceipt: send.getReceipt });
  send.createDeviceIo.mockReset().mockImplementation(io);
  send.createDeviceWatchIo.mockReset().mockImplementation(io);
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
    // 起動時の「最近の送信」の確認 (読み込みの間は次の QR を出さない) を終えてから
    if (result.current.busy) await vi.advanceTimersByTimeAsync(0);
    s = await result.current.start(SHOP, AMOUNT, 80002);
  });
  return s;
}

describe('useStoreDeviceRegister (レジ端末: 受け渡し → 確かめて送る → 結果)', () => {
  it('切替 OFF (enabled = false) では通信も effect も起こさない', async () => {
    window.sessionStorage.setItem(STORE_DEVICE_SESSION_KEY, JSON.stringify({ id: ID, token: TOKEN, expiresAt: nowSec() + 600, merchant: SHOP, amount: '1', chainId: 80002 }));
    const { result } = renderHook(() => useStoreDeviceRegister({ ...input, enabled: false }));
    await advance(10_000);
    expect(await result.current.start(SHOP, AMOUNT, 80002)).toBeNull();
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
      expect.objectContaining({ merchant: SHOP, amount: AMOUNT, feeReceiver: FEE, forwarder: FWD }),
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

  it('起動時に最近の送信を確かめ始めるまでは、次の QR も通常の QR も出さない', async () => {
    send.readSentMarks.mockReturnValue({ ok: true, marks: [{ ...MARK, at: Date.now() - 60_000 }] });
    let releaseReceipt!: (v: unknown) => void;
    send.waitReceipt.mockReturnValueOnce(new Promise((r) => { releaseReceipt = r; }));
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    // 読み込みの前 (まだ「何もしていない」に見える間)
    expect(result.current.busy).toBe(true);
    let next!: unknown;
    let normal!: boolean;
    await act(async () => {
      next = await result.current.start(SHOP, AMOUNT, 80002);
      normal = await result.current.releaseForNormal();
    });
    expect(next).toBeNull();
    expect(normal).toBe(false);
    expect(calls).toHaveLength(0);
    await advance(0);
    expect(result.current.state).toMatchObject({ phase: 'sent', previous: true });
    await act(async () => {
      releaseReceipt({ status: 'success', logs: [] });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.busy).toBe(false);
  });

  it('送る設定を OFF にしても、「前回の送信」の結果は確かめ続ける (次の QR を出せないまま残さない)', async () => {
    send.readSentMarks.mockReturnValue({ ok: true, marks: [{ ...MARK, at: Date.now() - 60_000 }] });
    let releaseReceipt!: (v: unknown) => void;
    send.waitReceipt.mockReturnValueOnce(new Promise((r) => { releaseReceipt = r; }));
    const { result, rerender } = renderHook((p: StoreDeviceRegisterInput) => useStoreDeviceRegister(p), {
      initialProps: { ...input, monitor: true },
    });
    await advance(0);
    expect(result.current.state).toMatchObject({ phase: 'sent', previous: true });
    // ガス用ウォレットを消した (送る設定が使えなくなった)
    rerender({ ...input, monitor: true, enabled: false, gasAddress: null });
    expect(result.current.busy).toBe(true);
    await act(async () => {
      releaseReceipt({ status: 'success', logs: [] });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.state).toMatchObject({ phase: 'received', previous: true });
    expect(result.current.busy).toBe(false);
  });

  it('ガス用ウォレットが無くても (送る設定が OFF でも)、起動時に最近の送信の結果を確かめる', async () => {
    send.readSentMarks.mockReturnValue({ ok: true, marks: [{ ...MARK, at: Date.now() - 60_000 }] });
    const { result } = renderHook(() =>
      useStoreDeviceRegister({ ...input, enabled: false, gasAddress: null, monitor: true }),
    );
    await advance(0);
    expect(result.current.state).toMatchObject({ phase: 'received', previous: true });
  });

  it('前のタブのセッションの署名を送り始めたら、「前回の送信」の確認の結果でこの会計の表示を上書きしない', async () => {
    // 前回の送信 A は入金の確認まで済み (確定の確認を続けている)・前のタブのセッション B には署名が入っている
    send.readSentMarks.mockReturnValue({ ok: true, marks: [{ ...MARK, at: Date.now() - 60_000 }] });
    window.sessionStorage.setItem(
      STORE_DEVICE_SESSION_KEY,
      JSON.stringify({ id: ID, token: TOKEN, expiresAt: nowSec() + 600, merchant: SHOP, amount: AMOUNT.toString(), chainId: 80002 }),
    );
    let openClose!: () => void;
    const gate = new Promise<void>((r) => { openClose = r; });
    closeRes = () => gate.then(() => json({ ok: true, closed: false, auth: AUTH, txHash: null }));
    const HASH_B = `0x${'ef'.repeat(32)}` as Hex;
    send.sendStoreDeviceSettle.mockResolvedValue({ kind: 'sent', hash: HASH_B, mark: { ...MARK, hash: HASH_B } });
    let releaseB!: (v: unknown) => void;
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await advance(0);
    expect(result.current.state).toMatchObject({ phase: 'received', previous: true, mark: { hash: HASH } });
    send.waitReceipt.mockReturnValueOnce(new Promise((r) => { releaseB = r; }));
    await act(async () => {
      openClose();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.state).toMatchObject({ phase: 'sent', previous: false, mark: { hash: HASH_B } });
    // A の確定の確認が「確定」を返しても、B の「送信しました」を上書きしない (次の QR を出せないまま)
    resolveRes = () => json({ ok: true, state: 'settled', txHash: HASH });
    await advance(30_000);
    expect(result.current.state).toMatchObject({ phase: 'sent', mark: { hash: HASH_B } });
    expect(result.current.busy).toBe(true);
    await act(async () => {
      releaseB({ status: 'success', logs: [] });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.state).toMatchObject({ phase: 'received', previous: false, mark: { hash: HASH_B } });
  });

  it('「いま確認する」の応答を待つ間に閉じたら、遅れた結果で「次の QR を出せない」に戻さない', async () => {
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
    act(() => {
      result.current.dismiss();
    });
    await act(async () => {
      release(null);
      await checking;
    });
    expect(result.current.state).toEqual({ phase: 'idle' });
    expect(result.current.busy).toBe(false);
  });

  it('再読み込みの後の「前回の送信」も、結果が出るまで次の QR を出さない (送っている途中で再読み込みした会計)', async () => {
    send.readSentMarks.mockReturnValue({ ok: true, marks: [{ ...MARK, at: Date.now() - 60_000 }] });
    let release!: (v: unknown) => void;
    send.waitReceipt.mockReturnValueOnce(new Promise((r) => { release = r; }));
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await advance(0);
    expect(result.current.state).toMatchObject({ phase: 'sent', previous: true });
    expect(result.current.busy).toBe(true);
    expect(await started(result)).toBeNull();
    expect(calls.filter((c) => c.url === '/api/register/handoff')).toHaveLength(0);
    await act(async () => {
      release({ status: 'success', logs: [] });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.state).toMatchObject({ phase: 'received', previous: true });
    expect(result.current.busy).toBe(false);
    expect(await started(result)).toMatchObject({ id: ID });
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

  it('「前回の送信」の結果が分からないときも次の QR は出さない・取引を確かめて閉じたら出せる (遅れた確認で上書きしない)', async () => {
    send.readSentMarks.mockReturnValue({ ok: true, marks: [{ ...MARK, at: Date.now() - 60_000 }] });
    send.waitReceipt.mockResolvedValueOnce(null);
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await advance(0);
    expect(result.current.state).toMatchObject({ phase: 'unknown', previous: true });
    expect(result.current.busy).toBe(true);
    expect(await started(result)).toBeNull();
    let release!: (v: unknown) => void;
    send.getReceipt.mockReturnValueOnce(new Promise((r) => { release = r; }));
    let checking!: Promise<void>;
    act(() => {
      checking = result.current.checkNow();
    });
    act(() => {
      result.current.dismiss();
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
      next = await staleStart(SHOP, AMOUNT, 80002);
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
    await advance(0); // 起動時の確認を終える
    let a!: unknown;
    let b!: unknown;
    await act(async () => {
      [a, b] = await Promise.all([result.current.start(SHOP, AMOUNT, 80002), result.current.start(SHOP, AMOUNT, 80002)]);
    });
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(calls.filter((c) => c.url === '/api/register/handoff')).toHaveLength(1);
  });

  it('閉じた QR の締め切りと「通常の QR」の締め切りは一つの応答を共有し、分からなければ手放す (送らない)', async () => {
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await started(result);
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    // 締め切りの応答は通信断 (分からない)。分からなければもう一度だけ問い合わせ、それでも分からなければ手放す。
    closeRes = () => gate.then(() => Promise.reject(new TypeError('net')));
    act(() => {
      result.current.stop();
    });
    let releasing!: Promise<boolean>;
    act(() => {
      releasing = result.current.releaseForNormal();
    });
    expect(of('/close')).toHaveLength(1); // 閉じたときの締め切りを待つ (二本目を出さない)
    let ok!: boolean;
    await act(async () => {
      open();
      ok = await releasing;
    });
    expect(ok).toBe(true);
    expect(of('/close')).toHaveLength(2);
    expect(send.sendStoreDeviceSettle).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(STORE_DEVICE_SESSION_KEY)).toBeNull();
  });

  describe('別のタブへ移る前 (hasPendingSale → leave)', () => {
    it('何も無ければ通す必要が無い・署名待ちはある・閉じた QR が締め切れたら無くなる', async () => {
      const { result } = renderHook(() => useStoreDeviceRegister(input));
      expect(result.current.hasPendingSale()).toBe(false);
      await started(result);
      expect(result.current.hasPendingSale()).toBe(true);
      await act(async () => {
        result.current.stop();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.hasPendingSale()).toBe(false);
    });

    it('閉じた QR の締め切りの応答を待ち、署名が入っていたら端末が送って移らせない (送るのは 1 回)', async () => {
      const { result } = renderHook(() => useStoreDeviceRegister(input));
      await started(result);
      let open!: () => void;
      const gate = new Promise<void>((r) => { open = r; });
      closeRes = () => gate.then(() => json({ ok: true, closed: false, auth: AUTH, txHash: null }));
      act(() => {
        result.current.stop();
      });
      expect(result.current.hasPendingSale()).toBe(true); // 締め切りの応答待ち
      let leaving!: Promise<boolean>;
      act(() => {
        leaving = result.current.leave();
      });
      expect(result.current.busy).toBe(true); // 移る判断の間は次の QR も出させない
      let ok!: boolean;
      await act(async () => {
        open();
        ok = await leaving;
      });
      expect(ok).toBe(false);
      expect(of('/close')).toHaveLength(1);
      expect(send.sendStoreDeviceSettle).toHaveBeenCalledTimes(1);
      expect(result.current.state).toMatchObject({ phase: 'received', previous: false });
    });

    it('署名を待っている受け渡しは締め切ってから移る (署名が無ければ移ってよい)', async () => {
      const { result } = renderHook(() => useStoreDeviceRegister(input));
      await started(result);
      let ok!: boolean;
      await act(async () => {
        ok = await result.current.leave();
      });
      expect(ok).toBe(true);
      expect(of('/close')).toHaveLength(1);
      expect(result.current.state).toEqual({ phase: 'idle' });
      expect(window.sessionStorage.getItem(STORE_DEVICE_SESSION_KEY)).toBeNull();
      const readsAtLeave = reads().length;
      await advance(30_000);
      expect(reads().length).toBe(readsAtLeave); // 移った後は読まない
    });

    it('締め切りの応答が分からなければ、そのセッションは手放して移る (後から署名が届いても送らない)', async () => {
      const { result } = renderHook(() => useStoreDeviceRegister(input));
      await started(result);
      closeRes = () => Promise.reject(new TypeError('net'));
      let ok!: boolean;
      await act(async () => {
        ok = await result.current.leave();
      });
      expect(ok).toBe(true);
      expect(window.sessionStorage.getItem(STORE_DEVICE_SESSION_KEY)).toBeNull();
      expect(result.current.hasPendingSale()).toBe(false);
      // 次の会計で前のセッションを締め切り直さない (手放したので、署名が入っていても送らない)
      closeRes = () => json({ ok: true, closed: false, auth: AUTH, txHash: null });
      await started(result);
      expect(send.sendStoreDeviceSettle).not.toHaveBeenCalled();
    });

    it('「もう一度送る」で送れる署名があれば移る前に使えなくする (移った先で通常の QR で払った後に送らない)', async () => {
      send.sendStoreDeviceSettle.mockResolvedValueOnce({ kind: 'not_sent', reason: 'rpc' });
      readRes = () => json({ ok: true, state: 'signed', merchant: SHOP, amount: AMOUNT.toString(), auth: AUTH });
      const { result } = renderHook(() => useStoreDeviceRegister(input));
      await started(result);
      await advance(3_000);
      expect(result.current.state).toEqual({ phase: 'not_sent', reason: 'rpc', canRetry: true });
      expect(result.current.hasPendingSale()).toBe(true);
      let ok!: boolean;
      await act(async () => {
        ok = await result.current.leave();
      });
      expect(ok).toBe(true);
      expect(result.current.state).toEqual({ phase: 'not_sent', reason: 'rpc', canRetry: false });
      act(() => {
        result.current.retry();
      });
      await advance(0);
      expect(send.sendStoreDeviceSettle).toHaveBeenCalledTimes(1);
      expect(result.current.hasPendingSale()).toBe(false);
    });

    it('手放した後に遅れて返った読み取りの署名は送らない (締め切りの応答が分からず手放したセッション)', async () => {
      const { result } = renderHook(() => useStoreDeviceRegister(input));
      await started(result);
      let openRead!: () => void;
      const gate = new Promise<void>((r) => { openRead = r; });
      readRes = () => gate.then(() => json({ ok: true, state: 'signed', merchant: SHOP, amount: AMOUNT.toString(), auth: AUTH }));
      await advance(3_000); // 読み取りが出たまま返らない
      closeRes = () => Promise.reject(new TypeError('net'));
      let ok!: boolean;
      // 描画 (読み取りの停止) の前に、手放した後で読み取りが署名を返す
      await act(async () => {
        ok = await result.current.leave();
        openRead();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(ok).toBe(true);
      expect(send.verifyDeviceAuth).not.toHaveBeenCalled();
      expect(send.sendStoreDeviceSettle).not.toHaveBeenCalled();
    });

    it('閉じた QR の署名を送り終えた後は、最初の 1 回で移れる・次の QR も 1 回で出せる', async () => {
      const { result } = renderHook(() => useStoreDeviceRegister(input));
      await started(result);
      closeRes = () => json({ ok: true, closed: false, auth: AUTH, txHash: null });
      await act(async () => {
        result.current.stop();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.state).toMatchObject({ phase: 'received', previous: false });
      expect(result.current.hasPendingSale()).toBe(true); // 閉じたときの締め切りの結果がまだ残っている
      let ok!: boolean;
      await act(async () => {
        ok = await result.current.leave();
      });
      expect(ok).toBe(true);
      closeRes = () => json({ ok: true, closed: true });
      expect(await started(result)).toMatchObject({ id: ID });
      expect(send.sendStoreDeviceSettle).toHaveBeenCalledTimes(1);
    });

    it('送っている・この会計の結果を待っている間は移らせない (通信もしない)', async () => {
      send.waitReceipt.mockResolvedValueOnce(null);
      readRes = () => json({ ok: true, state: 'signed', merchant: SHOP, amount: AMOUNT.toString(), auth: AUTH });
      const { result } = renderHook(() => useStoreDeviceRegister(input));
      await started(result);
      await advance(3_000);
      expect(result.current.state).toMatchObject({ phase: 'unknown', previous: false });
      const before = calls.length;
      let ok!: boolean;
      await act(async () => {
        ok = await result.current.leave();
      });
      expect(ok).toBe(false);
      expect(calls.length).toBe(before);
    });
  });

  it('確かめている間に切替を OFF にしたら送らず表示を戻す・送っている間の OFF は結果まで表示と「次の QR を出せない」を保つ', async () => {
    let releaseVerify!: (v: unknown) => void;
    send.verifyDeviceAuth.mockReturnValueOnce(new Promise((r) => { releaseVerify = r; }));
    readRes = () => json({ ok: true, state: 'signed', merchant: SHOP, amount: AMOUNT.toString(), auth: AUTH });
    const first = renderHook((p: StoreDeviceRegisterInput) => useStoreDeviceRegister(p), { initialProps: input });
    await started(first.result);
    await advance(3_000);
    first.rerender({ ...input, enabled: false });
    expect(first.result.current.state).toEqual({ phase: 'processing' });
    expect(first.result.current.busy).toBe(true);
    await act(async () => {
      releaseVerify({ ok: true, value: { params: {}, signature: '0x', nonce: NONCE } });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(send.sendStoreDeviceSettle).not.toHaveBeenCalled();
    expect(first.result.current.state).toEqual({ phase: 'idle' });
    first.unmount();

    let releaseSend!: (v: unknown) => void;
    send.sendStoreDeviceSettle.mockReturnValueOnce(new Promise((r) => { releaseSend = r; }));
    const second = renderHook((p: StoreDeviceRegisterInput) => useStoreDeviceRegister(p), { initialProps: input });
    await started(second.result);
    await advance(3_000);
    second.rerender({ ...input, enabled: false });
    expect(second.result.current.busy).toBe(true);
    await act(async () => {
      releaseSend({ kind: 'sent', hash: HASH, mark: MARK });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(second.result.current.state).toMatchObject({ phase: 'received' });
  });

  it('この会計の送信の結果が分からない間は次の QR を出さない → サーバの判定で「成立しなかった」が出たら出せる', async () => {
    send.waitReceipt.mockResolvedValueOnce(null);
    readRes = () => json({ ok: true, state: 'signed', merchant: SHOP, amount: AMOUNT.toString(), auth: AUTH });
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await started(result);
    await advance(3_000);
    expect(result.current.state).toMatchObject({ phase: 'unknown', previous: false });
    expect(result.current.busy).toBe(true);
    expect(await started(result)).toBeNull();
    let ok!: boolean;
    await act(async () => {
      ok = await result.current.releaseForNormal();
    });
    expect(ok).toBe(false);
    resolveRes = () => json({ ok: true, state: 'expired_unused' });
    await advance(10_000);
    expect(result.current.state).toMatchObject({ phase: 'failed' });
    expect(result.current.busy).toBe(false);
  });

  it('結果が分からないとき、店員が取引を確かめて閉じれば次の QR を出せる', async () => {
    send.waitReceipt.mockResolvedValueOnce(null);
    readRes = () => json({ ok: true, state: 'signed', merchant: SHOP, amount: AMOUNT.toString(), auth: AUTH });
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await started(result);
    await advance(3_000);
    act(() => {
      result.current.dismiss();
    });
    expect(result.current.state).toEqual({ phase: 'idle' });
    expect(result.current.busy).toBe(false);
  });

  it('この会計の結果が分からないまま切替を OFF→ON にしても、「前回」に変えず次の QR を出さないまま', async () => {
    send.waitReceipt.mockResolvedValueOnce(null);
    send.readSentMarks.mockReturnValue({ ok: true, marks: [] });
    readRes = () => json({ ok: true, state: 'signed', merchant: SHOP, amount: AMOUNT.toString(), auth: AUTH });
    const { result, rerender } = renderHook((p: StoreDeviceRegisterInput) => useStoreDeviceRegister(p), { initialProps: input });
    await advance(0);
    await started(result);
    await advance(3_000);
    expect(result.current.state).toMatchObject({ phase: 'unknown', previous: false });
    // この送信の印が残っている (起動時の処理が「前回の送信」として拾いうる)
    send.readSentMarks.mockReturnValue({ ok: true, marks: [{ ...MARK, at: Date.now() }] });
    rerender({ ...input, enabled: false });
    rerender(input);
    await advance(0);
    expect(result.current.state).toMatchObject({ phase: 'unknown', previous: false });
    expect(result.current.busy).toBe(true);
  });

  it('QR を作っている途中で切替を OFF にしたら表示を戻し、遅れて返ったセッションは出さずに締め切る', async () => {
    let release!: (v: Response) => void;
    createRes = () => new Promise<Response>((r) => { release = r; });
    const { result, rerender } = renderHook((p: StoreDeviceRegisterInput) => useStoreDeviceRegister(p), { initialProps: input });
    await advance(0); // 起動時の確認を終える
    let starting!: Promise<unknown>;
    act(() => {
      starting = result.current.start(SHOP, AMOUNT, 80002);
    });
    await advance(0);
    expect(result.current.state).toEqual({ phase: 'creating' });
    rerender({ ...input, enabled: false });
    expect(result.current.state).toEqual({ phase: 'idle' });
    // 作成の応答を待つ間はまだ操作中 (次の QR・切替を重ねない)
    expect(result.current.busy).toBe(true);
    let created!: unknown;
    await act(async () => {
      release(new Response(JSON.stringify({ ok: true, id: ID, token: TOKEN, expiresAt: nowSec() + 600 }), { status: 200 }));
      created = await starting;
    });
    expect(created).toBeNull();
    expect(result.current.busy).toBe(false);
    expect(of('/close')).toHaveLength(1);
    expect(window.sessionStorage.getItem(STORE_DEVICE_SESSION_KEY)).toBeNull();
  });

  it('締め切りを待つ間は「通常の QR」と「次の QR」を重ねない (同じ会計で二つの QR を出さない)', async () => {
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await started(result);
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    closeRes = () => gate.then(() => json({ ok: true, closed: true }));
    act(() => {
      result.current.stop();
    });
    let releasing!: Promise<boolean>;
    act(() => {
      releasing = result.current.releaseForNormal();
    });
    expect(result.current.busy).toBe(true);
    let next!: unknown;
    await act(async () => {
      next = await result.current.start(SHOP, AMOUNT, 80002);
    });
    expect(next).toBeNull(); // 切り替えの最中は次の QR を作らない
    let ok!: boolean;
    await act(async () => {
      open();
      ok = await releasing;
    });
    expect(ok).toBe(true);
    expect(calls.filter((c) => c.url === '/api/register/handoff')).toHaveLength(1);
    expect(result.current.busy).toBe(false);
  });

  it('次の QR が前の締め切りを待つ間に切替を OFF にしたら、作らずに終える (操作できないまま残らない)', async () => {
    const { result, rerender } = renderHook((p: StoreDeviceRegisterInput) => useStoreDeviceRegister(p), { initialProps: input });
    await started(result);
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    closeRes = () => gate.then(() => json({ ok: true, closed: true }));
    act(() => {
      result.current.stop();
    });
    let starting!: Promise<unknown>;
    act(() => {
      starting = result.current.start(SHOP, AMOUNT, 80002);
    });
    rerender({ ...input, enabled: false });
    let next!: unknown;
    await act(async () => {
      open();
      next = await starting;
    });
    expect(next).toBeNull();
    expect(calls.filter((c) => c.url === '/api/register/handoff')).toHaveLength(1);
    expect(result.current.state).toEqual({ phase: 'idle' });
    expect(result.current.busy).toBe(false);
  });

  it('新しい会計に使えないチェーン (testnet で mainnet・forwarder の無い Fuji) では QR を作らない', async () => {
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await advance(0);
    for (const chainId of [137, 43113, 1]) {
      let s: unknown;
      await act(async () => {
        s = await result.current.start(SHOP, AMOUNT, chainId);
      });
      expect(s).toBeNull();
    }
    expect(calls.filter((c) => c.url === '/api/register/handoff')).toHaveLength(0);
    expect(result.current.state).toEqual({ phase: 'idle' });
  });

  it('チェーン由来の値はセッションのチェーンから引く (Kairos の会計は Kairos の forwarder で確かめて送る)', async () => {
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await advance(0);
    await act(async () => {
      await result.current.start(SHOP, AMOUNT, 1001);
    });
    expect(JSON.parse(String(calls[0].init!.body))).toEqual({ chainId: 1001, merchant: SHOP, amount: AMOUNT.toString() });
    send.sendStoreDeviceSettle.mockResolvedValue({ kind: 'sent', hash: HASH, mark: { ...MARK, chainId: 1001 } });
    readRes = () => json({ ok: true, state: 'signed', merchant: SHOP, amount: AMOUNT.toString(), auth: AUTH });
    await advance(3_000);
    expect(send.verifyDeviceAuth).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ chainId: 1001, forwarder: FWD_KAIROS, feeReceiver: FEE }),
    );
    expect(send.createDeviceIo).toHaveBeenLastCalledWith(expect.objectContaining({ chainId: 1001, forwarder: FWD_KAIROS }));
    expect(send.sendStoreDeviceSettle.mock.calls[0][1]).toMatchObject({ chainId: 1001, forwarder: FWD_KAIROS });
    expect(send.receiptHasSettlement).toHaveBeenCalledWith(expect.anything(), FWD_KAIROS, expect.anything(), FEE);
  });

  it('送った印の結果は印のチェーンで確かめる (いまの設定のチェーンに関係なく)', async () => {
    send.readSentMarks.mockReturnValue({ ok: true, marks: [{ ...MARK, chainId: 1001, at: Date.now() - 60_000 }] });
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await advance(0);
    expect(send.createDeviceWatchIo).toHaveBeenCalledWith(1001);
    expect(send.receiptHasSettlement).toHaveBeenCalledWith(expect.anything(), FWD_KAIROS, expect.anything(), FEE);
    expect(result.current.state).toMatchObject({ phase: 'received', previous: true });
  });

  it('再読み込み後: 最近送った印があれば、その結果を「前回の送信」として出す', async () => {
    send.readSentMarks.mockReturnValue({ ok: true, marks: [{ ...MARK, at: Date.now() - 60_000 }] });
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await advance(0);
    expect(send.waitReceipt).toHaveBeenCalledWith(HASH, expect.any(Number));
    expect(result.current.state).toMatchObject({ phase: 'received', previous: true });
  });
});

// 第 7 回全コードベースレビュー A3・A11・A12 (G8)。
describe('useStoreDeviceRegister: 店の tx の revert・判定が返す tx・店側の処理の例外', () => {
  const HASH_B = `0x${'ef'.repeat(32)}` as Hex;
  const signed = () => json({ ok: true, state: 'signed', merchant: SHOP, amount: AMOUNT.toString(), auth: AUTH });

  it('A3: 店の tx が revert しても、すぐ「行われていません」と言わず判定を 1 回引く → 別の tx で成立していれば入金の確認 (実際の tx)', async () => {
    send.waitReceipt.mockResolvedValueOnce({ status: 'reverted', logs: [] });
    let openResolve!: () => void;
    const gate = new Promise<void>((r) => { openResolve = r; });
    resolveRes = () => gate.then(() => json({ ok: true, state: 'settled', txHash: HASH_B }));
    readRes = signed;
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await started(result);
    await advance(3_000);
    // 判定を待つ間は「送信しました」のまま (次の QR を出せない)
    expect(result.current.state).toMatchObject({ phase: 'sent', mark: { hash: HASH } });
    expect(result.current.busy).toBe(true);
    expect(of('/resolve')).toHaveLength(1);
    expect(JSON.parse(String(of('/resolve')[0].init!.body))).toMatchObject({
      chainId: 80002,
      nonce: NONCE,
      txHash: HASH,
      merchantValue: AMOUNT.toString(),
      forwarder: FWD,
      feeReceiver: FEE,
    });
    await act(async () => {
      openResolve();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.state).toMatchObject({
      phase: 'received',
      finalized: true,
      previous: false,
      mark: { hash: HASH },
      txHash: HASH_B,
    });
    expect(result.current.busy).toBe(false);
    // 1 回だけ (確定済みの結論なので追いかけない)
    await advance(60_000);
    expect(of('/resolve')).toHaveLength(1);
  });

  it.each([
    ['確認中 (pending・確定待ちを含む)', () => json({ ok: true, state: 'pending', confirming: true })],
    ['期限切れ・未使用', () => json({ ok: true, state: 'expired_unused' })],
    ['成立だが tx hash が読めない応答', () => json({ ok: true, state: 'settled', txHash: 'nope' })],
    ['判定を引けない (503)', () => json({ ok: false, error: 'unavailable' }, 503)],
    ['通信断', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('A3: revert の後の判定が %s なら、従来どおり reverted (追いかけない)', async (_label, res) => {
    send.waitReceipt.mockResolvedValueOnce({ status: 'reverted', logs: [] });
    resolveRes = res as () => Promise<Response>;
    readRes = signed;
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await started(result);
    await advance(3_000);
    expect(result.current.state).toEqual({ phase: 'reverted', mark: MARK, previous: false });
    expect(result.current.busy).toBe(false);
    expect(of('/resolve')).toHaveLength(1);
    await advance(60_000);
    expect(of('/resolve')).toHaveLength(1);
  });

  it('A3: 判定の応答が返らなくても「送信しました」のまま止めない (上限の後は reverted)', async () => {
    send.waitReceipt.mockResolvedValueOnce({ status: 'reverted', logs: [] });
    resolveRes = () => new Promise<Response>(() => {});
    readRes = signed;
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await started(result);
    await advance(3_000);
    expect(result.current.state).toMatchObject({ phase: 'sent' });
    await advance(30_000);
    expect(result.current.state).toEqual({ phase: 'reverted', mark: MARK, previous: false });
    expect(result.current.busy).toBe(false);
  });

  it('A3: 再読み込みの後の「前回の送信」が revert でも、判定で成立していれば入金の確認 (前回の送信・実際の tx)', async () => {
    send.readSentMarks.mockReturnValue({ ok: true, marks: [{ ...MARK, at: Date.now() - 60_000 }] });
    send.waitReceipt.mockResolvedValueOnce({ status: 'reverted', logs: [] });
    resolveRes = () => json({ ok: true, state: 'settled', txHash: HASH_B });
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await advance(0);
    expect(result.current.state).toMatchObject({ phase: 'received', previous: true, finalized: true, txHash: HASH_B });
  });

  it('A3:「いま確認する」で revert を読んだときも判定を引き、成立していれば入金の確認', async () => {
    send.waitReceipt.mockResolvedValueOnce(null);
    readRes = signed;
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await started(result);
    await advance(3_000);
    expect(result.current.state).toMatchObject({ phase: 'unknown' });
    send.getReceipt.mockResolvedValueOnce({ status: 'reverted', logs: [] });
    resolveRes = () => json({ ok: true, state: 'settled', txHash: HASH_B });
    await act(async () => {
      await result.current.checkNow();
    });
    expect(result.current.state).toMatchObject({ phase: 'received', finalized: true, txHash: HASH_B });
  });

  it('A3: 判定を待つ間に閉じた (前回の送信) なら、遅れた判定で表示を戻さない', async () => {
    send.readSentMarks.mockReturnValue({ ok: true, marks: [{ ...MARK, at: Date.now() - 60_000 }] });
    send.waitReceipt.mockResolvedValueOnce({ status: 'reverted', logs: [] });
    let openResolve!: () => void;
    const gate = new Promise<void>((r) => { openResolve = r; });
    resolveRes = () => gate.then(() => json({ ok: true, state: 'settled', txHash: HASH_B }));
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await advance(0);
    expect(result.current.state).toMatchObject({ phase: 'sent', previous: true });
    act(() => {
      result.current.dismiss();
    });
    await act(async () => {
      openResolve();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.state).toEqual({ phase: 'idle' });
  });

  it('A11: 結果が分からない送信を判定が「成立」で返したら、判定が見つけた tx (実際に成立した tx) を持つ', async () => {
    send.waitReceipt.mockResolvedValueOnce(null);
    readRes = signed;
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await started(result);
    await advance(3_000);
    expect(result.current.state).toMatchObject({ phase: 'unknown' });
    resolveRes = () => json({ ok: true, state: 'settled', txHash: HASH_B });
    await advance(10_000);
    expect(result.current.state).toMatchObject({ phase: 'received', finalized: true, mark: { hash: HASH }, txHash: HASH_B });
  });

  it('A12: 送信の部品の読み込み (loadIo) に失敗しても「確かめて送っています」のまま止めない → 送っていない (もう一度送れる)', async () => {
    // loadIo の失敗 (chunk の読み込み失敗 = 通信断・新しい版の配信後の古い chunk と同じく、await loadIo が reject する)
    send.createDeviceIo.mockImplementationOnce(() => {
      throw new Error('Failed to fetch dynamically imported module');
    });
    readRes = signed;
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await started(result);
    await advance(3_000);
    expect(result.current.state).toEqual({ phase: 'not_sent', reason: 'rpc', canRetry: true });
    expect(result.current.busy).toBe(false);
    expect(send.sendStoreDeviceSettle).not.toHaveBeenCalled();
    await act(async () => {
      result.current.retry();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(send.sendStoreDeviceSettle).toHaveBeenCalledTimes(1);
    expect(result.current.state).toMatchObject({ phase: 'received' });
  });

  it('A12: 署名の確認の途中の例外も送っていない (not_sent)', async () => {
    send.verifyDeviceAuth.mockRejectedValueOnce(new RangeError('boom'));
    readRes = signed;
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await started(result);
    await advance(3_000);
    expect(result.current.state).toEqual({ phase: 'not_sent', reason: 'rpc', canRetry: true });
    expect(send.sendStoreDeviceSettle).not.toHaveBeenCalled();
  });

  it('A12: 送信の中の例外 — 送った印が無ければ送っていない (not_sent)', async () => {
    send.sendStoreDeviceSettle.mockRejectedValueOnce(new Error('boom'));
    send.readSentMarks.mockReturnValue({ ok: true, marks: [] });
    readRes = signed;
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await started(result);
    await advance(3_000);
    expect(result.current.state).toEqual({ phase: 'not_sent', reason: 'rpc', canRetry: true });
    expect(result.current.busy).toBe(false);
  });

  it('A12: 送信の中の例外 — 送った印があれば「送っていない」と言わず、結果が分からない (unknown) として判定を待つ', async () => {
    send.sendStoreDeviceSettle.mockRejectedValueOnce(new Error('boom'));
    readRes = signed;
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await started(result);
    await advance(3_000);
    expect(result.current.state).toEqual({ phase: 'unknown', mark: MARK, previous: false });
    expect(result.current.busy).toBe(true);
    resolveRes = () => json({ ok: true, state: 'settled', txHash: HASH });
    await advance(10_000);
    expect(result.current.state).toMatchObject({ phase: 'received', finalized: true });
  });

  it('A12: 送った後の例外 (結果の確認の失敗) も「送っていない」と言わない (unknown)', async () => {
    send.waitReceipt.mockRejectedValueOnce(new Error('boom'));
    readRes = signed;
    const { result } = renderHook(() => useStoreDeviceRegister(input));
    await started(result);
    await advance(3_000);
    expect(result.current.state).toEqual({ phase: 'unknown', mark: MARK, previous: false });
    expect(result.current.busy).toBe(true);
  });
});
