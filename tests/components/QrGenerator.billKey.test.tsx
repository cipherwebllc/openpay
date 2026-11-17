// 決済QR (components/QrGenerator.tsx) と会計ごとの印 (bill key):
//   - 載せるのは、画面に表示中の「JPYC・回収 (forwarder のあるチェーンのガスレス)・金額あり・通常の QR」だけ。
//   - 画面の外へ出るもの (リンクの表示・コピー・印刷・SVG / PNG の保存・前回の受け取り QR) には載せない。
//     保存した SVG / PNG は、実際に画像にして QR として読み (sharp + jsQR)、中身の URL に bk が無いことを確かめる。
//   - 載せない QR (金額なし・通常決済と互換 QR・USDC・forwarder の無いチェーン・中継が無効・お店負担) では、見張りを呼ばず、
//     RPC を 1 回も読まない。
//   - QR の画面の DOM・残高の見張りに渡す値は、bill key を載せても載せなくても同じ (違うのは QR の中身だけ)。
//   - 画面 → 見張り → 履歴: 画面が出した bill key で署名された入金が、画面の設定 (店名・商品名・管理番号) つきの行になる。
// 差し替えるのは、ウォレット (wagmi)・為替・経路の判定の入力 (中継の有無・forwarder)・お店の端末の状態・RPC の読み取りだけ。
import type { ComponentProps } from 'react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';
import sharp from 'sharp';
import jsQR from 'jsqr';
import type { Address } from 'viem';
import { renderWithIntl } from '../_helpers/i18n';
import { qrAmountInput } from '../_helpers/qrAmount';
import ja from '@/messages/ja.json';

const h = vi.hoisted(() => ({
  storeGas: false,
  provider: 'eip3009-relay' as string,
  forwarders: {} as Record<number, `0x${string}`>,
  billKeyOff: false,
  watchArgs: [] as string[],
  shown: [] as { billKey: string; kind: string; url: string; itemName: string }[],
  hidden: [] as string[],
}));
const sd = vi.hoisted(() => ({
  active: false,
  state: { phase: 'idle' } as Record<string, unknown>,
  start: vi.fn(),
  stop: vi.fn(),
  releaseForNormal: vi.fn(),
}));
const rpc = vi.hoisted(() => ({ head: vi.fn(), logs: vi.fn(), time: vi.fn() }));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined, isConnected: false }),
  useReadContract: () => ({ data: undefined }),
}));
vi.mock('@/hooks/useResolveAddress', () => ({
  useResolveAddress: () => ({ data: null, isFetching: false, error: null }),
}));
vi.mock('@/hooks/useOrigin', () => ({ useOrigin: () => 'https://test.local' }));
vi.mock('@/hooks/useMarketRates', () => ({
  useMarketRates: () => ({ data: { usdcJpy: 150, updatedAt: '2026-09-24T00:00:00.000Z' }, isLoading: false, isError: false, refetch: () => {} }),
}));
vi.mock('@/lib/jpycGaslessProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/jpycGaslessProvider')>()),
  resolveJpycGaslessProvider: () => h.provider,
}));
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/forwarderConfig')>()),
  jpycForwarderFor: (chainId: number) => h.forwarders[chainId] ?? null,
}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (target, key) =>
        key === 'enableStoreGasWallet'
          ? h.storeGas
          : key === 'feeReceiver'
            ? '0x428483FbA62eDCef1E3a100d3799F6d71759c560'
            : Reflect.get(target, key),
    }),
  };
});
// 残高の見張りに渡す値を記録する (中身は本物)。
vi.mock('@/hooks/useIncomingPaymentWatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useIncomingPaymentWatch')>();
  return {
    ...actual,
    useIncomingPaymentWatch: (args: Parameters<typeof actual.useIncomingPaymentWatch>[0]) => {
      h.watchArgs.push(JSON.stringify({ ...args, expectedAmountWei: String(args.expectedAmountWei) }));
      return actual.useIncomingPaymentWatch(args);
    },
  };
});
// QR に渡す値を data 属性に写す (描画は本物の qrcode.react = 保存した SVG を QR として読める)。
vi.mock('qrcode.react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('qrcode.react')>();
  return {
    ...actual,
    QRCodeSVG: (props: ComponentProps<typeof actual.QRCodeSVG>) => (
      <actual.QRCodeSVG {...props} data-qr-value={props.value} />
    ),
  };
});
vi.mock('@/components/StoreGasWalletPanel', () => ({
  StoreGasWalletPanel: () => <div data-testid="gas-wallet-panel">gas-wallet-panel</div>,
}));
vi.mock('@/components/StoreDeviceProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/StoreDeviceProvider')>();
  return {
    ...actual,
    useStoreDeviceMode: () =>
      sd.active
        ? {
            on: true,
            setOn: () => {},
            gasAddress: '0x0000000000000000000000000000000000000abc',
            setGasAddress: () => {},
            chainIds: [80002, 1001],
            blocked: null,
            enabled: true,
            device: {
              state: sd.state,
              busy: false,
              start: sd.start,
              stop: sd.stop,
              releaseForNormal: sd.releaseForNormal,
              hasPendingSale: () => false,
              checkNow: () => {},
              retry: () => {},
              dismiss: () => {},
            },
          }
        : actual.useStoreDeviceMode(),
  };
});
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
      h.shown.push(args[0]);
      actual.showQrBill(...args);
    },
    hideQrBill: (...args: Parameters<typeof actual.hideQrBill>) => {
      h.hidden.push(args[0]);
      actual.hideQrBill(...args);
    },
  };
});
// bill key を載せない画面 (DOM と残高の見張りの比べ先)。h.billKeyOff のときだけ、hook に「載せない QR」を渡す。
vi.mock('@/hooks/useQrBillKey', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useQrBillKey')>();
  return {
    ...actual,
    useQrBillKey: (args: Parameters<typeof actual.useQrBillKey>[0]) =>
      actual.useQrBillKey(h.billKeyOff ? { ...args, url: '' } : args),
  };
});

