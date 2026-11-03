import { createHash } from 'node:crypto';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';

// F-8 PR-21 (QrGenerator をセクション単位の component に分ける) の網。期待値はすべて分割前の component
// (origin/main dc2b0659) で採取したもの。分割に合わせて採り直さない — 生成物や hash が変わったら、DOM か
// 支払い URL が変わったので、分割の方を直す。この画面は支払い URL を作るので、生成物の完全一致を先に固定する
// (計画 P4 の停止条件)。固定するもの:
//   - 生成物の完全一致 (通貨 × チェーン × 金額 (空・小数・桁の多い額・最小単位) × 支払い方法 × 明細・値引き・
//     為替換算・ENS 名・回収 / 無料の経路・en): QR に渡す値 (主 QR と互換 QR (EIP-681))・画面に出す URL・
//     クリップボードに書く値 (URL と EIP-681)・SVG / PNG の保存名・印刷・「前回の受け取り QR」の保存値・
//     着金の見張りに渡す値 (受取先・トークン・チェーン・期待額・有効か)・QR の画面の DOM の sha256
//   - 「お店がガス代を肩代わりして送る」(flag ON) の /checkout の QR (受け渡しの id 付き) の完全一致と、受け渡しを
//     作る呼び出しの引数 (受取先・請求額 wei・チェーン)・通常の QR に切り替えたときの QR と利用料の開示
//   - 全 DOM の sha256 (主な状態: 新規・入力済み・設定シート・据え置き・QR の画面 (ガスレス・通常決済と EIP-681・
//     回収・為替換算・Arc・着金)・値引き・明細・en・お店負担の各状態)
//   - 子 component に分けても入力欄・QR の画面・設定シートを作り直さないこと (node の同一性と focus) と、QR の画面を
//     作り直す条件 (閉じて開き直したとき・出せなくなったら閉じて勝手に開き直さない) が変わらないこと
// 支払い URL の各 param の意味・節ごとの DOM の digest・既存の振る舞いは QrGenerator.extraction.test.tsx (R11b) と
// QrGenerator*.test.tsx が固定している。

const h = vi.hoisted(() => ({
  storeGas: false,
  provider: 'pimlico-7702' as string,
  forwarders: {} as Record<number, `0x${string}`>,
  resolve: {} as Record<string, `0x${string}`>,
  balance: undefined as bigint | undefined,
  account: { address: undefined as `0x${string}` | undefined, isConnected: false },
  watch: [] as Array<Record<string, unknown>>,
  rates: { data: { usdcJpy: 150, updatedAt: '2026-09-24T00:00:00.000Z' }, isLoading: false, isError: false, refetch: () => {} },
}));
// 「お店の端末で送る」の状態 (作成ページで 1 つ)。active = false の間は本物の hook (Provider の外の単独の状態) を使う。
const sd = vi.hoisted(() => ({
  active: false,
  busy: false,
  enabled: true,
  blocked: null as null | 'no_locks' | 'config',
  gasAddress: '0x0000000000000000000000000000000000000abc' as string | null | undefined,
  state: { phase: 'idle' } as Record<string, unknown>,
  pending: false,
  start: vi.fn(),
  stop: vi.fn(),
  releaseForNormal: vi.fn(),
  setOn: vi.fn(),
  setGasAddress: vi.fn(),
  checkNow: vi.fn(),
  retry: vi.fn(),
  dismiss: vi.fn(),
}));

vi.mock('wagmi', () => ({
  useAccount: () => h.account,
  useReadContract: () => ({ data: h.balance }),
}));
vi.mock('@/hooks/useResolveAddress', () => ({
  useResolveAddress: (input: string) => {
    const address = h.resolve[input.trim().toLowerCase()];
    return { data: address ? { address } : null, isFetching: false, error: null };
  },
}));
vi.mock('@/hooks/useOrigin', () => ({ useOrigin: () => 'https://test.local' }));
vi.mock('@/hooks/useMarketRates', () => ({ useMarketRates: () => h.rates }));
vi.mock('@/lib/jpycGaslessProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/jpycGaslessProvider')>()),
  resolveJpycGaslessProvider: () => h.provider,
}));
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/forwarderConfig')>()),
  jpycForwarderFor: (chainId: number) => h.forwarders[chainId] ?? null,
}));
// この画面が読む flag は enableStoreGasWallet だけ (テストごとに切り替える)。Arc の USDC と Avalanche の JPYC は
// チェーンの一覧 (lib/chains の読み込み時に決まる) に入れて、Arc の表示と Avalanche の生成物も固定する。
// feeReceiver はお店負担の対象チェーンの判定に要る (flag ON のときだけ)。
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (target, key) =>
        key === 'enableStoreGasWallet'
          ? h.storeGas
          : key === 'feeReceiver' && h.storeGas
            ? '0x428483FbA62eDCef1E3a100d3799F6d71759c560'
            : key === 'enableUsdcArc' || key === 'enableJpycAvalanche'
              ? true
              : Reflect.get(target, key),
    }),
  };
});
// 着金の見張りに渡す値を記録する (中身は本物)。
vi.mock('@/hooks/useIncomingPaymentWatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useIncomingPaymentWatch')>();
  return {
    ...actual,
    useIncomingPaymentWatch: (args: Parameters<typeof actual.useIncomingPaymentWatch>[0]) => {
      h.watch.push({ ...args, expectedAmountWei: String(args.expectedAmountWei) });
      return actual.useIncomingPaymentWatch(args);
    },
  };
});
// QR に渡す値をそのまま読む (描画は本物の qrcode.react・値は data 属性に写すだけ = DOM の hash では外す)。
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
            setOn: sd.setOn,
            gasAddress: sd.gasAddress,
            setGasAddress: sd.setGasAddress,
            chainIds: [80002, 1001],
            blocked: sd.blocked,
            enabled: sd.enabled,
            device: {
              state: sd.state,
              busy: sd.busy,
              start: sd.start,
              stop: sd.stop,
              releaseForNormal: sd.releaseForNormal,
              hasPendingSale: () => sd.pending,
              checkNow: sd.checkNow,
              retry: sd.retry,
              dismiss: sd.dismiss,
            },
          }
        : actual.useStoreDeviceMode(),
  };
});

import { QrGenerator } from '@/components/QrGenerator';

type Locale = 'ja' | 'en';

const RECEIVER = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ENS_ADDRESS = '0x000000000000000000000000000000000000dEaD';
const SPLIT = '0x2222222222222222222222222222222222222222';
const SPLIT2 = '0x3333333333333333333333333333333333333333';
const FORWARDER = '0x1234567890123456789012345678901234567890';
const HS = 'AbCdEfGhIjKlMnOpQrStUv';
const NOW = Date.parse('2026-09-24T00:00:00.000Z');
const SETTINGS_KEY = 'openpay:qr-settings:v2';
const LAST_QR_KEY = 'openpay:lastQr:v1';
const frames = new Map<number, FrameRequestCallback>();
const writeText = vi.fn(async (_value: string) => {});

let locale: Locale = 'ja';
let container: HTMLElement;
const msgs = () => (locale === 'ja' ? ja : en);
const L = () => msgs().QrGenerator;

function seed(settings: Record<string, unknown> = {}) {
  localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({ receiver: RECEIVER, receiverSource: 'manual', ...settings }),
  );
}

function renderQr() {
  const view = renderWithIntl(<QrGenerator />, { locale });
  container = view.container;
  return view;
}

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20);
  });
}

function flushFrames() {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(0);
}

// 金額欄は名前 (aria-label =見出しと同じ「請求金額 (JPYC)」・値引きを開くと「値引き前の金額」) で探す (淡い例の額の placeholder は 2026-11-03 にやめた)。
function amountInput() {
  return container.querySelector<HTMLInputElement>(
    'input[aria-label^="請求金額"], input[aria-label^="値引き前の金額"], input[aria-label^="Amount"]',
  )!;
}
function setAmount(value: string) {
  fireEvent.change(amountInput(), { target: { value } });
}
function receiverInput() {
  return screen.getByPlaceholderText(msgs().AddressInput.placeholder);
}
function settingsButton() {
  return screen.getByRole('button', { name: new RegExp(`^${L().shopSettings.open}$`) });
}
function settingsSheet() {
  return screen.queryByRole('dialog', { name: L().shopSettings.title });
}
function closeSettings() {
  const sheet = settingsSheet();
  if (sheet) fireEvent.click(within(sheet).getByRole('button', { name: L().shopSettings.done }));
}
function qrDialog() {
  return screen.queryByRole('dialog', { name: L().qrModalTitle });
}
function showQrButtons() {
  return screen.getAllByRole('button', { name: L().showQr });
}
function addDiscount(value: string) {
  fireEvent.click(screen.getByRole('button', { name: msgs().Discount.add }));
  fireEvent.change(screen.getByLabelText(msgs().Discount.amountInput), { target: { value } });
}
function convertButton() {
  return screen.getByRole('button', {
    name: new RegExp(`^${L().convertButton.replace('{symbol}', '(JPYC|USDC)')}$`),
  });
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

// この画面の <svg> は lucide-react の icon と QR (qrcode.react)。版更新で path data や既定の描画属性が変わると
// 自前の code と無関係に hash が落ちるので、複製した tree の各 <svg> の子を空にし、属性は配置と a11y に効く
// class/width/height/role/aria-* だけ残し、class からも lucide / lucide-* を外す (R10a・R11b・PR-19・PR-20 の網と
// 同じ規則・QR に写した data-qr-value もここで外れる)。QR の中身は data-qr-value の完全一致で別に固定する。
const SVG_KEPT_ATTR = /^(class|width|height|role|aria-.+)$/;
function normalized(root: Element) {
  const copy = root.cloneNode(true) as Element;
  for (const svg of copy.querySelectorAll('svg')) {
    svg.replaceChildren();
    for (const { name } of [...svg.attributes]) if (!SVG_KEPT_ATTR.test(name)) svg.removeAttribute(name);
    const cls = svg.getAttribute('class');
    if (cls !== null) {
      svg.setAttribute('class', cls.split(/\s+/).filter((c) => c && c !== 'lucide' && !c.startsWith('lucide-')).join(' '));
    }
  }
  return copy;
}
// all = 全 DOM の sha256 (網の本体)。parts = 最上段の 2 つ (前回の QR の枠・grid) のうち grid の子 (左列・会計
// パネル・設定シート・QR の画面・下部バー) と前回の QR の枠の短い hash と冒頭の文字で、落ちたときにどの節が
// 変わったかを snapshot の diff に出す補助 (all は弱めない)。下部バーの再描画 frame を先に消化して style を確定させる。
function hashDom() {
  flushFrames();
  const dom = normalized(container);
  const [offline, grid, ...outside] = [...dom.children];
  return {
    all: sha256(dom.innerHTML),
    parts: [offline, ...grid.children, ...outside].map((el) => (
      `${el.tagName.toLowerCase()} ${sha256(el.outerHTML).slice(0, 12)} ${el.textContent!.slice(0, 16)}`
    )),
  };
}

// SVG / PNG の保存 (ファイル名と保存の形式) を読む。保存の処理は components/qr/qrDownload.ts (分割の対象外)。
function captureDownloads(dialog: HTMLElement): string[] {
  const saved: string[] = [];
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push(`${this.download} <- ${this.href.split(/[,:]/)[0]}:${this.href.split(':')[1]?.split(/[;,]/)[0]}`);
  });
  const createObjectURL = vi.fn(() => 'blob:pinned');
  const revokeObjectURL = vi.fn();
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillStyle: '',
    fillRect: () => {},
    drawImage: () => {},
  } as unknown as CanvasRenderingContext2D);
  const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,pinned');
  const RealImage = globalThis.Image;
  class TestImage {
    width = 340;
    onload: (() => void) | null = null;
    set src(_value: string) {
      this.onload?.();
    }
  }
  globalThis.Image = TestImage as unknown as typeof Image;
  try {
    for (const name of [L().downloadSvg, L().downloadPng]) {
      const button = within(dialog).queryByRole('button', { name });
      if (button) fireEvent.click(button);
    }
  } finally {
    globalThis.Image = RealImage;
    click.mockRestore();
    getContext.mockRestore();
    toDataURL.mockRestore();
  }
  return saved;
}

