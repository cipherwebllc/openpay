import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { getAddress, type Hex } from 'viem';
import { renderWithIntl } from '../_helpers/i18n';

// お店の端末で送る の同じ支払いを、払った側 (本物の StoreDeviceCheckoutForm + useStoreDevicePayment + usePaymentHistory) と
// お店の端末 (本物の写し + recordStoreDeviceSale) の両方で実際に行にして、欄ごとに比べる (片方を手で写した期待値にしない)。
// 差し替えるのは、ウォレット (wagmi)・通信 (fetch)・画面の部品 (接続ボタン・控えの表示・残高) だけ。
// 払った側のブラウザが履歴の行を書くのは、受取先が自分のときだけ (hooks/usePaymentHistory の paidToSelf)。払った側の本物の行を
// 作るために、払う人 = お店の受取先 (SHOP と同じアドレス) の会計で比べる。払った側が書く行の値そのものは、払う人が誰でも同じ式。
const PAYER = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const w = vi.hoisted(() => ({ signTypedData: vi.fn(), address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }));
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: w.address, isConnected: true, chainId: 80002 }),
  useWalletClient: () => ({ data: { signTypedData: w.signTypedData } }),
  useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false }),
}));
vi.mock('@/components/ConnectButton', () => ({ ConnectButton: () => <div>connect</div> }));
vi.mock('@/components/PayerReceiptCompletion', () => ({ PayerReceiptCompletion: () => <div>receipt</div> }));
vi.mock('@/hooks/useErc20BalanceAndChain', () => ({
  useErc20BalanceAndChain: () => ({ balance: 10n ** 24n, insufficientBalance: false, wrongChain: false }),
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
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/forwarderConfig')>()),
  jpycForwarderFor: () => '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4',
}));

import { StoreDeviceCheckoutForm } from '@/components/StoreDeviceCheckoutForm';
import { clearHistory, loadHistory, type HistoryEntry } from '@/lib/history';
import { loadPayerReceipts } from '@/lib/payerReceipt';
import { recordStoreDeviceSale } from '@/lib/storeDeviceSaleHistory';
import { readStoreDeviceSaleSnapshot, saveStoreDeviceSaleSnapshot } from '@/lib/storeDeviceSaleSnapshot';
import type { DeviceSentMark } from '@/lib/storeDeviceSend';
import { buildCheckoutUrl, calcCheckoutPayable, parseCheckoutParams, type CheckoutParams } from '@/lib/url';

const SHOP = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const HS = 'AbCdEfGhIjKlMnOpQrStUv';
const TX = `0x${'ab'.repeat(32)}` as Hex;
const SIG = `0x${'1b'.repeat(65)}`;
const ORIGIN = 'https://test.local';

// お店の画面が QR に載せる会計 (components/RegisterMode.tsx・components/QrGenerator.tsx の storeCheckout と同じ形)。
const base = { to: SHOP, token: 'jpyc', chain: 'polygon', gas: 'merchant', mode: 'gasless', submit: 'store' } as const;
const CASES: [string, CheckoutParams][] = [
  [
    'レジ: 税率の違う 2 品・品ごとのメモ・値引き・管理番号・店名・登録番号',
    {
      ...base,
      items: [
        { name: 'コーヒー', qty: 2, price: '500', taxRate: 8, taxCategory: 'taxable_8', memo: '氷なし' },
        { name: 'ケーキ', qty: 1, price: '480', taxRate: 10, taxCategory: 'taxable_10' },
      ],
      receiptNo: 'R-0012',
      storeName: 'OpenPay Cafe',
      invoiceNo: 'T1234567890123',
      discount: '80',
    },
  ],
  [
    '決済QR: 1 品・メモ・会計単位の税率と税区分・管理番号・店名',
    {
      ...base,
      items: [{ name: 'ランチセット', qty: 1, price: '1400', memo: '店内' }],
      taxRate: 10,
      taxCategory: 'taxable_10',
      receiptNo: 'QR-7',
      storeName: 'OpenPay Cafe',
    },
  ],
  [
    '決済QR: 1 品・値引き・非課税',
    {
      ...base,
      items: [{ name: 'お支払い', qty: 1, price: '3000' }],
      discount: '300',
      taxRate: 0,
      taxCategory: 'tax_free',
    },
  ],
  ['決済QR: 金額だけ (商品名は既定・ほかは何も無い)', { ...base, items: [{ name: 'お支払い', qty: 1, price: '250' }] }],
];

