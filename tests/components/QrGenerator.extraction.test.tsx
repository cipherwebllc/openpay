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

// 2026-10 磨き上げ P2: 受取先・通貨とチェーン・支払い方法・控えとポスターは「お店の設定」シート。
// 旧 ② 受取先の開閉と「高度な設定」は、どちらもシートを開く「設定」ボタンになった。
function settingsButton() {
  return screen.getByRole('button', {
    name: new RegExp(`^${labels().shopSettings.open}$`),
  });
}
const step2Toggle = settingsButton;
const advancedToggle = settingsButton;

function closeSettings() {
  const sheet = screen.queryByRole('dialog', { name: labels().shopSettings.title });
  if (sheet) {
    fireEvent.click(within(sheet).getByRole('button', { name: labels().shopSettings.done }));
  }
}

function qrDialog() {
  return screen.getByRole('dialog', { name: labels().qrModalTitle });
}

function openQr() {
  // QR の画面は設定シートを閉じてから開く (2 つの dialog を重ねない)。
  closeSettings();
  fireEvent.click(screen.getAllByRole('button', { name: labels().showQr })[0]);
  return qrDialog();
}

function closeQr() {
  fireEvent.click(
    within(qrDialog()).getByRole('button', {
      name: labels().qrModalClose,
    }),
  );
}