type Watch = { receiver: unknown; tokenAddress: unknown; chainId: unknown; expectedAmountWei: unknown; enabled: unknown };
function lastWatch(): Watch | null {
  const last = h.watch.at(-1);
  if (!last) return null;
  const { receiver, tokenAddress, chainId, expectedAmountWei, enabled } = last as Watch;
  return { receiver, tokenAddress, chainId, expectedAmountWei, enabled };
}

// QR の画面が出している生成物を全部読む (画面の hash を先に採ってから、コピー・保存・印刷を押す)。
async function modalOutputs(dialog: HTMLElement) {
  const modal = sha256(normalized(dialog).outerHTML);
  const qr = dialog.querySelector('svg[data-qr-value][width="340"]')?.getAttribute('data-qr-value') ?? null;
  const eip681 = dialog.querySelector('svg[data-qr-value][width="180"]')?.getAttribute('data-qr-value') ?? null;
  const tag = (value: string | null | undefined) =>
    value === undefined || value === null ? null : value === qr ? '=qr' : value === eip681 ? '=eip681' : value;
  const shownUrl = within(dialog).queryByText(/^https:\/\/test\.local\//)?.textContent;
  const shownEip681 = within(dialog).queryByText(/^ethereum:/)?.textContent;
  writeText.mockClear();
  for (const name of [L().qrCopy, L().eip681Copy]) {
    const button = within(dialog).queryByRole('button', { name });
    if (button) {
      await act(async () => {
        fireEvent.click(button);
      });
    }
  }
  const copies = writeText.mock.calls.map(([value]) => tag(value));
  const downloads = captureDownloads(dialog);
  const print = vi.spyOn(window, 'print').mockImplementation(() => {});
  const printButton = within(dialog).queryByRole('button', { name: L().printPoster });
  if (printButton) fireEvent.click(printButton);
  const printed = print.mock.calls.length;
  print.mockRestore();
  const raw = localStorage.getItem(LAST_QR_KEY);
  const lastQr = raw ? { ...JSON.parse(raw), payUrl: tag(JSON.parse(raw).payUrl) } : null;
  return {
    qr,
    eip681,
    shownUrl: tag(shownUrl),
    shownEip681: tag(shownEip681),
    copies,
    downloads,
    printed,
    lastQr,
    watch: lastWatch(),
    modal,
  };
}

type Case = {
  settings?: Record<string, unknown> | null;
  amount: string | null;
  locale?: Locale;
  provider?: string;
  forwarder?: boolean;
  resolve?: Record<string, `0x${string}`>;
  typeReceiver?: string;
  receipt?: string;
  discount?: string;
  convert?: boolean;
};

async function generated(c: Case) {
  locale = c.locale ?? 'ja';
  h.provider = c.provider ?? 'pimlico-7702';
  h.forwarders = c.forwarder ? { 80002: FORWARDER, 1001: FORWARDER, 43113: FORWARDER } : {};
  h.resolve = c.resolve ?? {};
  localStorage.clear();
  if (c.settings !== null) seed(c.settings);
  const view = renderQr();
  await settle();
  if (c.typeReceiver !== undefined) {
    fireEvent.change(receiverInput(), { target: { value: c.typeReceiver } });
    await settle();
  }
  if (c.amount === null) fireEvent.click(screen.getByRole('button', { name: L().modeStatic }));
  else setAmount(c.amount);
  await settle();
  if (c.receipt !== undefined) {
    fireEvent.change(screen.getByPlaceholderText(L().receiptNoPlaceholder), { target: { value: c.receipt } });
  }
  if (c.discount !== undefined) addDiscount(c.discount);
  if (c.convert) fireEvent.click(convertButton());
  await settle();
  const [button] = showQrButtons();
  let out: Record<string, unknown>;
  if (button.hasAttribute('disabled')) {
    fireEvent.click(button);
    await settle();
    out = { qr: null, dialog: qrDialog() !== null, amountShown: amountInput().value };
  } else {
    fireEvent.click(button);
    await settle();
    out = await modalOutputs(qrDialog()!);
  }
  view.unmount();
  return out;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
  frames.clear();
  let frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  h.storeGas = false;
  h.provider = 'pimlico-7702';
  h.forwarders = {};
  h.resolve = {};
  h.balance = undefined;
  h.account = { address: undefined, isConnected: false };
  h.watch = [];
  sd.active = false;
  sd.busy = false;
  sd.enabled = true;
  sd.blocked = null;
  sd.gasAddress = '0x0000000000000000000000000000000000000abc';
  sd.state = { phase: 'idle' };
  sd.pending = false;
  sd.start.mockReset().mockResolvedValue({ id: HS, token: 'ab'.repeat(32), expiresAt: 0, merchant: RECEIVER, amount: '1', chainId: 80002 });
  sd.stop.mockReset();
  sd.releaseForNormal.mockReset().mockResolvedValue(true);
  sd.setOn.mockReset();
  writeText.mockClear();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  locale = 'ja';
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('QrGenerator pre-split pinning (F-8 PR-21)', () => {
  it('pins every generated JPYC output (chains・amounts・pay modes・accounting・discount・FX・ENS・recover / free・en)', async () => {
    const cases: Record<string, Case> = {
      polygonGasless: { amount: '1000' },
      polygonStatic: { amount: null },
      polygonEmptyAmount: { amount: '' },
      freshTypedReceiver: { settings: null, typeReceiver: RECEIVER, amount: '2500' },
      kaiaDecimal: { settings: { chain: 'kaia' }, amount: '0.5' },
      avalancheLarge18Decimals: { settings: { chain: 'avalanche' }, amount: '123456789.123456789012345678' },
      polygonStandardLarge: { settings: { payMode: 'standard' }, amount: '1234567.89' },
      kaiaStandardStatic: { settings: { chain: 'kaia', payMode: 'standard' }, amount: null },
      accountingMeta: {
        settings: {
          storeName: ' 神田 & Coffee ',
          productName: '豆/袋 🎉',
          memo: 'A+B = 1?#',
          taxRate: 8,
          taxCategory: 'taxable_8',
          invoiceNo: 't-1234-5678-90123',
          posterNote: 'ありがとう',
        },
        receipt: 'R-001#?',
        amount: '750',
      },
      recover: { provider: 'eip3009-relay', forwarder: true, settings: { gasMode: 'customer' }, amount: '500' },
      recoverFloor: { provider: 'eip3009-relay', forwarder: true, amount: '3' },
      recoverKaiaStatic: { provider: 'eip3009-relay', forwarder: true, settings: { chain: 'kaia' }, amount: null },
      free: { provider: 'eip3009-relay', settings: { gasMode: 'merchant' }, amount: '500' },
      discount: { amount: '1000', discount: '20' },
      // JPYC の値引きは 1 円単位 (端数は直すまで QR を出さない)。
      discountInvalidFraction: { amount: '1000', discount: '20.5' },
      ensReceiver: { settings: { receiver: 'shop.eth' }, resolve: { 'shop.eth': ENS_ADDRESS }, amount: '100' },
      fxToUsdc: { amount: '1000', convert: true },
      en: { locale: 'en', settings: { storeName: 'Cafe', chain: 'kaia' }, amount: '42' },
    };
    const outputs: Record<string, unknown> = {};
    for (const [name, c] of Object.entries(cases)) outputs[name] = await generated(c);
    expect(outputs).toMatchInlineSnapshot(`
      {
        "accountingMeta": {
          "copies": [
            "=qr",
          ],
          "downloads": [
            "神田-&-Coffee-豆-袋-🎉-jpyc-polygon-750.svg <- blob:pinned",
            "神田-&-Coffee-豆-袋-🎉-jpyc-polygon-750.png <- data:image/png",
          ],
          "eip681": null,
          "lastQr": {
            "amountLabel": "750 JPYC",
            "payUrl": "=qr",
            "storeName": "神田 & Coffee",
            "tokenChainLabel": "JPYC · Polygon Amoy",
            "ts": 1790208000720,
          },
          "modal": "27adadeb7aaf36a9579d676f4064b2c94a45393c8000ed760b12d18036944bc0",
          "printed": 1,
          "qr": "https://test.local/pay?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=jpyc&amount=750&store=%E7%A5%9E%E7%94%B0+%26+Coffee&pname=%E8%B1%86%2F%E8%A2%8B+%F0%9F%8E%89&memo=A%2BB+%3D+1%3F%23&tax=8&taxcat=taxable_8&rcpt=R-001%23%3F&inv=T1234567890123",
          "shownEip681": null,
          "shownUrl": "=qr",
          "watch": {
            "chainId": 80002,
            "enabled": true,
            "expectedAmountWei": "750000000000000000000",
            "receiver": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "tokenAddress": "0x0000000000000000000000000000000000000aBc",
          },
        },
        "avalancheLarge18Decimals": {
          "copies": [
            "=qr",
            "=eip681",
          ],
          "downloads": [
            "openpay-jpyc-avalanche-123456789-123456789012345678.svg <- blob:pinned",
            "openpay-jpyc-avalanche-123456789-123456789012345678.png <- data:image/png",
          ],
          "eip681": "ethereum:0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29@43113/transfer?address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&uint256=123456789123456789012345678",
          "lastQr": {
            "amountLabel": "123,456,789.123456789012345678 JPYC",
            "payUrl": "=qr",
            "tokenChainLabel": "JPYC · Avalanche Fuji",
            "ts": 1790208000480,
          },
          "modal": "f6df3812e0447d622b7ab78d808d410458653bd146ace04f25575efb4658e137",
          "printed": 1,
          "qr": "https://test.local/pay?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=jpyc&chain=avalanche&amount=123456789.123456789012345678&mode=standard",
          "shownEip681": "=eip681",
          "shownUrl": "=qr",
          "watch": {
            "chainId": 43113,
            "enabled": true,
            "expectedAmountWei": "123456789123456789012345678",
            "receiver": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "tokenAddress": "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
          },
        },
        "discount": {
          "copies": [
            "=qr",
          ],
          "downloads": [
            "openpay-jpyc-polygon-980.svg <- blob:pinned",
            "openpay-jpyc-polygon-980.png <- data:image/png",
          ],
          "eip681": null,
          "lastQr": {
            "amountLabel": "980 JPYC",
            "payUrl": "=qr",
            "tokenChainLabel": "JPYC · Polygon Amoy",
            "ts": 1790208001120,
          },
          "modal": "946e65f8372fb54d69ba1a01f91a92283818e5e91f08edfce51d4a96558a6bfc",
          "printed": 1,
          "qr": "https://test.local/pay?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=jpyc&amount=980&disc=20",
          "shownEip681": null,
          "shownUrl": "=qr",
          "watch": {
            "chainId": 80002,
            "enabled": true,
            "expectedAmountWei": "980000000000000000000",
            "receiver": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "tokenAddress": "0x0000000000000000000000000000000000000aBc",
          },
        },
        "discountInvalidFraction": {
          "amountShown": "1,000",
          "dialog": false,
          "qr": null,
        },
        "en": {
          "copies": [
            "=qr",
          ],
          "downloads": [
            "Cafe-jpyc-kaia-42.svg <- blob:pinned",
            "Cafe-jpyc-kaia-42.png <- data:image/png",
          ],
          "eip681": null,
          "lastQr": {
            "amountLabel": "42 JPYC",
            "payUrl": "=qr",
            "storeName": "Cafe",
            "tokenChainLabel": "JPYC · Kairos Testnet",
            "ts": 1790208001440,
          },
          "modal": "77b269ce8bcb1428199551559341df2345a44a56bff48b845c0b341b34d7dbd1",
          "printed": 1,
          "qr": "https://test.local/pay?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=jpyc&chain=kaia&amount=42&store=Cafe",
          "shownEip681": null,
          "shownUrl": "=qr",
          "watch": {
            "chainId": 1001,
            "enabled": true,
            "expectedAmountWei": "42000000000000000000",
            "receiver": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "tokenAddress": "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
          },
        },
        "ensReceiver": {
          "copies": [
            "=qr",
          ],
          "downloads": [
            "openpay-jpyc-polygon-100.svg <- blob:pinned",
            "openpay-jpyc-polygon-100.png <- data:image/png",
          ],
          "eip681": null,
          "lastQr": {
            "amountLabel": "100 JPYC",
            "payUrl": "=qr",
            "tokenChainLabel": "JPYC · Polygon Amoy",
            "ts": 1790208001280,
          },
          "modal": "77587e6f86f4c307f454e6e1dafce19c372837a250967a05eb2052b2ab9e9609",
          "printed": 1,
          "qr": "https://test.local/pay?to=0x000000000000000000000000000000000000dEaD&token=jpyc&amount=100",
          "shownEip681": null,
          "shownUrl": "=qr",
          "watch": {
            "chainId": 80002,
            "enabled": true,
            "expectedAmountWei": "100000000000000000000",
            "receiver": "0x000000000000000000000000000000000000dEaD",
            "tokenAddress": "0x0000000000000000000000000000000000000aBc",
          },
        },
        "free": {
          "copies": [
            "=qr",
          ],
          "downloads": [
            "openpay-jpyc-polygon-500.svg <- blob:pinned",
            "openpay-jpyc-polygon-500.png <- data:image/png",
          ],
          "eip681": null,
          "lastQr": {
            "amountLabel": "500 JPYC",
            "payUrl": "=qr",
            "tokenChainLabel": "JPYC · Polygon Amoy",
            "ts": 1790208001040,
          },
          "modal": "578ad230b7c10ecc5d4beb994048f01dff0a84b83f5c4ebd14fe525964b931c3",
          "printed": 1,
          "qr": "https://test.local/pay?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=jpyc&amount=500",
          "shownEip681": null,
          "shownUrl": "=qr",
          "watch": {
            "chainId": 80002,
            "enabled": true,
            "expectedAmountWei": "500000000000000000000",
            "receiver": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "tokenAddress": "0x0000000000000000000000000000000000000aBc",
          },
        },
        "freshTypedReceiver": {
          "copies": [
            "=qr",
          ],
          "downloads": [
            "openpay-jpyc-polygon-2500.svg <- blob:pinned",
            "openpay-jpyc-polygon-2500.png <- data:image/png",
          ],
          "eip681": null,
          "lastQr": {
            "amountLabel": "2,500 JPYC",
            "payUrl": "=qr",
            "tokenChainLabel": "JPYC · Polygon Amoy",
            "ts": 1790208000320,
          },
          "modal": "374aed62592bb157f61fbdb4eced8e42094b6c5d225ef36d62b204b096dd99ee",
          "printed": 1,
          "qr": "https://test.local/pay?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=jpyc&amount=2500",
          "shownEip681": null,
          "shownUrl": "=qr",
          "watch": {
            "chainId": 80002,
            "enabled": true,
            "expectedAmountWei": "2500000000000000000000",
            "receiver": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "tokenAddress": "0x0000000000000000000000000000000000000aBc",
          },
        },
        "fxToUsdc": {
          "copies": [
            "=qr",
          ],
          "downloads": [
            "openpay-usdc-polygon-6-666667.svg <- blob:pinned",
            "openpay-usdc-polygon-6-666667.png <- data:image/png",
          ],
          "eip681": null,
          "lastQr": {
            "amountLabel": "6.666667 USDC",
            "payUrl": "=qr",
            "tokenChainLabel": "USDC · Base Sepolia / Arbitrum Sepolia / OP Sepolia / Polygon Amoy / Sepolia / Avalanche Fuji / Unichain Sepolia / World Chain Sepolia / Sonic Blaze Testnet / Sei Testnet / HyperEVM Testnet",
            "ts": 1790208001360,
          },
          "modal": "c8dea8a165fa703f8d218fbae4cb4233e3f98d384b4fb9fd8c1a47009dc55018",
          "printed": 1,
          "qr": "https://test.local/pay?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=usdc&chain=polygon&amount=6.666667&exp=1790208181&refAmt=1000&fxRate=150",
          "shownEip681": null,
          "shownUrl": "=qr",
          "watch": {
            "chainId": 80002,
            "enabled": true,
            "expectedAmountWei": "6666667",
            "receiver": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "tokenAddress": "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582",
          },
        },
        "kaiaDecimal": {
          "copies": [
            "=qr",
          ],
          "downloads": [
            "openpay-jpyc-kaia-0-5.svg <- blob:pinned",
            "openpay-jpyc-kaia-0-5.png <- data:image/png",
          ],
          "eip681": null,
          "lastQr": {
            "amountLabel": "0.5 JPYC",
            "payUrl": "=qr",
            "tokenChainLabel": "JPYC · Kairos Testnet",
            "ts": 1790208000400,
          },
          "modal": "c0fa3085d4bfa1878558ee1f0aeeecc1bd5e199e5ac32291302b0489836355c5",
          "printed": 1,
          "qr": "https://test.local/pay?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=jpyc&chain=kaia&amount=0.5",
          "shownEip681": null,
          "shownUrl": "=qr",
          "watch": {
            "chainId": 1001,
            "enabled": true,
            "expectedAmountWei": "500000000000000000",
            "receiver": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "tokenAddress": "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
          },
        },
        "kaiaStandardStatic": {
          "copies": [
            "=qr",
          ],
          "downloads": [
            "openpay-jpyc-kaia-open.svg <- blob:pinned",
            "openpay-jpyc-kaia-open.png <- data:image/png",
          ],
          "eip681": null,
          "lastQr": {
            "amountLabel": "JPYC で金額を入力",
            "payUrl": "=qr",
            "tokenChainLabel": "JPYC · Kairos Testnet",
            "ts": 1790208000640,
          },
          "modal": "67032bfd27e812bc5b86d8659f0fc50c9a9544f7debf8b1be96bdea7e137639e",
          "printed": 1,
          "qr": "https://test.local/pay?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=jpyc&chain=kaia&mode=standard",
          "shownEip681": null,
          "shownUrl": "=qr",
          "watch": {
            "chainId": 1001,
            "enabled": false,
            "expectedAmountWei": "0",
            "receiver": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "tokenAddress": "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
          },
        },
        "polygonEmptyAmount": {
          "amountShown": "",
          "dialog": false,
          "qr": null,
        },
        "polygonGasless": {
          "copies": [
            "=qr",
          ],
          "downloads": [
            "openpay-jpyc-polygon-1000.svg <- blob:pinned",
            "openpay-jpyc-polygon-1000.png <- data:image/png",
          ],
          "eip681": null,
          "lastQr": {
            "amountLabel": "1,000 JPYC",
            "payUrl": "=qr",
            "tokenChainLabel": "JPYC · Polygon Amoy",
            "ts": 1790208000060,
          },
          "modal": "0bde47b4498cffa6fcf78537060f8dcbd8de170296b8bb4d03a1ea71b84835bf",
          "printed": 1,
          "qr": "https://test.local/pay?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=jpyc&amount=1000",
          "shownEip681": null,
          "shownUrl": "=qr",
          "watch": {
            "chainId": 80002,
            "enabled": true,
            "expectedAmountWei": "1000000000000000000000",
            "receiver": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "tokenAddress": "0x0000000000000000000000000000000000000aBc",
          },
        },
        "polygonStandardLarge": {
          "copies": [
            "=qr",
            "=eip681",
          ],
          "downloads": [
            "openpay-jpyc-polygon-1234567-89.svg <- blob:pinned",
            "openpay-jpyc-polygon-1234567-89.png <- data:image/png",
          ],
          "eip681": "ethereum:0x0000000000000000000000000000000000000aBc@80002/transfer?address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&uint256=1234567890000000000000000",
          "lastQr": {
            "amountLabel": "1,234,567.89 JPYC",
            "payUrl": "=qr",
            "tokenChainLabel": "JPYC · Polygon Amoy",
            "ts": 1790208000560,
          },
          "modal": "4f1c7967555c9b72ac5fb30ef2106e0f8f03f764ca0669e13bc04c9cf035c71a",
          "printed": 1,
          "qr": "https://test.local/pay?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=jpyc&amount=1234567.89&mode=standard",
          "shownEip681": "=eip681",
          "shownUrl": "=qr",
          "watch": {
            "chainId": 80002,
            "enabled": true,
            "expectedAmountWei": "1234567890000000000000000",
            "receiver": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "tokenAddress": "0x0000000000000000000000000000000000000aBc",
          },
        },
        "polygonStatic": {
          "copies": [
            "=qr",
          ],
          "downloads": [
            "openpay-jpyc-polygon-open.svg <- blob:pinned",
            "openpay-jpyc-polygon-open.png <- data:image/png",
          ],
          "eip681": null,
          "lastQr": {
            "amountLabel": "JPYC で金額を入力",
            "payUrl": "=qr",
            "tokenChainLabel": "JPYC · Polygon Amoy",
            "ts": 1790208000140,
          },
          "modal": "23d6d5faa7b0c2c2bd370818b58c2335071ad77c8bab2b9d0b61b6cec169bd7f",
          "printed": 1,
          "qr": "https://test.local/pay?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=jpyc",
          "shownEip681": null,
          "shownUrl": "=qr",
          "watch": {
            "chainId": 80002,
            "enabled": false,
            "expectedAmountWei": "0",
            "receiver": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "tokenAddress": "0x0000000000000000000000000000000000000aBc",
          },
        },
        "recover": {
          "copies": [
            "=qr",
          ],
          "downloads": [
            "openpay-jpyc-polygon-500.svg <- blob:pinned",
            "openpay-jpyc-polygon-500.png <- data:image/png",
          ],
          "eip681": null,
          "lastQr": {
            "amountLabel": "500 JPYC",
            "payUrl": "=qr",
            "tokenChainLabel": "JPYC · Polygon Amoy",
            "ts": 1790208000800,
          },
          "modal": "e93fc78e443b2cb7c46ad7eab901d8b05f3272f2b6b27dc125413247f13bdef7",
          "printed": 1,
          "qr": "https://test.local/pay?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=jpyc&gas=merchant&amount=500",
          "shownEip681": null,
          "shownUrl": "=qr",
          "watch": {
            "chainId": 80002,
            "enabled": true,
            "expectedAmountWei": "498000000000000000000",
            "receiver": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "tokenAddress": "0x0000000000000000000000000000000000000aBc",
          },
        },
        "recoverFloor": {
          "copies": [
            "=qr",
          ],
          "downloads": [
            "openpay-jpyc-polygon-3.svg <- blob:pinned",
            "openpay-jpyc-polygon-3.png <- data:image/png",
          ],
          "eip681": null,
          "lastQr": {
            "amountLabel": "3 JPYC",
            "payUrl": "=qr",
            "tokenChainLabel": "JPYC · Polygon Amoy",
            "ts": 1790208000880,
          },
          "modal": "05ed15f40d6f0f8973a168638dcbaf24d80b734e45ff632536cbd2b96f67c4ba",
          "printed": 1,
          "qr": "https://test.local/pay?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=jpyc&gas=merchant&amount=3",
          "shownEip681": null,
          "shownUrl": "=qr",
          "watch": {
            "chainId": 80002,
            "enabled": true,
            "expectedAmountWei": "1000000000000000000",
            "receiver": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "tokenAddress": "0x0000000000000000000000000000000000000aBc",
          },
        },
        "recoverKaiaStatic": {
          "copies": [
            "=qr",
          ],
          "downloads": [
            "openpay-jpyc-kaia-open.svg <- blob:pinned",
            "openpay-jpyc-kaia-open.png <- data:image/png",
          ],
          "eip681": null,
          "lastQr": {
            "amountLabel": "JPYC で金額を入力",
            "payUrl": "=qr",
            "tokenChainLabel": "JPYC · Kairos Testnet",
            "ts": 1790208000960,
          },
          "modal": "e32a5c2dc2801eba8864f28fdabc3d0c17c52ecb4ec748d3eff69c52669848ae",
          "printed": 1,
          "qr": "https://test.local/pay?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=jpyc&chain=kaia&gas=merchant",
          "shownEip681": null,
          "shownUrl": "=qr",
          "watch": {
            "chainId": 1001,
            "enabled": false,
            "expectedAmountWei": "0",
            "receiver": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "tokenAddress": "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
          },
        },
      }
    `);
  });

  // 回収 (JPYC・forwarder あり) の利用料の下限 (2 JPYC) ちょうどと、それより小さい会計。着金の見張りに渡す期待額
  // (店舗の純受取額) は 0 で止まる (負の額にしない)。上の行列とは別の snapshot にして、行列の採取値 (保存時刻を含む) を
  // 動かさない。期待値は分割前の component で採取したもの。
  it('pins the recover outputs at and below the 2 JPYC floor (the expected amount for the payment watch stops at 0)', async () => {
    const cases: Record<string, Case> = {
      recoverAtFloor: { provider: 'eip3009-relay', forwarder: true, amount: '2' },
      recoverBelowFloor: { provider: 'eip3009-relay', forwarder: true, amount: '1' },
    };
    const outputs: Record<string, Record<string, unknown>> = {};
    for (const [name, c] of Object.entries(cases)) outputs[name] = await generated(c);
    for (const out of Object.values(outputs)) {
      expect(BigInt((out.watch as Watch).expectedAmountWei as string)).toBeGreaterThanOrEqual(0n);
    }
    expect(outputs).toMatchInlineSnapshot(`
      {
        "recoverAtFloor": {
          "copies": [
            "=qr",
          ],
          "downloads": [
            "openpay-jpyc-polygon-2.svg <- blob:pinned",
            "openpay-jpyc-polygon-2.png <- data:image/png",
          ],
          "eip681": null,
          "lastQr": {
            "amountLabel": "2 JPYC",
            "payUrl": "=qr",
            "tokenChainLabel": "JPYC · Polygon Amoy",
            "ts": 1790208000060,
          },
          "modal": "6f79254ff03e87e6044c5ad8a49db9ade2e26454d8231657f4fc581e2b023530",
          "printed": 1,
          "qr": "https://test.local/pay?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=jpyc&gas=merchant&amount=2",
          "shownEip681": null,
          "shownUrl": "=qr",
          "watch": {
            "chainId": 80002,
            "enabled": true,
            "expectedAmountWei": "0",
            "receiver": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "tokenAddress": "0x0000000000000000000000000000000000000aBc",
          },
        },
        "recoverBelowFloor": {
          "copies": [
            "=qr",
          ],
          "downloads": [
            "openpay-jpyc-polygon-1.svg <- blob:pinned",
            "openpay-jpyc-polygon-1.png <- data:image/png",
          ],
          "eip681": null,
          "lastQr": {
            "amountLabel": "1 JPYC",
            "payUrl": "=qr",
            "tokenChainLabel": "JPYC · Polygon Amoy",
            "ts": 1790208000140,
          },
          "modal": "a339a2ca8f66a6c6ee90c715c075502c5398aa040e9320a48409eab6a599b965",
          "printed": 1,
          "qr": "https://test.local/pay?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=jpyc&gas=merchant&amount=1",
          "shownEip681": null,
          "shownUrl": "=qr",
          "watch": {
            "chainId": 80002,
            "enabled": true,
            "expectedAmountWei": "0",
            "receiver": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "tokenAddress": "0x0000000000000000000000000000000000000aBc",
          },
        },
      }
    `);
  });

  it('pins every generated USDC output (chains・cross-chain・split・standard / EIP-681・truncation・smallest unit・Arc・FX・discount)', async () => {
    const cases: Record<string, Case> = {
      baseGasless: { settings: { token: 'usdc', chain: 'base' }, amount: '12.5' },
      arbitrumSplitNoCrossChain: {
        settings: {
          token: 'usdc',
          chain: 'arbitrum',
          gasMode: 'merchant',
          crossChain: false,
          splits: [{ address: SPLIT, percent: '30' }, { address: SPLIT2, percent: '20' }],
        },
        amount: '1.23456789',
      },
      // 分配の 1 件が不正なら分配は URL に入れない (他の param はそのまま)。
      splitWithInvalidEntry: {
        settings: {
          token: 'usdc',
          chain: 'base',
          splits: [{ address: SPLIT, percent: '30' }, { address: SPLIT2, percent: '12.5' }],
        },
        amount: '20',
      },
      optimismStandard: { settings: { token: 'usdc', chain: 'optimism', payMode: 'standard' }, amount: '5' },
      polygonStandardStatic: { settings: { token: 'usdc', chain: 'polygon', payMode: 'standard' }, amount: null },
      ethereumLarge: { settings: { token: 'usdc', chain: 'ethereum' }, amount: '99999999.999999' },
      avalancheSmallestStandard: { settings: { token: 'usdc', chain: 'avalanche', payMode: 'standard' }, amount: '0.000001' },
      arc: { settings: { token: 'usdc', chain: 'arc' }, amount: '3' },
      arcStatic: { settings: { token: 'usdc', chain: 'arc', storeName: 'Arc 店' }, amount: null },
      fxToJpyc: { settings: { token: 'usdc', chain: 'base' }, amount: '12.5', convert: true },
      discount: { settings: { token: 'usdc', chain: 'base', payMode: 'standard' }, amount: '10', discount: '0.25' },
      en: { locale: 'en', settings: { token: 'usdc', chain: 'optimism', memo: 'memo' }, amount: '7.77', receipt: '9' },
    };
    const outputs: Record<string, unknown> = {};
    for (const [name, c] of Object.entries(cases)) outputs[name] = await generated(c);
    expect(outputs).toMatchInlineSnapshot(`
      {
        "arbitrumSplitNoCrossChain": {
          "copies": [
            "=qr",
          ],
          "downloads": [
            "openpay-usdc-arbitrum-1-234567.svg <- blob:pinned",
            "openpay-usdc-arbitrum-1-234567.png <- data:image/png",
          ],
          "eip681": null,
          "lastQr": {
            "amountLabel": "1.234567 USDC",
            "payUrl": "=qr",
            "tokenChainLabel": "USDC · Arbitrum Sepolia",
            "ts": 1790208000140,
          },
          "modal": "6d2330258efd311f58dbb78fcad22bea3b9086d0114f377767dcfca6e6d2fda1",
          "printed": 1,
          "qr": "https://test.local/pay?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=usdc&chain=arbitrum&gas=merchant&amount=1.234567&split=0x2222222222222222222222222222222222222222%3A30%2C0x3333333333333333333333333333333333333333%3A20&crossChain=false",
          "shownEip681": null,
          "shownUrl": "=qr",
          "watch": {
            "chainId": 421614,
            "enabled": true,
            "expectedAmountWei": "1234567",
            "receiver": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "tokenAddress": "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
          },
        },
        "arc": {
          "copies": [
            "=qr",
            "=eip681",
          ],
          "downloads": [
            "openpay-usdc-arc-3.svg <- blob:pinned",
            "openpay-usdc-arc-3.png <- data:image/png",
          ],
          "eip681": "ethereum:0x3600000000000000000000000000000000000000@5042002/transfer?address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&uint256=3000000",
          "lastQr": {
            "amountLabel": "3 USDC",
            "payUrl": "=qr",
            "tokenChainLabel": "USDC · Arc Testnet",
            "ts": 1790208000620,
          },
          "modal": "058925846ea3c2bb7cdd1fb7e13edf3fbf658c7a3435d63db9c5ddc7b0a8ed0d",
          "printed": 1,
          "qr": "https://test.local/pay?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=usdc&chain=arc&amount=3&mode=standard&crossChain=false",
          "shownEip681": "=eip681",
          "shownUrl": "=qr",
          "watch": {
            "chainId": 5042002,
            "enabled": true,
            "expectedAmountWei": "3000000",
            "receiver": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "tokenAddress": "0x3600000000000000000000000000000000000000",
          },
        },
        "arcStatic": {
          "copies": [
            "=qr",
          ],
          "downloads": [
            "Arc-店-usdc-arc-open.svg <- blob:pinned",
            "Arc-店-usdc-arc-open.png <- data:image/png",
          ],
          "eip681": null,
          "lastQr": {
            "amountLabel": "USDC で金額を入力",
            "payUrl": "=qr",
            "storeName": "Arc 店",
            "tokenChainLabel": "USDC · Arc Testnet",
            "ts": 1790208000700,
          },
          "modal": "9358d2e07e93788f84b9396c5c365c91c0c79afcb0ab7ae0a6de5ca26c72b26b",
          "printed": 1,
          "qr": "https://test.local/pay?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=usdc&chain=arc&mode=standard&crossChain=false&store=Arc+%E5%BA%97",
          "shownEip681": null,
          "shownUrl": "=qr",
          "watch": {
            "chainId": 5042002,
            "enabled": false,
            "expectedAmountWei": "0",
            "receiver": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "tokenAddress": "0x3600000000000000000000000000000000000000",
          },
        },
        "avalancheSmallestStandard": {
          "copies": [
            "=qr",
            "=eip681",
          ],
          "downloads": [
            "openpay-usdc-avalanche-0-000001.svg <- blob:pinned",
            "openpay-usdc-avalanche-0-000001.png <- data:image/png",
          ],
          "eip681": "ethereum:0x5425890298aed601595a70AB815c96711a31Bc65@43113/transfer?address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&uint256=1",
          "lastQr": {
            "amountLabel": "0.000001 USDC",
            "payUrl": "=qr",
            "tokenChainLabel": "USDC · Base Sepolia / Arbitrum Sepolia / OP Sepolia / Polygon Amoy / Sepolia / Avalanche Fuji / Unichain Sepolia / World Chain Sepolia / Sonic Blaze Testnet / Sei Testnet / HyperEVM Testnet",
            "ts": 1790208000540,
          },
          "modal": "e4260cc9c6246a5aa2d50471083322946ff74eec1f01f20c0d2b48d1e2b50201",
          "printed": 1,
          "qr": "https://test.local/pay?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=usdc&chain=avalanche&amount=0.000001&mode=standard",
          "shownEip681": "=eip681",
          "shownUrl": "=qr",
          "watch": {
            "chainId": 43113,
            "enabled": true,
            "expectedAmountWei": "1",
            "receiver": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "tokenAddress": "0x5425890298aed601595a70AB815c96711a31Bc65",
          },
        },
        "baseGasless": {
          "copies": [
            "=qr",
          ],
          "downloads": [
            "openpay-usdc-base-12-5.svg <- blob:pinned",
            "openpay-usdc-base-12-5.png <- data:image/png",
          ],
          "eip681": null,
          "lastQr": {
            "amountLabel": "12.5 USDC",
            "payUrl": "=qr",
            "tokenChainLabel": "USDC · Base Sepolia / Arbitrum Sepolia / OP Sepolia / Polygon Amoy / Sepolia / Avalanche Fuji / Unichain Sepolia / World Chain Sepolia / Sonic Blaze Testnet / Sei Testnet / HyperEVM Testnet",
            "ts": 1790208000060,
          },
          "modal": "11488b478b880a5b9dd37d2910d160af1b807156726ec3af444f53f791bf37e7",
          "printed": 1,
          "qr": "https://test.local/pay?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=usdc&amount=12.5",
          "shownEip681": null,
          "shownUrl": "=qr",
          "watch": {
            "chainId": 84532,
            "enabled": true,
            "expectedAmountWei": "12500000",
            "receiver": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "tokenAddress": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          },
        },
        "discount": {
          "copies": [
            "=qr",
            "=eip681",
          ],
          "downloads": [
            "openpay-usdc-base-9-75.svg <- blob:pinned",
            "openpay-usdc-base-9-75.png <- data:image/png",
          ],
          "eip681": "ethereum:0x036CbD53842c5426634e7929541eC2318f3dCF7e@84532/transfer?address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&uint256=9750000",
          "lastQr": {
            "amountLabel": "9.75 USDC",
            "payUrl": "=qr",
            "tokenChainLabel": "USDC · Base Sepolia / Arbitrum Sepolia / OP Sepolia / Polygon Amoy / Sepolia / Avalanche Fuji / Unichain Sepolia / World Chain Sepolia / Sonic Blaze Testnet / Sei Testnet / HyperEVM Testnet",
            "ts": 1790208000860,
          },
          "modal": "9423ceb33020abb32ac0be0aa4fb072e36af28c95f6fb165eb81724d957c2a1f",
          "printed": 1,
          "qr": "https://test.local/pay?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=usdc&amount=9.75&disc=0.25&mode=standard",
          "shownEip681": "=eip681",
          "shownUrl": "=qr",
          "watch": {
            "chainId": 84532,
            "enabled": true,
            "expectedAmountWei": "9750000",
            "receiver": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "tokenAddress": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          },
        },
        "en": {
          "copies": [
            "=qr",
          ],
          "downloads": [
            "openpay-usdc-optimism-7-77.svg <- blob:pinned",
            "openpay-usdc-optimism-7-77.png <- data:image/png",
          ],
          "eip681": null,
          "lastQr": {
            "amountLabel": "7.77 USDC",
            "payUrl": "=qr",
            "tokenChainLabel": "USDC · Base Sepolia / Arbitrum Sepolia / OP Sepolia / Polygon Amoy / Sepolia / Avalanche Fuji / Unichain Sepolia / World Chain Sepolia / Sonic Blaze Testnet / Sei Testnet / HyperEVM Testnet",
            "ts": 1790208000940,
          },
          "modal": "a3350e92ff925736225ff0ca57b2359db4965effd975ba430465dd6b81058c61",
          "printed": 1,
          "qr": "https://test.local/pay?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=usdc&chain=optimism&amount=7.77&memo=memo&rcpt=9",
          "shownEip681": null,
          "shownUrl": "=qr",
          "watch": {
            "chainId": 11155420,
            "enabled": true,
            "expectedAmountWei": "7770000",
            "receiver": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "tokenAddress": "0x5fd84259d66Cd46123540766Be93DFE6D43130D7",
          },
        },
        "ethereumLarge": {
          "copies": [
            "=qr",
          ],
          "downloads": [
            "openpay-usdc-ethereum-99999999-999999.svg <- blob:pinned",
            "openpay-usdc-ethereum-99999999-999999.png <- data:image/png",
          ],
          "eip681": null,
          "lastQr": {
            "amountLabel": "99,999,999.999999 USDC",
            "payUrl": "=qr",
            "tokenChainLabel": "USDC · Base Sepolia / Arbitrum Sepolia / OP Sepolia / Polygon Amoy / Sepolia / Avalanche Fuji / Unichain Sepolia / World Chain Sepolia / Sonic Blaze Testnet / Sei Testnet / HyperEVM Testnet",
            "ts": 1790208000460,
          },
          "modal": "aa91947f0e36e81b388c8e138bf288b6772f955c98a21c3a1a672cbef3c49776",
          "printed": 1,
          "qr": "https://test.local/pay?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=usdc&chain=ethereum&amount=99999999.999999",
          "shownEip681": null,
          "shownUrl": "=qr",
          "watch": {
            "chainId": 11155111,
            "enabled": true,
            "expectedAmountWei": "99999999999999",
            "receiver": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "tokenAddress": "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
          },
        },
        "fxToJpyc": {
          "copies": [
            "=qr",
          ],
          "downloads": [
            "openpay-jpyc-polygon-1875.svg <- blob:pinned",
            "openpay-jpyc-polygon-1875.png <- data:image/png",
          ],
          "eip681": null,
          "lastQr": {
            "amountLabel": "1,875 JPYC",
            "payUrl": "=qr",
            "tokenChainLabel": "JPYC · Polygon Amoy",
            "ts": 1790208000780,
          },
          "modal": "eade324e704e8c7b444824cd0898e1787c63f4b46080d63c2fb60df18b6cc95f",
          "printed": 1,
          "qr": "https://test.local/pay?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=jpyc&amount=1875&exp=1790208180&refAmt=12.5&fxRate=150",
          "shownEip681": null,
          "shownUrl": "=qr",
          "watch": {
            "chainId": 80002,
            "enabled": true,
            "expectedAmountWei": "1875000000000000000000",
            "receiver": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "tokenAddress": "0x0000000000000000000000000000000000000aBc",
          },
        },
        "optimismStandard": {
          "copies": [
            "=qr",
            "=eip681",
          ],
          "downloads": [
            "openpay-usdc-optimism-5.svg <- blob:pinned",
            "openpay-usdc-optimism-5.png <- data:image/png",
          ],
          "eip681": "ethereum:0x5fd84259d66Cd46123540766Be93DFE6D43130D7@11155420/transfer?address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&uint256=5000000",
          "lastQr": {
            "amountLabel": "5 USDC",
            "payUrl": "=qr",
            "tokenChainLabel": "USDC · Base Sepolia / Arbitrum Sepolia / OP Sepolia / Polygon Amoy / Sepolia / Avalanche Fuji / Unichain Sepolia / World Chain Sepolia / Sonic Blaze Testnet / Sei Testnet / HyperEVM Testnet",
            "ts": 1790208000300,
          },
          "modal": "874a09dfcd77c74939bdac582c7c10817c84735e42df9ce87627c7602a6eb3f4",
          "printed": 1,
          "qr": "https://test.local/pay?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=usdc&chain=optimism&amount=5&mode=standard",
          "shownEip681": "=eip681",
          "shownUrl": "=qr",
          "watch": {
            "chainId": 11155420,
            "enabled": true,
            "expectedAmountWei": "5000000",
            "receiver": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "tokenAddress": "0x5fd84259d66Cd46123540766Be93DFE6D43130D7",
          },
        },
        "polygonStandardStatic": {
          "copies": [
            "=qr",
          ],
          "downloads": [
            "openpay-usdc-polygon-open.svg <- blob:pinned",
            "openpay-usdc-polygon-open.png <- data:image/png",
          ],
          "eip681": null,
          "lastQr": {
            "amountLabel": "USDC で金額を入力",
            "payUrl": "=qr",
            "tokenChainLabel": "USDC · Base Sepolia / Arbitrum Sepolia / OP Sepolia / Polygon Amoy / Sepolia / Avalanche Fuji / Unichain Sepolia / World Chain Sepolia / Sonic Blaze Testnet / Sei Testnet / HyperEVM Testnet",
            "ts": 1790208000380,
          },
          "modal": "c9727c46dc094bbc96748f721b4eb3eab5f153e4aef6e577fd280adb788da490",
          "printed": 1,
          "qr": "https://test.local/pay?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=usdc&chain=polygon&mode=standard",
          "shownEip681": null,
          "shownUrl": "=qr",
          "watch": {
            "chainId": 80002,
            "enabled": false,
            "expectedAmountWei": "0",
            "receiver": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "tokenAddress": "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582",
          },
        },
        "splitWithInvalidEntry": {
          "copies": [
            "=qr",
          ],
          "downloads": [
            "openpay-usdc-base-20.svg <- blob:pinned",
            "openpay-usdc-base-20.png <- data:image/png",
          ],
          "eip681": null,
          "lastQr": {
            "amountLabel": "20 USDC",
            "payUrl": "=qr",
            "tokenChainLabel": "USDC · Base Sepolia / Arbitrum Sepolia / OP Sepolia / Polygon Amoy / Sepolia / Avalanche Fuji / Unichain Sepolia / World Chain Sepolia / Sonic Blaze Testnet / Sei Testnet / HyperEVM Testnet",
            "ts": 1790208000220,
          },
          "modal": "d3dd51e2f320dae38bc44cfc2aa3cca400eb8061be4d783b9b593e7dad4d5cfc",
          "printed": 1,
          "qr": "https://test.local/pay?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=usdc&amount=20",
          "shownEip681": null,
          "shownUrl": "=qr",
          "watch": {
            "chainId": 84532,
            "enabled": true,
            "expectedAmountWei": "20000000",
            "receiver": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "tokenAddress": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          },
        },
      }
    `);
  });

  it('pins the DOM of the main states (fresh・typed・settings sheet・static・modals・discount・accounting・en)', async () => {
    const states: Record<string, unknown> = {};
    // 新規 (受取先の欄を会計画面に出す) → 受取先 → 金額 → 設定シート → 据え置き → QR の画面。
    let view = renderQr();
    await settle();
    states.freshEmpty = hashDom();
    fireEvent.change(receiverInput(), { target: { value: RECEIVER } });
    await settle();
    states.freshReceiverTyped = hashDom();
    setAmount('1000');
    await settle();
    states.freshAmount = hashDom();
    fireEvent.click(settingsButton());
    await settle();
    states.freshSettingsSheet = hashDom();
    closeSettings();
    fireEvent.click(screen.getByRole('button', { name: L().modeStatic }));
    await settle();
    states.freshStatic = hashDom();
    fireEvent.click(showQrButtons()[0]);
    await settle();
    states.freshStaticModal = hashDom();
    view.unmount();

    // USDC (分配・他チェーンからの受取 OFF) の設定シートと金額の参考円・為替換算・換算後の QR の画面。
    localStorage.clear();
    seed({ token: 'usdc', chain: 'base', crossChain: false, splits: [{ address: SPLIT, percent: '30' }] });
    view = renderQr();
    await settle();
    setAmount('12.5');
    await settle();
    states.usdcAmount = hashDom();
    fireEvent.click(settingsButton());
    await settle();
    states.usdcSettingsSheet = hashDom();
    closeSettings();
    localStorage.clear();
    view.unmount();
    seed({ token: 'usdc', chain: 'base' });
    view = renderQr();
    await settle();
    setAmount('12.5');
    fireEvent.click(convertButton());
    await settle();
    states.usdcFxApplied = hashDom();
    fireEvent.click(showQrButtons()[0]);
    await settle();
    states.usdcFxModal = hashDom();
    view.unmount();

    // 通常決済 (USDC・EIP-681 を開いて両方コピー済み)。
    localStorage.clear();
    seed({ token: 'usdc', chain: 'base', payMode: 'standard', storeName: '神田珈琲', posterNote: '店頭でお見せください' });
    view = renderQr();
    await settle();
    setAmount('5');
    fireEvent.click(showQrButtons()[0]);
    await settle();
    const standardDialog = qrDialog()!;
    fireEvent.click(within(standardDialog).getByText(L().eip681Title));
    await act(async () => {
      fireEvent.click(within(standardDialog).getByRole('button', { name: L().qrCopy }));
    });
    await act(async () => {
      fireEvent.click(within(standardDialog).getByRole('button', { name: L().eip681Copy }));
    });
    states.standardModalEip681Copied = hashDom();
    view.unmount();

    // 回収 (JPYC・forwarder あり・利用料の開示) の会計画面と QR の画面。
    localStorage.clear();
    h.provider = 'eip3009-relay';
    h.forwarders = { 80002: FORWARDER, 1001: FORWARDER, 43113: FORWARDER };
    seed();
    view = renderQr();
    await settle();
    setAmount('500');
    await settle();
    states.recoverAmount = hashDom();
    fireEvent.click(showQrButtons()[0]);
    await settle();
    states.recoverModal = hashDom();
    view.unmount();
    h.provider = 'pimlico-7702';
    h.forwarders = {};

    // Arc (USDC・通常決済のみ) の QR の画面。
    localStorage.clear();
    seed({ token: 'usdc', chain: 'arc' });
    view = renderQr();
    await settle();
    setAmount('3');
    fireEvent.click(showQrButtons()[0]);
    await settle();
    states.arcModal = hashDom();
    view.unmount();

    // 着金の見張り (監視中 → 残高が増えた) と、閉じた後の A2HS の案内。
    localStorage.clear();
    seed();
    view = renderQr();
    await settle();
    setAmount('750');
    fireEvent.click(showQrButtons()[0]);
    await settle();
    states.watchWatching = hashDom();
    h.balance = 10n ** 21n;
    view.rerender(<QrGenerator />);
    h.balance += 750n * 10n ** 18n;
    view.rerender(<QrGenerator />);
    await settle();
    states.watchReceived = hashDom();
    fireEvent.click(within(qrDialog()!).getByRole('button', { name: L().qrModalClose }));
    await settle();
    states.closedWithPwaHint = hashDom();
    view.unmount();
    h.balance = undefined;

    // 値引き (JPYC) の会計画面と QR の画面・明細を開いて入れた会計画面。
    localStorage.clear();
    seed({ storeName: 'Cafe' });
    view = renderQr();
    await settle();
    setAmount('1000');
    addDiscount('120');
    await settle();
    states.discountAmount = hashDom();
    fireEvent.click(showQrButtons()[0]);
    await settle();
    states.discountModal = hashDom();
    fireEvent.click(within(qrDialog()!).getByRole('button', { name: L().qrModalClose }));
    (screen.getByText(L().accountingFieldsTitle).closest('details') as HTMLDetailsElement).open = true;
    fireEvent.change(screen.getByPlaceholderText(L().productNamePlaceholder), { target: { value: '豆' } });
    fireEvent.change(screen.getByPlaceholderText(L().memoPlaceholder), { target: { value: 'メモ' } });
    fireEvent.change(screen.getByPlaceholderText(L().receiptNoPlaceholder), { target: { value: 'R-9' } });
    await settle();
    states.accountingFilled = hashDom();
    view.unmount();

    // en (新規と QR の画面)。
    localStorage.clear();
    locale = 'en';
    view = renderQr();
    await settle();
    states.enFresh = hashDom();
    fireEvent.change(receiverInput(), { target: { value: RECEIVER } });
    setAmount('12');
    await settle();
    fireEvent.click(showQrButtons()[0]);
    await settle();
    states.enModal = hashDom();
    view.unmount();

    expect(states).toMatchInlineSnapshot(`
      {
        "accountingFilled": {
          "all": "52da0c1cab872358b0ef9c0c0700986e91574f5ffe472e7830811eb0c1e2912e",
          "parts": [
            "div 77d610789dd9 ",
            "div 01981ba9106b Cafe0x8335…2913J",
            "aside 3651b5379f53 請求金額880 JPYCQRコー",
            "div c2aed2ae5974 請求金額880 JPYCQRコー",
          ],
        },
        "arcModal": {
          "all": "3f056328a19e6d1fe5b4ad2e0596638865268c4f68a9995a917a411ff1796d4d",
          "parts": [
            "div 77d610789dd9 ",
            "div f5f936bf11bc 店名未設定0x8335…2913",
            "aside 2d22fb287f20 請求金額3 USDC≈ ¥450",
            "div 058925846ea3 決済用 QR コード閉じるOpe",
            "div 250c78e3d30a 請求金額3 USDC≈ ¥450",
          ],
        },
        "closedWithPwaHint": {
          "all": "df0c68d8d4effabc9c0cd57dbd7d4b49a37a065e2f389cbdc5f28e591cbf8a0d",
          "parts": [
            "div 77d610789dd9 ",
            "div a096ad605709 店名未設定0x8335…2913",
            "aside 21a611c68df2 請求金額750 JPYCQRコー",
            "div 7ec07a0f813b 請求金額750 JPYCQRコー",
          ],
        },
        "discountAmount": {
          "all": "3b25eb14d983dc0ee13b56a326c9be49037b5136c22fec03ae05d3aacc902184",
          "parts": [
            "div 77d610789dd9 ",
            "div dd66a93740c4 Cafe0x8335…2913J",
            "aside 3651b5379f53 請求金額880 JPYCQRコー",
            "div c2aed2ae5974 請求金額880 JPYCQRコー",
          ],
        },
        "discountModal": {
          "all": "e5d0efd6996656ed1cbad4411a0c97a3d6ee2f7b5a7ef85f51cefffd946e2842",
          "parts": [
            "div 77d610789dd9 ",
            "div 4e32a97b772b Cafe0x8335…2913J",
            "aside 3651b5379f53 請求金額880 JPYCQRコー",
            "div 0c68b4bd9fa2 決済用 QR コード閉じるOpe",
            "div c2aed2ae5974 請求金額880 JPYCQRコー",
          ],
        },
        "enFresh": {
          "all": "25a28edd6edd5a60077b5b172be8dbf6eed4cbb6844968fa54806bc227eb5d07",
          "parts": [
            "div 77d610789dd9 ",
            "div 1037b32e62e9 No shop nameNo r",
            "aside e432f1338d73 Amount—Show QR c",
            "div 4b481618cc35 No receiver setS",
          ],
        },
        "enModal": {
          "all": "208867e951e71b6924460145171d8e71459f0a6c70768d05eba593b33fed888d",
          "parts": [
            "div 77d610789dd9 ",
            "div 7bc8aeab7f39 No shop name0x83",
            "aside db456af43b57 Amount12 JPYCSho",
            "div af8d4512b1c9 Payment QR codeC",
            "div 43cacceebc91 Amount12 JPYCSho",
          ],
        },
        "freshAmount": {
          "all": "b31d3a4e53943aefc2c1c2b837b1a289fd6c877d2e768fa3c6307fb4a007c04b",
          "parts": [
            "div 77d610789dd9 ",
            "div d5e39853594f 店名未設定0x8335…2913",
            "aside 99b871383cb3 請求金額1,000 JPYCQR",
            "div 6bdf93b197f0 請求金額1,000 JPYCQR",
          ],
        },
        "freshEmpty": {
          "all": "fe841878a8115f99eee92b08e36a00ac2874cf22226fcd4dc36a6a555ed58c07",
          "parts": [
            "div 77d610789dd9 ",
            "div f8ef62818e48 店名未設定受取先が未設定JPYC",
            "aside 1a4e0aab7a49 請求金額—QRコードを表示する受",
            "div 9491363e27ea 受取先が未設定QRコードを表示す",
          ],
        },
        "freshReceiverTyped": {
          "all": "9091f9c1a3cddeea6b792eccd297e70303c2c4542a057d55767d6373bd521640",
          "parts": [
            "div 77d610789dd9 ",
            "div b02c08e8d0e7 店名未設定0x8335…2913",
            "aside 3fcd31b86f55 請求金額—QRコードを表示する金",
            "div 739ef6dfdbb0 金額が未入力QRコードを表示する",
          ],
        },
        "freshSettingsSheet": {
          "all": "a9ad1c58ab55edf9a0af70637192b8db93154e78639e5336f6e84e068b3a3fc2",
          "parts": [
            "div 77d610789dd9 ",
            "div d5e39853594f 店名未設定0x8335…2913",
            "aside 99b871383cb3 請求金額1,000 JPYCQR",
            "div 4e01661f5ebd お店の設定完了受け取り受取先ウォ",
            "div 6bdf93b197f0 請求金額1,000 JPYCQR",
          ],
        },
        "freshStatic": {
          "all": "4ede7eff6e2a5b1b5efa95b8d2f5a4e1c38cc06982ee8b3ec64bdad37ee8edb6",
          "parts": [
            "div 77d610789dd9 ",
            "div e5fbd61ef0a3 店名未設定0x8335…2913",
            "aside a3758a9929a3 請求金額JPYC で金額を入力Q",
            "div ed7e724d0a8d 請求金額JPYC で金額を入力Q",
          ],
        },
        "freshStaticModal": {
          "all": "c614c6dc1ea7600a94906faa495f439042d41e83b1a9ce7f5ebc2df412ceccfa",
          "parts": [
            "div 77d610789dd9 ",
            "div f85d9913aa38 店名未設定0x8335…2913",
            "aside a3758a9929a3 請求金額JPYC で金額を入力Q",
            "div 23d6d5faa7b0 決済用 QR コード閉じるOpe",
            "div ed7e724d0a8d 請求金額JPYC で金額を入力Q",
          ],
        },
        "recoverAmount": {
          "all": "412c481669d3191581399c4682a32021d30d17bf81681faf63ae0611c9ec170a",
          "parts": [
            "div 77d610789dd9 ",
            "div 4a2582cce150 店名未設定0x8335…2913",
            "aside 2cc76e1c1637 請求金額500 JPYCQRコー",
            "div 26fa70486c48 請求金額500 JPYCQRコー",
          ],
        },
        "recoverModal": {
          "all": "8e7b234a94511ae05e0dd1cb6813214c1444e1be1718bcdafaf3f6f51b645a61",
          "parts": [
            "div 77d610789dd9 ",
            "div 186e8982cec1 店名未設定0x8335…2913",
            "aside 2cc76e1c1637 請求金額500 JPYCQRコー",
            "div e93fc78e443b 決済用 QR コード閉じるOpe",
            "div 26fa70486c48 請求金額500 JPYCQRコー",
          ],
        },
        "standardModalEip681Copied": {
          "all": "a5389d263b8d5a86c9792073bd9e95cba8262cf8ec3f3275baecf5075543be85",
          "parts": [
            "div 77d610789dd9 ",
            "div a7ec42aa48cb 神田珈琲0x8335…2913U",
            "aside 4b4a106c5654 請求金額5 USDC≈ ¥750",
            "div c90e0fbff95e 決済用 QR コード閉じるOpe",
            "div 75d49299c4ea 請求金額5 USDC≈ ¥750",
          ],
        },
        "usdcAmount": {
          "all": "7ea6fe6a4bf60163ca0ba3a6d7bd6f6d32c2142fde29f3db8ce408c061915c00",
          "parts": [
            "div 77d610789dd9 ",
            "div f0c5513165f0 店名未設定0x8335…2913",
            "aside 934ceead99e8 請求金額12.5 USDC≈ ¥",
            "div 7309dd8672ad 請求金額12.5 USDC≈ ¥",
          ],
        },
        "usdcFxApplied": {
          "all": "2e28ba8ea28794eaffa9d39272dd48d562adc33f59c3e751d0a8c70707d4c502",
          "parts": [
            "div 77d610789dd9 ",
            "div be1fdc2ef177 店名未設定0x8335…2913",
            "aside 1f554979d6b2 請求金額1,875 JPYCQR",
            "div 9297eecd7c80 請求金額1,875 JPYCQR",
          ],
        },
        "usdcFxModal": {
          "all": "4ec9234b9669db0370bcf94715f4ca561e3fcae4356ae1ed69178baf3e13f1c3",
          "parts": [
            "div 77d610789dd9 ",
            "div 8937b7864de3 店名未設定0x8335…2913",
            "aside 1f554979d6b2 請求金額1,875 JPYCQR",
            "div eade324e704e 決済用 QR コード閉じるOpe",
            "div 9297eecd7c80 請求金額1,875 JPYCQR",
          ],
        },
        "usdcSettingsSheet": {
          "all": "e22234955122c03bbce15818b165c87ca85f79c77f6c39ace0417e8ce5578a4b",
          "parts": [
            "div 77d610789dd9 ",
            "div f0c5513165f0 店名未設定0x8335…2913",
            "aside 934ceead99e8 請求金額12.5 USDC≈ ¥",
            "div 3409558e528d お店の設定完了受け取り受取先ウォ",
            "div 7309dd8672ad 請求金額12.5 USDC≈ ¥",
          ],
        },
        "watchReceived": {
          "all": "a82a119cd2cce09fa48ad2f5c89d99b6ad07dd8de67650c3f3900c1917e13027",
          "parts": [
            "div 77d610789dd9 ",
            "div a096ad605709 店名未設定0x8335…2913",
            "aside 21a611c68df2 請求金額750 JPYCQRコー",
            "div ff63a3ce803b 決済用 QR コード閉じるOpe",
            "div 7ec07a0f813b 請求金額750 JPYCQRコー",
          ],
        },
        "watchWatching": {
          "all": "711d9803015a23b91a2452180358ac16064479a3fc6e47fc36a1c90181a15506",
          "parts": [
            "div 77d610789dd9 ",
            "div a096ad605709 店名未設定0x8335…2913",
            "aside 21a611c68df2 請求金額750 JPYCQRコー",
            "div 2df49707dd8e 決済用 QR コード閉じるOpe",
            "div 7ec07a0f813b 請求金額750 JPYCQRコー",
          ],
        },
      }
    `);
  });

  it('pins the store-pays QR (flag ON): /checkout bytes with the hand-off id, the hand-off call, blocked reasons, dimming and the normal QR with its fee disclosure', async () => {
    h.storeGas = true;
    sd.active = true;
    h.provider = 'eip3009-relay';
    h.forwarders = { 80002: FORWARDER, 1001: FORWARDER };
    const storeSeed = (over: Record<string, unknown> = {}) =>
      seed({ token: 'jpyc', chain: 'polygon', payMode: 'gasless', storePays: true, ...over });
    const results: Record<string, unknown> = {};
    const states: Record<string, unknown> = {};
    const openStoreQr = async () => {
      fireEvent.click(showQrButtons()[0]);
      const dialog = await screen.findByRole('dialog', { name: L().qrModalTitle });
      await settle();
      return dialog;
    };
    const storeOutputs = async (dialog: HTMLElement) => ({
      start: sd.start.mock.calls.map(([merchant, wei, chainId]) => [merchant, String(wei), chainId]),
      buttons: within(dialog).queryAllByRole('button').map((b) => b.textContent),
      ...(await modalOutputs(dialog)),
    });

    // 1 品 (500 JPYC・Polygon)。
    storeSeed();
    let view = renderQr();
    await settle();
    await screen.findByTestId('gas-wallet-panel');
    setAmount('500');
    await settle();
    states.storeReady = hashDom();
    let dialog = await openStoreQr();
    states.storeModal = hashDom();
    results.polygon500 = await storeOutputs(dialog);
    view.unmount();

    // 明細・値引き・管理番号・店名・インボイス番号を引き継ぐ (Kaia)。
    sd.start.mockClear();
    localStorage.clear();
    storeSeed({
      chain: 'kaia',
      productName: 'ランチ & 珈琲',
      memo: '2 名',
      taxRate: 10,
      taxCategory: 'taxable_10',
      storeName: ' Cafe ',
      invoiceNo: 'T1234567890123',
    });
    view = renderQr();
    await settle();
    setAmount('1200');
    addDiscount('200');
    fireEvent.change(screen.getByPlaceholderText(L().receiptNoPlaceholder), { target: { value: 'R-7' } });
    await settle();
    dialog = await openStoreQr();
    results.kaiaMetaDiscount = await storeOutputs(dialog);
    view.unmount();

    // 小数の額 (1.5 JPYC)・署名を待っている間ははっきり出し、別の受け渡しの間は薄くする。
    sd.start.mockClear();
    localStorage.clear();
    storeSeed();
    sd.state = { phase: 'waiting', session: { id: HS }, stale: false, degraded: false };
    view = renderQr();
    await settle();
    setAmount('1.5');
    await settle();
    dialog = await openStoreQr();
    await within(dialog).findByRole('status');
    await settle();
    states.storeModalWaiting = hashDom();
    results.decimalWaiting = await storeOutputs(dialog);
    sd.state = { phase: 'waiting', session: { id: 'ZzZzZzZzZzZzZzZzZzZzZz' }, stale: false, degraded: false };
    view.rerender(<QrGenerator />);
    await settle();
    states.storeModalDimmed = hashDom();
    view.unmount();

    // 使えない会計 (1 JPYC 未満・据え置き) の理由。
    sd.state = { phase: 'idle' };
    localStorage.clear();
    storeSeed();
    view = renderQr();
    await settle();
    setAmount('0.5');
    await settle();
    states.storeBlockedMinAmount = hashDom();
    results.blockedMinAmount = showQrButtons().map((b) => [b.hasAttribute('disabled'), b.closest('div')!.textContent]);
    fireEvent.click(screen.getByRole('button', { name: L().modeStatic }));
    await settle();
    states.storeBlockedStatic = hashDom();
    view.unmount();

    // 作れなかった → 店員が選んで通常の QR (回収・利用料の開示を QR の画面の中に)。
    sd.start.mockReset().mockResolvedValue(null);
    sd.state = { phase: 'create_failed', reason: 'unavailable' };
    localStorage.clear();
    storeSeed();
    view = renderQr();
    await settle();
    setAmount('800');
    await settle();
    await screen.findByRole('button', { name: L().storeDevice.showNormalQr });
    states.storeCreateFailed = hashDom();
    fireEvent.click(screen.getByRole('button', { name: L().storeDevice.showNormalQr }));
    dialog = await screen.findByRole('dialog', { name: L().qrModalTitle });
    await within(dialog).findByRole('alert');
    await settle();
    states.storeNormalQr = hashDom();
    results.normalAfterCreateFailed = {
      releaseForNormal: sd.releaseForNormal.mock.calls.length,
      ...(await modalOutputs(dialog)),
    };
    view.unmount();

    expect(results).toMatchInlineSnapshot(`
      {
        "blockedMinAmount": [
          [
            true,
            "請求金額0.5 JPYCQRコードを表示する",
          ],
          [
            true,
            "請求金額0.5 JPYCQRコードを表示する",
          ],
        ],
        "decimalWaiting": {
          "buttons": [
            "閉じる",
          ],
          "copies": [],
          "downloads": [],
          "eip681": null,
          "lastQr": null,
          "modal": "ac2136ac5c3ab4aef932fd2de4d92c7785fdd38f7146478d2b49de7fa22267b6",
          "printed": 0,
          "qr": "https://test.local/checkout?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=jpyc&items=%25E3%2581%258A%25E6%2594%25AF%25E6%2589%2595%25E3%2581%2584%3A1%3A1.5&gas=merchant&submit=store&hs=AbCdEfGhIjKlMnOpQrStUv",
          "shownEip681": null,
          "shownUrl": null,
          "start": [
            [
              "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              "1500000000000000000",
              80002,
            ],
          ],
          "watch": {
            "chainId": 80002,
            "enabled": false,
            "expectedAmountWei": "0",
            "receiver": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "tokenAddress": "0x0000000000000000000000000000000000000aBc",
          },
        },
        "kaiaMetaDiscount": {
          "buttons": [
            "閉じる",
          ],
          "copies": [],
          "downloads": [],
          "eip681": null,
          "lastQr": null,
          "modal": "030f2f86b5f38839b2654b2a72252ad816ebc44c7c90e127bb02beb0926e7d3b",
          "printed": 0,
          "qr": "https://test.local/checkout?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=jpyc&chain=kaia&items=%25E3%2583%25A9%25E3%2583%25B3%25E3%2583%2581%2520%2526%2520%25E7%258F%2588%25E7%2590%25B2%3A1%3A1200%3A%3A%3A2%2520%25E5%2590%258D&disc=200&gas=merchant&store=Cafe&submit=store&hs=AbCdEfGhIjKlMnOpQrStUv&tax=10&taxcat=taxable_10&rcpt=R-7&inv=T1234567890123",
          "shownEip681": null,
          "shownUrl": null,
          "start": [
            [
              "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              "1000000000000000000000",
              1001,
            ],
          ],
          "watch": {
            "chainId": 1001,
            "enabled": false,
            "expectedAmountWei": "998000000000000000000",
            "receiver": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "tokenAddress": "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
          },
        },
        "normalAfterCreateFailed": {
          "copies": [
            "=qr",
          ],
          "downloads": [
            "openpay-jpyc-polygon-800.svg <- blob:pinned",
            "openpay-jpyc-polygon-800.png <- data:image/png",
          ],
          "eip681": null,
          "lastQr": {
            "amountLabel": "800 JPYC",
            "payUrl": "=qr",
            "tokenChainLabel": "JPYC · Polygon Amoy",
            "ts": 1790208000320,
          },
          "modal": "9601a8f921293f70a638a0d0b2290d78222b8b449da91e885793cb35c5085baa",
          "printed": 1,
          "qr": "https://test.local/pay?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=jpyc&gas=merchant&amount=800",
          "releaseForNormal": 1,
          "shownEip681": null,
          "shownUrl": "=qr",
          "watch": {
            "chainId": 80002,
            "enabled": true,
            "expectedAmountWei": "798000000000000000000",
            "receiver": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "tokenAddress": "0x0000000000000000000000000000000000000aBc",
          },
        },
        "polygon500": {
          "buttons": [
            "閉じる",
          ],
          "copies": [],
          "downloads": [],
          "eip681": null,
          "lastQr": null,
          "modal": "c396cc43abedb8e152b810b33effa2bb7182b76ea0552f2e15dc704a7daa40cc",
          "printed": 0,
          "qr": "https://test.local/checkout?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&token=jpyc&items=%25E3%2581%258A%25E6%2594%25AF%25E6%2589%2595%25E3%2581%2584%3A1%3A500&gas=merchant&submit=store&hs=AbCdEfGhIjKlMnOpQrStUv",
          "shownEip681": null,
          "shownUrl": null,
          "start": [
            [
              "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              "500000000000000000000",
              80002,
            ],
          ],
          "watch": {
            "chainId": 80002,
            "enabled": false,
            "expectedAmountWei": "498000000000000000000",
            "receiver": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "tokenAddress": "0x0000000000000000000000000000000000000aBc",
          },
        },
      }
    `);
    expect(states).toMatchInlineSnapshot(`
      {
        "storeBlockedMinAmount": {
          "all": "a9a7fb2bb4e4c319bff46ab586e392583f879083ebdab2e34bb03d9f0f68cee4",
          "parts": [
            "div 77d610789dd9 ",
            "div 68d59235de71 店名未設定0x8335…2913",
            "aside 8ce733544927 1 JPYC 未満の会計では使え",
            "div 1437279c8f7c 請求金額0.5 JPYCQRコー",
          ],
        },
        "storeBlockedStatic": {
          "all": "ac0e7715b3f0ea181cef79472762e54aa04a38cc53f2e88f562658cd5267354c",
          "parts": [
            "div 77d610789dd9 ",
            "div c6f7495fadd6 店名未設定0x8335…2913",
            "aside 5228778ee43b 金額ありの QR だけで使えます",
            "div 3c304438833c 請求金額JPYC で金額を入力Q",
          ],
        },
        "storeCreateFailed": {
          "all": "e19c1e93a888f38db38a82a9523450d943e6fd2b72610dbbf06ecbcdf1178db3",
          "parts": [
            "div 77d610789dd9 ",
            "div 26b1257e842e 店名未設定0x8335…2913",
            "aside 16d1e218b2b8 通常の QR を出す通常の QR",
            "div 3cf4eb536ffb 請求金額800 JPYCQRコー",
          ],
        },
        "storeModal": {
          "all": "b2e2dd3161bc818467a773f008c592734c95c6457169936bfa1a8e2bcddde944",
          "parts": [
            "div 77d610789dd9 ",
            "div 2d3f46ce4edb 店名未設定0x8335…2913",
            "aside 2cc76e1c1637 請求金額500 JPYCQRコー",
            "div c396cc43abed 決済用 QR コード閉じるOpe",
            "div 26fa70486c48 請求金額500 JPYCQRコー",
          ],
        },
        "storeModalDimmed": {
          "all": "3749c368a6c3bad2b446eb8d9b8c27185103a23d4ce9e3ca3b2fe7705ab98cd5",
          "parts": [
            "div 77d610789dd9 ",
            "div 844a3815dcc1 店名未設定0x8335…2913",
            "aside 54b57acbe676 請求金額1.5 JPYCQRコー",
            "div eada9dd71c73 決済用 QR コード閉じるOpe",
            "div c958c2006ed4 請求金額1.5 JPYCQRコー",
          ],
        },
        "storeModalWaiting": {
          "all": "575d39fd0af39353999dde69af2c9ca9043d706057eef7f7bbb10c6ba9d6a6c3",
          "parts": [
            "div 77d610789dd9 ",
            "div 844a3815dcc1 店名未設定0x8335…2913",
            "aside 54b57acbe676 請求金額1.5 JPYCQRコー",
            "div ac2136ac5c3a 決済用 QR コード閉じるOpe",
            "div c958c2006ed4 請求金額1.5 JPYCQRコー",
          ],
        },
        "storeNormalQr": {
          "all": "27c95fdd763a01a92db104ff8951983920508560afddf16444307e7546df4f11",
          "parts": [
            "div 77d610789dd9 ",
            "div 4486398be930 店名未設定0x8335…2913",
            "aside 16d1e218b2b8 通常の QR を出す通常の QR",
            "div 9601a8f92129 決済用 QR コード閉じるOpe",
            "div 3cf4eb536ffb 請求金額800 JPYCQRコー",
          ],
        },
        "storeReady": {
          "all": "229c5da3090929296d590b7b30d91166418c2cb3c82fe99869f31255a8c3bc18",
          "parts": [
            "div 77d610789dd9 ",
            "div aea04d1e9b1f 店名未設定0x8335…2913",
            "aside 2cc76e1c1637 請求金額500 JPYCQRコー",
            "div 26fa70486c48 請求金額500 JPYCQRコー",
          ],
        },
      }
    `);
  });

  it('子 component に分けても入力欄・設定シート・QR の画面を作り直さず、QR の画面は閉じて開き直したときだけ作り直す', async () => {
    const view = renderQr();
    await settle();
    // 会計画面の受取先の欄 (新規)。打っている間も同じ node・focus のまま、正しいアドレスになっても欄は消えない。
    const inlineReceiver = receiverInput();
    inlineReceiver.focus();
    for (const value of ['0x8', RECEIVER.slice(0, 20), RECEIVER]) {
      fireEvent.change(inlineReceiver, { target: { value } });
      await settle();
      expect(receiverInput()).toBe(inlineReceiver);
      expect(inlineReceiver).toHaveFocus();
    }
    const amountEl = amountInput();
    amountEl.focus();
    setAmount('1000');
    await settle();
    expect(amountInput()).toBe(amountEl);
    expect(amountEl).toHaveFocus();

    // 出している間に受取先が使えなくなったら閉じ (受け渡しの締め切りと同じ終了処理)、直しても勝手に開き直さない。
    fireEvent.click(showQrButtons()[0]);
    await settle();
    expect(qrDialog()).not.toBeNull();
    fireEvent.change(inlineReceiver, { target: { value: '0x12' } });
    await settle();
    expect(qrDialog()).toBeNull();
    fireEvent.change(inlineReceiver, { target: { value: RECEIVER } });
    await settle();
    expect(qrDialog()).toBeNull();
    expect(receiverInput()).toBe(inlineReceiver);

    // 明細の欄。
    const details = screen.getByText(L().accountingFieldsTitle).closest('details') as HTMLDetailsElement;
    details.open = true;
    const accounting = () => ({
      productName: screen.getByPlaceholderText(L().productNamePlaceholder),
      memo: screen.getByPlaceholderText(L().memoPlaceholder),
      receipt: screen.getByPlaceholderText(L().receiptNoPlaceholder),
    });
    const before = accounting();
    for (const key of Object.keys(before) as Array<keyof typeof before>) {
      const node = before[key] as HTMLInputElement;
      node.focus();
      fireEvent.change(node, { target: { value: `${key}-1` } });
      await settle();
      expect(accounting()[key]).toBe(node);
      expect(node).toHaveFocus();
    }
    expect(screen.getByText(L().accountingFieldsTitle).closest('details')).toBe(details);
    expect(details.open).toBe(true);
    // 値引きの欄。
    addDiscount('1');
    const discountEl = screen.getByLabelText(msgs().Discount.amountInput) as HTMLInputElement;
    discountEl.focus();
    for (const value of ['10', '100']) {
      fireEvent.change(discountEl, { target: { value } });
      await settle();
      expect(screen.getByLabelText(msgs().Discount.amountInput)).toBe(discountEl);
      expect(discountEl).toHaveFocus();
    }

    // 設定シートの欄 (店名・受取先) と通貨・チェーンの切替。
    fireEvent.click(settingsButton());
    await settle();
    const sheet = settingsSheet()!;
    const storeName = within(sheet).getByPlaceholderText(L().storeNamePlaceholder);
    const sheetReceiver = within(sheet).getByPlaceholderText(msgs().AddressInput.placeholder);
    storeName.focus();
    fireEvent.change(storeName, { target: { value: '店' } });
    await settle();
    expect(within(settingsSheet()!).getByPlaceholderText(L().storeNamePlaceholder)).toBe(storeName);
    expect(storeName).toHaveFocus();
    sheetReceiver.focus();
    fireEvent.change(sheetReceiver, { target: { value: ENS_ADDRESS } });
    await settle();
    expect(within(settingsSheet()!).getByPlaceholderText(msgs().AddressInput.placeholder)).toBe(sheetReceiver);
    expect(sheetReceiver).toHaveFocus();
    fireEvent.click(within(sheet).getByRole('button', { name: /Kairos/ }));
    await settle();
    expect(settingsSheet()).toBe(sheet);
    expect(within(sheet).getByPlaceholderText(L().storeNamePlaceholder)).toBe(storeName);
    closeSettings();
    await settle();
    // シートで受取先を決めて閉じたら、会計画面の受取先の欄は役目を終えて消える。
    expect(screen.queryByPlaceholderText(msgs().AddressInput.placeholder)).toBeNull();

    // QR の画面: 開いている間の親の再描画 (背面の金額欄の入力・描画し直し) では作り直さない。
    fireEvent.click(showQrButtons()[0]);
    await settle();
    const dialog = qrDialog()!;
    const close = within(dialog).getByRole('button', { name: L().qrModalClose });
    const qrSvg = dialog.querySelector('svg[data-qr-value][width="340"]')!;
    const urlBefore = qrSvg.getAttribute('data-qr-value');
    const input = amountInput();
    input.focus();
    setAmount('1200');
    await settle();
    view.rerender(<QrGenerator />);
    await settle();
    expect(qrDialog()).toBe(dialog);
    expect(within(dialog).getByRole('button', { name: L().qrModalClose })).toBe(close);
    expect(dialog.querySelector('svg[data-qr-value][width="340"]')).toBe(qrSvg);
    const urlAfter = qrSvg.getAttribute('data-qr-value');
    expect(input).toHaveFocus();
    // 閉じて開き直すと作り直す (開いたら dialog に focus)。
    fireEvent.click(close);
    await settle();
    expect(qrDialog()).toBeNull();
    fireEvent.click(showQrButtons()[0]);
    await settle();
    const reopened = qrDialog()!;
    expect(reopened).not.toBe(dialog);
    expect(reopened).toHaveFocus();
    expect({ urlBefore, urlAfter }).toMatchInlineSnapshot(`
      {
        "urlAfter": "https://test.local/pay?to=0x000000000000000000000000000000000000dEaD&token=jpyc&chain=kaia&amount=1100&disc=100&store=%E5%BA%97&pname=productName-1&memo=memo-1&rcpt=receipt-1",
        "urlBefore": "https://test.local/pay?to=0x000000000000000000000000000000000000dEaD&token=jpyc&chain=kaia&amount=900&disc=100&store=%E5%BA%97&pname=productName-1&memo=memo-1&rcpt=receipt-1",
      }
    `);
  });
});