import { QrGenerator } from '@/components/QrGenerator';
import { useQrSaleWatchScope } from '@/hooks/useQrBillKey';
import { loadHistory } from '@/lib/history';
import { stopQrSaleWatch } from '@/lib/qrSaleWatch';
import { billNonce, settledRpcLog } from '../_helpers/qrSale';

const L = ja.QrGenerator;
const RECEIVER: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CUSTOMER: Address = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const FORWARDER: Address = '0x1234567890123456789012345678901234567890';
const HS = 'AbCdEfGhIjKlMnOpQrStUv';
const SETTINGS_KEY = 'openpay:qr-settings:v2';
const LAST_QR_KEY = 'openpay:lastQr:v1';
const NOW = Date.parse('2026-11-17T03:00:00.000Z');
// 入金が取り込まれた block の時刻 (QR を出した 10 秒後・会計が生きていた間)。
const BLOCK_TIME = BigInt(NOW / 1000) + 10n;
const ONE = 10n ** 18n;
const BK_SUFFIX = /&bk=([A-Za-z0-9_-]{11})$/;

function seed(settings: Record<string, unknown> = {}) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ receiver: RECEIVER, receiverSource: 'manual', ...settings }));
}
// 画面の更新と、見張りの chunk の読み込み (Promise) を待つ。時計は進めない。
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 25)); });
// 見張りの 6 秒の間隔を n 回ぶん進める。
const tick = (times = 1) => act(async () => { await vi.advanceTimersByTimeAsync(6_000 * times); });
const dialog = () => screen.queryByRole('dialog', { name: L.qrModalTitle });
const showButtons = () => screen.getAllByRole('button', { name: L.showQr });
const mainQr = (root: HTMLElement) => root.querySelector('svg[data-qr-value][width="340"]')!;
const mainQrValue = (root: HTMLElement) => mainQr(root).getAttribute('data-qr-value')!;
const shownLink = (root: HTMLElement) => within(root).getByText(/^https:\/\/test\.local\//).textContent!;

async function openQr(amount: string | null, settings?: Record<string, unknown>) {
  seed(settings);
  const view = renderWithIntl(<QrGenerator />);
  await settle();
  if (amount === null) fireEvent.click(screen.getByRole('button', { name: L.modeStatic }));
  else fireEvent.change(qrAmountInput(settings?.token === 'usdc' ? 'USDC' : 'JPYC'), { target: { value: amount } });
  await settle();
  fireEvent.click(showButtons()[0]);
  await settle();
  return { view, dialog: dialog()! };
}
async function reopen() {
  fireEvent.click(within(dialog()!).getByRole('button', { name: L.qrModalClose }));
  await settle();
  expect(dialog()).toBeNull();
  fireEvent.click(showButtons()[0]);
  await settle();
  return dialog()!;
}

/** SVG の markup を画像にして、QR として読んだ中身 (340px = 画面の QR と同じ大きさ・1 マス 6px 前後)。 */
async function decodeQr(svgMarkup: string): Promise<string | null> {
  const raw = await sharp(Buffer.from(svgMarkup))
    .resize(340, 340, { fit: 'fill' })
    .flatten({ background: '#ffffff' })
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });
  return jsQR(new Uint8ClampedArray(raw.data), raw.info.width, raw.info.height)?.data ?? null;
}

