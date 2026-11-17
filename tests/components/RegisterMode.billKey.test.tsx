// レジ (components/RegisterMode.tsx) と会計ごとの印 (bill key):
//   - 載せるのは、画面に表示中の「JPYC・回収 (forwarder のあるチェーンのガスレス)・通常の QR」だけ。画面に出す URL と
//     コピーする値には載せない (レジの QR の画面に、印刷と保存は無い)。
//   - 載せない QR (通常決済・USDC の商品・forwarder の無いチェーン・中継が無効・お店負担) では、見張りを呼ばず、RPC を
//     1 回も読まない。
//   - QR の画面の DOM は、bill key を載せても載せなくても同じ (違うのは QR の中身だけ)。
//   - レジ → 見張り → 履歴: 画面が出した bill key で署名された入金が、カートの明細・値引き・管理番号つきの行になる。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, type ReactElement } from 'react';
import userEvent from '@testing-library/user-event';
import type { Address } from 'viem';
import { renderWithIntl } from '../_helpers/i18n';
import ja from '@/messages/ja.json';

const hold = vi.hoisted(() => ({
  eip3009: true,
  forwarder: null as string | null,
  storeGasWallet: false,
  billKeyOff: false,
  shown: [] as { billKey: string; kind: string; url: string; itemName: string }[],
  hidden: [] as string[],
  start: vi.fn(),
  stop: vi.fn(),
  release: vi.fn(),
}));
const rpc = vi.hoisted(() => ({ head: vi.fn(), logs: vi.fn(), time: vi.fn() }));

vi.mock('@/hooks/useResolveAddress', () => ({
  useResolveAddress: vi.fn(() => ({ data: null, isFetching: false, error: null })),
}));
vi.mock('wagmi', () => ({
  useAccount: vi.fn(() => ({ address: undefined, isConnected: false })),
}));
vi.mock('@/hooks/useOrigin', () => ({ useOrigin: () => 'https://test.local' }));
vi.mock('@/hooks/useMarketRates', () => ({
  useMarketRates: () => ({ data: { usdcJpy: 150, updatedAt: '2026-06-03T00:00:00.000Z' }, isLoading: false, isError: false, refetch: vi.fn() }),
}));
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({ isSignedIn: false, sessionAddress: null, mismatch: false, isLoading: false, signIn: vi.fn(), isSigningIn: false, signInError: null, signOut: vi.fn() }),
}));
// QR の中身 (URL) を読む。
vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value }: { value: string }) => <svg data-testid="qr" data-value={value} />,
}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      networkEnv: 'testnet',
      feeReceiver: '0x428483FbA62eDCef1E3a100d3799F6d71759c560',
      enableShopLive: false,
      enableMobileOrder: false,
      get enableJpycEip3009() {
        return hold.eip3009;
      },
      get enableStoreGasWallet() {
        return hold.storeGasWallet;
      },
    },
  };
});
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/forwarderConfig')>()),
  jpycForwarderFor: () => hold.forwarder,
}));
vi.mock('@/hooks/useStoreDeviceRegister', () => ({
  useStoreDeviceRegister: () => ({
    state: { phase: 'idle' },
    busy: false,
    start: hold.start,
    stop: hold.stop,
    releaseForNormal: hold.release,
    checkNow: vi.fn(),
    retry: vi.fn(),
    dismiss: vi.fn(),
  }),
}));
vi.mock('@/components/StoreGasWalletPanel', () => ({
  StoreGasWalletPanel: ({ onAddressChange }: { onAddressChange?: (a: string | null) => void }) => {
    useEffect(() => {
      onAddressChange?.('0x0000000000000000000000000000000000000abc');
    }, [onAddressChange]);
    return <div>gas-wallet-panel</div>;
  },
}));
// お店の端末が読むチェーン (RPC)。
vi.mock('@/lib/qrSaleRpc', () => ({
  QR_SALE_RPC_TIMEOUT_MS: 6_000,
  readChainHead: rpc.head,
  readSettledLogs: rpc.logs,
  readBlockTime: rpc.time,
}));
// 見張りは本物。画面が渡した会計を記録するだけ包む。
vi.mock('@/lib/qrSaleWatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/qrSaleWatch')>();
  return {
    ...actual,
    showQrBill: (...args: Parameters<typeof actual.showQrBill>) => {
      hold.shown.push(args[0]);
      actual.showQrBill(...args);
    },
    hideQrBill: (...args: Parameters<typeof actual.hideQrBill>) => {
      hold.hidden.push(args[0]);
      actual.hideQrBill(...args);
    },
  };
});
// bill key を載せない画面 (DOM の比べ先)。hold.billKeyOff のときだけ、hook に「載せない QR」を渡す。
vi.mock('@/hooks/useQrBillKey', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useQrBillKey')>();
  return {
    ...actual,
    useQrBillKey: (args: Parameters<typeof actual.useQrBillKey>[0]) =>
      actual.useQrBillKey(hold.billKeyOff ? { ...args, url: '' } : args),
  };
});

