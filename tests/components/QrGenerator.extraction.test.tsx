import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
import type { QrSettings } from '@/hooks/useQrSettings';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';

// R11b (QrGenerator の表示節を components/qr/* へ抽出) の pinning。
// 期待値はすべて抽出前の main で記録・確認したもの。抽出に合わせて作り直さない
// (Phase 6 原則 2)。固定するもの:
//   - 生成される決済 URL / EIP-681 URI の完全一致 (JPYC/USDC・チェーン・金額有無・会計メタ・split・FX)
//   - 各節 (①金額 ②受取先 会計 高度な設定 ③QR 下部バー モーダル) の DOM (要素・属性・class・順序・文言)
//   - 子 component への分割で remount しないこと (focus・<details> の開閉・入力 node の同一性)
//   - モーダルの再表示とキャッシュ (コピー状態・前回 QR の保存・着金監視の再開)
//   - FX の期限が子の mount/unmount をまたいで保たれること
//   - SVG/PNG 保存が「今の」主 QR の ref を読むこと・印刷
//   - 下部バーの WebKit 再描画 effect の発火条件 (B-R11d: 出現時も含める)
// B-R11d の意図した差分: modal の focus 保持・バー出現時の再描画・モード切替時の入力保持。

const mocks = vi.hoisted(() => ({
  balance: undefined as bigint | undefined,
  read: vi.fn(),
  provider: vi.fn((): string => 'pimlico-7702'),
  forwarder: vi.fn((): `0x${string}` | null => null),
  origin: 'https://test.local',
  account: {
    address: undefined as `0x${string}` | undefined,
    isConnected: false,
  },
  usageFee: false,
}));
vi.mock('wagmi', () => ({
  useAccount: () => mocks.account,
  useReadContract: (args: unknown) => {
    mocks.read(args);
    return { data: mocks.balance };
  },
}));
vi.mock('@/hooks/useResolveAddress', () => ({
  useResolveAddress: () => ({ data: null, isFetching: false, error: null }),
}));
vi.mock('@/hooks/useOrigin', () => ({ useOrigin: () => mocks.origin }));
vi.mock('@/hooks/useMarketRates', () => ({
  useMarketRates: () => ({
    data: { usdcJpy: 150, updatedAt: '2026-09-24T00:00:00.000Z' },
  }),
}));
vi.mock('@/lib/jpycGaslessProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/jpycGaslessProvider')>()),
  resolveJpycGaslessProvider: mocks.provider,
}));
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/forwarderConfig')>()),
  jpycForwarderFor: mocks.forwarder,
}));
// a1 利用料の注記 (受取先 ≠ 接続ウォレット) だけを点灯できるよう enableUsageFee を差し替える。
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (target, key) =>
        key === 'enableUsageFee' ? mocks.usageFee : Reflect.get(target, key),
    }),
  };
});

import { QrGenerator } from '@/components/QrGenerator';

type Locale = 'ja' | 'en';

const RECEIVER = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CONNECTED = '0x1111111111111111111111111111111111111111';
const SPLIT = '0x2222222222222222222222222222222222222222';
const FORWARDER = '0x1234567890123456789012345678901234567890';
const BASE_URL = `https://test.local/pay?to=${RECEIVER}`;
const NOW = Date.parse('2026-09-24T00:00:00.000Z');
const SETTINGS_KEY = 'openpay:qr-settings:v2';
const LAST_QR_KEY = 'openpay:lastQr:v1';
const frames = new Map<number, FrameRequestCallback>();

let locale: Locale = 'ja';
let container: HTMLElement;
const msgs = () => (locale === 'ja' ? ja : en);
const labels = () => msgs().QrGenerator;

function seed(settings: Partial<QrSettings> = {}) {
  localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({ receiver: RECEIVER, receiverSource: 'manual', ...settings }),
  );
}

function renderQr() {
  const view = render(<QrGenerator />, { locale });
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
  const pattern = labels()
    .amountLabel.replace(/[()]/g, '\\$&')
    .replace('{symbol}', '[A-Z]+');
  return screen.getByRole('textbox', { name: new RegExp(`^${pattern}$`) });
}

function amount(value: string) {
  fireEvent.change(amountInput(), { target: { value } });
}

function receiverInput() {
  return screen.getByPlaceholderText(msgs().AddressInput.placeholder);
}

function step2Toggle() {
  return container.querySelector<HTMLButtonElement>(
    'button[aria-controls="step-2-body"]',
  )!;
}

function advancedToggle() {
  return screen.getByRole('button', {
    name: new RegExp(labels().advancedSettings),
  });
}

function openQr() {
  fireEvent.click(screen.getAllByRole('button', { name: labels().showQr })[0]);
  return screen.getByRole('dialog');
}

function closeQr() {
  fireEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: labels().qrModalClose,
    }),
  );
}

function displayedUrl() {
  return within(screen.getByRole('dialog')).getByText(
    /^https:\/\/test\.local\/pay\?/,
  ).textContent;
}

function detailsOf(text: string) {
  return screen.getByText(text).closest('details')!;
}

function mobileBar() {
  return container.querySelector<HTMLDivElement>('div.sticky.bottom-14');
}

const h = (value: string) =>
  createHash('sha256').update(value).digest('hex').slice(0, 12);

// この画面の <svg> はすべて第三者の出力 (lucide-react のアイコン・qrcode.react の QR)。
// その中身 (path の d・QR の module 数で変わる viewBox 等) や lucide が icon 名から
// 付ける class (lucide / lucide-*) を digest に含めると、依存の更新 (renovate の
// lockFileMaintenance 等) だけで全 digest が落ちて無関係の PR を止めるので、digest の
// 前に外す。残すのは <svg> 要素自身の位置と、こちらが指定する配置・a11y 系の属性
// (class の自前 utility・width/height・role・aria-*)。QR の中身は決済 URL の完全一致
// (displayedUrl) で、SVG/PNG 保存は serialize 結果の一致で別に固定している。
const SVG_KEPT_ATTR = /^(class|width|height|role|aria-.+)$/;
function withoutSvgInternals(el: Element): Element {
  const clone = el.cloneNode(true) as Element;
  for (const svg of Array.from(clone.querySelectorAll('svg'))) {
    svg.replaceChildren();
    for (const { name } of Array.from(svg.attributes)) {
      if (!SVG_KEPT_ATTR.test(name)) svg.removeAttribute(name);
    }
    const cls = svg.getAttribute('class');
    if (cls !== null) {
      svg.setAttribute(
        'class',
        cls
          .split(/\s+/)
          .filter((c) => c && c !== 'lucide' && !c.startsWith('lucide-'))
          .join(' '),
      );
    }
  }
  return clone;
}

