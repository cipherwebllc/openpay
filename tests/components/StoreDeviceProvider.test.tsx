import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { getAddress, type Hex } from 'viem';

// 本物の useStoreDeviceRegister を Provider の中で動かし、送信 (lib/storeDeviceSend) と通信 (fetch) だけを差し替える。
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
  createDeviceWatchIo: () => ({ waitReceipt: send.waitReceipt, getReceipt: send.getReceipt }),
}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      networkEnv: 'testnet',
      enableStoreGasWallet: true,
      feeReceiver: '0x428483FbA62eDCef1E3a100d3799F6d71759c560',
    },
  };
});
const wallet = vi.hoisted(() => ({ address: null as string | null, loads: 0 }));
vi.mock('@/lib/storeGasWallet', () => ({
  loadStoreGasWallet: () => {
    wallet.loads += 1;
    return wallet.address ? { state: 'ok', info: { address: wallet.address, createdAt: 1 } } : { state: 'none' };
  },
}));
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/forwarderConfig')>()),
  jpycForwarderFor: () => '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4',
}));

import { StoreDeviceProvider, useStoreDeviceMode } from '@/components/StoreDeviceProvider';

const SHOP = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const GAS = getAddress('0x0000000000000000000000000000000000000abc');
const AMOUNT = 1000n * 10n ** 18n;
const ID = 'AbCdEfGhIjKlMnOpQrStUv';
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

