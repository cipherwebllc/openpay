import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { getAddress, type Hex } from 'viem';
import { renderWithIntl } from '../_helpers/i18n';

// 本物の StoreDeviceProvider + useStoreDeviceRegister + 履歴の書き手を動かし、送信 (lib/storeDeviceSend) と通信 (fetch)
// だけを差し替える。入金を確かめた支払いが、お店の取引履歴 (localStorage) に 1 行になること・履歴の失敗が、お店の端末で
// 送る の状態と表示を変えないことを確かめる。
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
vi.mock('@/lib/storeGasWallet', () => ({
  loadStoreGasWallet: () => ({ state: 'ok', info: { address: '0x0000000000000000000000000000000000000abc', createdAt: 1 } }),
}));
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/forwarderConfig')>()),
  jpycForwarderFor: () => '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4',
}));
// 書き手は本物。失敗 (throw) を差し込めるようにだけ包む。
const writer = vi.hoisted(() => ({ calls: 0, fail: false }));
vi.mock('@/lib/storeDeviceSaleHistory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/storeDeviceSaleHistory')>();
  return {
    ...actual,
    recordStoreDeviceSale: (...args: Parameters<typeof actual.recordStoreDeviceSale>) => {
      writer.calls += 1;
      if (writer.fail) throw new Error('history write failed');
      return actual.recordStoreDeviceSale(...args);
    },
  };
});

import { StoreDeviceProvider, useStoreDeviceMode } from '@/components/StoreDeviceProvider';
import { StoreDeviceRegisterStatus } from '@/components/StoreDeviceRegisterStatus';
import { loadHistory } from '@/lib/history';
import { logger } from '@/lib/logger';
import { formatStoreDeviceAmount } from '@/lib/storeDevicePayment';
import { STORE_DEVICE_SALE_SNAPSHOT_KEY, saveStoreDeviceSaleSnapshot } from '@/lib/storeDeviceSaleSnapshot';
import type { CheckoutParams } from '@/lib/url';

const SHOP = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const GAS = getAddress('0x0000000000000000000000000000000000000abc');
const PAYER = getAddress('0x0000000000000000000000000000000000000def');
const AMOUNT = 1000n * 10n ** 18n;
const ID = 'AbCdEfGhIjKlMnOpQrStUv';
const HASH = `0x${'cd'.repeat(32)}` as Hex;
const SETTLED_HASH = `0x${'ef'.repeat(32)}` as Hex;
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
const NOW = new Date('2026-11-16T03:00:00Z').getTime();
const MARK = {
  handoffId: ID, chainId: 80002, nonce: NONCE, hash: HASH, from: PAYER, merchant: SHOP,
  amount: AMOUNT.toString(), validBefore: AUTH.validBefore, intentSalt: AUTH.intentSalt, at: NOW,
};
// QR を出した時点の会計 (カフェラテ 500 × 2 = 1,000)。
const checkout: CheckoutParams = {
  to: SHOP,
  token: 'jpyc',
  chain: 'polygon',
  gas: 'merchant',
  mode: 'gasless',
  items: [{ name: 'カフェラテ', qty: 2, price: '500' }],
  receiptNo: 'R-0012',
  submit: 'store',
};

let readRes: () => Promise<Response>;
let resolveRes: () => Promise<Response>;
const json = (body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
const nowSec = () => Math.floor(Date.now() / 1000);

// 書き手の module を先に読み込んでおく (各テストの中の dynamic import が、module の変換を待たずにすぐ解決する =
// 負荷の高い full run でも、前のテストの読み込みが次のテストへずれ込まない)。
beforeAll(async () => {
  await import('@/lib/storeDeviceSaleHistory');
});
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(new Date(NOW));
  window.localStorage.clear();
  window.sessionStorage.clear();
  Object.defineProperty(window.navigator, 'locks', { value: { request: vi.fn() }, configurable: true });
  writer.calls = 0;
  writer.fail = false;
  readRes = () => json({ ok: true, state: 'open', merchant: SHOP, amount: AMOUNT.toString(), auth: null });
  resolveRes = () => json({ ok: true, state: 'pending' });
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url === '/api/register/handoff') return json({ ok: true, id: ID, token: 'ab'.repeat(32), expiresAt: nowSec() + 600 });
    if (url.endsWith('/close')) return json({ ok: true, closed: true });
    if (url.endsWith('/tx')) return json({ ok: true, txHash: HASH });
    if (url.endsWith('/resolve')) return resolveRes();
    return readRes();
  }));
  send.verifyDeviceAuth.mockReset().mockResolvedValue({ ok: true, value: { params: {}, signature: '0x', nonce: NONCE } });
  send.sendStoreDeviceSettle.mockReset().mockResolvedValue({ kind: 'sent', hash: HASH, mark: MARK });
  send.readSentMarks.mockReset().mockReturnValue({ ok: true, marks: [] });
  send.receiptHasSettlement.mockReset().mockReturnValue(true);
  send.waitReceipt.mockReset().mockResolvedValue({ status: 'success', logs: [] });
  send.getReceipt.mockReset().mockResolvedValue({ status: 'success', logs: [] });
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** 時間を進め、書き手の読み込み (dynamic import) とその後の書き込みまで待つ。 */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** レジ役: お店負担を選び、QR を出すときに会計を写す (components/RegisterMode.tsx の openStoreQr と同じ順)。 */
function Register({ cart = checkout }: { cart?: CheckoutParams }) {
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
      <button
        type="button"
        onClick={() =>
          void mode.device.start(SHOP, AMOUNT, 80002).then((s) => {
            if (s) saveStoreDeviceSaleSnapshot(s.id, cart);
          })
        }
      >
        start
      </button>
    </>
  );
}
const mount = (cart?: CheckoutParams) =>
  renderWithIntl(
    <StoreDeviceProvider>
      <Register {...(cart ? { cart } : {})} />
    </StoreDeviceProvider>,
  );