import { RegisterMode } from '@/components/RegisterMode';
import { loadHistory } from '@/lib/history';
import { stopQrSaleWatch } from '@/lib/qrSaleWatch';
import { billNonce, settledRpcLog } from '../_helpers/qrSale';

const VALID: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CUSTOMER: Address = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const FORWARDER: Address = '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4';
const HS = 'AbCdEfGhIjKlMnOpQrStUv';
const QR_KEY = 'openpay:qr-settings:v2';
const PRESETS_KEY = 'openpay:product-presets:v1';
const ONE = 10n ** 18n;
const BK_SUFFIX = /&bk=([A-Za-z0-9_-]{11})$/;
const enc = encodeURIComponent;
const COFFEE = `${enc('コーヒー')}:1:500:10:taxable_10:`;
const SHIRT = `${enc('Tシャツ')}:1:3000:10:taxable_10:`;

type User = ReturnType<typeof userEvent.setup>;

function render(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithIntl(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
function seedSettings(extra: Record<string, unknown> = {}) {
  window.localStorage.setItem(QR_KEY, JSON.stringify({ receiver: VALID, token: 'jpyc', chain: 'polygon', ...extra }));
}
function seedPresets(presets: Record<string, unknown>[]) {
  window.localStorage.setItem(
    PRESETS_KEY,
    JSON.stringify({
      presets: presets.map((p, i) => ({ token: 'jpyc', taxRate: 10, taxCategory: 'taxable_10', memo: null, sortOrder: i, enabled: true, ...p })),
      receipt: { day: '', n: 0 },
    }),
  );
}
async function tap(user: User, name: RegExp) {
  const region = await screen.findByRole('region', { name: /^(商品|Products)$/ });
  await user.click(await within(region).findByRole('button', { name }));
}
const orderPanel = () => within(screen.getByRole('region', { name: /^(ご注文|Order)$/ }));
/** QR のボタンの 1 つ目を押し、QR の画面を返す。 */
async function openQr(user: User, cta: RegExp = /QRコードを表示する/) {
  const btns = await screen.findAllByRole('button', { name: cta });
  await waitFor(() => expect(btns[0]).toBeEnabled());
  await user.click(btns[0]);
  const dialog = await screen.findByRole('dialog', { name: 'お会計 QR コード' });
  // 見張りの chunk の読み込み (Promise) を待つ。
  await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
  return dialog;
}
const qrValue = (dialog: HTMLElement) => within(dialog).getByTestId('qr').getAttribute('data-value')!;
const closeQr = (user: User, dialog: HTMLElement) => user.click(within(dialog).getByRole('button', { name: '閉じる' }));
// 見張りの 6 秒の間隔を n 回ぶん進める。
const tick = (times = 1) => act(async () => { await vi.advanceTimersByTimeAsync(6_000 * times); });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  window.localStorage.clear();
  hold.eip3009 = true;
  hold.forwarder = FORWARDER;
  hold.storeGasWallet = false;
  hold.billKeyOff = false;
  hold.shown = [];
  hold.hidden = [];
  hold.start.mockReset().mockResolvedValue({ id: HS, token: 'ab'.repeat(32), expiresAt: 0, merchant: VALID, amount: '1', chainId: 80002 });
  hold.stop.mockReset();
  hold.release.mockReset().mockResolvedValue(true);
  rpc.head.mockReset().mockResolvedValue(1_000n);
  rpc.logs.mockReset().mockResolvedValue([]);
  rpc.time.mockReset().mockResolvedValue(1_790_000_000n);
  global.fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response) as unknown as typeof fetch;
});
afterEach(() => {
  stopQrSaleWatch();
  vi.useRealTimers();
});

