import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { getAddress, type Hex } from 'viem';
import { renderWithIntl } from '../_helpers/i18n';

// 履歴の書き手 (lib/storeDeviceSaleHistory の dynamic import) そのものを読み込めない (配信の入れ替え・通信断) ときも、
// お店の端末で送る の送信・入金の確認・表示は今までどおり。動的 import を失敗させるため、この file では module の mock
// 自体が throw する (tests/hooks/useStoreDeviceRegister.marksModuleFailure.test.tsx と同じやり方)。
vi.mock('@/lib/storeDeviceSaleHistory', () => {
  throw new Error('Failed to fetch dynamically imported module');
});
const send = vi.hoisted(() => ({
  verifyDeviceAuth: vi.fn(),
  sendStoreDeviceSettle: vi.fn(),
  waitReceipt: vi.fn(),
}));
vi.mock('@/lib/storeDeviceSend', () => ({
  verifyDeviceAuth: send.verifyDeviceAuth,
  sendStoreDeviceSettle: send.sendStoreDeviceSettle,
  readSentMarks: () => ({ ok: true, marks: [] }),
  receiptHasSettlement: () => true,
  createDeviceIo: () => ({ waitReceipt: send.waitReceipt, getReceipt: send.waitReceipt }),
  createDeviceWatchIo: () => ({ waitReceipt: send.waitReceipt, getReceipt: send.waitReceipt }),
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
vi.mock('@/lib/storeGasWallet', () => ({
  loadStoreGasWallet: () => ({ state: 'ok', info: { address: '0x0000000000000000000000000000000000000abc', createdAt: 1 } }),
}));
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/forwarderConfig')>()),
  jpycForwarderFor: () => '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4',
}));

import { StoreDeviceProvider, useStoreDeviceMode } from '@/components/StoreDeviceProvider';
import { StoreDeviceRegisterStatus } from '@/components/StoreDeviceRegisterStatus';
import { loadHistory } from '@/lib/history';
import { logger } from '@/lib/logger';
import { formatStoreDeviceAmount } from '@/lib/storeDevicePayment';

const SHOP = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const GAS = getAddress('0x0000000000000000000000000000000000000abc');
const PAYER = getAddress('0x0000000000000000000000000000000000000def');
const AMOUNT = 1000n * 10n ** 18n;
const ID = 'AbCdEfGhIjKlMnOpQrStUv';
const HASH = `0x${'cd'.repeat(32)}` as Hex;
const NONCE = `0x${'33'.repeat(32)}` as Hex;
const AUTH = {
  from: PAYER,
  merchantValue: AMOUNT.toString(),
  feeValue: '1',
  validAfter: '0',
  validBefore: '9999999999',
  intentSalt: `0x${'11'.repeat(32)}`,
  signature: `0x${'1b'.repeat(65)}`,
  nonce: NONCE,
};
const MARK = {
  handoffId: ID, chainId: 80002, nonce: NONCE, hash: HASH, from: PAYER, merchant: SHOP,
  amount: AMOUNT.toString(), validBefore: AUTH.validBefore, intentSalt: AUTH.intentSalt, at: 0,
};

let readRes: () => Promise<Response>;
const json = (body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
const nowSec = () => Math.floor(Date.now() / 1000);
// 失敗する読み込みを先に 1 回済ませておく (テストの中の dynamic import が、すぐ reject で返る)。
beforeAll(async () => {
  await import('@/lib/storeDeviceSaleHistory').catch(() => undefined);
});
let warn: ReturnType<typeof vi.spyOn>;
let unhandled: unknown[];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(new Date('2026-11-16T03:00:00Z'));
  window.localStorage.clear();
  window.sessionStorage.clear();
  Object.defineProperty(window.navigator, 'locks', { value: { request: vi.fn() }, configurable: true });
  readRes = () => json({ ok: true, state: 'open', merchant: SHOP, amount: AMOUNT.toString(), auth: null });
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url === '/api/register/handoff') return json({ ok: true, id: ID, token: 'ab'.repeat(32), expiresAt: nowSec() + 600 });
    if (url.endsWith('/close')) return json({ ok: true, closed: true });
    if (url.endsWith('/tx')) return json({ ok: true, txHash: HASH });
    if (url.endsWith('/resolve')) return json({ ok: true, state: 'settled', txHash: HASH });
    return readRes();
  }));
  send.verifyDeviceAuth.mockReset().mockResolvedValue({ ok: true, value: { params: {}, signature: '0x', nonce: NONCE } });
  send.sendStoreDeviceSettle.mockReset().mockResolvedValue({ kind: 'sent', hash: HASH, mark: MARK });
  send.waitReceipt.mockReset().mockResolvedValue({ status: 'success', logs: [] });
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
});
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.dynamicImportSettled().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
  });
}

function Register() {
  const mode = useStoreDeviceMode();
  useEffect(() => {
    mode.setOn(true);
    mode.setGasAddress(GAS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <p data-testid="phase">{`${mode.device.state.phase}:${String(mode.device.busy)}`}</p>
      <div data-testid="status">
        <StoreDeviceRegisterStatus
          state={mode.device.state}
          formatAmount={formatStoreDeviceAmount}
          onCheckNow={() => void mode.device.checkNow()}
          onDismiss={mode.device.dismiss}
        />
      </div>
      <button type="button" onClick={() => void mode.device.start(SHOP, AMOUNT, 80002)}>
        start
      </button>
    </>
  );
}

describe('StoreDeviceProvider × お店の取引履歴: 書き手を読み込めないとき', () => {
  it('送信・入金の確認・確定・閉じる操作は今までどおり (履歴は空・警告は 1 回・未処理の reject なし)', async () => {
    renderWithIntl(
      <StoreDeviceProvider>
        <Register />
      </StoreDeviceProvider>,
    );
    await advance(0);
    await act(async () => {
      screen.getByRole('button', { name: 'start' }).click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('phase').textContent).toBe('waiting:false');
    readRes = () => json({ ok: true, state: 'signed', merchant: SHOP, amount: AMOUNT.toString(), auth: AUTH });
    await advance(3_000);
    expect(screen.getByTestId('phase').textContent).toBe('received:false');
    expect(screen.getByTestId('status').textContent).toMatch(/入金を確認しました/);
    expect(send.sendStoreDeviceSettle).toHaveBeenCalledTimes(1);
    // 確定の確認 (サーバの判定) も続く
    await advance(10_000);
    expect(screen.getByTestId('phase').textContent).toBe('received:false');
    expect(loadHistory()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'storeDevice.saleHistory.not-written',
      expect.objectContaining({ chainId: 80002, error: expect.any(Error) }),
    );
    await act(async () => {
      screen.getByRole('button', { name: /閉じる/ }).click();
    });
    expect(screen.getByTestId('phase').textContent).toBe('idle:false');
    // 本物の時計で 1 回待ってから (処理されなかった reject は、次の macrotask で届く)。
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 0));
    expect(unhandled).toEqual([]);
  });
});
