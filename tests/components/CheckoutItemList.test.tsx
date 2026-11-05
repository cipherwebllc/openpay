// /checkout (CheckoutForm) のお支払い額の欄 (section) の前半 = 商品の明細 (見出し「商品」と品目の行の並び) の描画を、出しうる
// 状態ごとに固定する characterization test (第 9 回レビュー F-04・PR-23 の 4 本目・Q11)。
//
// CheckoutForm から表示だけの部品 (components/checkout/CheckoutItemList.tsx) を切り出す前に、このテストを変更前のコードで green
// にし、切り出した後も無変更で green であることを確かめた。だから部品は直接 render しない: CheckoutForm を render して、描かれた
// DOM (要素・属性 (class 等すべて)・可視テキスト (額の表記を含む)・入れ子・並び・要素のあいだのテキストノード) だけを見る。部品の
// props の形には依存しない。
//
// 見る範囲: お支払い額の欄 (section) の最初の子から、小計・値引き・手数料・お支払い額の表 (dl) を包む div の手前までの、子の
// ノードすべて (要素だけでなくテキストノードも nextSibling でたどる)。後ろの目印の div は欄の後半 (次の PR で切り出す) で、ここに
// 値引きの行も入る。値引きの行は明細の行の並び (ul) の外なので、この範囲には入らない。section 自身の属性も見る。要素は子まで
// 木のまま比べる (品名・数量・行の額は li の子の span)。隣り合うテキストノードはつないで 1 つの文字列にする (描画が同じなら
// 分かれ方は問わない)。
//
// 明細の行には条件の分岐がない (品目を並びどおりに 1 行ずつ出すだけ)。だから値引き・消費税・送料・モバイル注文の利用料・経路・
// 接続の有無・完了は、どれも行を変えないことを 1 つずつ単独で効かせて固定する (効いていることは欄の後半の表で確かめる)。
//
// mock の作法は tests/components/WalletBalance.test.tsx に合わせる (hook は mockHook で ReturnType に型づけ)。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { baseSepolia, polygonAmoy } from 'viem/chains';
import type { Address } from 'viem';
import messages from '@/messages/ja.json';
import enMessages from '@/messages/en.json';
import { renderWithIntl as render } from '../_helpers/i18n';
import { mockHook } from '../_helpers/wagmiMock';

vi.mock('wagmi', () => ({
  useWalletClient: vi.fn(() => ({ data: undefined })),
  usePublicClient: vi.fn(),
  useAccount: vi.fn(),
  useReadContract: vi.fn(),
  useSwitchChain: vi.fn(),
  useConnect: vi.fn(() => ({ connectors: [], connect: vi.fn(), isPending: false, error: null })),
  useDisconnect: vi.fn(() => ({ disconnect: vi.fn() })),
  useSignMessage: vi.fn(() => ({ signMessageAsync: vi.fn(), isPending: false })),
}));
vi.mock('@/hooks/useSmartAccount', () => ({ useSmartAccount: vi.fn() }));
vi.mock('@/hooks/useBatchPayment', () => ({ useBatchPayment: vi.fn() }));
vi.mock('@/hooks/useStandardPayment', () => ({ useStandardPayment: vi.fn() }));
vi.mock('@/hooks/useGasQuoteUsdc', () => ({ useGasQuoteUsdc: vi.fn() }));
vi.mock('@/hooks/useGasQuoteJpyc', () => ({ useGasQuoteJpyc: vi.fn() }));
vi.mock('@/hooks/useGasQuoteCircle', () => ({ useGasQuoteCircle: vi.fn() }));
vi.mock('@/hooks/useRelayHealth', () => ({ useRelayHealth: vi.fn(() => ({ degraded: false })) }));
vi.mock('@/hooks/useJpycEip3009Payment', () => ({ useJpycEip3009Payment: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/circlePaymaster', async () => {
  const actual = await vi.importActual<typeof import('@/lib/circlePaymaster')>('@/lib/circlePaymaster');
  return { ...actual, resolveUsdcGaslessProvider: vi.fn(() => 'pimlico') };
});
vi.mock('@/lib/jpycGaslessProvider', async () => {
  const actual = await vi.importActual<typeof import('@/lib/jpycGaslessProvider')>('@/lib/jpycGaslessProvider');
  return { ...actual, resolveJpycGaslessProvider: vi.fn(() => 'eip3009-relay') };
});
vi.mock('@/lib/relay/forwarderConfig', async () => {
  const actual = await vi.importActual<typeof import('@/lib/relay/forwarderConfig')>('@/lib/relay/forwarderConfig');
  return { ...actual, jpycForwarderFor: vi.fn(() => null), relayGasFeeValue: vi.fn(() => 2n * 10n ** 18n) };
});
vi.mock('@/lib/pimlico', async () => {
  const actual = await vi.importActual<typeof import('@/lib/pimlico')>('@/lib/pimlico');
  return { ...actual, resolvePaymasterMode: vi.fn(() => 'sponsorship') };
});
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn() })),
}));
// 実物の ConnectButton は jsdom で wagmi の module graph を評価して重い (tests/_helpers/connectButtonStub.tsx)。
vi.mock('@/components/ConnectButton', async () => ({
  ConnectButton: (await import('../_helpers/connectButtonStub')).ConnectButtonStub,
}));
// モバイル注文の利用料の flag を切り替えられるようにする (既定 OFF・tests/components/CheckoutForm.test.tsx と同じ作法)。
const feeFlags = vi.hoisted(() => ({ enableMobileOrderFee: false }));
// hermetic: 手元の shell の NEXT_PUBLIC_RECOVER_FEE_BPS に左右されないよう 0 に固定する (CheckoutForm.test と同じ)。
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      recoverFeeBps: 0,
      get enableMobileOrderFee() {
        return feeFlags.enableMobileOrderFee;
      },
    },
  };
});