describe('レジ: bill key を載せる QR', () => {
  it('JPYC・回収・通常の QR: 画面の QR だけが `&bk=<11 字>` つき。画面に出す URL とコピーする値は元の URL', async () => {
    const writeText = vi.fn(async (_value: string) => {});
    seedSettings({ storeName: 'OpenPay Cafe' });
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<RegisterMode />);
    await tap(user, /コーヒー/);
    await tap(user, /Tシャツ/);
    const dialog = await openQr(user);
    const plain = `https://test.local/checkout?to=${VALID}&token=jpyc&items=${enc(`${COFFEE},${SHIRT}`)}&gas=merchant&store=OpenPay+Cafe`;
    const value = qrValue(dialog);
    expect(new URL(value.replace(BK_SUFFIX, '')).search).toBe(new URL(plain).search);
    const billKey = BK_SUFFIX.exec(value)![1];
    const plainShown = value.replace(BK_SUFFIX, '');
    // 画面に出す URL。
    expect(within(dialog).getByText(plainShown)).toBeInTheDocument();
    expect(within(dialog).queryByText(value)).toBeNull();
    // コピー。
    await user.click(within(dialog).getByRole('button', { name: '決済リンクをコピー' }));
    expect(writeText.mock.calls).toEqual([[plainShown]]);
    // 見張りに渡す会計は、bill key を足す前の URL。
    expect(hold.shown).toEqual([{ billKey, kind: 'checkout', url: plainShown, itemName: '' }]);
    // 画面の QR は同じ bill key のまま (コピーの表示が変わる再描画)。
    expect(qrValue(dialog)).toBe(value);
    expect(dialog.innerHTML.match(/bk=/g)).toHaveLength(1);
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('出し直すたびに新しい bill key (閉じて開く・カートを変える)。前の bill key は hide', async () => {
    seedSettings();
    const user = userEvent.setup();
    render(<RegisterMode />);
    await tap(user, /コーヒー/);
    let dialog = await openQr(user);
    const key1 = BK_SUFFIX.exec(qrValue(dialog))![1];
    await closeQr(user, dialog);
    dialog = await openQr(user);
    const key2 = BK_SUFFIX.exec(qrValue(dialog))![1];
    await closeQr(user, dialog);
    await tap(user, /Tシャツ/);
    dialog = await openQr(user);
    const key3 = BK_SUFFIX.exec(qrValue(dialog))![1];
    expect(new Set([key1, key2, key3]).size).toBe(3);
    expect(hold.shown.map((s) => s.billKey)).toEqual([key1, key2, key3]);
    expect(hold.hidden).toEqual([key1, key2]);
  });
});

describe('レジ: bill key を載せない QR (見張りも呼ばず、RPC を 1 回も読まない)', () => {
  const expectNoBillKey = async (dialog: HTMLElement) => {
    expect(qrValue(dialog)).not.toMatch(/[?&]bk=/);
    expect(dialog.innerHTML).not.toMatch(/bk=/);
    await tick(12);
    expect(hold.shown).toEqual([]);
    expect(rpc.head).not.toHaveBeenCalled();
    expect(rpc.logs).not.toHaveBeenCalled();
    expect(rpc.time).not.toHaveBeenCalled();
  };

  it('通常決済', async () => {
    seedSettings({ payMode: 'standard' });
    const user = userEvent.setup();
    render(<RegisterMode />);
    await tap(user, /コーヒー/);
    const dialog = await openQr(user);
    expect(qrValue(dialog)).toContain('mode=standard');
    await expectNoBillKey(dialog);
  });

  it('USDC の商品 (forwarder があっても)', async () => {
    seedSettings({ token: 'usdc', chain: 'base' });
    seedPresets([{ id: 's', name: 'Sticker', unitPrice: '5.5', token: 'usdc' }]);
    const user = userEvent.setup();
    render(<RegisterMode />);
    await tap(user, /Sticker/);
    const dialog = await openQr(user);
    expect(qrValue(dialog)).toContain('token=usdc');
    await expectNoBillKey(dialog);
  });

  it('forwarder の無いチェーン (中継が利用料を取らない経路)', async () => {
    hold.forwarder = null;
    seedSettings();
    const user = userEvent.setup();
    render(<RegisterMode />);
    await tap(user, /コーヒー/);
    await expectNoBillKey(await openQr(user));
  });

  it('中継が無効 (Pimlico の経路) で forwarder だけある', async () => {
    hold.eip3009 = false;
    seedSettings();
    const user = userEvent.setup();
    render(<RegisterMode />);
    await tap(user, /コーヒー/);
    await expectNoBillKey(await openQr(user));
  });

  it('お店負担の QR (submit=store と hs)', async () => {
    hold.storeGasWallet = true;
    Object.defineProperty(window.navigator, 'locks', { value: { request: vi.fn() }, configurable: true });
    seedSettings({ payMode: 'gasless', storePays: true });
    seedPresets([{ id: 'g', name: 'ガム', unitPrice: '1' }]);
    const user = userEvent.setup();
    render(<RegisterMode />);
    await tap(user, /ガム/);
    const dialog = await openQr(user);
    expect(qrValue(dialog)).toContain(`hs=${HS}`);
    expect(qrValue(dialog)).toContain('submit=store');
    await expectNoBillKey(dialog);
    Object.defineProperty(window.navigator, 'locks', { value: undefined, configurable: true });
  });
});

describe('レジ: QR の画面は、bill key を載せても同じ', () => {
  it('QR の画面の DOM は、QR の中身の `&bk=…` だけが違う', async () => {
    const capture = async () => {
      seedSettings({ storeName: 'OpenPay Cafe' });
      const user = userEvent.setup();
      const view = render(<RegisterMode />);
      await tap(user, /コーヒー/);
      await tap(user, /Tシャツ/);
      const dialog = await openQr(user);
      const out = { html: dialog.outerHTML, value: qrValue(dialog) };
      view.unmount();
      window.localStorage.clear();
      return out;
    };
    const withKey = await capture();
    hold.billKeyOff = true;
    const without = await capture();
    expect(without.value).not.toMatch(/bk=/);
    const billKey = BK_SUFFIX.exec(withKey.value)![1];
    expect(withKey.html).not.toBe(without.html);
    expect(withKey.html.replace(`&amp;bk=${billKey}`, '')).toBe(without.html);
  });
});

describe('レジ → 見張り → 取引履歴', () => {
  it('画面が出した bill key で署名された入金が、カートの明細・値引き・管理番号つきの行になる (店名は行に入れない)', async () => {
    seedSettings({ storeName: 'OpenPay Cafe' });
    const user = userEvent.setup();
    render(<RegisterMode />);
    await tap(user, /コーヒー/);
    await tap(user, /コーヒー/);
    await tap(user, /Tシャツ/);
    await user.click(orderPanel().getByRole('button', { name: '＋ 値引きを追加' }));
    await user.type(orderPanel().getByLabelText('値引きの金額'), '100');
    await user.click(orderPanel().getByText('管理番号を付ける（任意）'));
    await user.type(orderPanel().getByLabelText('管理番号 / レシート番号'), 'R-001');
    const dialog = await openQr(user);
    const billKey = BK_SUFFIX.exec(qrValue(dialog))![1];
    // 入金が取り込まれた block の時刻 (QR を出した後・会計が生きていた間)。
    const blockTime = BigInt(Math.floor(Date.now() / 1000)) + 5n;
    rpc.time.mockResolvedValue(blockTime);
    // 会計: 500 × 2 + 3,000 − 100 = 3,900。利用料 2 (下限)・着金 3,898。
    const sale = {
      from: CUSTOMER, merchant: VALID, merchantValue: 3_898n * ONE, feeValue: 2n * ONE,
      validBefore: blockTime + 295n, chainId: 80002, forwarder: FORWARDER,
    };
    const TX = `0x${'d1'.repeat(32)}`;
    rpc.logs.mockResolvedValue([settledRpcLog({ ...sale, nonce: billNonce(billKey, sale), txHash: TX, blockNumber: 995n })]);
    await tick();
    expect(rpc.logs).toHaveBeenCalledWith(80002, FORWARDER, [VALID], 910n, 997n);
    const rows = loadHistory();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: `batch-${TX}`,
      ts: Number(blockTime) * 1000,
      merchant: VALID,
      customer: CUSTOMER,
      merchantAmount: (3_898n * ONE).toString(),
      saleAmount: (3_900n * ONE).toString(),
      networkFeeEquivalent: (2n * ONE).toString(),
      feeAmount: '0',
      storeName: '',
      productName: 'コーヒー, Tシャツ',
      receiptNo: 'R-001',
    });
    expect(rows[0].lineItems?.map((it) => [it.name, it.quantity, it.unitPrice])).toEqual([
      ['コーヒー', 2, '500'],
      ['Tシャツ', 1, '3000'],
    ]);
  });
});

