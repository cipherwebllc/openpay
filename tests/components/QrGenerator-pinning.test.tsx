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

function amountInput() {
  return container.querySelector<HTMLInputElement>('input[placeholder="1,000"], input[placeholder="10.00"]')!;
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
          "modal": "0bb425c8e03b056a00fa4aeeea0a3f88096a3697eee9af9e04a7ad90ad8bec75",
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
          "modal": "6d7c60bd122ee261ddb3f0d3f4f7bb8becfb8a92204327c5801c1a1b5452ed8c",
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
          "modal": "6bea2797f5a953fc9ec0c9dfc92a1b6199ec09abc781699f82979f40ab3245bc",
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
          "modal": "d2f0185b2eacc243511b08706cc311f79640a5692995bab8bdb6762df4a69650",
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
          "modal": "3d408eed892dde932a77532e8b33cad10ccf514cf8b4788018e1d108e9181cec",
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
          "modal": "422c5f4565ed80a9d699a1708cdd5b07ecf3e128c2126383a4282251da99055b",
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
          "modal": "51eba6ad085a15f61736996f42776cd74f1995c48d80819608a6600a46fbe5e4",
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
          "modal": "da30c1965bc2f30ce256a4b093b5210ce8025946165b1054c0c6c88c67ff1726",
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
          "modal": "2d07570478a5260267551fdfe7da6c2a5e1244125faf363a6019ab5c79076daf",
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
          "modal": "7c567562ac68c61615d611b08e5825dc66d2036d08557f7f47a6248deec5e657",
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
          "modal": "8893f9749bb3c8265ff3ce40a184b749c3b81fc250f2cf025af5eed910c4bbde",
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
          "modal": "3dc6e250f4dd370a56c8cba1ad98cb7db2b93dd0647f205d57a30f6a5750766a",
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
          "modal": "16db5b8c6f51cb296d09740f82fa0800fd653621092a2bc92195726e1be0aa96",
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
          "modal": "40e2b5cc51cc0c61278da379a905be93ba2202c3fd3edaf99dea54ad908a2e47",
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
          "modal": "7f6b1ee7fdd7e565feeb53c0037ee06110ea668c0b7e73e070dab197aaddc31f",
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
          "modal": "42cadadf0abdb5d01672183fcaf0333c9386c4ea1eed8ea6296e94c04b1182e9",
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
          "modal": "b5dbfe306ab5956411de2c75ad69bc812dcac1d3ab19211630d6aba17748e147",
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
          "modal": "ebf5c9d810257585472383ec5e6fc87915a9cbc5c6882fb04151daede5b264f7",
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
          "modal": "d81dd07b60c228e766e4499536ebe27c11addbfd021c49df6a6977a7d2313589",
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
          "modal": "422126f7fe130d49e17e29017c6284553cd9f5cd7be36ed55f1b0e63efdbfb3d",
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
          "modal": "0d12cac8830b33b7d9d9ef157072dc627e06b05ba52a3e844cf21780da00d9e7",
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
          "modal": "8716dbdac9e924229cf8b5b039fa6de99661cd609c9b09072980360c60f1ef30",
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
          "modal": "071480075111363cb7b357b256a3c0bac6c17a8756f136c1faff09a9b2bb3ec2",
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
          "modal": "76deb7a49b48948d85195be9bd73eff13c38dac5300bcb851484d6859ff52f15",
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
          "modal": "af16635f9fa84b31e04d056dcd27fdb0ec88fc176b0c2754a8e7cdaaab4f4f67",
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
          "modal": "5f19516e0326f24a44815331317a17e4a06758eb57adcb3de70830c3e92d636e",
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
          "modal": "103bd3baf8a602e880b9f3644caa75670bb4811748b01078bd0c9af19df35d25",
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
          "modal": "51ff7c2de03931e4d354730c299f9fc2376fe508e23762f11889c552650d1408",
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
          "all": "7800830a59e1c8722e53ebe59a3a519b3b139b8605e9d61b3b2637a83b7e11c5",
          "parts": [
            "div 77d610789dd9 ",
            "div d0c000e65633 Cafe0x8335…2913J",
            "aside 3651b5379f53 請求金額880 JPYCQRコー",
            "div c2aed2ae5974 請求金額880 JPYCQRコー",
          ],
        },
        "arcModal": {
          "all": "6898739821e785cb5d2b208b4a5727263d004dc81a7a7d5d6752d77e5060e9b5",
          "parts": [
            "div 77d610789dd9 ",
            "div a2f331d5bece 店名未設定0x8335…2913",
            "aside 2d22fb287f20 請求金額3 USDC≈ ¥450",
            "div ebf5c9d81025 決済用 QR コード閉じるOpe",
            "div 250c78e3d30a 請求金額3 USDC≈ ¥450",
          ],
        },
        "closedWithPwaHint": {
          "all": "2a8db5a0a41d49bc57a7df25f85652c6f71fbb3d166545aafccae99070df0779",
          "parts": [
            "div 77d610789dd9 ",
            "div 0cead74f9762 店名未設定0x8335…2913",
            "aside 21a611c68df2 請求金額750 JPYCQRコー",
            "div 7ec07a0f813b 請求金額750 JPYCQRコー",
          ],
        },
        "discountAmount": {
          "all": "82512e99e402b5dc65185bb9cc053ce47c05b83daf643786283b2e3283e8158e",
          "parts": [
            "div 77d610789dd9 ",
            "div ffdbbdbc5f80 Cafe0x8335…2913J",
            "aside 3651b5379f53 請求金額880 JPYCQRコー",
            "div c2aed2ae5974 請求金額880 JPYCQRコー",
          ],
        },
        "discountModal": {
          "all": "79398ba08cbcd028ffe87ecdfb6af1eb7d693b8d67de6c9607476088027f6db5",
          "parts": [
            "div 77d610789dd9 ",
            "div fd0c4e56a5b5 Cafe0x8335…2913J",
            "aside 3651b5379f53 請求金額880 JPYCQRコー",
            "div 5b49d80aec67 決済用 QR コード閉じるOpe",
            "div c2aed2ae5974 請求金額880 JPYCQRコー",
          ],
        },
        "enFresh": {
          "all": "1e9d2abae7443c497e967ef8780681ab89a365ef104fe3396bab56c37901392e",
          "parts": [
            "div 77d610789dd9 ",
            "div 4ceb7e9f0530 No shop nameNo r",
            "aside e432f1338d73 Amount—Show QR c",
            "div 4b481618cc35 No receiver setS",
          ],
        },
        "enModal": {
          "all": "040036db6164d911b95c5dd6e398cf4c4c2de4ce29c8c8d59b19bffe352dd921",
          "parts": [
            "div 77d610789dd9 ",
            "div a5fb297615d2 No shop name0x83",
            "aside db456af43b57 Amount12 JPYCSho",
            "div 59588c94a5f1 Payment QR codeC",
            "div 43cacceebc91 Amount12 JPYCSho",
          ],
        },
        "freshAmount": {
          "all": "adcbc37f553f63de9a658585d6bcaeca212cc7c1b37e211459307fd5eab4e488",
          "parts": [
            "div 77d610789dd9 ",
            "div 53b43af8f2a4 店名未設定0x8335…2913",
            "aside 99b871383cb3 請求金額1,000 JPYCQR",
            "div 6bdf93b197f0 請求金額1,000 JPYCQR",
          ],
        },
        "freshEmpty": {
          "all": "bf1ffeb7b1d5ddd4796de6b4e9c276fb0276207e44d33cb180cf6bd7ef16360a",
          "parts": [
            "div 77d610789dd9 ",
            "div 9fd5549dfd36 店名未設定受取先が未設定JPYC",
            "aside 1a4e0aab7a49 請求金額—QRコードを表示する受",
            "div 9491363e27ea 受取先が未設定QRコードを表示す",
          ],
        },
        "freshReceiverTyped": {
          "all": "d438b6d05d52e7fcc4192d60106d82d2a45c676f47c36ad2f1e9ec1469d623b9",
          "parts": [
            "div 77d610789dd9 ",
            "div 585e623037a2 店名未設定0x8335…2913",
            "aside 3fcd31b86f55 請求金額—QRコードを表示する金",
            "div 739ef6dfdbb0 金額が未入力QRコードを表示する",
          ],
        },
        "freshSettingsSheet": {
          "all": "e541f5d8dfe596c3d7adf4e182764e76aa65f9bae29c1f1b65f01763c1709447",
          "parts": [
            "div 77d610789dd9 ",
            "div 53b43af8f2a4 店名未設定0x8335…2913",
            "aside 99b871383cb3 請求金額1,000 JPYCQR",
            "div e5bac6b2408e お店の設定完了受け取り受取先ウォ",
            "div 6bdf93b197f0 請求金額1,000 JPYCQR",
          ],
        },
        "freshStatic": {
          "all": "c06741732336350a1923daf1839f775676ac455de08f836932282853f8eab9df",
          "parts": [
            "div 77d610789dd9 ",
            "div 1d9924ee632f 店名未設定0x8335…2913",
            "aside a3758a9929a3 請求金額JPYC で金額を入力Q",
            "div ed7e724d0a8d 請求金額JPYC で金額を入力Q",
          ],
        },
        "freshStaticModal": {
          "all": "206fabc11fe11c776184afcc9f443c213304e17c4a370f97bc262ecb342a749b",
          "parts": [
            "div 77d610789dd9 ",
            "div 7ac21f067703 店名未設定0x8335…2913",
            "aside a3758a9929a3 請求金額JPYC で金額を入力Q",
            "div 16db5b8c6f51 決済用 QR コード閉じるOpe",
            "div ed7e724d0a8d 請求金額JPYC で金額を入力Q",
          ],
        },
        "recoverAmount": {
          "all": "b955c77b7006ee6ce4af8e74a26566861c9bf879d683f26ce9e05177fb8be588",
          "parts": [
            "div 77d610789dd9 ",
            "div 4d97b7e015e4 店名未設定0x8335…2913",
            "aside 2cc76e1c1637 請求金額500 JPYCQRコー",
            "div 26fa70486c48 請求金額500 JPYCQRコー",
          ],
        },
        "recoverModal": {
          "all": "5f4378ae8cd376b81a9d0134eb9e3e03a2b71367afa2dfabc551cd3f8dd0c086",
          "parts": [
            "div 77d610789dd9 ",
            "div f4b4e120c60f 店名未設定0x8335…2913",
            "aside 2cc76e1c1637 請求金額500 JPYCQRコー",
            "div 40e2b5cc51cc 決済用 QR コード閉じるOpe",
            "div 26fa70486c48 請求金額500 JPYCQRコー",
          ],
        },
        "standardModalEip681Copied": {
          "all": "7f09cc925076548b0fa84c157ddebb2759cbbab24ce2bc2c34f3b5a48f7ac240",
          "parts": [
            "div 77d610789dd9 ",
            "div 1e591e4061e7 神田珈琲0x8335…2913U",
            "aside 4b4a106c5654 請求金額5 USDC≈ ¥750",
            "div fbdec6144618 決済用 QR コード閉じるOpe",
            "div 75d49299c4ea 請求金額5 USDC≈ ¥750",
          ],
        },
        "usdcAmount": {
          "all": "e56825c6103ff9413b2933899ccaf530513c8f4d4d4eeabad533c5632f514187",
          "parts": [
            "div 77d610789dd9 ",
            "div 4e2720ded2d0 店名未設定0x8335…2913",
            "aside 934ceead99e8 請求金額12.5 USDC≈ ¥",
            "div 7309dd8672ad 請求金額12.5 USDC≈ ¥",
          ],
        },
        "usdcFxApplied": {
          "all": "b0e5f9b563870a18d300b0c46029fa343c267a6c2945d82a95dd956012950d68",
          "parts": [
            "div 77d610789dd9 ",
            "div 50272784c31e 店名未設定0x8335…2913",
            "aside 1f554979d6b2 請求金額1,875 JPYCQR",
            "div 9297eecd7c80 請求金額1,875 JPYCQR",
          ],
        },
        "usdcFxModal": {
          "all": "82527062dd44c67a97754fdc681fd82f05bfeeab9d65d0544f28d680a7d2f3d4",
          "parts": [
            "div 77d610789dd9 ",
            "div 250d02160aad 店名未設定0x8335…2913",
            "aside 1f554979d6b2 請求金額1,875 JPYCQR",
            "div af16635f9fa8 決済用 QR コード閉じるOpe",
            "div 9297eecd7c80 請求金額1,875 JPYCQR",
          ],
        },
        "usdcSettingsSheet": {
          "all": "67e530f1b0fd5fd33b658374db1e8dca5fbbd8384e93b682ed8b74913facb772",
          "parts": [
            "div 77d610789dd9 ",
            "div 4e2720ded2d0 店名未設定0x8335…2913",
            "aside 934ceead99e8 請求金額12.5 USDC≈ ¥",
            "div 127b796e77af お店の設定完了受け取り受取先ウォ",
            "div 7309dd8672ad 請求金額12.5 USDC≈ ¥",
          ],
        },
        "watchReceived": {
          "all": "a27320978413ddb78ad0caeae7fcb71cf478c99bd145735f6791bfb63e7109e6",
          "parts": [
            "div 77d610789dd9 ",
            "div 0cead74f9762 店名未設定0x8335…2913",
            "aside 21a611c68df2 請求金額750 JPYCQRコー",
            "div caddd3f18a64 決済用 QR コード閉じるOpe",
            "div 7ec07a0f813b 請求金額750 JPYCQRコー",
          ],
        },
        "watchWatching": {
          "all": "6a18fef22d57e048f2d5debbb733d431f8cec294e94f522caf6a80ac1a337eda",
          "parts": [
            "div 77d610789dd9 ",
            "div 0cead74f9762 店名未設定0x8335…2913",
            "aside 21a611c68df2 請求金額750 JPYCQRコー",
            "div 29ab7c6cc505 決済用 QR コード閉じるOpe",
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
          "modal": "5226d84de4876bbac82a2323068362e7171f18702d0a732aa3a6dc8774e5e83f",
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
          "modal": "4a1a11d5cd0c68713515984d213ab2c7707090f5272b901e28b7640b158c3161",
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
          "modal": "c8e3f682b1815ce7bd3fcc2d09c8d809835ef3ef6222db06081e98f05c9f21ab",
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
          "modal": "4aa03250226d0072c094ab10b3af45ab7094d75371a67225cacfa19600b5bfef",
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
          "all": "60de7ffc4f651eb878c815b5dbe40fc807bd6e22c5cad2a545bdfbb150a6caa0",
          "parts": [
            "div 77d610789dd9 ",
            "div 3e15487bec89 店名未設定0x8335…2913",
            "aside 8ce733544927 1 JPYC 未満の会計では使え",
            "div 1437279c8f7c 請求金額0.5 JPYCQRコー",
          ],
        },
        "storeBlockedStatic": {
          "all": "daa11f7291136dd896ca7f4241301f71d8a3c202e9e4413c48a4b9c691d43343",
          "parts": [
            "div 77d610789dd9 ",
            "div 23a3ea971b36 店名未設定0x8335…2913",
            "aside 5228778ee43b 金額ありの QR だけで使えます",
            "div 3c304438833c 請求金額JPYC で金額を入力Q",
          ],
        },
        "storeCreateFailed": {
          "all": "4ea23d285584ff609e54fc9bddf9ebcb10f76ad421f014af4aa60ec48e8fd15a",
          "parts": [
            "div 77d610789dd9 ",
            "div 2ca52c71620d 店名未設定0x8335…2913",
            "aside 16d1e218b2b8 通常の QR を出す通常の QR",
            "div 3cf4eb536ffb 請求金額800 JPYCQRコー",
          ],
        },
        "storeModal": {
          "all": "9a778d2cd548dd2f6f6fb8a1eda6b16780513f330428fe841e026bdf190048d8",
          "parts": [
            "div 77d610789dd9 ",
            "div fa6d80a05fdd 店名未設定0x8335…2913",
            "aside 2cc76e1c1637 請求金額500 JPYCQRコー",
            "div 4aa03250226d 決済用 QR コード閉じるOpe",
            "div 26fa70486c48 請求金額500 JPYCQRコー",
          ],
        },
        "storeModalDimmed": {
          "all": "4d2151453cb7baa70cb41d88053d91f0b03ed2bb5270f52fe7fa5fd358061f40",
          "parts": [
            "div 77d610789dd9 ",
            "div c32aa06b364e 店名未設定0x8335…2913",
            "aside 54b57acbe676 請求金額1.5 JPYCQRコー",
            "div d3c93509cca1 決済用 QR コード閉じるOpe",
            "div c958c2006ed4 請求金額1.5 JPYCQRコー",
          ],
        },
        "storeModalWaiting": {
          "all": "e34810d2de2002792ca2f803383a1bf8f56443d58bcf6e86f6b0501ea5b5cf16",
          "parts": [
            "div 77d610789dd9 ",
            "div c32aa06b364e 店名未設定0x8335…2913",
            "aside 54b57acbe676 請求金額1.5 JPYCQRコー",
            "div 5226d84de487 決済用 QR コード閉じるOpe",
            "div c958c2006ed4 請求金額1.5 JPYCQRコー",
          ],
        },
        "storeNormalQr": {
          "all": "445874947de86d1b0f59d839f8fc4372509b793691ca1d8b4d2f665383b0ebce",
          "parts": [
            "div 77d610789dd9 ",
            "div d57db678fc96 店名未設定0x8335…2913",
            "aside 16d1e218b2b8 通常の QR を出す通常の QR",
            "div c8e3f682b181 決済用 QR コード閉じるOpe",
            "div 3cf4eb536ffb 請求金額800 JPYCQRコー",
          ],
        },
        "storeReady": {
          "all": "c5cef351f3447ab0d45cadf92b5fcc06f2ed79a0b5bc5738db58632eb84c103a",
          "parts": [
            "div 77d610789dd9 ",
            "div ba925847812d 店名未設定0x8335…2913",
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