import { useAccount, useReadContract, useSwitchChain } from 'wagmi';
import { useSmartAccount } from '@/hooks/useSmartAccount';
import { useBatchPayment } from '@/hooks/useBatchPayment';
import { useStandardPayment } from '@/hooks/useStandardPayment';
import { useGasQuoteUsdc } from '@/hooks/useGasQuoteUsdc';
import { useGasQuoteJpyc } from '@/hooks/useGasQuoteJpyc';
import { useGasQuoteCircle } from '@/hooks/useGasQuoteCircle';
import { useJpycEip3009Payment } from '@/hooks/useJpycEip3009Payment';
import { resolvePaymasterMode } from '@/lib/pimlico';
import { resolveJpycGaslessProvider } from '@/lib/jpycGaslessProvider';
import { CheckoutForm } from '@/components/CheckoutForm';
import type { CheckoutItem, CheckoutParams } from '@/lib/url';

const CF = messages.CheckoutForm;
const MERCHANT: Address = '0x2222222222222222222222222222222222222222';
const CUSTOMER: Address = '0x9999999999999999999999999999999999999999';
const TX_HASH = `0x${'e'.repeat(64)}` as const;
const JPYC = (n: bigint) => n * 10n ** 18n;

// JPYC の会計 (test env の 'polygon' は Amoy に解決される)。
const jpycParams = (items: CheckoutItem[], extra: Partial<CheckoutParams> = {}): CheckoutParams => ({
  to: MERCHANT,
  token: 'jpyc',
  chain: 'polygon',
  gas: 'customer',
  items,
  ...extra,
});
// USDC の会計 (test env の 'base' は Base Sepolia に解決される)。
const usdcParams = (items: CheckoutItem[]): CheckoutParams => ({
  to: MERCHANT,
  token: 'usdc',
  chain: 'base',
  gas: 'customer',
  items,
});

function setAccount(state: { isConnected: boolean; chainId?: number }) {
  mockHook(useAccount, {
    address: state.isConnected ? CUSTOMER : undefined,
    isConnected: state.isConnected,
    chainId: state.chainId,
  });
}

function setBalance(data: bigint | undefined) {
  mockHook(useReadContract, {
    data,
    isLoading: false,
    isError: false,
    error: null,
  } as Partial<ReturnType<typeof useReadContract>>);
}

function setRelay(state: { data?: ReturnType<typeof useJpycEip3009Payment>['data'] } = {}) {
  mockHook(useJpycEip3009Payment, {
    mutate: vi.fn(),
    isPending: false,
    data: state.data,
    error: null,
    retryRelay: vi.fn(),
    retrySamePayload: vi.fn(),
    recoveryState: null,
    restoredIntent: null,
    orderDelivery: null,
    previousPaymentPending: false,
    previousPaymentSameMerchant: false,
  } as Partial<ReturnType<typeof useJpycEip3009Payment>>);
}