describe('レジ: 入金の確認の表示 (見張りが表示中の会計の行を書いたら、その QR の画面に緑で出す)', () => {
  const Q = ja.QrGenerator;
  const first = (amount: string) => Q.billPaymentRecorded.replace('{amount}', amount);
  const another = (amount: string) => Q.billPaymentAnother.replace('{amount}', amount);
  const TX1 = `0x${'f1'.repeat(32)}`;
  const TX2 = `0x${'f2'.repeat(32)}`;
  // コーヒー 1 つ = 500 の会計 (利用料 2・着金 498) に、bill key で署名した入金。
  const payment = (billKey: string, blockTime: bigint, tx: string, block: bigint) => {
    const sale = {
      from: CUSTOMER, merchant: VALID, merchantValue: 498n * ONE, feeValue: 2n * ONE,
      validBefore: blockTime + 295n, chainId: 80002, forwarder: FORWARDER,
    };
    return settledRpcLog({ ...sale, nonce: billNonce(billKey, sale), txHash: tx, blockNumber: block });
  };

  it('1 件目 → 1 件目の文・2 件目 → 2 件目の文 (額 = 書いた行の saleAmount = 請求額)。確認の前は status を出さない', async () => {
    seedSettings();
    const user = userEvent.setup();
    render(<RegisterMode />);
    await tap(user, /コーヒー/);
    const dialog = await openQr(user);
    const billKey = BK_SUFFIX.exec(qrValue(dialog))![1];
    expect(within(dialog).queryByRole('status')).toBeNull();
    const blockTime = BigInt(Math.floor(Date.now() / 1000)) + 5n;
    rpc.time.mockResolvedValue(blockTime);
    rpc.logs.mockResolvedValue([payment(billKey, blockTime, TX1, 995n)]);
    await tick();
    expect(loadHistory()[0]).toMatchObject({ id: `batch-${TX1}`, saleAmount: (500n * ONE).toString() });
    const status = within(dialog).getByRole('status');
    expect(status.textContent).toBe(first('500 JPYC'));
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).not.toHaveAttribute('aria-label');
    expect(status).toHaveClass('border-emerald-200', 'bg-emerald-50', 'text-emerald-900');
    // 同じ会計への 2 件目 (明細なしの行)。
    rpc.logs.mockResolvedValue([payment(billKey, blockTime, TX1, 995n), payment(billKey, blockTime, TX2, 996n)]);
    await tick();
    expect(loadHistory()[0]).toMatchObject({ id: `batch-${TX2}`, lineItems: null });
    expect(within(dialog).getByRole('status').textContent).toBe(another('500 JPYC'));
  });

  it('閉じた後に見つけた入金は出さない (履歴には入る)。出し直した QR (新しい会計) には前の表示も前の会計の入金も出ない', async () => {
    seedSettings();
    const user = userEvent.setup();
    render(<RegisterMode />);
    await tap(user, /コーヒー/);
    let dialog = await openQr(user);
    const oldKey = BK_SUFFIX.exec(qrValue(dialog))![1];
    const blockTime = BigInt(Math.floor(Date.now() / 1000)) + 5n;
    rpc.time.mockResolvedValue(blockTime);
    rpc.logs.mockResolvedValue([payment(oldKey, blockTime, TX1, 995n)]);
    await tick();
    expect(within(dialog).getByRole('status').textContent).toBe(first('500 JPYC'));
    await closeQr(user, dialog);
    // 閉じている間に、同じ会計の 2 件目が見つかる。
    rpc.logs.mockResolvedValue([payment(oldKey, blockTime, TX1, 995n), payment(oldKey, blockTime, TX2, 996n)]);
    await tick();
    expect(loadHistory()).toHaveLength(2);
    dialog = await openQr(user);
    expect(BK_SUFFIX.exec(qrValue(dialog))![1]).not.toBe(oldKey);
    expect(within(dialog).queryByRole('status')).toBeNull();
    expect(dialog.textContent).not.toContain(first('500 JPYC'));
    expect(dialog.textContent).not.toContain(another('500 JPYC'));
  });
});