/** 保存する Blob の中身 (jsdom の Blob に text() が無い)。 */
function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
  localStorage.clear();
  h.storeGas = false;
  h.provider = 'eip3009-relay';
  h.forwarders = { 80002: FORWARDER, 1001: FORWARDER };
  h.billKeyOff = false;
  h.watchArgs = [];
  h.shown = [];
  h.hidden = [];
  sd.active = false;
  sd.state = { phase: 'idle' };
  sd.start.mockReset().mockResolvedValue({ id: HS, token: 'ab'.repeat(32), expiresAt: 0, merchant: RECEIVER, amount: '1', chainId: 80002 });
  sd.stop.mockReset();
  sd.releaseForNormal.mockReset().mockResolvedValue(true);
  rpc.head.mockReset().mockResolvedValue(1_000n);
  rpc.logs.mockReset().mockResolvedValue([]);
  rpc.time.mockReset().mockResolvedValue(BLOCK_TIME);
});
afterEach(() => {
  stopQrSaleWatch();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('決済QR: bill key を載せる QR', () => {
  it('JPYC・回収・金額あり・通常の QR: 画面の QR だけが `&bk=<11 字>` つき。リンクの表示・前回の受け取り QR は元の URL', async () => {
    const { dialog: d } = await openQr('1000', { storeName: 'OpenPay Cafe' });
    const plain = `https://test.local/pay?to=${RECEIVER}&token=jpyc&gas=merchant&amount=1000&store=OpenPay+Cafe`;
    const value = mainQrValue(d);
    expect(value.replace(BK_SUFFIX, '')).toBe(plain);
    const billKey = BK_SUFFIX.exec(value)![1];
    // 画面に出す URL (店員向けの折りたたみ)。
    expect(shownLink(d)).toBe(plain);
    // 前回の受け取り QR (localStorage)。
    expect(JSON.parse(localStorage.getItem(LAST_QR_KEY)!).payUrl).toBe(plain);
    expect(localStorage.getItem(LAST_QR_KEY)).not.toContain('bk=');
    // 見張りに渡す会計は、bill key を足す前の URL。
    expect(h.shown).toEqual([{ billKey, kind: 'pay', url: plain, itemName: 'お支払い' }]);
    // QR の中身を実際に読んでも、画面の値と同じ。
    expect(await decodeQr(mainQr(d).outerHTML)).toBe(value);
  });

  it('コピー・SVG 保存・PNG 保存・印刷には bk が無い (保存した画像を QR として読んで確かめる)。画面の QR は bk つきのまま', async () => {
    const writeText = vi.fn(async (_value: string) => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const { dialog: d } = await openQr('1000');
    const plain = `https://test.local/pay?to=${RECEIVER}&token=jpyc&gas=merchant&amount=1000`;
    const onScreen = mainQrValue(d);
    expect(onScreen).toMatch(BK_SUFFIX);

    // コピー。
    await act(async () => { fireEvent.click(within(d).getByRole('button', { name: L.qrCopy })); });
    expect(writeText.mock.calls).toEqual([[plain]]);

    // SVG 保存: 保存する Blob の中身。
    const blobs: Blob[] = [];
    Object.assign(URL, { createObjectURL: (blob: Blob) => { blobs.push(blob); return 'blob:saved'; }, revokeObjectURL: () => {} });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(within(d).getByRole('button', { name: L.downloadSvg }));
    expect(blobs).toHaveLength(1);
    const savedSvg = await blobText(blobs[0]);
    expect(savedSvg).not.toContain('bk=');
    expect(savedSvg).toContain(`data-qr-value="${plain.replace(/&/g, '&amp;')}"`);
    expect(await decodeQr(savedSvg)).toBe(plain);
    // 保存の後、画面の QR は同じ bill key のまま。
    expect(mainQrValue(d)).toBe(onScreen);

    // PNG 保存: 画像にする元の SVG。
    const sources: string[] = [];
    class CapturedImage {
      width = 340;
      onload: (() => void) | null = null;
      set src(value: string) { sources.push(value); }
    }
    vi.stubGlobal('Image', CapturedImage);
    fireEvent.click(within(d).getByRole('button', { name: L.downloadPng }));
    expect(sources).toHaveLength(1);
    const pngSource = decodeURIComponent(sources[0].replace('data:image/svg+xml;charset=utf-8,', ''));
    expect(pngSource).not.toContain('bk=');
    expect(await decodeQr(pngSource)).toBe(plain);
    expect(mainQrValue(d)).toBe(onScreen);
    click.mockRestore();

    // 印刷: 印刷が始まる瞬間の画面の QR。終わったら (afterprint) bill key つきに戻る。
    const printed: string[] = [];
    const print = vi.spyOn(window, 'print').mockImplementation(() => { printed.push(mainQr(d).outerHTML); });
    fireEvent.click(within(d).getByRole('button', { name: L.printPoster }));
    expect(print).toHaveBeenCalledTimes(1);
    expect(printed[0]).not.toContain('bk=');
    expect(await decodeQr(printed[0])).toBe(plain);
    act(() => { window.dispatchEvent(new Event('afterprint')); });
    expect(mainQrValue(d)).toBe(onScreen);

    // ブラウザのメニューからの印刷 (beforeprint) も同じ。
    act(() => { window.dispatchEvent(new Event('beforeprint')); });
    expect(mainQrValue(d)).toBe(plain);
    act(() => { window.dispatchEvent(new Event('afterprint')); });
    expect(mainQrValue(d)).toBe(onScreen);
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('出し直すたびに新しい bill key (閉じて開く・金額を変える)。関係のない再描画 (コピーの表示の切り替え) では同じ', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } });
    const { dialog: first, view } = await openQr('1000');
    const key1 = BK_SUFFIX.exec(mainQrValue(first))![1];
    // 関係のない再描画: コピーを押す (「コピーしました」に変わる)・親の再描画。
    await act(async () => { fireEvent.click(within(first).getByRole('button', { name: L.qrCopy })); });
    view.rerender(<QrGenerator />);
    await settle();
    expect(BK_SUFFIX.exec(mainQrValue(dialog()!))![1]).toBe(key1);

    const second = await reopen();
    const key2 = BK_SUFFIX.exec(mainQrValue(second))![1];
    expect(key2).not.toBe(key1);

    fireEvent.click(within(second).getByRole('button', { name: L.qrModalClose }));
    await settle();
    fireEvent.change(qrAmountInput(), { target: { value: '1200' } });
    await settle();
    fireEvent.click(showButtons()[0]);
    await settle();
    const key3 = BK_SUFFIX.exec(mainQrValue(dialog()!))![1];
    expect(new Set([key1, key2, key3]).size).toBe(3);
    // 見張りには、出した bill key が全部渡り、閉じた分は hide される。
    expect(h.shown.map((s) => s.billKey)).toEqual([key1, key2, key3]);
    expect(h.hidden).toEqual([key1, key2]);
    expect(h.shown[2].url).toContain('amount=1200');
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('Kaia の JPYC (回収) にも載る', async () => {
    const { dialog: d } = await openQr('500', { chain: 'kaia' });
    expect(mainQrValue(d).replace(BK_SUFFIX, '')).toBe(`https://test.local/pay?to=${RECEIVER}&token=jpyc&chain=kaia&gas=merchant&amount=500`);
    expect(mainQrValue(d)).toMatch(BK_SUFFIX);
  });

  it('StrictMode でも bill key は 1 つで、見張りも 1 つ (6 秒に先頭を読むのは 1 回)', async () => {
    seed();
    renderWithIntl(<StrictMode><QrGenerator /></StrictMode>);
    await settle();
    fireEvent.change(qrAmountInput(), { target: { value: '1000' } });
    await settle();
    fireEvent.click(showButtons()[0]);
    await settle();
    const billKey = BK_SUFFIX.exec(mainQrValue(dialog()!))![1];
    expect(new Set(h.shown.map((s) => s.billKey))).toEqual(new Set([billKey]));
    await tick();
    expect(rpc.head).toHaveBeenCalledTimes(1);
    await tick(3);
    expect(rpc.head).toHaveBeenCalledTimes(4);
  });
});

describe('決済QR: bill key を載せない QR (見張りも呼ばず、RPC を 1 回も読まない)', () => {
  const expectNoBillKey = async (d: HTMLElement) => {
    for (const svg of d.querySelectorAll('svg[data-qr-value]')) {
      expect(svg.getAttribute('data-qr-value')).not.toMatch(/[?&]bk=/);
    }
    expect(d.innerHTML).not.toMatch(/[?&](amp;)?bk=/);
    await tick(12);
    expect(h.shown).toEqual([]);
    expect(rpc.head).not.toHaveBeenCalled();
    expect(rpc.logs).not.toHaveBeenCalled();
    expect(rpc.time).not.toHaveBeenCalled();
  };

  it('金額なし (据え置き) の QR', async () => {
    const { dialog: d } = await openQr(null);
    expect(mainQrValue(d)).toBe(`https://test.local/pay?to=${RECEIVER}&token=jpyc&gas=merchant`);
    await expectNoBillKey(d);
  });

  it('通常決済の QR と、互換 QR (EIP-681)', async () => {
    const { dialog: d } = await openQr('1000', { payMode: 'standard' });
    expect(mainQrValue(d)).toBe(`https://test.local/pay?to=${RECEIVER}&token=jpyc&amount=1000&mode=standard`);
    expect(d.querySelector('svg[data-qr-value][width="180"]')!.getAttribute('data-qr-value')).toMatch(/^ethereum:/);
    await expectNoBillKey(d);
  });

  it('USDC の QR', async () => {
    const { dialog: d } = await openQr('5', { token: 'usdc', chain: 'base' });
    expect(mainQrValue(d)).toMatch(/token=usdc/);
    await expectNoBillKey(d);
  });

  it('forwarder の無いチェーン (中継が利用料を取らない経路)', async () => {
    h.forwarders = {};
    const { dialog: d } = await openQr('1000');
    expect(mainQrValue(d)).toBe(`https://test.local/pay?to=${RECEIVER}&token=jpyc&amount=1000`);
    await expectNoBillKey(d);
  });

  it('中継が無効 (Pimlico の経路) で forwarder だけある', async () => {
    h.provider = 'pimlico-7702';
    const { dialog: d } = await openQr('1000');
    await expectNoBillKey(d);
  });

  it('お店負担の QR (hs つきの /checkout)。店員が通常の QR に切り替えたら、その QR には載る', async () => {
    h.storeGas = true;
    sd.active = true;
    const { dialog: d, view } = await openQr('500', { token: 'jpyc', chain: 'polygon', payMode: 'gasless', storePays: true });
    expect(mainQrValue(d)).toContain(`hs=${HS}`);
    expect(mainQrValue(d)).toContain('submit=store');
    await expectNoBillKey(d);
    view.unmount();

    // 作れなかった → 店員が選んで通常の QR (回収)。
    sd.start.mockReset().mockResolvedValue(null);
    sd.state = { phase: 'create_failed', reason: 'unavailable' };
    localStorage.clear();
    seed({ token: 'jpyc', chain: 'polygon', payMode: 'gasless', storePays: true });
    renderWithIntl(<QrGenerator />);
    await settle();
    fireEvent.change(qrAmountInput(), { target: { value: '800' } });
    await settle();
    fireEvent.click(await screen.findByRole('button', { name: L.storeDevice.showNormalQr }));
    await settle();
    const normal = dialog()!;
    expect(mainQrValue(normal).replace(BK_SUFFIX, '')).toBe(`https://test.local/pay?to=${RECEIVER}&token=jpyc&gas=merchant&amount=800`);
    expect(mainQrValue(normal)).toMatch(BK_SUFFIX);
    expect(h.shown).toHaveLength(1);
  });

  it('bill key つきの QR を出した後に閉じると、画面のどこにも bk は残らない', async () => {
    const { view } = await openQr('1000');
    fireEvent.click(within(dialog()!).getByRole('button', { name: L.qrModalClose }));
    await settle();
    expect(view.container.innerHTML).not.toMatch(/bk=/);
    const stored = (storage: Storage) =>
      Array.from({ length: storage.length }, (_, i) => `${storage.key(i)}=${storage.getItem(storage.key(i)!)}`).join('\n');
    expect(stored(localStorage)).toContain('amount=1000');
    expect(stored(localStorage)).not.toContain('bk=');
    expect(stored(sessionStorage)).not.toContain('bk=');
  });
});

describe('決済QR: QR の画面と残高の見張りは、bill key を載せても同じ', () => {
  it.each([
    ['金額だけ', '1000', {}],
    ['店名・商品名・メモ・税', '1400', { storeName: 'OpenPay Cafe', productName: 'ランチ', memo: '店内', taxRate: 10, taxCategory: 'taxable_10' }],
    ['Kaia', '500', { chain: 'kaia' }],
  ])('%s: QR の画面の DOM は QR の中身の `&bk=…` だけが違い、残高の見張りに渡す値は 1 つも違わない', async (_name, amount, settings) => {
    const capture = async () => {
      h.watchArgs = [];
      const { dialog: d, view } = await openQr(amount, settings);
      // QR の <svg> の中 (path) は中身で変わるので外し、渡した値 (data 属性) で比べる。
      const copy = d.cloneNode(true) as HTMLElement;
      for (const svg of copy.querySelectorAll('svg')) svg.replaceChildren();
      // 残高の見張りに渡した値の並び (同じ値が続く再描画は 1 つに数える)。
      const watch = h.watchArgs.filter((args, i, all) => args !== all[i - 1]);
      const out = { html: copy.outerHTML, watch, value: mainQrValue(d) };
      view.unmount();
      localStorage.clear();
      return out;
    };
    const withKey = await capture();
    h.billKeyOff = true;
    const without = await capture();
    expect(without.value).not.toMatch(/bk=/);
    const billKey = BK_SUFFIX.exec(withKey.value)![1];
    expect(withKey.html).not.toBe(without.html);
    // QR の値は、viewBox (module の数) と一緒に svg の属性にある。値の `&bk=…` と、module の数が変わる属性だけが違う。
    const strip = (html: string) => html.replace(`&amp;bk=${billKey}`, '').replace(/ viewBox="[^"]*"/g, '');
    expect(strip(withKey.html)).toBe(strip(without.html));
    expect(withKey.watch).toEqual(without.watch);
    expect(withKey.watch.length).toBeGreaterThan(0);
    expect(JSON.parse(withKey.watch.at(-1)!)).toMatchObject({ enabled: true, receiver: RECEIVER });
  });
});

describe('決済QR → 見張り → 取引履歴', () => {
  function Page({ tab }: { tab: 'qr' | 'other' }) {
    useQrSaleWatchScope();
    return tab === 'qr' ? <QrGenerator /> : <p>別のタブ</p>;
  }
  const payment = (billKey: string, block: bigint, tx: string, over: { merchantValue?: bigint; feeValue?: bigint } = {}) => {
    const sale = {
      from: CUSTOMER, merchant: RECEIVER, merchantValue: over.merchantValue ?? 1_398n * ONE,
      feeValue: over.feeValue ?? 2n * ONE, validBefore: BLOCK_TIME + 296n, chainId: 80002, forwarder: FORWARDER,
    };
    return settledRpcLog({ ...sale, nonce: billNonce(billKey, sale), txHash: tx, blockNumber: block });
  };
  const TX1 = `0x${'c1'.repeat(32)}`;
  const TX2 = `0x${'c2'.repeat(32)}`;

  it('画面が出した bill key で署名された入金が、画面の設定 (店名・商品名・メモ・税・管理番号) つきの行になる。閉じた後・タブを切り替えた後の入金も', async () => {
    seed({ storeName: 'OpenPay Cafe', productName: 'ランチ', memo: '店内', taxRate: 10, taxCategory: 'taxable_10' });
    const view = renderWithIntl(<Page tab="qr" />);
    await settle();
    fireEvent.change(qrAmountInput(), { target: { value: '1400' } });
    fireEvent.change(screen.getByPlaceholderText(L.receiptNoPlaceholder), { target: { value: 'R-7' } });
    await settle();
    fireEvent.click(showButtons()[0]);
    await settle();
    const billKey = BK_SUFFIX.exec(mainQrValue(dialog()!))![1];
    await tick();
    expect(rpc.logs).toHaveBeenCalledWith(80002, FORWARDER, [RECEIVER], 910n, 997n);
    expect(loadHistory()).toEqual([]);

    // QR を閉じ、別のタブへ移る (QrGenerator が外れる)。その後に入金が取り込まれる。
    fireEvent.click(within(dialog()!).getByRole('button', { name: L.qrModalClose }));
    await settle();
    view.rerender(<Page tab="other" />);
    await settle();
    rpc.head.mockResolvedValue(1_010n);
    rpc.logs.mockResolvedValue([payment(billKey, 1_003n, TX1), payment(billKey, 1_004n, TX2)]);
    await tick();
    const [second, first] = loadHistory();
    expect(first).toMatchObject({
      id: `batch-${TX1}`,
      ts: Number(BLOCK_TIME) * 1000,
      merchant: RECEIVER,
      customer: CUSTOMER,
      merchantAmount: (1_398n * ONE).toString(),
      saleAmount: (1_400n * ONE).toString(),
      networkFeeEquivalent: (2n * ONE).toString(),
      feeAmount: '0',
      storeName: 'OpenPay Cafe',
      productName: 'ランチ',
      memo: '店内',
      taxRate: 10,
      taxCategory: 'taxable_10',
      receiptNo: 'R-7',
    });
    expect(first.lineItems).toEqual([
      { name: 'ランチ', quantity: 1, unitPrice: '1400', amount: '1400', taxRate: 10, taxCategory: 'taxable_10', memo: '店内' },
    ]);
    // 同じ QR への 2 回目の入金は明細なし。
    expect(second).toMatchObject({ id: `batch-${TX2}`, receiptNo: null, lineItems: null, storeName: '' });

    // /create を離れたら、見張りは止まる。
    const reads = rpc.head.mock.calls.length;
    view.unmount();
    await settle();
    await tick(5);
    expect(rpc.head).toHaveBeenCalledTimes(reads);
  });
});