// 節ごとの DOM digest (outerHTML = 要素・属性・class・子の順序・文言をすべて含む。
// ただし <svg> の中身は上の withoutSvgInternals で外す)。
// どの節が変わったかが 1 行の diff で読めるよう、節名つきの 1 文字列にする。
function sections(): string {
  // 下部バーの再描画 frame を先に消化し、style 属性を確定させてから記録する。
  flushFrames();
  const [offline, grid, ...outside] = Array.from(container.children);
  const [left, right, ...rest] = Array.from(grid.children);
  const leftNames = ['amount', 'receiver', 'accounting', 'settings', 'pwa'];
  const deep = (el: Element) => h(withoutSvgInternals(el).outerHTML);
  const shallow = (el: Element) => h((el.cloneNode(false) as Element).outerHTML);
  return [
    `shape=${container.children.length}/${grid.children.length}/${left.children.length}/${outside.length}`,
    `offline=${deep(offline)}`,
    `grid=${shallow(grid)}`,
    `left=${shallow(left)}`,
    ...Array.from(left.children).map(
      (el, i) => `${leftNames[i] ?? `left${i}`}=${deep(el)}`,
    ),
    `preview=${deep(right)}`,
    ...rest.map(
      (el) =>
        `${el.getAttribute('role') === 'dialog' ? 'modal' : 'bar'}=${deep(el)}`,
    ),
    `full=${h(withoutSvgInternals(container).innerHTML)}`,
  ].join(' ');
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
  mocks.balance = undefined;
  mocks.read.mockClear();
  mocks.provider.mockReturnValue('pimlico-7702');
  mocks.forwarder.mockReturnValue(null);
  mocks.origin = 'https://test.local';
  mocks.account = { address: undefined, isConnected: false };
  mocks.usageFee = false;
  locale = 'ja';
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('R11b: generated payment URL fixtures', () => {
  it.each([
    { name: 'default JPYC', settings: {}, value: '1000', suffix: '&token=jpyc&amount=1000' },
    { name: 'static JPYC', settings: {}, value: null, suffix: '&token=jpyc' },
    { name: 'JPYC on Kaia', settings: { chain: 'kaia' }, value: '300', suffix: '&token=jpyc&chain=kaia&amount=300' },
    { name: 'JPYC split with merchant gas', settings: { gasMode: 'merchant', splits: [{ address: SPLIT, percent: '30' }] }, value: '1000', suffix: `&token=jpyc&gas=merchant&amount=1000&split=${SPLIT}%3A30` },
    { name: 'USDC Base default', settings: { token: 'usdc', chain: 'base' }, value: '12.5', suffix: '&token=usdc&amount=12.5' },
    { name: 'static USDC Optimism', settings: { token: 'usdc', chain: 'optimism' }, value: null, suffix: '&token=usdc&chain=optimism' },
    { name: 'USDC split and opt-out', settings: { token: 'usdc', chain: 'arbitrum', gasMode: 'merchant', crossChain: false, splits: [{ address: SPLIT, percent: '30' }] }, value: '1.23456789', suffix: `&token=usdc&chain=arbitrum&gas=merchant&amount=1.234567&split=${SPLIT}%3A30&crossChain=false` },
    { name: 'standard ignores saved gas and split', settings: { token: 'usdc', chain: 'base', payMode: 'standard', gasMode: 'merchant', splits: [{ address: SPLIT, percent: '30' }] }, value: '5', suffix: '&token=usdc&amount=5&mode=standard' },
    { name: 'disabled Arc selection falls back to Base', settings: { token: 'usdc', chain: 'arc' }, value: '5', suffix: '&token=usdc&amount=5' },
    { name: 'free overrides saved merchant', settings: { gasMode: 'merchant' }, value: '500', relay: true, suffix: '&token=jpyc&amount=500' },
    { name: 'recover forces merchant', settings: { gasMode: 'customer' }, value: '500', relay: true, recover: true, suffix: '&token=jpyc&gas=merchant&amount=500' },
    { name: 'encoded accounting fields and zero tax', settings: { storeName: '神田 & Coffee', productName: '豆/袋', memo: 'A+B = 1', taxRate: 0, taxCategory: 'tax_free' }, value: '750', suffix: '&token=jpyc&amount=750&store=%E7%A5%9E%E7%94%B0+%26+Coffee&pname=%E8%B1%86%2F%E8%A2%8B&memo=A%2BB+%3D+1&tax=0&taxcat=tax_free' },
  ])('$name: exact generated URL bytes', async ({ settings, value, suffix, relay, recover }) => {
    seed(settings as Partial<QrSettings>);
    if (relay) mocks.provider.mockReturnValue('eip3009-relay');
    if (recover) mocks.forwarder.mockReturnValue(FORWARDER);
    renderQr();
    await settle();
    if (value === null) fireEvent.click(screen.getByRole('button', { name: labels().modeStatic }));
    else amount(value);
    openQr();
    expect(displayedUrl()).toBe(BASE_URL + suffix);
  });

  it('turning the cross-chain checkbox off via the UI bakes crossChain=false into the URL', async () => {
    seed({ token: 'usdc', chain: 'arbitrum' });
    renderQr();
    await settle();
    amount('5');
    fireEvent.click(advancedToggle());
    fireEvent.click(screen.getByRole('checkbox'));
    openQr();
    expect(displayedUrl()).toBe(BASE_URL + '&token=usdc&chain=arbitrum&amount=5&crossChain=false');
    closeQr();
    fireEvent.click(screen.getByRole('checkbox'));
    openQr();
    expect(displayedUrl()).toBe(BASE_URL + '&token=usdc&chain=arbitrum&amount=5');
  });

  it('receipt number (local state, never persisted) is appended after the saved accounting fields', async () => {
    seed({ memo: 'レジ1' });
    renderQr();
    await settle();
    amount('300');
    fireEvent.change(screen.getByPlaceholderText(labels().receiptNoPlaceholder), {
      target: { value: 'R-001' },
    });
    openQr();
    expect(displayedUrl()).toBe(
      BASE_URL + '&token=jpyc&amount=300&memo=%E3%83%AC%E3%82%B81&rcpt=R-001',
    );
    expect(localStorage.getItem(SETTINGS_KEY)).not.toContain('R-001');
  });

  it('standard mode also issues the exact EIP-681 transfer URI', async () => {
    seed({ token: 'usdc', chain: 'base', payMode: 'standard' });
    renderQr();
    await settle();
    amount('5');
    const dialog = openQr();
    expect(within(dialog).getByText(/^ethereum:/).textContent).toBe(
      'ethereum:0x036CbD53842c5426634e7929541eC2318f3dCF7e@84532/transfer?address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&uint256=5000000',
    );
  });
});

// 抽出前 main (444c30ce・QrGenerator は 3b205825 / 164f49c2 と同一) で記録した節ごとの
// DOM digest (sha256 先頭 12 桁・<svg> の中身は除外)。shape = 子要素数 (container/grid/左列/grid 外)。
// 意図して DOM を変えたとき (文言・class・構造の変更) の記録し直し方: この describe を
// 実行すると toEqual の diff に実際の `節名=digest` 文字列が出る。diff で変わった節名が
// 変更の意図と一致することを確かめてから、その文字列を下の該当キーへ写す。抽出・分割の
// 差分に合わせて書き換えてはならない (Phase 6 原則 2 — その場合は抽出前の code で記録する)。
// lucide-react / qrcode.react の更新だけで digest が変わるなら除外 (withoutSvgInternals) の漏れ。
// B-R11d: fresh-ja/en の static/modal だけ amount/full を更新。金額欄・エディタが
// hidden で残るため。amount モードの DOM と、それ以外の節の digest は不変。
// B-R11f: usdc/fx-modal の modal/full だけ更新 (期限前から mount する空の FX 通知領域)。
const DOM_BASELINE: Record<string, string> = {
  'fresh-ja/empty':
    'shape=2/2/4/0 offline=f77ebeefe1a1 grid=8c2858128be8 left=2b7c226170e0 amount=58f78ef36af2 receiver=e7e8e741048e accounting=1ae21b00fd1a settings=52f60fef0496 preview=df6fdaa1b2ab full=87e6a26fdc72',
  'fresh-ja/receiver-typed':
    'shape=2/2/4/0 offline=f77ebeefe1a1 grid=8c2858128be8 left=2b7c226170e0 amount=58f78ef36af2 receiver=53e63a799c4c accounting=1ae21b00fd1a settings=52f60fef0496 preview=ef5f97440853 full=b431de83bbbe',
  'fresh-ja/amount':
    'shape=2/3/4/0 offline=f77ebeefe1a1 grid=8c2858128be8 left=2b7c226170e0 amount=f11c9c908a3d receiver=53e63a799c4c accounting=1ae21b00fd1a settings=52f60fef0496 preview=a2659703e1e8 bar=59ab00522b30 full=a03fc2472495',
  'fresh-ja/advanced':
    'shape=2/3/4/0 offline=f77ebeefe1a1 grid=8c2858128be8 left=2b7c226170e0 amount=f11c9c908a3d receiver=53e63a799c4c accounting=1ae21b00fd1a settings=248c7149dc79 preview=a2659703e1e8 bar=59ab00522b30 full=da0a17195a81',
  'fresh-ja/static':
    'shape=2/3/4/0 offline=f77ebeefe1a1 grid=8c2858128be8 left=2b7c226170e0 amount=6535b1cbe2da receiver=53e63a799c4c accounting=1ae21b00fd1a settings=248c7149dc79 preview=a2659703e1e8 bar=de07dcf3f38f full=49b178e99ae5',
  'fresh-ja/modal':
    'shape=2/4/5/0 offline=f77ebeefe1a1 grid=8c2858128be8 left=2b7c226170e0 amount=6535b1cbe2da receiver=53e63a799c4c accounting=1ae21b00fd1a settings=248c7149dc79 pwa=f0506b8ca563 preview=a2659703e1e8 modal=bddf69eea475 bar=de07dcf3f38f full=e50b5a7ab4d1',
  'fresh-en/empty':
    'shape=2/2/4/0 offline=f77ebeefe1a1 grid=8c2858128be8 left=2b7c226170e0 amount=63f2f3856490 receiver=df2279b703b8 accounting=74ed35d7215a settings=16c64a10b7aa preview=fe779a049a06 full=94d3a55cfcb0',
  'fresh-en/receiver-typed':
    'shape=2/2/4/0 offline=f77ebeefe1a1 grid=8c2858128be8 left=2b7c226170e0 amount=63f2f3856490 receiver=fedfcd16f726 accounting=74ed35d7215a settings=16c64a10b7aa preview=0866874a49a0 full=1299d7bd940f',
  'fresh-en/amount':
    'shape=2/3/4/0 offline=f77ebeefe1a1 grid=8c2858128be8 left=2b7c226170e0 amount=225a60671bb5 receiver=fedfcd16f726 accounting=74ed35d7215a settings=16c64a10b7aa preview=af1a40c48a66 bar=8fd7054ec7dc full=8bc0db723b39',
  'fresh-en/advanced':
    'shape=2/3/4/0 offline=f77ebeefe1a1 grid=8c2858128be8 left=2b7c226170e0 amount=225a60671bb5 receiver=fedfcd16f726 accounting=74ed35d7215a settings=8d52fa6c9d78 preview=af1a40c48a66 bar=8fd7054ec7dc full=2ae0731b41e4',
  'fresh-en/static':
    'shape=2/3/4/0 offline=f77ebeefe1a1 grid=8c2858128be8 left=2b7c226170e0 amount=0967e76f4762 receiver=fedfcd16f726 accounting=74ed35d7215a settings=8d52fa6c9d78 preview=af1a40c48a66 bar=7af51957c9d0 full=d6f784e55d7a',
  'fresh-en/modal':
    'shape=2/4/5/0 offline=f77ebeefe1a1 grid=8c2858128be8 left=2b7c226170e0 amount=0967e76f4762 receiver=fedfcd16f726 accounting=74ed35d7215a settings=8d52fa6c9d78 pwa=3e04971c2b53 preview=af1a40c48a66 modal=1f8b3ee8e853 bar=7af51957c9d0 full=3143a82eacfe',
  'seeded/collapsed':
    'shape=2/2/4/0 offline=f77ebeefe1a1 grid=8c2858128be8 left=2b7c226170e0 amount=58f78ef36af2 receiver=a40a7c4b7637 accounting=1ae21b00fd1a settings=52f60fef0496 preview=ef5f97440853 full=16d1e09dc74d',
  'seeded/step2-open':
    'shape=2/2/4/0 offline=f77ebeefe1a1 grid=8c2858128be8 left=2b7c226170e0 amount=58f78ef36af2 receiver=6402faeff77a accounting=1ae21b00fd1a settings=52f60fef0496 preview=ef5f97440853 full=d43b7b3b3bdc',
  'seeded/advanced-split':
    'shape=2/3/4/0 offline=f77ebeefe1a1 grid=8c2858128be8 left=2b7c226170e0 amount=0c61aca9e357 receiver=6402faeff77a accounting=1ae21b00fd1a settings=a0ad50b9662c preview=a2659703e1e8 bar=59ab00522b30 full=609e5ee8741e',
  'seeded/quick-editor':
    'shape=2/3/4/0 offline=f77ebeefe1a1 grid=8c2858128be8 left=2b7c226170e0 amount=8b58a06e7024 receiver=6402faeff77a accounting=1ae21b00fd1a settings=a0ad50b9662c preview=a2659703e1e8 bar=59ab00522b30 full=f1a7c0a82a87',
  'seeded/accounting':
    'shape=2/3/4/0 offline=f77ebeefe1a1 grid=8c2858128be8 left=2b7c226170e0 amount=8b58a06e7024 receiver=6402faeff77a accounting=c1efa3a4b75e settings=a0ad50b9662c preview=a2659703e1e8 bar=59ab00522b30 full=1bc85f8c1ac9',
  'usdc/amount-fiat':
    'shape=2/3/4/0 offline=f77ebeefe1a1 grid=8c2858128be8 left=2b7c226170e0 amount=b8ed42a5143e receiver=f06e1dbf118c accounting=1ae21b00fd1a settings=52f60fef0496 preview=a2659703e1e8 bar=f03f88810f5b full=6b407e8598ad',
  'usdc/advanced-crosschain':
    'shape=2/3/4/0 offline=f77ebeefe1a1 grid=8c2858128be8 left=2b7c226170e0 amount=b8ed42a5143e receiver=f06e1dbf118c accounting=1ae21b00fd1a settings=481ca9776306 preview=a2659703e1e8 bar=f03f88810f5b full=59ffa146b244',
  'usdc/fx-applied':
    'shape=2/3/4/0 offline=f77ebeefe1a1 grid=8c2858128be8 left=2b7c226170e0 amount=8246c076c52b receiver=f06e1dbf118c accounting=1ae21b00fd1a settings=248c7149dc79 preview=a2659703e1e8 bar=6f06b167fcfe full=6ea0cb5a67de',
  'usdc/fx-modal':
    'shape=2/4/5/0 offline=f77ebeefe1a1 grid=8c2858128be8 left=2b7c226170e0 amount=8246c076c52b receiver=f06e1dbf118c accounting=1ae21b00fd1a settings=248c7149dc79 pwa=f0506b8ca563 preview=a2659703e1e8 modal=d861551cfa0d bar=6f06b167fcfe full=3894130a185e',
  'usdc/fx-expired':
    'shape=2/3/5/0 offline=f77ebeefe1a1 grid=8c2858128be8 left=2b7c226170e0 amount=905cb32ce2af receiver=f06e1dbf118c accounting=1ae21b00fd1a settings=248c7149dc79 pwa=f0506b8ca563 preview=a2659703e1e8 bar=6f06b167fcfe full=b0d30d24b2f9',
  'standard/closed':
    'shape=2/3/4/0 offline=f77ebeefe1a1 grid=8c2858128be8 left=2b7c226170e0 amount=e2cb9fc58f8e receiver=f06e1dbf118c accounting=1ae21b00fd1a settings=e521d1b1f9d3 preview=a2659703e1e8 bar=f316e8a8778c full=ffc2d4731db3',
  'standard/advanced':
    'shape=2/3/4/0 offline=f77ebeefe1a1 grid=8c2858128be8 left=2b7c226170e0 amount=e2cb9fc58f8e receiver=f06e1dbf118c accounting=1ae21b00fd1a settings=587b06de2156 preview=a2659703e1e8 bar=f316e8a8778c full=c43510314f30',
  'standard/modal-eip681':
    'shape=2/4/5/0 offline=f77ebeefe1a1 grid=8c2858128be8 left=2b7c226170e0 amount=e2cb9fc58f8e receiver=f06e1dbf118c accounting=1ae21b00fd1a settings=587b06de2156 pwa=f0506b8ca563 preview=a2659703e1e8 modal=d91b96035e2b bar=f316e8a8778c full=2ba83c8278a5',
  'recover/closed':
    'shape=2/3/4/0 offline=f77ebeefe1a1 grid=8c2858128be8 left=2b7c226170e0 amount=6e41c8856081 receiver=f06e1dbf118c accounting=1ae21b00fd1a settings=58804c1d9ee2 preview=a2659703e1e8 bar=70c6ee9f9cf5 full=639a69d0c511',
  'recover/advanced':
    'shape=2/3/4/0 offline=f77ebeefe1a1 grid=8c2858128be8 left=2b7c226170e0 amount=6e41c8856081 receiver=f06e1dbf118c accounting=1ae21b00fd1a settings=852c863652e2 preview=a2659703e1e8 bar=70c6ee9f9cf5 full=673215778dbf',
  'free/closed':
    'shape=2/3/4/0 offline=f77ebeefe1a1 grid=8c2858128be8 left=2b7c226170e0 amount=2957e6520b93 receiver=f06e1dbf118c accounting=1ae21b00fd1a settings=a181c16167ab preview=a2659703e1e8 bar=70c6ee9f9cf5 full=6948bd29d66e',
  'free/advanced':
    'shape=2/3/4/0 offline=f77ebeefe1a1 grid=8c2858128be8 left=2b7c226170e0 amount=2957e6520b93 receiver=f06e1dbf118c accounting=1ae21b00fd1a settings=852c863652e2 preview=a2659703e1e8 bar=70c6ee9f9cf5 full=048079129c84',
  'invalid/invalid':
    'shape=2/2/4/0 offline=f77ebeefe1a1 grid=8c2858128be8 left=2b7c226170e0 amount=58f78ef36af2 receiver=b71d06586735 accounting=1ae21b00fd1a settings=52f60fef0496 preview=df6fdaa1b2ab full=e6d53badc8f4',
  'generating/generating':
    'shape=2/2/4/0 offline=f77ebeefe1a1 grid=8c2858128be8 left=2b7c226170e0 amount=f11c9c908a3d receiver=f06e1dbf118c accounting=1ae21b00fd1a settings=52f60fef0496 preview=8c5d0f2ab6ef full=059e91c5a89c',
  'usage-fee/mismatch':
    'shape=2/2/4/0 offline=f77ebeefe1a1 grid=8c2858128be8 left=2b7c226170e0 amount=58f78ef36af2 receiver=2419f4bc0986 accounting=1ae21b00fd1a settings=52f60fef0496 preview=ef5f97440853 full=36b6f4e55cc6',
  'watch/watching':
    'shape=2/4/5/0 offline=f77ebeefe1a1 grid=8c2858128be8 left=2b7c226170e0 amount=e74441b2f95e receiver=f06e1dbf118c accounting=1ae21b00fd1a settings=52f60fef0496 pwa=f0506b8ca563 preview=a2659703e1e8 modal=2a6584873b2b bar=5f5f11543bcb full=0243d244d431',
  'watch/received':
    'shape=2/4/5/0 offline=f77ebeefe1a1 grid=8c2858128be8 left=2b7c226170e0 amount=e74441b2f95e receiver=f06e1dbf118c accounting=1ae21b00fd1a settings=52f60fef0496 pwa=f0506b8ca563 preview=a2659703e1e8 modal=cfc4a026e8d1 bar=5f5f11543bcb full=d6ce194ac06e',
  'watch/closed-with-pwa-hint':
    'shape=2/3/5/0 offline=f77ebeefe1a1 grid=8c2858128be8 left=2b7c226170e0 amount=e74441b2f95e receiver=f06e1dbf118c accounting=1ae21b00fd1a settings=52f60fef0496 pwa=f0506b8ca563 preview=a2659703e1e8 bar=5f5f11543bcb full=5e5d9dc6cb7b',
};

type Snap = (name: string) => void;

async function freshFlow(snap: Snap) {
  renderQr();
  await settle();
  snap('empty');
  fireEvent.change(receiverInput(), { target: { value: RECEIVER } });
  await settle();
  snap('receiver-typed');
  amount('1000');
  await settle();
  snap('amount');
  fireEvent.click(advancedToggle());
  await settle();
  snap('advanced');
  fireEvent.click(screen.getByRole('button', { name: labels().modeStatic }));
  await settle();
  snap('static');
  openQr();
  await settle();
  snap('modal');
}

const SCENARIOS: Record<string, { locale: Locale; run: (snap: Snap) => Promise<void> }> = {
  'fresh-ja': { locale: 'ja', run: freshFlow },
  'fresh-en': { locale: 'en', run: freshFlow },
  seeded: {
    locale: 'ja',
    run: async (snap) => {
      seed({ storeName: ' 神田珈琲 ', posterNote: 'ありがとう', splits: [{ address: SPLIT, percent: '30' }] });
      renderQr();
      await settle();
      snap('collapsed');
      fireEvent.click(step2Toggle());
      await settle();
      snap('step2-open');
      amount('1000');
      fireEvent.click(advancedToggle());
      await settle();
      snap('advanced-split');
      detailsOf(labels().quickAmountsLabel).open = true;
      await settle();
      snap('quick-editor');
      detailsOf(labels().accountingFieldsTitle).open = true;
      fireEvent.change(screen.getByPlaceholderText(labels().productNamePlaceholder), { target: { value: '豆' } });
      fireEvent.change(screen.getByPlaceholderText(labels().memoPlaceholder), { target: { value: 'メモ' } });
      fireEvent.change(screen.getByPlaceholderText(labels().receiptNoPlaceholder), { target: { value: 'R-9' } });
      await settle();
      snap('accounting');
    },
  },
  usdc: {
    locale: 'ja',
    run: async (snap) => {
      seed({ token: 'usdc', chain: 'base' });
      renderQr();
      await settle();
      amount('12.5');
      await settle();
      snap('amount-fiat');
      fireEvent.click(advancedToggle());
      await settle();
      snap('advanced-crosschain');
      fireEvent.click(screen.getByRole('button', { name: labels().convertButton.replace('{symbol}', 'JPYC') }));
      await settle();
      snap('fx-applied');
      openQr();
      await settle();
      snap('fx-modal');
      closeQr();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(181_000);
      });
      snap('fx-expired');
    },
  },
  standard: {
    locale: 'ja',
    run: async (snap) => {
      seed({ token: 'usdc', chain: 'base', payMode: 'standard' });
      renderQr();
      await settle();
      amount('5');
      await settle();
      snap('closed');
      fireEvent.click(advancedToggle());
      await settle();
      snap('advanced');
      const dialog = openQr();
      fireEvent.click(within(dialog).getByText(labels().eip681Title));
      await settle();
      snap('modal-eip681');
    },
  },
  recover: {
    locale: 'ja',
    run: async (snap) => {
      mocks.provider.mockReturnValue('eip3009-relay');
      mocks.forwarder.mockReturnValue(FORWARDER);
      seed();
      renderQr();
      await settle();
      amount('500');
      await settle();
      snap('closed');
      fireEvent.click(advancedToggle());
      await settle();
      snap('advanced');
    },
  },
  free: {
    locale: 'ja',
    run: async (snap) => {
      mocks.provider.mockReturnValue('eip3009-relay');
      seed();
      renderQr();
      await settle();
      amount('500');
      await settle();
      snap('closed');
      fireEvent.click(advancedToggle());
      await settle();
      snap('advanced');
    },
  },
  invalid: {
    locale: 'ja',
    run: async (snap) => {
      renderQr();
      await settle();
      fireEvent.change(receiverInput(), { target: { value: '0x1234' } });
      await settle();
      snap('invalid');
    },
  },
  generating: {
    locale: 'ja',
    run: async (snap) => {
      mocks.origin = '';
      seed();
      renderQr();
      await settle();
      amount('1000');
      await settle();
      snap('generating');
    },
  },
  'usage-fee': {
    locale: 'ja',
    run: async (snap) => {
      mocks.usageFee = true;
      mocks.account = { address: CONNECTED, isConnected: true };
      seed();
      renderQr();
      await settle();
      fireEvent.click(step2Toggle());
      await settle();
      snap('mismatch');
    },
  },
  watch: {
    locale: 'ja',
    run: async (snap) => {
      seed();
      const view = renderQr();
      await settle();
      amount('750');
      openQr();
      await settle();
      snap('watching');
      mocks.balance = 10n ** 21n;
      view.rerender(<QrGenerator />);
      mocks.balance += 750n * 10n ** 18n;
      view.rerender(<QrGenerator />);
      await settle();
      snap('received');
      closeQr();
      await settle();
      snap('closed-with-pwa-hint');
    },
  },
};