let urls: string[];
let readRes: () => Promise<Response>;
const json = (body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
const nowSec = () => Math.floor(Date.now() / 1000);
const reads = () => urls.filter((u) => u === `/api/register/handoff/${ID}`);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(new Date('2026-10-07T03:00:00Z'));
  window.sessionStorage.clear();
  Object.defineProperty(window.navigator, 'locks', { value: { request: vi.fn() }, configurable: true });
  urls = [];
  wallet.address = null;
  wallet.loads = 0;
  readRes = () => json({ ok: true, state: 'open', merchant: SHOP, amount: AMOUNT.toString(), auth: null });
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    urls.push(url);
    if (url === '/api/register/handoff') return json({ ok: true, id: ID, token: 'ab'.repeat(32), expiresAt: nowSec() + 600 });
    if (url.endsWith('/close')) return json({ ok: true, closed: true });
    if (url.endsWith('/tx')) return json({ ok: true, txHash: HASH });
    if (url.endsWith('/resolve')) return json({ ok: true, state: 'pending' });
    return readRes();
  }));
  send.verifyDeviceAuth.mockReset().mockResolvedValue({ ok: true, value: { params: {}, signature: '0x', nonce: NONCE } });
  send.sendStoreDeviceSettle.mockReset().mockResolvedValue({ kind: 'sent', hash: HASH, mark: MARK });
  send.readSentMarks.mockReset().mockReturnValue({ ok: true, marks: [] });
  send.receiptHasSettlement.mockReset().mockReturnValue(true);
  send.waitReceipt.mockReset().mockResolvedValue({ status: 'success', logs: [] });
  send.getReceipt.mockReset().mockResolvedValue({ status: 'success', logs: [] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** レジ役: お店負担を選んでいると知らせ、ガス用ウォレットを知らせ (reportGas のときだけ)、QR を出す。 */
function Register({ reportGas = true }: { reportGas?: boolean }) {
  const mode = useStoreDeviceMode();
  useEffect(() => {
    mode.setOn(true);
    if (reportGas) mode.setGasAddress(GAS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <p data-testid="phase">{`register:${mode.device.state.phase}:${String(mode.enabled)}`}</p>
      <button type="button" onClick={() => void mode.device.start(SHOP, AMOUNT)}>
        start
      </button>
    </>
  );
}
function Other() {
  const mode = useStoreDeviceMode();
  return <p data-testid="phase">{`other:${mode.device.state.phase}`}</p>;
}

/** 作成ページのタブ役: key で部品を本当に外して付け直す。 */
function Tabs() {
  const [tab, setTab] = useState<'register' | 'other' | 'register2'>('register');
  return (
    <>
      <button type="button" onClick={() => setTab('other')}>to-other</button>
      <button type="button" onClick={() => setTab('register2')}>to-register-again</button>
      {tab === 'register' && <Register key="register" />}
      {tab === 'other' && <Other key="other" />}
      {/* 付け直したレジはウォレットを知らせない (パネルの読み込み前) */}
      {tab === 'register2' && <Register key="register2" reportGas={false} />}
    </>
  );
}

describe('StoreDeviceProvider (お店の端末で送るの状態を作成ページの両タブの外に 1 つ・本物の hook)', () => {
  it('送っている途中でタブの部品が外れても、送信は 1 回だけ・結果は付け直した部品に出る・読み取りは 1 本', async () => {
    let releaseVerify!: (v: unknown) => void;
    send.verifyDeviceAuth.mockReturnValueOnce(new Promise((r) => { releaseVerify = r; }));
    render(
      <StoreDeviceProvider>
        <Tabs />
      </StoreDeviceProvider>,
    );
    await advance(0);
    expect(screen.getByTestId('phase').textContent).toBe('register:idle:true');
    await act(async () => {
      screen.getByRole('button', { name: 'start' }).click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('phase').textContent).toBe('register:waiting:true');
    await advance(9_000);
    expect(reads()).toHaveLength(3); // 3 秒おきの 1 本 (部品ごとに読まない)
    readRes = () => json({ ok: true, state: 'signed', merchant: SHOP, amount: AMOUNT.toString(), auth: AUTH });
    await advance(3_000);
    expect(screen.getByTestId('phase').textContent).toBe('register:processing:true');
    // 確かめている途中で別のタブへ (部品が外れる)
    await act(async () => {
      screen.getByRole('button', { name: 'to-other' }).click();
    });
    expect(screen.getByTestId('phase').textContent).toBe('other:processing');
    await act(async () => {
      releaseVerify({ ok: true, value: { params: {}, signature: '0x', nonce: NONCE } });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('phase').textContent).toBe('other:received');
    // レジに戻る (付け直した部品はまだウォレットを知らせない) → 結果は消えない・二度送らない
    await act(async () => {
      screen.getByRole('button', { name: 'to-register-again' }).click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('phase').textContent).toBe('register:received:true');
    await advance(30_000);
    expect(send.sendStoreDeviceSettle).toHaveBeenCalledTimes(1);
    expect(urls.filter((u) => u.endsWith('/tx'))).toHaveLength(1);
  });

  it('レジのパネルを開いていないタブで再読み込みしても、ウォレットを自分で読み、送った支払いの結果の確認を始める (次の QR を出させない)', async () => {
    wallet.address = GAS;
    send.readSentMarks.mockReturnValue({ ok: true, marks: [{ ...MARK, at: Date.now() - 60_000 }] });
    let release!: (v: unknown) => void;
    send.waitReceipt.mockReturnValueOnce(new Promise((r) => { release = r; }));
    function Watch() {
      const mode = useStoreDeviceMode();
      return <p data-testid="phase">{`${mode.device.state.phase}:${String(mode.device.busy)}`}</p>;
    }
    render(
      <StoreDeviceProvider>
        <Watch />
      </StoreDeviceProvider>,
    );
    await advance(0);
    await advance(0);
    expect(screen.getByTestId('phase').textContent).toBe('sent:true');
    await act(async () => {
      release({ status: 'success', logs: [] });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('phase').textContent).toBe('received:false');
  });

  it('Provider の中の部品側の実体は動かない (ウォレットを読まない・通信しない)', async () => {
    render(
      <StoreDeviceProvider>
        <Other />
      </StoreDeviceProvider>,
    );
    await advance(0);
    expect(wallet.loads).toBe(1); // Provider の 1 回だけ
  });

  it('Provider の外 (単独の描画) では、部品が自分の実体で動く (今までと同じ)', async () => {
    render(<Register />);
    await advance(0);
    expect(screen.getByTestId('phase').textContent).toBe('register:idle:true');
    await act(async () => {
      screen.getByRole('button', { name: 'start' }).click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('phase').textContent).toBe('register:waiting:true');
  });
});