function displayedUrl() {
  return within(qrDialog()).getByText(
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
  // 左列の節は中身で名前を付ける (受取先の欄・ガス用ウォレット等は出たり出なかったりするので位置では決めない)。
  const leftName = (el: Element, i: number) =>
    el.getAttribute('aria-labelledby') === 'qr-amount-heading'
      ? 'amount'
      : el.getAttribute('aria-labelledby') === 'qr-receiver-inline-heading'
        ? 'receiver'
        : el.tagName === 'DETAILS'
          ? 'accounting'
          : `left${i}`;
  const restName = (el: Element) =>
    el.getAttribute('role') === 'dialog'
      ? 'modal'
      : el.querySelector('[aria-labelledby="shop-settings-title"]')
        ? 'sheet'
        : 'bar';
  const deep = (el: Element) => h(withoutSvgInternals(el).outerHTML);
  const shallow = (el: Element) => h((el.cloneNode(false) as Element).outerHTML);
  return [
    `shape=${container.children.length}/${grid.children.length}/${left.children.length}/${outside.length}`,
    `offline=${deep(offline)}`,
    `grid=${shallow(grid)}`,
    `left=${shallow(left)}`,
    ...Array.from(left.children).map((el, i) => `${leftName(el, i)}=${deep(el)}`),
    `preview=${deep(right)}`,
    ...rest.map((el) => `${restName(el)}=${deep(el)}`),
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
    { name: 'invoice number is normalized after the tax fields', settings: { storeName: 'Cafe', invoiceNo: 't-1234-5678-90123', taxRate: 10, taxCategory: 'taxable_10' }, value: '1100', suffix: '&token=jpyc&amount=1100&store=Cafe&tax=10&taxcat=taxable_10&inv=T1234567890123' },
    { name: 'malformed invoice number stays out of the URL', settings: { invoiceNo: 'T123' }, value: '500', suffix: '&token=jpyc&amount=500' },
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
    fireEvent.click(advancedToggle());
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
// インボイス登録番号の欄 (店舗名の下) を追加: Step 2 を開いている節の receiver/full だけ更新。
// 2026-10 磨き上げ P1: QR の提示画面をスマホで全画面のシートに (余白と QR の縮み方の class だけ)。modal/full だけ更新。
// 同 P1: USDC の金額の下に参考レート (市場レートの帯の代わり)。USDC で金額欄を出す節の amount/full だけ更新。
// 2026-10 磨き上げ P2: 画面の作りを意図して変えた (①②③ と「高度な設定」→ 会計のカード + お店の設定シート・PC の会計パネル・
// 常に出す下部バー)。節の名前も中身で付け直したので、全シナリオを記録し直した (決済 URL のバイト一致は上の fixture が別に固定)。
// 2026-10 磨き上げ P1: QR の提示画面をスマホで全画面のシートに (余白と QR の縮み方の class だけ)。modal/full だけ更新。
// 同 P1: USDC の金額の下に参考レート (市場レートの帯の代わり)。USDC で金額欄を出す節の amount/full だけ更新。
// 2026-10 磨き上げ P2: 画面の作りを意図して変えた (①②③ と「高度な設定」→ 会計のカード + お店の設定シート・PC の会計パネル・
// 常に出す下部バー)。節の名前も中身で付け直したので、全シナリオを記録し直した (決済 URL のバイト一致は上の fixture が別に固定)。
// 値引き (plans/discount-common.md PR2): 金額ありの節に「＋ 値引きを追加」の 1 行。金額欄を出す節の amount/full だけ更新。
const DOM_BASELINE: Record<string, string> = {
  'fresh-ja/empty':
    'shape=2/3/3/0 offline=77d610789dd9 grid=bf14446808c6 left=f91415023c7f amount=2e34e3aa9dfa receiver=13ed1f2ca0c1 accounting=855d11756642 preview=1a4e0aab7a49 bar=9491363e27ea full=bf1ffeb7b1d5',
  'fresh-ja/receiver-typed':
    'shape=2/3/3/0 offline=77d610789dd9 grid=bf14446808c6 left=f91415023c7f amount=d7f08d86c652 receiver=c066a16c6409 accounting=855d11756642 preview=3fcd31b86f55 bar=739ef6dfdbb0 full=d438b6d05d52',
  'fresh-ja/amount':
    'shape=2/3/3/0 offline=77d610789dd9 grid=bf14446808c6 left=f91415023c7f amount=146a450107c7 receiver=c066a16c6409 accounting=855d11756642 preview=99b871383cb3 bar=6bdf93b197f0 full=adcbc37f553f',
  'fresh-ja/advanced':
    'shape=2/4/3/0 offline=77d610789dd9 grid=bf14446808c6 left=f91415023c7f amount=146a450107c7 receiver=c066a16c6409 accounting=855d11756642 preview=99b871383cb3 sheet=1b9866df718d bar=6bdf93b197f0 full=0d2add0be0d9',
  'fresh-ja/static':
    'shape=2/3/2/0 offline=77d610789dd9 grid=bf14446808c6 left=f91415023c7f amount=b27fdfffffe5 accounting=855d11756642 preview=a3758a9929a3 bar=ed7e724d0a8d full=c06741732336',
  'fresh-ja/modal':
    'shape=2/4/3/0 offline=77d610789dd9 grid=bf14446808c6 left=f91415023c7f amount=b27fdfffffe5 accounting=855d11756642 left2=f0506b8ca563 preview=a3758a9929a3 modal=d04b47295f86 bar=ed7e724d0a8d full=f6cf9c21441c',
  'fresh-en/empty':
    'shape=2/3/3/0 offline=77d610789dd9 grid=bf14446808c6 left=f91415023c7f amount=a4af21cdf909 receiver=7e1b87eb8cd0 accounting=1dc4435d9178 preview=e432f1338d73 bar=4b481618cc35 full=1e9d2abae744',
  'fresh-en/receiver-typed':
    'shape=2/3/3/0 offline=77d610789dd9 grid=bf14446808c6 left=f91415023c7f amount=b1dc96059cce receiver=6ae1125ae76d accounting=1dc4435d9178 preview=ed60ab2dd260 bar=9fa734137b5c full=fe8729e0ab2b',
  'fresh-en/amount':
    'shape=2/3/3/0 offline=77d610789dd9 grid=bf14446808c6 left=f91415023c7f amount=0f438ee2da5c receiver=6ae1125ae76d accounting=1dc4435d9178 preview=b419161ef24a bar=684cc53ba128 full=fb987c90f525',
  'fresh-en/advanced':
    'shape=2/4/3/0 offline=77d610789dd9 grid=bf14446808c6 left=f91415023c7f amount=0f438ee2da5c receiver=6ae1125ae76d accounting=1dc4435d9178 preview=b419161ef24a sheet=9f6742c83f22 bar=684cc53ba128 full=6748ec31dbe1',
  'fresh-en/static':
    'shape=2/3/2/0 offline=77d610789dd9 grid=bf14446808c6 left=f91415023c7f amount=5bec335051da accounting=1dc4435d9178 preview=6e9095c6e7c5 bar=e93e13762e55 full=5ebb0fb29740',
  'fresh-en/modal':
    'shape=2/4/3/0 offline=77d610789dd9 grid=bf14446808c6 left=f91415023c7f amount=5bec335051da accounting=1dc4435d9178 left2=3e04971c2b53 preview=6e9095c6e7c5 modal=30ef8967b69a bar=e93e13762e55 full=3441e01ccea8',
  'seeded/collapsed':
    'shape=2/3/2/0 offline=77d610789dd9 grid=bf14446808c6 left=f91415023c7f amount=7e02d3b15c42 accounting=855d11756642 preview=3fcd31b86f55 bar=739ef6dfdbb0 full=afa18de2e4c2',
  'seeded/step2-open':
    'shape=2/4/2/0 offline=77d610789dd9 grid=bf14446808c6 left=f91415023c7f amount=7e02d3b15c42 accounting=855d11756642 preview=3fcd31b86f55 sheet=d07042772fe5 bar=739ef6dfdbb0 full=b58a3c7b1e72',
  'seeded/advanced-split':
    'shape=2/4/2/0 offline=77d610789dd9 grid=bf14446808c6 left=f91415023c7f amount=4d9f699a2e32 accounting=855d11756642 preview=99b871383cb3 sheet=d07042772fe5 bar=6bdf93b197f0 full=a20b32fd8bac',
  'seeded/quick-editor':
    'shape=2/3/2/0 offline=77d610789dd9 grid=bf14446808c6 left=f91415023c7f amount=5aa267725177 accounting=855d11756642 preview=99b871383cb3 bar=6bdf93b197f0 full=a2d77232f308',
  'seeded/accounting':
    'shape=2/3/2/0 offline=77d610789dd9 grid=bf14446808c6 left=f91415023c7f amount=5aa267725177 accounting=ad0f69b8927f preview=99b871383cb3 bar=6bdf93b197f0 full=2701801a25a2',
  'usdc/amount-fiat':
    'shape=2/3/2/0 offline=77d610789dd9 grid=bf14446808c6 left=f91415023c7f amount=823d98fae38c accounting=855d11756642 preview=934ceead99e8 bar=7309dd8672ad full=e8f3246aa75d',
  'usdc/advanced-crosschain':
    'shape=2/4/2/0 offline=77d610789dd9 grid=bf14446808c6 left=f91415023c7f amount=823d98fae38c accounting=855d11756642 preview=934ceead99e8 sheet=760db63b847f bar=7309dd8672ad full=224e18f1f218',
  'usdc/fx-applied':
    'shape=2/4/2/0 offline=77d610789dd9 grid=bf14446808c6 left=f91415023c7f amount=0606daceaa43 accounting=855d11756642 preview=1f554979d6b2 sheet=1b9866df718d bar=9297eecd7c80 full=6c1447ed2569',
  'usdc/fx-modal':
    'shape=2/4/3/0 offline=77d610789dd9 grid=bf14446808c6 left=f91415023c7f amount=0606daceaa43 accounting=855d11756642 left2=f0506b8ca563 preview=1f554979d6b2 modal=fe18e3c8f038 bar=9297eecd7c80 full=7e4a421575da',
  'usdc/fx-expired':
    'shape=2/3/3/0 offline=77d610789dd9 grid=bf14446808c6 left=f91415023c7f amount=55c238564fb8 accounting=855d11756642 left2=f0506b8ca563 preview=1f554979d6b2 bar=9297eecd7c80 full=3473d904d373',
  'standard/closed':
    'shape=2/3/2/0 offline=77d610789dd9 grid=bf14446808c6 left=f91415023c7f amount=2c3e3cbb7f40 accounting=855d11756642 preview=4b4a106c5654 bar=75d49299c4ea full=dc64eb0dce87',
  'standard/advanced':
    'shape=2/4/2/0 offline=77d610789dd9 grid=bf14446808c6 left=f91415023c7f amount=2c3e3cbb7f40 accounting=855d11756642 preview=4b4a106c5654 sheet=fc8d703c8b68 bar=75d49299c4ea full=15cee28f98a8',
  'standard/modal-eip681':
    'shape=2/4/3/0 offline=77d610789dd9 grid=bf14446808c6 left=f91415023c7f amount=2c3e3cbb7f40 accounting=855d11756642 left2=f0506b8ca563 preview=4b4a106c5654 modal=d2f3d43f1049 bar=75d49299c4ea full=e9525c17c21a',
  'recover/closed':
    'shape=2/3/2/0 offline=77d610789dd9 grid=bf14446808c6 left=f91415023c7f amount=de619038f3a3 accounting=855d11756642 preview=2cc76e1c1637 bar=26fa70486c48 full=b955c77b7006',
  'recover/advanced':
    'shape=2/4/2/0 offline=77d610789dd9 grid=bf14446808c6 left=f91415023c7f amount=de619038f3a3 accounting=855d11756642 preview=2cc76e1c1637 sheet=32f251bdd9ee bar=26fa70486c48 full=2c7dca71129e',
  'free/closed':
    'shape=2/3/2/0 offline=77d610789dd9 grid=bf14446808c6 left=f91415023c7f amount=b6865b4a649c accounting=855d11756642 preview=2cc76e1c1637 bar=26fa70486c48 full=c216c36e44a2',
  'free/advanced':
    'shape=2/4/2/0 offline=77d610789dd9 grid=bf14446808c6 left=f91415023c7f amount=b6865b4a649c accounting=855d11756642 preview=2cc76e1c1637 sheet=32f251bdd9ee bar=26fa70486c48 full=0e091d797472',
  'invalid/invalid':
    'shape=2/3/3/0 offline=77d610789dd9 grid=bf14446808c6 left=f91415023c7f amount=2e34e3aa9dfa receiver=f1044fa3b94c accounting=855d11756642 preview=1a4e0aab7a49 bar=9491363e27ea full=eef57a0bbd22',
  'generating/generating':
    'shape=2/3/2/0 offline=77d610789dd9 grid=bf14446808c6 left=f91415023c7f amount=146a450107c7 accounting=855d11756642 preview=22857315cdab bar=9e4e78357c1b full=0de13a78ab2a',
  'usage-fee/mismatch':
    'shape=2/4/2/0 offline=77d610789dd9 grid=bf14446808c6 left=f91415023c7f amount=d7f08d86c652 accounting=855d11756642 preview=3fcd31b86f55 sheet=d93c64303ec2 bar=739ef6dfdbb0 full=c53239de893d',
  'watch/watching':
    'shape=2/4/3/0 offline=77d610789dd9 grid=bf14446808c6 left=f91415023c7f amount=4a58f9b1ebe1 accounting=855d11756642 left2=f0506b8ca563 preview=21a611c68df2 modal=cdc0d65cff29 bar=7ec07a0f813b full=ea6356eea3df',
  'watch/received':
    'shape=2/4/3/0 offline=77d610789dd9 grid=bf14446808c6 left=f91415023c7f amount=4a58f9b1ebe1 accounting=855d11756642 left2=f0506b8ca563 preview=21a611c68df2 modal=6c7f1615fc05 bar=7ec07a0f813b full=d28a1f6f0d05',
  'watch/closed-with-pwa-hint':
    'shape=2/3/3/0 offline=77d610789dd9 grid=bf14446808c6 left=f91415023c7f amount=4a58f9b1ebe1 accounting=855d11756642 left2=f0506b8ca563 preview=21a611c68df2 bar=7ec07a0f813b full=2a8db5a0a41d',
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
  closeSettings();
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
      closeSettings();
      fireEvent.click(screen.getByRole('button', { name: labels().quickAmountsEdit }));
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
    // よく使う金額の編集欄 (2026-10 P2: 折りたたみから「編集」の切替に) と、明細 (details) を開く。
    fireEvent.click(screen.getByRole('button', { name: labels().quickAmountsEdit }));
    const accountingDetails = detailsOf(labels().accountingFieldsTitle);
    accountingDetails.open = true;
    // お店の設定シートを開く (開くとシートに focus が移るので、店員の入力位置 = 金額欄へ戻して以降の再描画を見る)。
    fireEvent.click(settingsButton());
    await settle();
    amountEl.focus();
    const pageNodes = () => ({
      amountEl: amountInput(),
      quickEdit: screen.getByRole('button', { name: labels().quickAmountsDone, expanded: true }),
      accountingDetails: detailsOf(labels().accountingFieldsTitle),
      quickInput: screen.getAllByPlaceholderText(labels().quickAmountPlaceholder)[0],
      receipt: screen.getByPlaceholderText(labels().receiptNoPlaceholder),
      settings: settingsButton(),
      modeAmount: screen.getByRole('button', { name: labels().modeAmount }),
      modeStatic: screen.getByRole('button', { name: labels().modeStatic }),
    });
    const sheetNodes = () => ({
      storeName: screen.getByPlaceholderText(labels().storeNamePlaceholder),
      posterNote: screen.getByPlaceholderText(labels().posterNotePlaceholder),
      receiver: receiverInput(),
      crossChain: screen.getByRole('checkbox'),
      splitAddress: screen.getByDisplayValue(SPLIT),
    });
    const requery = () => ({ ...pageNodes(), ...sheetNodes() });
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
      expect({
        what,
        quick: nodes.quickEdit.getAttribute('aria-expanded'),
        accounting: accountingDetails.open,
      }).toEqual({ what, quick: 'true', accounting: true });
      expect({ what, focused: document.activeElement === amountEl }).toEqual({ what, focused: true });
    }
    const page = pageNodes();
    // モーダルは dialog に focus を移す (既存挙動)。QR の画面は設定シートを閉じてから開く
    // (閉じたシートの中身は unmount)。閉じた後も会計画面の節の node と開閉状態は同じ。
    openQr();
    await settle();
    expect(document.activeElement).toBe(qrDialog());
    closeQr();
    await settle();
    expect(pageNodes()).toEqual(page);
    expect([nodes.quickEdit.getAttribute('aria-expanded'), accountingDetails.open]).toEqual(['true', true]);
    // B-R11d S1: 据え置き中も金額欄とエディタを保持。ユーザーが金額指定へ
    // 戻した時だけ同じ入力 node に focus し、よく使う金額の編集欄も保持する。
    // モード切替ボタン自体は金額の節ごと作り直されない (同じ node のまま)。
    fireEvent.click(screen.getByRole('button', { name: labels().modeStatic }));
    await settle();
    expect(amountEl).toBeInTheDocument();
    expect(amountEl).not.toBeVisible();
    expect(nodes.quickInput).toBeInTheDocument();
    expect(nodes.quickInput).not.toBeVisible();
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
    expect(screen.getAllByPlaceholderText(labels().quickAmountPlaceholder)[0]).toBe(nodes.quickInput);
    expect(nodes.quickInput).toBeVisible();
    expect(nodes.quickInput).toHaveValue('7');
    expect(detailsOf(labels().accountingFieldsTitle)).toBe(accountingDetails);
    expect(accountingDetails.open).toBe(true);
    expect(settingsButton()).toBe(nodes.settings);
    focusSpy.mockClear();
    nodes.modeAmount.focus();
    fireEvent.click(nodes.modeAmount);
    expect(focusSpy).not.toHaveBeenCalled(); // 同じモードの再選択では focus を移さない。
    expect(document.activeElement).toBe(nodes.modeAmount);
  });

  it('keeps the quick-amount editor open across modal and mode changes; the settings sheet closes before the QR opens', async () => {
    seed();
    renderQr();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: labels().quickAmountsEdit }));
    fireEvent.click(settingsButton());
    expect(screen.getByRole('dialog', { name: labels().shopSettings.title })).toBeInTheDocument();
    amount('1000');
    openQr();
    expect(screen.queryByRole('dialog', { name: labels().shopSettings.title })).toBeNull();
    closeQr();
    fireEvent.click(screen.getByRole('button', { name: labels().modeStatic }));
    fireEvent.click(screen.getByRole('button', { name: labels().modeAmount }));
    await settle();
    expect(
      screen.getByRole('button', { name: labels().quickAmountsDone, expanded: true }),
    ).toBeInTheDocument();
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
  it('repaints on mount, readiness and amount/mode/symbol changes, cancelling stale frames on unmount', async () => {
    const view = renderQr();
    await settle();
    // 2026-10 P2: バーは最初から出ている (押せない間は未入力の理由を出す)。出た時点で WebKit の再描画を促す。
    const bar = mobileBar()!;
    expect(bar).not.toBeNull();
    flushFrames();
    expect(bar.style.transform).toBe('');
    amount('1000');
    await settle();
    expect(bar.style.transform).toBe('translateZ(0)');
    flushFrames();
    fireEvent.change(receiverInput(), { target: { value: RECEIVER } });
    await settle();
    // 金額が先・受取先が後でも、押せるようになった時点で再描画を促す (同じバーのまま)。
    expect(mobileBar()).toBe(bar);
    expect(bar.style.transform).toBe('translateZ(0)');
    expect(frames.size).toBe(1);
    flushFrames();
    expect(bar.style.transform).toBe('');
    fireEvent.click(settingsButton());
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
    closeSettings();
    expect(mobileBar()).toBe(bar);
    expect(bar.style.transform).toBe('translateZ(0)');
    flushFrames();
    expect(bar.style.transform).toBe('');
    amount('1400');
    expect(frames.size).toBe(1);
    // 受取先を消しても、バーは出したまま (押せなくなる) で再描画を促す。受取先を決めてシートを閉じた後は、
    // 受取先の欄はシートの中だけ (会計画面の欄は役目を終えて消える)。
    fireEvent.click(settingsButton());
    fireEvent.change(receiverInput(), { target: { value: '' } });
    expect(mobileBar()).toBe(bar);
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
    expect(within(dialog).getByRole('status').textContent).toContain('残高が増えました');
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
    expect(within(firstDialog).getByRole('status').textContent).toContain('残高が増えました');
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
      // 入力欄・下部バー・会計パネルは印刷に出さない (print:hidden の祖先に居る)。
      for (const el of [amountInput(), mobileBar()!, screen.getAllByRole('button', { name: labels().showQr })[0]]) {
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