/** USDC の会計に要るもの (Smart Account とガス代の見積)。ウォレットは Base Sepolia にいる (WalletBalance.test と同じ)。 */
function setUsdcReady() {
  vi.mocked(resolveJpycGaslessProvider).mockReturnValue('pimlico-7702');
  vi.mocked(resolvePaymasterMode).mockImplementation((dep) => (dep.symbol === 'usdc' ? 'erc20' : 'sponsorship'));
  setAccount({ isConnected: true, chainId: baseSepolia.id });
  setBalance(200_000_000n);
  mockHook(useSmartAccount, {
    data: { smartAccountClient: {}, pimlicoClient: {} },
    isLoading: false,
    error: null,
  } as Partial<ReturnType<typeof useSmartAccount>>);
  mockHook(useGasQuoteUsdc, {
    data: { gasAmount: 100_000n },
    isLoading: false,
    isError: false,
    error: null,
  } as Partial<ReturnType<typeof useGasQuoteUsdc>>);
}

function setDefaults() {
  feeFlags.enableMobileOrderFee = false;
  vi.mocked(resolveJpycGaslessProvider).mockReturnValue('eip3009-relay');
  vi.mocked(resolvePaymasterMode).mockImplementation(() => 'sponsorship');
  // 既定: 接続中で、ウォレットは要求のチェーン (Amoy) にいて、残高は足りる。
  setAccount({ isConnected: true, chainId: polygonAmoy.id });
  setBalance(JPYC(10_000_000_000n));
  mockHook(useSwitchChain, {
    switchChain: vi.fn(),
    isPending: false,
    error: null,
    variables: undefined,
  } as Partial<ReturnType<typeof useSwitchChain>>);
  setRelay();
  mockHook(useSmartAccount, { data: undefined, isLoading: false, error: null } as Partial<ReturnType<typeof useSmartAccount>>);
  mockHook(useBatchPayment, {
    mutate: vi.fn(),
    retryReceipt: vi.fn(),
    isPending: false,
    isUnknown: false,
    isSuccess: false,
    isError: false,
    data: undefined,
    error: null,
  } as Partial<ReturnType<typeof useBatchPayment>>);
  mockHook(useStandardPayment, {
    mutate: vi.fn(),
    retryFee: vi.fn(),
    retryReceipt: vi.fn(),
    phase: 'idle',
    isPending: false,
    isSuccess: false,
    isError: false,
    isFeeError: false,
    isMerchantError: false,
    isUnknown: false,
    isMerchantUnknown: false,
    isFeeUnknown: false,
    data: undefined,
    error: null,
    merchantTxHash: undefined,
    feeTxHash: undefined,
    merchantBlockNumber: undefined,
    isRestoring: false,
    hasActiveIntent: false,
    hasAttempt: false,
  } as Partial<ReturnType<typeof useStandardPayment>>);
  const quote = { data: undefined, isLoading: false, isError: false, error: null };
  mockHook(useGasQuoteUsdc, quote as Partial<ReturnType<typeof useGasQuoteUsdc>>);
  mockHook(useGasQuoteJpyc, quote as Partial<ReturnType<typeof useGasQuoteJpyc>>);
  mockHook(useGasQuoteCircle, { data: undefined, error: null, fetchStatus: 'idle' } as Partial<ReturnType<typeof useGasQuoteCircle>>);
  window.sessionStorage.clear();
  window.localStorage.clear();
}

beforeEach(() => {
  vi.clearAllMocks();
  setDefaults();
});

/** 要素を子まで木にしたもの。属性はすべて (class・role 等)、テキストは隣り合う text node をつないだ文字列で持つ。 */
type Dom = { tag: string; attrs: Record<string, string>; children: DomNode[] };
type DomNode = string | Dom;

function attrsOf(el: Element): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) attrs[a.name] = a.value;
  return attrs;
}

/** first から end の手前までの兄弟のノードを、テキストノード (要素のあいだの空白を含む) も落とさずに並びどおりに返す。 */
function nodes(first: ChildNode | null, end: ChildNode | null): DomNode[] {
  const out: DomNode[] = [];
  for (let n = first; n !== end; n = n.nextSibling) {
    // end に届かずに兄弟が尽きたら、目印が同じ親にいない (範囲が壊れている)。
    if (n === null) throw new Error('end marker is not a following sibling');
    if (n.nodeType === Node.TEXT_NODE) {
      const text = n.textContent ?? '';
      const last = out[out.length - 1];
      if (typeof last === 'string') out[out.length - 1] = last + text;
      else out.push(text);
    } else if (n.nodeType === Node.ELEMENT_NODE) {
      const el = n as Element;
      out.push({ tag: el.tagName.toLowerCase(), attrs: attrsOf(el), children: nodes(el.firstChild, null) });
    } else {
      // コメント等 (React は出さない) が紛れたら、そのまま違いとして見せる。
      out.push({ tag: `#node-${n.nodeType}`, attrs: {}, children: [] });
    }
  }
  return out;
}