const shown = () => `${screen.getByTestId('phase').textContent} | ${screen.getByTestId('status').textContent}`;

/** QR を出し、お客様の署名が届いて端末が送り、結果が出て、確定の確認が 1 回終わるまで。各時点の状態と表示を返す。 */
async function sale(): Promise<string[]> {
  const seen: string[] = [];
  await advance(0);
  seen.push(shown());
  await act(async () => {
    screen.getByRole('button', { name: 'start' }).click();
    await vi.advanceTimersByTimeAsync(0);
  });
  seen.push(shown());
  readRes = () => json({ ok: true, state: 'signed', merchant: SHOP, amount: AMOUNT.toString(), auth: AUTH });
  await advance(3_000);
  seen.push(shown());
  await advance(10_000);
  seen.push(shown());
  return seen;
}

describe('StoreDeviceProvider × お店の取引履歴 (お店の端末で送る の入金を 1 行)', () => {
  it('入金を確かめたら 1 行 (QR を出した時点の会計の明細つき)・確定の確認の後も、閉じた後も 1 行', async () => {
    resolveRes = () => json({ ok: true, state: 'settled', txHash: HASH });
    mount();
    const seen = await sale();
    expect(seen[2]).toMatch(/^received:false \| .*入金を確認しました/);
    expect(seen[3]).toMatch(/^received:false \| /);
    const rows = loadHistory();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: `batch-${HASH}`,
      flow: 'batch',
      status: 'success',
      merchant: SHOP,
      merchantAmount: AMOUNT.toString(),
      customer: PAYER,
      feeAmount: '1',
      gasMode: 'merchant',
      txHash: HASH,
      receiptNo: 'R-0012',
      productName: 'カフェラテ',
    });
    expect(rows[0].lineItems).toEqual([expect.objectContaining({ name: 'カフェラテ', quantity: 2, amount: '1000' })]);
    await act(async () => {
      screen.getByRole('button', { name: /閉じる/ }).click();
    });
    await advance(0);
    expect(screen.getByTestId('phase').textContent).toBe('idle:false');
    expect(loadHistory()).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('結果が分からない間は書かない → サーバの判定で入金を確かめたら、成立した tx で 1 行', async () => {
    // receipt を読めない (時間切れ) → 結果が分からない
    send.waitReceipt.mockResolvedValue(null);
    mount();
    await advance(0);
    await act(async () => {
      screen.getByRole('button', { name: 'start' }).click();
      await vi.advanceTimersByTimeAsync(0);
    });
    readRes = () => json({ ok: true, state: 'signed', merchant: SHOP, amount: AMOUNT.toString(), auth: AUTH });
    await advance(3_000);
    expect(screen.getByTestId('phase').textContent).toBe('unknown:true');
    await advance(25_000);
    expect(screen.getByTestId('phase').textContent).toBe('unknown:true');
    expect(loadHistory()).toEqual([]);
    expect(writer.calls).toBe(0);
    // 判定が、この支払いの成立 (別の tx) を見つけた
    resolveRes = () => json({ ok: true, state: 'settled', txHash: SETTLED_HASH });
    await advance(10_000);
    expect(screen.getByTestId('phase').textContent).toBe('received:false');
    const rows = loadHistory();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: `batch-${SETTLED_HASH}`, txHash: SETTLED_HASH, receiptNo: 'R-0012' });
  });

  // 写しの期限 (60 分) は読むときにも効く: QR を出す → 送る → receipt を読めず「結果が分からない」→ 次の写しの保存なしで
  // 時間が過ぎる → 「いま確認する」で入金の確認。60 分を過ぎた (ちょうど 60 分を含む) 写しは使わず、明細なしの行。
  it.each([
    ['60 分の直前 (写しを使う)', 60 * 60_000 - 1, true],
    ['ちょうど 60 分 (写しを使わない)', 60 * 60_000, false],
    ['61 分 (写しを使わない)', 61 * 60_000, false],
  ])('結果が分からないまま QR から %s で「いま確認する」→ 入金の確認', async (_label, elapsed, withSnapshot) => {
    send.waitReceipt.mockResolvedValue(null);
    mount();
    await advance(0);
    await act(async () => {
      screen.getByRole('button', { name: 'start' }).click();
      await vi.advanceTimersByTimeAsync(0);
    });
    const savedAt = (JSON.parse(window.sessionStorage.getItem(STORE_DEVICE_SALE_SNAPSHOT_KEY) ?? '[]') as { at: number }[])
      .map((s) => s.at);
    expect(savedAt).toEqual([NOW]);
    readRes = () => json({ ok: true, state: 'signed', merchant: SHOP, amount: AMOUNT.toString(), auth: AUTH });
    await advance(3_000);
    expect(screen.getByTestId('phase').textContent).toBe('unknown:true');
    // 自動の確認 (最長 15 分) が終わった後も、結論が出ないまま QR を出した時点から elapsed まで (次の保存なし)
    await advance(NOW + elapsed - Date.now());
    expect(Date.now()).toBe(NOW + elapsed);
    expect(screen.getByTestId('phase').textContent).toBe('unknown:true');
    expect(writer.calls).toBe(0);
    expect(loadHistory()).toEqual([]);
    await act(async () => {
      screen.getByRole('button', { name: 'いま確認する' }).click();
      await vi.advanceTimersByTimeAsync(0);
    });
    await advance(0);
    expect(Date.now()).toBe(NOW + elapsed);
    expect(screen.getByTestId('phase').textContent).toBe('received:false');
    expect(writer.calls).toBe(1);
    const rows = loadHistory();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: `batch-${HASH}`, merchantAmount: AMOUNT.toString(), customer: PAYER, txHash: HASH });
    if (withSnapshot) {
      expect(rows[0]).toMatchObject({ receiptNo: 'R-0012', productName: 'カフェラテ' });
      expect(rows[0].lineItems).toEqual([expect.objectContaining({ name: 'カフェラテ', quantity: 2, amount: '1000' })]);
    } else {
      expect(rows[0]).toMatchObject({ receiptNo: null, productName: null, lineItems: null, memo: null, taxRate: null });
    }
  });

  it('成立しなかった (期限切れ・未使用) 支払いは書かない', async () => {
    send.waitReceipt.mockResolvedValue(null);
    resolveRes = () => json({ ok: true, state: 'expired_unused' });
    mount();
    await advance(0);
    await act(async () => {
      screen.getByRole('button', { name: 'start' }).click();
      await vi.advanceTimersByTimeAsync(0);
    });
    readRes = () => json({ ok: true, state: 'signed', merchant: SHOP, amount: AMOUNT.toString(), auth: AUTH });
    await advance(3_000);
    await advance(10_000);
    expect(screen.getByTestId('phase').textContent).toBe('failed:false');
    expect(loadHistory()).toEqual([]);
  });

  it('再読み込みの後の「前回の送信」が入金の確認になったら書く (同じタブに残った写しの明細・時刻は送った時刻)', async () => {
    // 再読み込みの前: QR を出したときの写しが sessionStorage に残っている
    saveStoreDeviceSaleSnapshot(ID, checkout);
    vi.setSystemTime(new Date(NOW + 5 * 60_000));
    send.readSentMarks.mockReturnValue({ ok: true, marks: [MARK] });
    let release!: (v: unknown) => void;
    send.waitReceipt.mockReturnValueOnce(new Promise((r) => { release = r; }));
    mount();
    await advance(0);
    await advance(0);
    expect(screen.getByTestId('phase').textContent).toBe('sent:true');
    expect(loadHistory()).toEqual([]);
    await act(async () => {
      release({ status: 'success', logs: [] });
      await vi.advanceTimersByTimeAsync(0);
    });
    await advance(0);
    expect(screen.getByTestId('status').textContent).toMatch(/入金を確認しました/);
    const rows = loadHistory();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: `batch-${HASH}`, receiptNo: 'R-0012', productName: 'カフェラテ', ts: NOW });
  });

  it('再読み込みの後の「前回の送信」で写しが無い (別のタブで開き直した) ときは、明細なしで金額と tx だけの行', async () => {
    send.readSentMarks.mockReturnValue({ ok: true, marks: [{ ...MARK, at: NOW - 60_000 }] });
    mount();
    await advance(0);
    await advance(0);
    expect(screen.getByTestId('phase').textContent).toBe('received:false');
    expect(loadHistory()).toEqual([
      expect.objectContaining({
        id: `batch-${HASH}`,
        merchantAmount: AMOUNT.toString(),
        customer: PAYER,
        txHash: HASH,
        lineItems: null,
        productName: null,
        receiptNo: null,
      }),
    ]);
  });

  it('履歴の書き込みが throw しても、お店の端末で送る の状態と表示は同じ (履歴は空・警告は 1 回)', async () => {
    resolveRes = () => json({ ok: true, state: 'settled', txHash: HASH });
    const ok = mount();
    const baseline = await sale();
    expect(loadHistory()).toHaveLength(1);
    ok.unmount();
    window.localStorage.clear();
    window.sessionStorage.clear();
    readRes = () => json({ ok: true, state: 'open', merchant: SHOP, amount: AMOUNT.toString(), auth: null });

    writer.fail = true;
    writer.calls = 0;
    mount();
    const withFailure = await sale();
    expect(withFailure).toEqual(baseline);
    expect(withFailure[2]).toMatch(/入金を確認しました/);
    expect(writer.calls).toBe(1);
    expect(loadHistory()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('storeDevice.saleHistory.not-written', expect.anything());
    // 結果は今までどおり閉じられる (次の会計へ進める)
    await act(async () => {
      screen.getByRole('button', { name: /閉じる/ }).click();
    });
    expect(screen.getByTestId('phase').textContent).toBe('idle:false');
  });

  it('写しを保存できない (sessionStorage の setItem が throw) ときも、状態と表示は同じ・行は明細なしで書く', async () => {
    resolveRes = () => json({ ok: true, state: 'settled', txHash: HASH });
    const ok = mount();
    const baseline = await sale();
    ok.unmount();
    window.localStorage.clear();
    window.sessionStorage.clear();
    readRes = () => json({ ok: true, state: 'open', merchant: SHOP, amount: AMOUNT.toString(), auth: null });

    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === STORE_DEVICE_SALE_SNAPSHOT_KEY) throw new Error('QuotaExceededError');
      original.call(this, key, value);
    });
    mount();
    const withFailure = await sale();
    expect(withFailure).toEqual(baseline);
    expect(loadHistory()).toEqual([
      expect.objectContaining({ id: `batch-${HASH}`, merchantAmount: AMOUNT.toString(), lineItems: null, receiptNo: null }),
    ]);
  });

  it('送っている間に別の会計を写しても (カートを直して次の QR)、行は QR を出した時点の会計のまま', async () => {
    let releaseVerify!: (v: unknown) => void;
    send.verifyDeviceAuth.mockReturnValueOnce(new Promise((r) => { releaseVerify = r; }));
    mount();
    await advance(0);
    await act(async () => {
      screen.getByRole('button', { name: 'start' }).click();
      await vi.advanceTimersByTimeAsync(0);
    });
    readRes = () => json({ ok: true, state: 'signed', merchant: SHOP, amount: AMOUNT.toString(), auth: AUTH });
    await advance(3_000);
    expect(screen.getByTestId('phase').textContent).toBe('processing:true');
    // 送っている間に、直したカートの会計が別の受け渡しの id で写される (この支払いの写しは変わらない)
    saveStoreDeviceSaleSnapshot('ZZZZZZZZZZZZZZZZZZZZZZ', {
      ...checkout,
      items: [{ name: '直した後のカート', qty: 1, price: '1000' }],
      receiptNo: 'R-0013',
    });
    await act(async () => {
      releaseVerify({ ok: true, value: { params: {}, signature: '0x', nonce: NONCE } });
      await vi.advanceTimersByTimeAsync(0);
    });
    await advance(0);
    expect(screen.getByTestId('phase').textContent).toBe('received:false');
    expect(loadHistory()).toEqual([
      expect.objectContaining({ id: `batch-${HASH}`, productName: 'カフェラテ', receiptNo: 'R-0012' }),
    ]);
  });
});