type AuthBody = { from: string; merchant: string; merchantValue: string; validBefore: string; intentSalt: Hex };
let authBody: AuthBody | null;

const json = (body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(new Date('2026-11-16T03:00:00Z'));
  window.localStorage.clear();
  window.sessionStorage.clear();
  authBody = null;
  w.address = PAYER;
  w.signTypedData.mockReset().mockResolvedValue(SIG);
  // Web Locks の代わり (jsdom には無い)。
  Object.defineProperty(window.navigator, 'locks', {
    value: { request: (_name: string, fn: () => Promise<unknown>) => fn() },
    configurable: true,
  });
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith('/auth')) {
      authBody = JSON.parse(String(init!.body)) as AuthBody;
      return json({ ok: true, idempotent: false });
    }
    // 判定: この支払いは TX で成立して確定した。
    if (url.endsWith('/resolve')) return json({ ok: true, state: 'settled', txHash: TX });
    // 受け渡しの読み取り: お店の端末が送った tx。
    return json({ ok: true, state: 'sent', expiresAt: 0, txHash: TX });
  }));
});
afterEach(() => {
  Object.defineProperty(window.navigator, 'locks', { value: undefined, configurable: true });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** 払った側: QR の URL を開いて署名し、支払い済みの結論まで進める。書かれた履歴の行を返す。 */
async function payerRow(url: string): Promise<HistoryEntry> {
  const parsed = parseCheckoutParams(new URL(url).searchParams);
  if (!parsed.ok) throw new Error(`QR の URL を読めない: ${parsed.error}`);
  const view = renderWithIntl(<StoreDeviceCheckoutForm params={parsed.params} />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /JPYC を支払う/ }));
    await vi.advanceTimersByTimeAsync(0);
  });
  for (let i = 0; i < 10 && loadHistory().length === 0; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
  }
  const rows = loadHistory();
  expect(rows).toHaveLength(1);
  view.unmount();
  return rows[0];
}

/** お店の端末が、自分で作った受け渡し (受取先・請求額) とお客様の署名を照合して送った印。 */
function sentMark(checkout: CheckoutParams): DeviceSentMark {
  if (!authBody) throw new Error('お客様の署名が受け渡しに届いていない');
  const amount = calcCheckoutPayable(checkout, 18);
  // 端末は、受け渡しの受取先・請求額 (お店の画面が start() に渡した値) と署名の値が同じときだけ送る (verifyDeviceAuth)。
  expect(authBody.merchantValue).toBe(amount.toString());
  expect(getAddress(authBody.merchant)).toBe(getAddress(checkout.to));
  return {
    handoffId: HS,
    chainId: 80002,
    nonce: `0x${'33'.repeat(32)}`,
    hash: TX,
    from: getAddress(authBody.from),
    merchant: getAddress(checkout.to),
    amount: amount.toString(),
    validBefore: authBody.validBefore,
    intentSalt: authBody.intentSalt,
    at: Date.now(),
  };
}