/** お支払い額の欄 (小計・お支払い額の表 dl を持つ section) と、その表を包む div (後ろの目印)。 */
function amountSection(): { section: HTMLElement; breakdown: Element } {
  const found = Array.from(document.querySelectorAll('section')).filter(
    (s) => s.querySelector(':scope > div > dl') !== null,
  );
  expect(found).toHaveLength(1);
  const section = found[0];
  const breakdown = section.querySelector(':scope > div > dl')!.parentElement!;
  expect(breakdown.parentElement).toBe(section);
  return { section, breakdown };
}

/** お支払い額の欄の前半 (欄の最初の子から、表を包む div の手前まで) と、欄 (section) 自身の属性。 */
function itemArea(): { section: Record<string, string>; nodes: DomNode[] } {
  const { section, breakdown } = amountSection();
  return { section: attrsOf(section), nodes: nodes(section.firstChild, breakdown) };
}

/** 欄の後半の表の行の見出し (dt) の並び。前半には出ない条件 (値引き・利用料・経路) が効いていることを確かめるのに使う。 */
function breakdownLabels(): string[] {
  const { breakdown } = amountSection();
  return Array.from(breakdown.querySelectorAll('dt')).map((dt) => dt.textContent ?? '');
}

const msgs = (locale: 'ja' | 'en') => (locale === 'ja' ? messages : enMessages).CheckoutForm;

const SECTION_ATTRS = { class: 'rounded-2xl border border-slate-200 bg-white p-4 text-sm' };

/** 品目の行 1 つ (品名・「×数量」・行の額 (単価 × 数量))。 */
const row = (name: string, qty: number, amount: string): Dom => ({
  tag: 'li',
  attrs: { class: 'flex items-baseline justify-between gap-3 py-2' },
  children: [
    { tag: 'span', attrs: { class: 'min-w-0 flex-1 break-words font-medium text-slate-700' }, children: [name] },
    { tag: 'span', attrs: { class: 'shrink-0 font-mono text-xs text-slate-500' }, children: [`×${qty}`] },
    { tag: 'span', attrs: { class: 'shrink-0 font-mono text-sm text-slate-800' }, children: [amount] },
  ],
});

/** 期待する前半: 見出し「商品」の p と、品目の行を並べた ul (あいだにテキストノードはない)。 */
const expected = (rows: Dom[], locale: 'ja' | 'en' = 'ja') => ({
  section: SECTION_ATTRS,
  nodes: [
    {
      tag: 'p',
      attrs: { class: 'text-xs font-semibold uppercase tracking-wide text-slate-500' },
      children: [msgs(locale).itemsTitle],
    },
    { tag: 'ul', attrs: { class: 'mt-3 divide-y divide-slate-100' }, children: rows },
  ],
});