describe('R11b: section DOM with B-R11d hidden static controls', () => {
  it.each(Object.keys(SCENARIOS))('%s', async (key) => {
    const scenario = SCENARIOS[key];
    locale = scenario.locale;
    const actual: Record<string, string> = {};
    await scenario.run((name) => {
      actual[`${key}/${name}`] = sections();
    });
    const expected = Object.fromEntries(
      Object.keys(actual).map((name) => [name, DOM_BASELINE[name]]),
    );
    expect(actual).toEqual(expected);
  });
});

describe('R11b: no remount when sections become child components', () => {
  it('keeps focus, input nodes and uncontrolled <details> state across parent re-renders', async () => {
    seed({ token: 'usdc', chain: 'base', splits: [{ address: SPLIT, percent: '30' }] });
    renderQr();
    await settle();
    const amountEl = amountInput();
    expect(document.activeElement).toBe(amountEl);
    fireEvent.click(advancedToggle());
    fireEvent.click(step2Toggle());
    await settle();
    const quickDetails = detailsOf(labels().quickAmountsLabel);
    const accountingDetails = detailsOf(labels().accountingFieldsTitle);
    quickDetails.open = true;
    accountingDetails.open = true;
    const requery = () => ({
      amountEl: amountInput(),
      quickDetails: detailsOf(labels().quickAmountsLabel),
      accountingDetails: detailsOf(labels().accountingFieldsTitle),
      quickInput: within(detailsOf(labels().quickAmountsLabel)).getAllByRole('textbox')[0],
      storeName: screen.getByPlaceholderText(labels().storeNamePlaceholder),
      posterNote: screen.getByPlaceholderText(labels().posterNotePlaceholder),
      receiver: receiverInput(),
      receipt: screen.getByPlaceholderText(labels().receiptNoPlaceholder),
      crossChain: screen.getByRole('checkbox'),
      splitAddress: screen.getByDisplayValue(SPLIT),
      advanced: advancedToggle(),
      step2: step2Toggle(),
      modeAmount: screen.getByRole('button', { name: labels().modeAmount }),
      modeStatic: screen.getByRole('button', { name: labels().modeStatic }),
    });
    const nodes = requery();
    const rerenders: [string, () => void][] = [
      ['amount', () => amount('12')],
      ['quick amount apply', () => fireEvent.click(screen.getByRole('button', { name: '20 USDC' }))],
      ['quick amount edit', () => fireEvent.change(nodes.quickInput, { target: { value: '7' } })],
      ['store name', () => fireEvent.change(nodes.storeName, { target: { value: 'A' } })],
      ['poster note', () => fireEvent.change(nodes.posterNote, { target: { value: 'B' } })],
      ['receipt', () => fireEvent.change(nodes.receipt, { target: { value: 'R' } })],
      ['cross-chain', () => fireEvent.click(nodes.crossChain)],
      ['split percent', () => fireEvent.change(screen.getByDisplayValue('30'), { target: { value: '40' } })],
      ['chain', () => fireEvent.click(screen.getByRole('button', { name: /Arbitrum/ }))],
      ['pay mode', () => fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${labels().payModeGaslessTitle}`) }))],
    ];
    for (const [what, action] of rerenders) {
      action();
      await settle();
      expect({ what, same: requery() }).toEqual({ what, same: nodes });
      for (const [key, node] of Object.entries(nodes)) {
        expect({ what, key, connected: node.isConnected }).toEqual({ what, key, connected: true });
      }
      expect({ what, quick: quickDetails.open, accounting: accountingDetails.open }).toEqual({
        what,
        quick: true,
        accounting: true,
      });
      expect({ what, focused: document.activeElement === amountEl }).toEqual({ what, focused: true });
    }
    // モーダルは dialog に focus を移す (既存挙動)。閉じた後も節の node と開閉状態は同じ。
    openQr();
    await settle();
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    closeQr();
    await settle();
    expect(requery()).toEqual(nodes);
    expect([quickDetails.open, accountingDetails.open]).toEqual([true, true]);
    // B-R11d S1: 据え置き中も金額欄とエディタを保持。ユーザーが金額指定へ
    // 戻した時だけ同じ入力 node に focus し、クイック金額の開閉も保持する。
    // モード切替ボタン自体は ① の節ごと作り直されない (同じ node のまま)。
    fireEvent.click(screen.getByRole('button', { name: labels().modeStatic }));
    await settle();
    expect(amountEl).toBeInTheDocument();
    expect(amountEl).not.toBeVisible();
    expect(quickDetails).toBeInTheDocument();
    expect(quickDetails).not.toBeVisible();
    expect(within(quickDetails).queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.getByRole('button', { name: labels().modeStatic })).toBe(nodes.modeStatic);
    expect(screen.getByRole('button', { name: labels().modeAmount })).toBe(nodes.modeAmount);
    const focusAmount = amountEl.focus.bind(amountEl);
    const focusSpy = vi.spyOn(amountEl, 'focus').mockImplementation(() => {
      // jsdom は hidden な入力にも focus できるので、実ブラウザで必要な表示順も検証する。
      expect(amountEl).toBeVisible();
      focusAmount();
    });
    nodes.modeAmount.focus();
    fireEvent.click(nodes.modeAmount);
    await settle();
    expect(screen.getByRole('button', { name: labels().modeAmount })).toBe(nodes.modeAmount);
    expect(screen.getByRole('button', { name: labels().modeStatic })).toBe(nodes.modeStatic);
    expect(amountInput()).toBe(amountEl);
    expect(amountEl).toBeVisible();
    expect(amountEl).toHaveValue('20');
    expect(focusSpy).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(amountEl);
    expect(detailsOf(labels().quickAmountsLabel)).toBe(quickDetails);
    expect(quickDetails).toBeVisible();
    expect(quickDetails.open).toBe(true);
    expect(within(quickDetails).getAllByRole('textbox')[0]).toBe(nodes.quickInput);
    expect(nodes.quickInput).toHaveValue('7');
    expect(detailsOf(labels().accountingFieldsTitle)).toBe(accountingDetails);
    expect(accountingDetails.open).toBe(true);
    expect(advancedToggle()).toBe(nodes.advanced);
    expect(screen.getByRole('checkbox')).toBe(nodes.crossChain);
    focusSpy.mockClear();
    nodes.modeAmount.focus();
    fireEvent.click(nodes.modeAmount);
    expect(focusSpy).not.toHaveBeenCalled(); // 同じモードの再選択では focus を移さない。
    expect(document.activeElement).toBe(nodes.modeAmount);
  });

  it('keeps the Step 2 and advanced-settings open state owned by the generator across modal and mode changes', async () => {
    seed();
    renderQr();
    await settle();
    expect(step2Toggle()).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(step2Toggle());
    fireEvent.click(advancedToggle());
    amount('1000');
    openQr();
    closeQr();
    fireEvent.click(screen.getByRole('button', { name: labels().modeStatic }));
    fireEvent.click(screen.getByRole('button', { name: labels().modeAmount }));
    await settle();
    expect(step2Toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(advancedToggle()).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('B-R11d: retained amount in static mode', () => {
  it('omits a previously typed amount and EIP-681 in static mode, restoring both when switched back', async () => {
    seed({ token: 'usdc', chain: 'base', payMode: 'standard' });
    renderQr();
    await settle();
    amount('12.5');
    const input = amountInput();
    const amountDialog = openQr();
    const amountUrl = BASE_URL + '&token=usdc&amount=12.5&mode=standard';
    expect(displayedUrl()).toBe(amountUrl);
    const eip681 = within(amountDialog).getByText(/^ethereum:/).textContent;
    expect(within(amountDialog).getByText(labels().eip681Title)).toBeInTheDocument();
    closeQr();

    fireEvent.click(screen.getByRole('button', { name: labels().modeStatic }));
    expect(input).toHaveValue('12.5');
    expect(input).not.toBeVisible();
    const staticDialog = openQr();
    expect(displayedUrl()).toBe(BASE_URL + '&token=usdc&mode=standard');
    expect(within(staticDialog).queryByText(labels().eip681Title)).toBeNull();
    expect(within(staticDialog).queryByText(/^ethereum:/)).toBeNull();
    closeQr();

    fireEvent.click(screen.getByRole('button', { name: labels().modeAmount }));
    expect(amountInput()).toBe(input);
    const restoredDialog = openQr();
    expect(displayedUrl()).toBe(amountUrl);
    expect(within(restoredDialog).getByText(labels().eip681Title)).toBeInTheDocument();
    expect(within(restoredDialog).getByText(/^ethereum:/).textContent).toBe(eip681);
  });
});

describe('B-R11d: mobile bar repaint effect', () => {
  it('repaints on appearance and amount/mode/symbol changes, cancelling stale frames on hide or unmount', async () => {
    const view = renderQr();
    await settle();
    amount('1000');
    await settle();
    // 受取先が未設定の間はバーが無い (effect は ref=null で素通り)。
    expect(mobileBar()).toBeNull();
    fireEvent.change(receiverInput(), { target: { value: RECEIVER } });
    await settle();
    // 金額が先・受取先が後でも、バーの初回表示で WebKit の再描画を促す。
    const bar = mobileBar()!;
    expect(bar.style.transform).toBe('translateZ(0)');
    expect(frames.size).toBe(1);
    flushFrames();
    expect(bar.style.transform).toBe('');
    fireEvent.change(screen.getByPlaceholderText(labels().storeNamePlaceholder), { target: { value: '店' } });
    await settle();
    expect(bar.style.transform).toBe('');
    expect(frames.size).toBe(0); // URL の変更だけでは再描画しない。
    amount('1200');
    expect(bar.style.transform).toBe('translateZ(0)');
    amount('1300');
    // 前の frame は cleanup で cancel され、保留は常に 1 つ。
    expect(frames.size).toBe(1);
    flushFrames();
    expect(bar.getAttribute('style')).toBe('');
    fireEvent.click(screen.getByRole('button', { name: labels().modeStatic }));
    expect(bar.style.transform).toBe('translateZ(0)');
    flushFrames();
    fireEvent.click(screen.getByRole('button', { name: labels().modeAmount }));
    flushFrames();
    fireEvent.click(screen.getByRole('button', { name: 'USDC' }));
    await settle();
    expect(mobileBar()).toBe(bar);
    expect(bar.style.transform).toBe('translateZ(0)');
    flushFrames();
    expect(bar.style.transform).toBe('');
    amount('1400');
    expect(frames.size).toBe(1);
    fireEvent.change(receiverInput(), { target: { value: '' } });
    expect(mobileBar()).toBeNull();
    expect(frames.size).toBe(0);
    fireEvent.change(receiverInput(), { target: { value: RECEIVER } });
    const reappeared = mobileBar()!;
    expect(reappeared).not.toBe(bar);
    expect(reappeared.style.transform).toBe('translateZ(0)');
    expect(frames.size).toBe(1);
    view.unmount();
    expect(frames.size).toBe(0);
  });
});

describe('B-R11d: modal focus survives parent updates', () => {
  it('keeps focus during balance polling and background input, and still focuses on reopen and closes with Escape', async () => {
    seed();
    const view = renderQr();
    await settle();
    amount('750');
    const dialog = openQr();
    expect(dialog).toHaveFocus();
    const close = within(dialog).getByRole('button', { name: labels().qrModalClose });
    close.focus();
    mocks.balance = 10n ** 21n;
    view.rerender(<QrGenerator />);
    expect(close).toHaveFocus();
    mocks.balance += 750n * 10n ** 18n;
    view.rerender(<QrGenerator />);
    expect(within(dialog).getByRole('status').textContent).toContain('残高の増加');
    expect(close).toHaveFocus();
    const input = amountInput();
    input.focus();
    amount('950');
    expect(input).toHaveFocus();
    expect(displayedUrl()).toBe(BASE_URL + '&token=jpyc&amount=950');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(openQr()).toHaveFocus();
    closeQr();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the modal action focused while the FX countdown re-renders the generator', async () => {
    seed();
    renderQr();
    await settle();
    amount('1000');
    fireEvent.click(screen.getByRole('button', { name: labels().convertButton.replace('{symbol}', 'USDC') }));
    const dialog = openQr();
    const close = within(dialog).getByRole('button', { name: labels().qrModalClose });
    close.focus();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByText(/残り 2:59/)).toBeInTheDocument();
    expect(close).toHaveFocus();
  });
});

describe('B-R11f: FX expiry in the open modal', () => {
  it.each(['ja', 'en'] as const)('%s: propagates expiry without reopening or replacing the QR', async (lang) => {
    locale = lang;
    seed();
    renderQr();
    await settle();
    amount('1000');
    fireEvent.click(screen.getByRole('button', { name: labels().convertButton.replace('{symbol}', 'USDC') }));
    const dialog = openQr();
    const status = within(dialog).getAllByRole('status').find((node) => !node.textContent)!;
    const qr = dialog.querySelector('svg[width="340"]')!;
    const url = displayedUrl();
    const close = within(dialog).getByRole('button', { name: labels().qrModalClose });
    close.focus();
    expect(status).toBeEmptyDOMElement();
    expect(within(dialog).getByRole('button', { name: labels().qrCopy })).toBeEnabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
    expect(status).toBeEmptyDOMElement(); // Existing expiry is strictly after exp.
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(within(dialog).getByText(labels().qrModalConvertExpired)).toBe(status);
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(dialog.querySelector('svg[width="340"]')).toBe(qr);
    expect(qr.parentElement).toHaveClass('opacity-40');
    expect(displayedUrl()).toBe(url);
    expect(close).toHaveFocus();
    expect(close).toBeEnabled();
    for (const name of [labels().qrCopy, labels().printPoster, labels().downloadSvg, labels().downloadPng]) {
      expect(within(dialog).getByRole('button', { name })).toBeDisabled();
    }
    closeQr();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('leaves a regular QR unchanged after the FX expiry interval', async () => {
    seed();
    renderQr();
    await settle();
    amount('1000');
    const dialog = openQr();
    const before = dialog.outerHTML;
    await act(async () => { await vi.advanceTimersByTimeAsync(181_000); });
    expect(dialog.outerHTML).toBe(before);
    expect(within(dialog).queryByText(labels().qrModalConvertExpired)).toBeNull();
    for (const button of within(dialog).getAllByRole('button')) {
      expect(button).toBeEnabled();
    }
  });
});

describe('R11b: modal reopen, FX expiry, downloads and print', () => {
  it('reopens the modal with copy state, refreshes last-QR storage only when open, and renews the balance scope', async () => {
    seed({ storeName: ' 神田珈琲 ' });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const view = renderQr();
    await settle();
    vi.setSystemTime(NOW);
    amount('750');
    expect(localStorage.getItem(LAST_QR_KEY)).toBeNull();
    const firstDialog = openQr();
    expect(localStorage.getItem(LAST_QR_KEY)).toBe(JSON.stringify({
      payUrl: BASE_URL + '&token=jpyc&amount=750&store=%E7%A5%9E%E7%94%B0%E7%8F%88%E7%90%B2',
      amountLabel: '750 JPYC', tokenChainLabel: 'JPYC · Polygon Amoy', storeName: '神田珈琲', ts: NOW,
    }));
    const firstScope = mocks.read.mock.lastCall![0].scopeKey;
    mocks.balance = 10n ** 21n;
    view.rerender(<QrGenerator />);
    mocks.balance += 750n * 10n ** 18n;
    view.rerender(<QrGenerator />);
    expect(within(firstDialog).getByRole('status').textContent).toContain('残高の増加');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: labels().qrCopy })); });
    expect(writeText).toHaveBeenCalledWith(displayedUrl());
    closeQr();
    expect(firstDialog).not.toBeInTheDocument();
    expect(mocks.read.mock.lastCall![0].query.enabled).toBe(false);
    const saved = localStorage.getItem(LAST_QR_KEY);
    vi.setSystemTime(NOW + 1000);
    amount('900');
    expect(localStorage.getItem(LAST_QR_KEY)).toBe(saved);
    mocks.balance = undefined;
    const reopened = openQr();
    expect(reopened).not.toBe(firstDialog);
    expect(screen.getByRole('button', { name: labels().qrCopied })).toBeInTheDocument();
    expect(displayedUrl()).toBe(BASE_URL + '&token=jpyc&amount=900&store=%E7%A5%9E%E7%94%B0%E7%8F%88%E7%90%B2');
    expect(JSON.parse(localStorage.getItem(LAST_QR_KEY)!)).toMatchObject({ amountLabel: '900 JPYC', ts: NOW + 1000 });
    expect(mocks.read.mock.lastCall![0].scopeKey).not.toBe(firstScope);
    expect(mocks.read.mock.lastCall![0].query.enabled).toBe(true);
    expect(within(reopened).getByRole('status')).toHaveTextContent(labels().paymentWatching);
    // 開いている間に URL が変わると (金額欄は背面に残る) 前回 QR も追従して保存し直す。
    vi.setSystemTime(NOW + 2000);
    amount('950');
    expect(JSON.parse(localStorage.getItem(LAST_QR_KEY)!)).toMatchObject({ amountLabel: '950 JPYC', ts: NOW + 2000 });
  });

  it('keeps the original FX expiry through accordion and Step 2 child remounts, and recalculates only on request', async () => {
    seed();
    renderQr();
    await settle();
    amount('1000');
    fireEvent.click(screen.getByRole('button', { name: labels().convertButton.replace('{symbol}', 'USDC') }));
    const fxUrl = BASE_URL + '&token=usdc&chain=polygon&amount=6.666667&exp=1790208180&refAmt=1000&fxRate=150';
    openQr();
    expect(displayedUrl()).toBe(fxUrl);
    closeQr();
    fireEvent.click(advancedToggle());
    fireEvent.click(step2Toggle());
    await act(async () => { await vi.advanceTimersByTimeAsync(179_000); });
    expect(screen.getByText(/残り 0:01/)).toBeInTheDocument();
    fireEvent.click(advancedToggle());
    fireEvent.click(step2Toggle());
    openQr();
    expect(displayedUrl()).toBe(fxUrl);
    closeQr();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByText(/残り 0:00/)).toBeInTheDocument();
    expect(screen.queryByText(/再計算してください/)).toBeNull(); // Expiry is strictly after exp.
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByText(/再計算してください/)).toBeInTheDocument();
    openQr();
    expect(displayedUrl()).toBe(fxUrl); // Existing advisory expiry does not suppress the generator's QR.
    closeQr();
    fireEvent.click(screen.getByRole('button', { name: labels().convertRecalc }));
    expect(screen.getByText(/残り 3:00/)).toBeInTheDocument();
    openQr();
    expect(displayedUrl()).toBe(BASE_URL + '&token=usdc&chain=polygon&amount=6.666667&exp=1790208361&refAmt=1000&fxRate=150');
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).token).toBe('jpyc');
  });

  it('downloads the current main QR ref after reopen (not an icon or EIP-681 SVG) and prints the current poster', async () => {
    seed({ payMode: 'standard', storeName: '神田珈琲', productName: '豆/袋' });
    renderQr();
    await settle();
    amount('750');
    const firstDialog = openQr();
    const firstSvg = firstDialog.querySelector('svg[width="340"]')!;
    closeQr();
    amount('900');
    const dialog = openQr();
    fireEvent.click(screen.getByText(/互換 QR \(EIP-681\)/));
    const svg = dialog.querySelector('svg[width="340"]')!;
    expect(firstSvg).not.toBeInTheDocument();
    expect(svg).not.toBe(firstSvg);
    const markup = new XMLSerializer().serializeToString(svg);
    expect(markup).not.toBe(new XMLSerializer().serializeToString(firstSvg));
    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => { blobs.push(blob); return 'blob:r11b'; });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    });
    const downloads: { href: string; filename: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push({ href: this.href, filename: this.download });
    });
    fireEvent.click(screen.getByRole('button', { name: labels().downloadSvg }));
    expect(blobs).toHaveLength(1);
    expect(blobs[0].type).toBe('image/svg+xml;charset=utf-8');
    const blobText = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsText(blobs[0]);
    });
    expect(blobText).toBe(markup);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:r11b');
    const fillRect = vi.fn();
    const drawImage = vi.fn();
    const ctx = { fillStyle: '', fillRect, drawImage };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,pinned');
    const imageSources: string[] = [];
    class TestImage {
      width = 340;
      onload: (() => void) | null = null;
      set src(value: string) { imageSources.push(value); this.onload?.(); }
    }
    vi.stubGlobal('Image', TestImage);
    fireEvent.click(screen.getByRole('button', { name: labels().downloadPng }));
    expect(imageSources).toEqual([`data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`]);
    expect(ctx.fillStyle).toBe('#ffffff');
    expect(fillRect).toHaveBeenCalledWith(0, 0, 340, 340);
    expect(drawImage).toHaveBeenCalledWith(expect.any(TestImage), 0, 0);
    expect(downloads).toEqual([
      { href: 'blob:r11b', filename: '神田珈琲-豆-袋-jpyc-polygon-900.svg' },
      { href: 'data:image/png;base64,pinned', filename: '神田珈琲-豆-袋-jpyc-polygon-900.png' },
    ]);
    const print = vi.spyOn(window, 'print').mockImplementation(() => {
      expect(dialog).toHaveClass('print:static', 'print:bg-white', 'print:p-0');
      const poster = svg.closest('section')!;
      expect(poster).toHaveClass('print:fixed', 'print:inset-0', 'print:min-h-screen', 'print:p-10');
      expect(poster).toHaveTextContent('神田珈琲');
      expect(poster).toHaveTextContent('900 JPYC');
      expect(poster.querySelectorAll('ol > li')).toHaveLength(3);
      expect(poster.querySelector('img[alt="OpenPay"]')).toBeInTheDocument();
      // 入力欄・下部バー・③ の列は印刷に出さない (print:hidden の祖先に居る)。
      for (const el of [amountInput(), mobileBar()!, screen.getByText(labels().qrDescription)]) {
        expect(el.closest('.print\\:hidden')).not.toBeNull();
      }
    });
    fireEvent.click(screen.getByRole('button', { name: labels().printPoster }));
    expect(print).toHaveBeenCalledOnce();
  });

  it('names downloads with the file-safe fallback and the open-amount segment', async () => {
    seed({ token: 'usdc', chain: 'optimism', storeName: ' / ', productName: '  ' });
    renderQr();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: labels().modeStatic }));
    openQr();
    const downloads: string[] = [];
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = () => 'blob:r11b';
      static revokeObjectURL = () => undefined;
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    fireEvent.click(screen.getByRole('button', { name: labels().downloadSvg }));
    expect(downloads).toEqual(['openpay-usdc-optimism-open.svg']);
  });
});