describe('お店の端末で送る: お店の履歴の行は、払った側が同じ支払いで書く行と欄ごとに同じ', () => {
  it.each(CASES)('%s', async (_name, checkout) => {
    // お店: QR を出すときに会計を写す (QR に載せる URL と同じ中身)。
    saveStoreDeviceSaleSnapshot(HS, checkout);
    const url = buildCheckoutUrl(ORIGIN, { ...checkout, handoffId: HS });
    expect(`${ORIGIN}${readStoreDeviceSaleSnapshot(HS)}`).toBe(url);

    // 払った側の行 (本物の画面と hook が書く)。
    const payer = await payerRow(url);
    expect(payer.id).toBe(`batch-${TX}`);
    expect(payer.customer).toBe(getAddress(PAYER));
    expect(payer.lineItems).toHaveLength(checkout.items.length);

    // お店の行 (本物の写しと書き手が書く)。
    const mark = sentMark(checkout);
    clearHistory();
    expect(recordStoreDeviceSale(mark, TX)).toBe(true);
    const shopRows = loadHistory();
    expect(shopRows).toHaveLength(1);
    const shop = shopRows[0];

    // 欄ごとに同じ。違ってよいのは ts だけ (行を書いた時刻 = それぞれの端末の時刻。お店の行は端末が送った時刻)。
    expect(Object.keys(shop).sort()).toEqual(Object.keys(payer).sort());
    for (const key of Object.keys(payer) as (keyof HistoryEntry)[]) {
      if (key === 'ts') continue;
      expect({ [key]: shop[key] }).toEqual({ [key]: payer[key] });
    }
    // 比べた欄が空どうしではない (金額・利用料の欄・負担・明細)。
    expect(shop).toMatchObject({
      flow: 'batch',
      status: 'success',
      payMode: 'gasless',
      gasMode: 'merchant',
      merchantAmount: calcCheckoutPayable(checkout, 18).toString(),
      saleAmount: calcCheckoutPayable(checkout, 18).toString(),
      feeAmount: '1',
      networkFeeEquivalent: null,
      blockNumber: null,
      asset: 'jpyc',
      chainSlug: 'polygon',
      storeName: '',
    });
    expect(shop.productName).toBe(checkout.items.map((it) => it.name).join(', '));
    expect(shop.receiptNo).toBe(checkout.receiptNo ?? null);
  });

  it('同じブラウザに両方が書いても 1 行 (払った側が先・お店が先のどちらでも)', async () => {
    const checkout = CASES[0][1];
    saveStoreDeviceSaleSnapshot(HS, checkout);
    const url = buildCheckoutUrl(ORIGIN, { ...checkout, handoffId: HS });
    // 払った側が先 → お店の端末が後から書く
    const payer = await payerRow(url);
    const mark = sentMark(checkout);
    expect(recordStoreDeviceSale(mark, TX)).toBe(true);
    expect(loadHistory()).toEqual([payer]);

    // お店の端末が先 → 払った側が後から書く
    clearHistory();
    window.localStorage.clear();
    expect(recordStoreDeviceSale(mark, TX)).toBe(true);
    const shop = loadHistory()[0];
    authBody = null;
    await payerRow(url);
    expect(loadHistory()).toEqual([shop]);
  });

  it('お客様 (お店の受取先でないウォレット) が払うと、払った側は履歴の行を書かず控えだけ・お店の端末は行を書く', async () => {
    const CUSTOMER = '0x0000000000000000000000000000000000000def';
    w.address = CUSTOMER;
    const checkout = CASES[0][1];
    saveStoreDeviceSaleSnapshot(HS, checkout);
    const parsed = parseCheckoutParams(new URL(buildCheckoutUrl(ORIGIN, { ...checkout, handoffId: HS })).searchParams);
    if (!parsed.ok) throw new Error(`QR の URL を読めない: ${parsed.error}`);
    const view = renderWithIntl(<StoreDeviceCheckoutForm params={parsed.params} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /JPYC を支払う/ }));
      await vi.advanceTimersByTimeAsync(0);
    });
    for (let i = 0; i < 10 && loadPayerReceipts().length === 0; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
    }
    // 払った側: 「支払い」の控えが 1 件・「受取」の行は無い。
    expect(loadPayerReceipts()).toHaveLength(1);
    expect(loadPayerReceipts()[0]).toMatchObject({
      receiptId: TX,
      status: 'confirmed',
      payerAddress: getAddress(CUSTOMER),
      merchantAddress: SHOP,
    });
    expect(loadHistory()).toEqual([]);
    view.unmount();

    // お店の端末: 同じ支払いの行を書く (お客様の欄は払ったウォレット)。
    expect(recordStoreDeviceSale(sentMark(checkout), TX)).toBe(true);
    const rows = loadHistory();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: `batch-${TX}`, merchant: SHOP, customer: getAddress(CUSTOMER) });
  });
});