describe('CheckoutForm — お支払い額の欄の前半 = 商品の明細 (CheckoutItemList の characterization・第 9 回レビュー F-04)', () => {
  describe('品目の数と数量', () => {
    it('品目 1 つ・数量 1: 見出し「商品」と 1 行 (行の額は単価のまま)', () => {
      render(<CheckoutForm params={jpycParams([{ name: 'チケット', qty: 1, price: '3000' }])} />);
      expect(itemArea()).toEqual(expected([row('チケット', 1, '3000 JPYC')]));
    });

    it('品目 1 つ・数量が複数: 数量は「×3」・行の額は単価 × 数量 (品目ごとの小計)', () => {
      render(<CheckoutForm params={jpycParams([{ name: 'コーヒー', qty: 3, price: '450' }])} />);
      expect(itemArea()).toEqual(expected([row('コーヒー', 3, '1350 JPYC')]));
    });

    it('品目が複数: URL の並びどおりに 1 品目 1 行 (数量 1 と複数が混ざる)', () => {
      render(
        <CheckoutForm
          params={jpycParams([
            { name: 'Tシャツ', qty: 1, price: '2500' },
            { name: 'マグ', qty: 2, price: '1500' },
            { name: 'ステッカー', qty: 10, price: '100' },
          ])}
        />,
      );
      expect(itemArea()).toEqual(
        expected([row('Tシャツ', 1, '2500 JPYC'), row('マグ', 2, '3000 JPYC'), row('ステッカー', 10, '1000 JPYC')]),
      );
    });

    it('同じ品名・同じ額の品目が 2 つ: まとめずに 2 行のまま出す', () => {
      render(
        <CheckoutForm
          params={jpycParams([
            { name: 'おにぎり', qty: 1, price: '200' },
            { name: 'おにぎり', qty: 1, price: '200' },
          ])}
        />,
      );
      expect(itemArea()).toEqual(expected([row('おにぎり', 1, '200 JPYC'), row('おにぎり', 1, '200 JPYC')]));
    });

    it('数量の上限 (999) と大きい単価: 行の額は桁区切りなし', () => {
      render(<CheckoutForm params={jpycParams([{ name: '業務用', qty: 999, price: '1000000' }])} />);
      expect(itemArea()).toEqual(expected([row('業務用', 999, '999000000 JPYC')]));
    });
  });

  describe('額の表記 (トークンの桁)', () => {
    it('JPYC の小数の単価: 行の額は 18 桁を整えた表記 (末尾の 0 は落とす)', () => {
      render(
        <CheckoutForm
          params={jpycParams([
            { name: '量り売り', qty: 3, price: '0.5' },
            { name: '端数', qty: 1, price: '1234.56' },
          ])}
        />,
      );
      expect(itemArea()).toEqual(expected([row('量り売り', 3, '1.5 JPYC'), row('端数', 1, '1234.56 JPYC')]));
    });

    it('USDC: 6 桁の小数 (最小単位・繰り上がり・末尾の 0 を落とす)', () => {
      setUsdcReady();
      render(
        <CheckoutForm
          params={usdcParams([
            { name: 'API 1 回', qty: 3, price: '0.000001' },
            { name: 'データ', qty: 2, price: '12.345678' },
            { name: 'Tシャツ', qty: 1, price: '25.00' },
          ])}
        />,
      );
      expect(itemArea()).toEqual(
        expected([row('API 1 回', 3, '0.000003 USDC'), row('データ', 2, '24.691356 USDC'), row('Tシャツ', 1, '25 USDC')]),
      );
    });
  });

  describe('品名', () => {
    it('長い品名 (空白のない長い語・長い英文): 切り詰めずにそのまま出す (折り返しは break-words の class)', () => {
      // URL の品名は parse が 80 字までに切る (CHECKOUT_NAME_MAX) ので、その上限ちょうどの長さで見る。表示では切り詰めない。
      const longJa = '特製'.repeat(40);
      const longEn = 'An extremely long product name that keeps going to test wrapping on phone screen';
      expect([longJa.length, longEn.length]).toEqual([80, 80]);
      render(
        <CheckoutForm
          params={jpycParams([
            { name: longJa, qty: 1, price: '100' },
            { name: longEn, qty: 2, price: '50' },
          ])}
        />,
      );
      expect(itemArea()).toEqual(expected([row(longJa, 1, '100 JPYC'), row(longEn, 2, '100 JPYC')]));
    });

    it('記号や HTML のような文字を含む品名: 文字のまま出す (要素として解釈しない)', () => {
      const name = '<b>限定</b> & "特価" ¥100';
      render(<CheckoutForm params={jpycParams([{ name, qty: 1, price: '100' }])} />);
      expect(itemArea()).toEqual(expected([row(name, 1, '100 JPYC')]));
    });
  });

  describe('明細の行を変えない会計の条件 (それぞれ単独で効かせる)', () => {
    it('送料の行 (注文リンクが足す「送料」・課税 10%): ほかの品目と同じ形の 1 行で、税率は出さない', () => {
      render(
        <CheckoutForm
          params={jpycParams([
            { name: 'クッキー', qty: 2, price: '800', taxRate: 8, taxCategory: 'taxable_8' },
            { name: '送料', qty: 1, price: '500', taxRate: 10, taxCategory: 'taxable_10' },
          ])}
        />,
      );
      expect(itemArea()).toEqual(expected([row('クッキー', 2, '1600 JPYC'), row('送料', 1, '500 JPYC')]));
    });

    it('消費税とインボイス (品目の税率・メモ、会計の税率・登録番号・店名・レシート番号): 明細の行には出さない', () => {
      render(
        <CheckoutForm
          params={jpycParams(
            [
              { name: 'ランチ', qty: 1, price: '1080', taxRate: 8, taxCategory: 'taxable_8', memo: '持ち帰り' },
              { name: 'ビール', qty: 2, price: '550', taxRate: 10, taxCategory: 'taxable_10', memo: '大' },
            ],
            { taxRate: 10, taxCategory: 'taxable_10', invoiceNo: 'T1234567890123', storeName: '食堂', receiptNo: 'R-1' },
          )}
        />,
      );
      expect(itemArea()).toEqual(expected([row('ランチ', 1, '1080 JPYC'), row('ビール', 2, '1100 JPYC')]));
    });

    it('値引きあり: 行の額は値引き前のまま・値引きの行は明細の外 (欄の後半の表) に出る', () => {
      render(
        <CheckoutForm
          params={jpycParams(
            [
              { name: 'Tシャツ', qty: 1, price: '2500' },
              { name: 'マグ', qty: 2, price: '1500' },
            ],
            { discount: '500' },
          )}
        />,
      );
      expect(itemArea()).toEqual(expected([row('Tシャツ', 1, '2500 JPYC'), row('マグ', 2, '3000 JPYC')]));
      // 値引きが効いている (後半の表に小計と値引きの行がある)。
      expect(breakdownLabels().slice(0, 2)).toEqual([CF.subtotalRow, CF.discountRow]);
    });

    it('値引きなし: 後半の表は小計から始まり、値引きの行はない (上の値引きありと対にする)', () => {
      render(<CheckoutForm params={jpycParams([{ name: 'Tシャツ', qty: 1, price: '2500' }])} />);
      expect(itemArea()).toEqual(expected([row('Tシャツ', 1, '2500 JPYC')]));
      expect(breakdownLabels()[0]).toBe(CF.subtotalRow);
      expect(breakdownLabels()).not.toContain(CF.discountRow);
    });

    it('モバイル注文の利用料 (事前注文・お客様の負担): 行の額は品代のまま (利用料は明細の行に入らない)', () => {
      feeFlags.enableMobileOrderFee = true;
      render(
        <CheckoutForm
          params={jpycParams(
            [
              { name: 'カレー', qty: 1, price: '900' },
              { name: 'ラッシー', qty: 2, price: '300' },
            ],
            { feeKind: 'preorder', feePayer: 'customer' },
          )}
        />,
      );
      expect(itemArea()).toEqual(expected([row('カレー', 1, '900 JPYC'), row('ラッシー', 2, '600 JPYC')]));
      // 利用料が効いている (後半の表に利用料の行がある)。
      expect(breakdownLabels()).toContain(CF.feeRow);
    });

    it('mode=standard (お客様がウォレットでガス代を払う経路): 行は同じ', () => {
      render(<CheckoutForm params={jpycParams([{ name: 'マグ', qty: 2, price: '1500' }], { mode: 'standard' })} />);
      expect(itemArea()).toEqual(expected([row('マグ', 2, '3000 JPYC')]));
      // standard の経路が効いている (後半の表にウォレットで払うネットワーク手数料の行がある)。
      expect(breakdownLabels()).toContain(CF.gasRowStandard);
    });

    it('未接続: 行は同じ (明細は接続の有無を見ない)', () => {
      setAccount({ isConnected: false });
      setBalance(undefined);
      render(<CheckoutForm params={jpycParams([{ name: 'マグ', qty: 2, price: '1500' }])} />);
      expect(itemArea()).toEqual(expected([row('マグ', 2, '3000 JPYC')]));
    });

    it('支払いが完了した後 (relay.data.success): ウォレットの欄は消えても、明細は同じ形で出し続ける', () => {
      setRelay({ data: { txHash: TX_HASH, success: true } });
      render(<CheckoutForm params={jpycParams([{ name: 'マグ', qty: 2, price: '1500' }])} />);
      expect(document.querySelector('[data-testid="connect-button"]')).toBeNull();
      expect(itemArea()).toEqual(expected([row('マグ', 2, '3000 JPYC')]));
    });
  });

  describe('英語', () => {
    it('見出しは「Items」・行 (品名・×数量・額の表記) は日本語と同じ', () => {
      render(
        <CheckoutForm
          params={jpycParams([
            { name: 'T-shirt', qty: 1, price: '2500' },
            { name: 'Mug', qty: 2, price: '1500' },
          ])}
        />,
        { locale: 'en' },
      );
      expect(itemArea()).toEqual(expected([row('T-shirt', 1, '2500 JPYC'), row('Mug', 2, '3000 JPYC')], 'en'));
    });
  });
});
