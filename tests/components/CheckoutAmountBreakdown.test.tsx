// /checkout (CheckoutForm) のお支払い額の欄 (section) の後半 = 合計の内訳 (小計・値引き・手数料・ネットワーク手数料・区切り線・
// お支払い額の表と、その下の説明・承認の確認のリンク) の描画を、出しうる経路と状態ごとに固定する characterization test
// (第 9 回レビュー F-04・PR-23 の 5 本目・Q11)。
//
// CheckoutForm から表示だけの部品 (components/checkout/CheckoutAmountBreakdown.tsx) を切り出す前に、このテストを変更前のコードで
// green にし、切り出した後も無変更で green であることを確かめた。だから部品は直接 render しない: CheckoutForm を render して、描かれた
// DOM (要素・属性 (class 等すべて)・可視テキスト (額の表記を含む)・入れ子・並び・要素のあいだのテキストノード) だけを見る。部品の
// props の形には依存しない。
//
// 見る範囲: お支払い額の欄 (section) で、前半の商品の明細の並び (ul・tests/components/CheckoutItemList.test.tsx が固定する) の次の
// ノードから欄の終わりまでの、子のノードすべて (要素だけでなくテキストノードも nextSibling でたどる)。section 自身の属性も見る。
// 要素は子まで木のまま比べ、テキストノードはつながずに 1 つずつ比べる (承認の確認のリンクの文言と「 ↗」は別のテキストノード)。
// ネットワーク手数料の行の (?) (InfoTooltip) の DOM も含め、閉じた状態に加えて、開いた状態 (説明の本文が出る) も比べる。開いた
// ときの id は描画のたびに乱数なので 'tip-*' にそろえ、ボタンの aria-describedby と吹き出しの id が同じことを別に確かめる。
//
// 文言は 3 つのカタログで見る: ja・en と、CheckoutForm の文言の先頭に「⟦キー⟧」を付けたもの。ja/en では値が同じキーがある
// (gasRowStandard と gasRowFree・totalRow と totalRowMerchantGas) ので、どのキーを出したかは 3 つめでしか見分けられない。
//
// 経路の組み合わせ (下の CASES) は、内訳の行・説明・リンクの出し分けの条件 (isStandard・isMobileFee・useRecover・useRelay・isJpyc・
// isMerchantGas・isCircle・isErc20Paymaster・見積の有無・チェーンが Arc か・値引き・利用料の額と負担者・承認の確認のリンク先の有無) を
// 1 つずつ単独で効かせ、先に見る条件が後の条件を隠すこと (standard がモバイル注文の利用料や relay の回収より先・モバイル注文が
// relay の回収より先 等) も対にして固定する。本番では起きない組み合わせ (USDC で relay の経路・Circle で paymaster が
// sponsorship) は mock でだけ作れるもので、条件を単独で効かせるために入れる (名前に明記)。
//
// mock の作法は tests/components/CheckoutItemList.test.tsx に合わせる (hook は mockHook で ReturnType に型づけ)。

import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { baseSepolia, polygonAmoy } from 'viem/chains';
import type { Address } from 'viem';
import messages from '@/messages/ja.json';
import enMessages from '@/messages/en.json';
import { arcTestnet } from '@/lib/chains';
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
// forwarder の設定 (relay の回収か無料か) を切り替えられるようにする。回収の下限 (ガス相当額) は 2 JPYC に固定する。
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
// hermetic: 手元の shell の NEXT_PUBLIC_RECOVER_FEE_BPS に左右されないよう 0 に固定する (relay の回収は下限の 2 JPYC になる)。
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
import { resolveUsdcGaslessProvider } from '@/lib/circlePaymaster';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { CheckoutForm } from '@/components/CheckoutForm';
import type { CheckoutItem, CheckoutParams } from '@/lib/url';

const MERCHANT: Address = '0x2222222222222222222222222222222222222222';
const CUSTOMER: Address = '0x9999999999999999999999999999999999999999';
const FORWARDER: Address = '0x1111111111111111111111111111111111111111';
const JPYC = (n: bigint) => n * 10n ** 18n;
// USDC (Base Sepolia) で Pimlico の erc20 paymaster を使うときの、ガス代の承認を確かめるリンク先。
const APPROVAL_URL = `https://sepolia.basescan.org/tokenapprovalchecker?search=${CUSTOMER}`;

// 品目: JPYC は 3000、値引きの会計は 5500 (値引き 500 で 5000)、USDC は 55 (25 + 30)。
const JPYC_ITEMS: CheckoutItem[] = [{ name: 'チケット', qty: 1, price: '3000' }];
const DISCOUNT_ITEMS: CheckoutItem[] = [
  { name: 'Tシャツ', qty: 1, price: '2500' },
  { name: 'マグ', qty: 2, price: '1500' },
];
const USDC_ITEMS: CheckoutItem[] = [
  { name: 'Tシャツ', qty: 1, price: '25' },
  { name: 'マグ', qty: 1, price: '30' },
];

// JPYC の会計 (test env の 'polygon' は Amoy に解決される・ネイティブトークンは POL)。
const jpycParams = (extra: Partial<CheckoutParams> = {}): CheckoutParams => ({
  to: MERCHANT,
  token: 'jpyc',
  chain: 'polygon',
  gas: 'customer',
  items: JPYC_ITEMS,
  ...extra,
});
// USDC の会計 (test env の 'base' は Base Sepolia に解決される・ネイティブトークンは ETH)。
const usdcParams = (extra: Partial<CheckoutParams> = {}): CheckoutParams => ({
  to: MERCHANT,
  token: 'usdc',
  chain: 'base',
  gas: 'customer',
  items: USDC_ITEMS,
  ...extra,
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

function setQuote(hook: typeof useGasQuoteUsdc | typeof useGasQuoteJpyc, gasAmount: bigint | undefined) {
  mockHook(hook, {
    data: gasAmount === undefined ? undefined : { gasAmount },
    isLoading: false,
    isError: false,
    error: null,
  } as Partial<ReturnType<typeof useGasQuoteUsdc>>);
}

function setCircleQuote(gasAmount: bigint | undefined) {
  mockHook(useGasQuoteCircle, {
    data: gasAmount === undefined ? undefined : { gasAmount, permitAmount: 60_000_000n },
    error: null,
    fetchStatus: 'idle',
  } as Partial<ReturnType<typeof useGasQuoteCircle>>);
}

function setSmartAccountReady() {
  mockHook(useSmartAccount, {
    data: { smartAccountClient: {}, pimlicoClient: {} },
    isLoading: false,
    error: null,
  } as Partial<ReturnType<typeof useSmartAccount>>);
}

/** relay の回収 (forwarder が設定されたチェーン)。既定は forwarder なし = relay の無料。 */
function setRelayRecover() {
  vi.mocked(jpycForwarderFor).mockReturnValue(FORWARDER);
}

/** JPYC で relay でないガスレス (Pimlico の sponsorship)。見積はあっても JPYC はガスを取らない。 */
function setJpycSponsorship(quote: bigint) {
  vi.mocked(resolveJpycGaslessProvider).mockReturnValue('pimlico-7702');
  setSmartAccountReady();
  setQuote(useGasQuoteJpyc, quote);
}

/** USDC の会計。ウォレットは Base Sepolia にいる (未接続を除く)。paymaster と Circle と見積を選ぶ。 */
function setUsdc(opts: {
  paymaster: 'erc20' | 'sponsorship';
  circle?: boolean;
  /** relay の経路にする (本番では起きない・mock でだけ作れる)。 */
  relay?: boolean;
  /** Pimlico の見積 (erc20 は useGasQuoteUsdc・sponsorship は useGasQuoteJpyc)。undefined は取得中。 */
  quote?: bigint;
  /** Circle の見積。undefined は取得中。 */
  circleQuote?: bigint;
  connected?: boolean;
}) {
  vi.mocked(resolveJpycGaslessProvider).mockReturnValue(opts.relay ? 'eip3009-relay' : 'pimlico-7702');
  vi.mocked(resolveUsdcGaslessProvider).mockReturnValue(opts.circle ? 'circle' : 'pimlico');
  vi.mocked(resolvePaymasterMode).mockImplementation((dep) => (dep.symbol === 'usdc' ? opts.paymaster : 'sponsorship'));
  setAccount(opts.connected === false ? { isConnected: false } : { isConnected: true, chainId: baseSepolia.id });
  setBalance(opts.connected === false ? undefined : 200_000_000n);
  setSmartAccountReady();
  setQuote(opts.paymaster === 'erc20' ? useGasQuoteUsdc : useGasQuoteJpyc, opts.quote);
  setCircleQuote(opts.circleQuote);
}

function setDefaults() {
  feeFlags.enableMobileOrderFee = false;
  vi.mocked(resolveJpycGaslessProvider).mockReturnValue('eip3009-relay');
  vi.mocked(resolveUsdcGaslessProvider).mockReturnValue('pimlico');
  vi.mocked(jpycForwarderFor).mockReturnValue(null);
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
  mockHook(useJpycEip3009Payment, {
    mutate: vi.fn(),
    isPending: false,
    data: undefined,
    error: null,
    retryRelay: vi.fn(),
    retrySamePayload: vi.fn(),
    recoveryState: null,
    restoredIntent: null,
    orderDelivery: null,
    previousPaymentPending: false,
    previousPaymentSameMerchant: false,
  } as Partial<ReturnType<typeof useJpycEip3009Payment>>);
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
  setQuote(useGasQuoteUsdc, undefined);
  setQuote(useGasQuoteJpyc, undefined);
  setCircleQuote(undefined);
  window.sessionStorage.clear();
  window.localStorage.clear();
}

beforeEach(() => {
  vi.clearAllMocks();
  setDefaults();
});

// ---- 文言のカタログ ----------------------------------------------------------------------------------------------

type Catalog = 'ja' | 'en' | 'keys';
type Messages = typeof messages;
type CheckoutKey = keyof Messages['CheckoutForm'];

// CheckoutForm の文言の先頭に「⟦キー⟧」を付けたカタログ (ja が元)。値が同じキー (gasRowStandard と gasRowFree・totalRow と
// totalRowMerchantGas) のどちらを出したかを見分けるため。InfoTooltip 等ほかの namespace は ja のまま。
const KEYED_MESSAGES: Messages = {
  ...messages,
  CheckoutForm: Object.fromEntries(
    Object.entries(messages.CheckoutForm).map(([key, value]) => [key, typeof value === 'string' ? `⟦${key}⟧${value}` : value]),
  ) as Messages['CheckoutForm'],
};

const catalogMessages = (c: Catalog): Messages =>
  c === 'ja' ? messages : c === 'en' ? (enMessages as Messages) : KEYED_MESSAGES;

function renderIn(c: Catalog, ui: ReactElement) {
  return render(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <NextIntlClientProvider locale={c === 'en' ? 'en' : 'ja'} messages={catalogMessages(c)}>
        {children}
      </NextIntlClientProvider>
    ),
  });
}

/** 文言のキーと、差し込む値 ({nativeToken}・{amount} 等)。 */
type Msg = { key: CheckoutKey; values?: Record<string, string> };
const k = (key: CheckoutKey, values?: Record<string, string>): Msg => ({ key, values });

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    if (!(name in values)) throw new Error(`missing value for {${name}} in "${template}"`);
    return values[name];
  });
}

/** カタログ c でのキーの文言 (差し込み済み)。 */
function tx(c: Catalog, m: Msg): string {
  const template = catalogMessages(c).CheckoutForm[m.key];
  if (typeof template !== 'string') throw new Error(`CheckoutForm.${String(m.key)} is not a string`);
  return fill(template, m.values ?? {});
}

/** (?) のボタンの a11y 名 (InfoTooltip の detailsLabel・行の見出しから導く)。 */
const tooltipName = (c: Catalog, label: string) => fill(catalogMessages(c).InfoTooltip.detailsLabel, { label });

// ---- DOM を木にして比べる ----------------------------------------------------------------------------------------

/** 要素を子まで木にしたもの。属性はすべて (class・role 等)、テキストは text node 1 つを 1 つの文字列で持つ (つながない)。 */
type Dom = { tag: string; attrs: Record<string, string>; children: DomNode[] };
type DomNode = string | Dom;

// (?) の吹き出しの id (と、それを指すボタンの aria-describedby) は描画のたびに乱数 (InfoTooltip の 'tip-' + 乱数)。
const TIP_ID = /^tip-[0-9a-z]+$/;

function attrsOf(el: Element): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) {
    attrs[a.name] = (a.name === 'id' || a.name === 'aria-describedby') && TIP_ID.test(a.value) ? 'tip-*' : a.value;
  }
  return attrs;
}

/** first から end の手前までの兄弟のノードを、テキストノード (要素のあいだの空白を含む) も落とさずに並びどおりに返す。 */
function nodes(first: ChildNode | null, end: ChildNode | null): DomNode[] {
  const out: DomNode[] = [];
  for (let n = first; n !== end; n = n.nextSibling) {
    // end に届かずに兄弟が尽きたら、目印が同じ親にいない (範囲が壊れている)。
    if (n === null) throw new Error('end marker is not a following sibling');
    if (n.nodeType === Node.TEXT_NODE) {
      // 隣り合うテキストノードもつながない (境界が変われば落ちる)。
      out.push(n.textContent ?? '');
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

/** お支払い額の欄 (小計・お支払い額の表 dl を持つ section)。 */
function amountSection(): HTMLElement {
  const found = Array.from(document.querySelectorAll('section')).filter(
    (s) => s.querySelector(':scope > div > dl') !== null,
  );
  expect(found).toHaveLength(1);
  return found[0];
}

/** お支払い額の欄の後半 (前半の商品の明細の並び ul の次のノードから、欄の終わりまで) と、欄 (section) 自身の属性。 */
function breakdownArea(): { section: Record<string, string>; nodes: DomNode[] } {
  const section = amountSection();
  const items = section.querySelector(':scope > ul');
  expect(items).not.toBeNull();
  return { section: attrsOf(section), nodes: nodes(items!.nextSibling, null) };
}

// ---- 期待する DOM ------------------------------------------------------------------------------------------------

const SECTION_ATTRS = { class: 'rounded-2xl border border-slate-200 bg-white p-4 text-sm' };
const TIP_BUTTON_CLASS =
  'relative inline-flex h-4 w-4 items-center justify-center rounded-full border border-slate-300 bg-white text-[10px] font-bold text-slate-500 after:absolute after:-inset-[5px] hover:border-slate-400 hover:text-slate-700';
const TIP_POPOVER_CLASS =
  'absolute left-1/2 top-full z-20 mt-2 w-64 -translate-x-1/2 rounded-md border border-slate-200 bg-white px-3 py-2 text-[11px] leading-relaxed text-slate-700 shadow-lg';

/** (?) (InfoTooltip)。open なら吹き出し (説明の本文) も出る。 */
function tooltip(name: string, open: { text: string } | null): Dom {
  return {
    tag: 'span',
    attrs: { class: 'relative inline-block' },
    children: [
      {
        tag: 'button',
        attrs: {
          type: 'button',
          'aria-label': name,
          'aria-expanded': open ? 'true' : 'false',
          ...(open ? { 'aria-describedby': 'tip-*' } : {}),
          class: TIP_BUTTON_CLASS,
        },
        children: ['?'],
      },
      ...(open ? [{ tag: 'span', attrs: { id: 'tip-*', role: 'tooltip', class: TIP_POPOVER_CLASS }, children: [open.text] }] : []),
    ],
  };
}

/** 内訳の 1 行 (dt = 見出し (+ (?))・dd = 額)。お支払い額の行だけ strong (太字)。 */
function row(label: string, value: string, extra: Dom | null = null): Dom {
  return {
    tag: 'div',
    attrs: { class: 'flex justify-between gap-2' },
    children: [
      { tag: 'dt', attrs: { class: 'inline-flex items-center gap-1 text-slate-500' }, children: extra ? [label, extra] : [label] },
      { tag: 'dd', attrs: { class: 'text-right font-mono text-slate-700' }, children: [value] },
    ],
  };
}
function strongRow(label: string, value: string): Dom {
  return {
    tag: 'div',
    attrs: { class: 'flex justify-between gap-2' },
    children: [
      { tag: 'dt', attrs: { class: 'inline-flex items-center gap-1 text-slate-700' }, children: [label] },
      { tag: 'dd', attrs: { class: 'text-right font-mono font-semibold text-slate-900' }, children: [value] },
    ],
  };
}

/** 経路と状態ごとに期待する内訳。額は表記の文字列 (例 "3000 JPYC")、文言はキー (と差し込む値)。 */
type Want = {
  /** 小計の行の額。 */
  subtotal: string;
  /** 値引きの行の額 (「−」付き)。無ければ値引きの行は出ない。 */
  discount?: string;
  /** OpenPay 利用手数料の行。無ければ出ない。 */
  fee?: { label: 'feeRow' | 'feeRowMerchant'; value: string };
  /** ネットワーク手数料の行。無ければ出ない。value は額の表記か文言。tooltip が無い行は (?) を出さない。 */
  gas?: { label: CheckoutKey; value: string | Msg; tooltip?: Msg };
  /** お支払い額の行 (区切り線の下・太字)。 */
  total: { label: Msg; value: string };
  /** 表の下の説明。 */
  hint: Msg;
  /** 承認の確認のリンク先。無ければリンクは出ない。 */
  approval?: string;
};

function expectedArea(c: Catalog, want: Want, open: boolean): { section: Record<string, string>; nodes: DomNode[] } {
  const rows: Dom[] = [row(tx(c, k('subtotalRow')), want.subtotal)];
  if (want.discount !== undefined) rows.push(row(tx(c, k('discountRow')), want.discount));
  if (want.fee) rows.push(row(tx(c, k(want.fee.label)), want.fee.value));
  if (want.gas) {
    const label = tx(c, k(want.gas.label));
    const value = typeof want.gas.value === 'string' ? want.gas.value : tx(c, want.gas.value);
    const extra = want.gas.tooltip
      ? tooltip(tooltipName(c, label), open ? { text: tx(c, want.gas.tooltip) } : null)
      : null;
    rows.push(row(label, value, extra));
  }
  rows.push({ tag: 'div', attrs: { class: 'my-1 border-t border-slate-200' }, children: [] });
  rows.push(strongRow(tx(c, want.total.label), want.total.value));

  const out: DomNode[] = [
    {
      tag: 'div',
      attrs: { class: 'mt-3 border-t border-slate-200 pt-3' },
      children: [{ tag: 'dl', attrs: { class: 'space-y-1.5' }, children: rows }],
    },
    { tag: 'p', attrs: { class: 'mt-3 text-[11px] leading-relaxed text-slate-500' }, children: [tx(c, want.hint)] },
  ];
  if (want.approval !== undefined) {
    out.push({
      tag: 'p',
      attrs: { class: 'mt-2 text-[11px]' },
      children: [
        {
          tag: 'a',
          attrs: {
            href: want.approval,
            target: '_blank',
            rel: 'noreferrer noopener',
            class: 'text-slate-500 underline hover:text-slate-700',
          },
          children: [tx(c, k('approvalCheckLink')), ' ↗'],
        },
      ],
    });
  }
  return { section: SECTION_ATTRS, nodes: out };
}

// ---- ネットワーク手数料の行 (期待) -----------------------------------------------------------------------------------

/** standard: お客様のウォレットがガスを払う (額でなく「ウォレットで支払い」・(?) なし)。 */
const GAS_STANDARD = { label: 'gasRowStandard', value: k('gasRowStandardValue') } as const;
/** JPYC のガスレス (relay の無料・relay でない sponsorship): 無料・中立の見出し。 */
const GAS_FREE = { label: 'gasRowFree', value: k('gasRowRelayFree'), tooltip: k('gasInfoJpycRelay') } as const;
/** relay の回収: 回収するガス相当額 (店舗負担に固定なので見出しは店主負担)。 */
const gasRecover = (amount: string) =>
  ({ label: 'gasRowMerchant', value: amount, tooltip: k('gasInfoJpycRecover') }) as const;
/** Pimlico / Circle の見積の行 (USDC 等)。amount が無ければ見積の取得中。 */
const gasQuote = (
  label: 'gasRow' | 'gasRowMerchant',
  info: 'gasInfoUsdc' | 'gasInfoUsdcCircle' | 'gasInfoJpyc',
  nativeToken: string,
  amount?: string,
) => ({
  label,
  tooltip: k(info, { nativeToken }),
  value: amount === undefined ? k('gasRowPending') : k('gasRowValue', { amount }),
});

const totalRow = (value: string) => ({ label: k('totalRow'), value });
const totalMerchantGas = (value: string) => ({ label: k('totalRowMerchantGas'), value });
const totalStandard = (nativeToken: string, value: string) => ({ label: k('totalRowStandard', { nativeToken }), value });

// ---- 経路と状態の組み合わせ ---------------------------------------------------------------------------------------

type Case = { name: string; setup?: () => void; params: CheckoutParams; want: Want };

const CASES: Case[] = [
  // --- JPYC ---
  {
    name: 'JPYC・relay の無料 (forwarder なし)・URL gas=customer',
    params: jpycParams(),
    want: { subtotal: '3000 JPYC', gas: GAS_FREE, total: totalRow('3000 JPYC'), hint: k('gaslessHintJpycRelay') },
  },
  {
    name: 'JPYC・relay の無料・URL gas=merchant (お支払い額の見出しだけが店主負担のキー)',
    params: jpycParams({ gas: 'merchant' }),
    want: { subtotal: '3000 JPYC', gas: GAS_FREE, total: totalMerchantGas('3000 JPYC'), hint: k('gaslessHintJpycRelay') },
  },
  {
    name: 'JPYC・relay の回収 (forwarder あり・URL gas=customer でも店舗負担に固定・回収額 2 JPYC)',
    setup: setRelayRecover,
    params: jpycParams(),
    want: { subtotal: '3000 JPYC', gas: gasRecover('2 JPYC'), total: totalMerchantGas('3000 JPYC'), hint: k('gaslessHintJpycRecover') },
  },
  {
    name: 'JPYC・relay でないガスレス (Pimlico の sponsorship・見積 5 JPYC があっても無料の行)',
    setup: () => setJpycSponsorship(JPYC(5n)),
    params: jpycParams(),
    want: { subtotal: '3000 JPYC', gas: GAS_FREE, total: totalRow('3000 JPYC'), hint: k('gaslessHintJpycRelay') },
  },
  {
    name: 'JPYC・standard (ネイティブトークンは POL)',
    params: jpycParams({ mode: 'standard' }),
    want: {
      subtotal: '3000 JPYC',
      gas: GAS_STANDARD,
      total: totalStandard('POL', '3000 JPYC'),
      hint: k('standardHint', { nativeToken: 'POL' }),
    },
  },
  {
    name: 'JPYC・standard・URL gas=merchant (standard のお支払い額の見出しのまま)',
    params: jpycParams({ mode: 'standard', gas: 'merchant' }),
    want: {
      subtotal: '3000 JPYC',
      gas: GAS_STANDARD,
      total: totalStandard('POL', '3000 JPYC'),
      hint: k('standardHint', { nativeToken: 'POL' }),
    },
  },
  {
    name: 'JPYC・standard・relay の回収の設定あり (standard が回収より先)',
    setup: setRelayRecover,
    params: jpycParams({ mode: 'standard' }),
    want: {
      subtotal: '3000 JPYC',
      gas: GAS_STANDARD,
      total: totalStandard('POL', '3000 JPYC'),
      hint: k('standardHint', { nativeToken: 'POL' }),
    },
  },
  // --- USDC ---
  {
    name: 'USDC・Pimlico の erc20 paymaster・見積 0.1 USDC・接続中 (承認の確認のリンクが出る)',
    setup: () => setUsdc({ paymaster: 'erc20', quote: 100_000n }),
    params: usdcParams(),
    want: {
      subtotal: '55 USDC',
      gas: gasQuote('gasRow', 'gasInfoUsdc', 'ETH', '0.1 USDC'),
      total: totalRow('55.1 USDC'),
      hint: k('gaslessHintUsdc'),
      approval: APPROVAL_URL,
    },
  },
  {
    name: 'USDC・erc20・見積の取得中',
    setup: () => setUsdc({ paymaster: 'erc20', quote: undefined }),
    params: usdcParams(),
    want: {
      subtotal: '55 USDC',
      gas: gasQuote('gasRow', 'gasInfoUsdc', 'ETH'),
      total: totalRow('55 USDC'),
      hint: k('gaslessHintUsdc'),
      approval: APPROVAL_URL,
    },
  },
  {
    name: 'USDC・erc20・URL gas=merchant (見出しは店主負担・お支払い額にガスを足さない)',
    setup: () => setUsdc({ paymaster: 'erc20', quote: 100_000n }),
    params: usdcParams({ gas: 'merchant' }),
    want: {
      subtotal: '55 USDC',
      gas: gasQuote('gasRowMerchant', 'gasInfoUsdc', 'ETH', '0.1 USDC'),
      total: totalMerchantGas('55 USDC'),
      hint: k('gaslessHintUsdc'),
      approval: APPROVAL_URL,
    },
  },
  {
    name: 'USDC・erc20・未接続 (承認の確認のリンクは出ない)',
    setup: () => setUsdc({ paymaster: 'erc20', quote: 100_000n, connected: false }),
    params: usdcParams(),
    want: {
      subtotal: '55 USDC',
      gas: gasQuote('gasRow', 'gasInfoUsdc', 'ETH', '0.1 USDC'),
      total: totalRow('55.1 USDC'),
      hint: k('gaslessHintUsdc'),
    },
  },
  {
    name: 'USDC・Circle paymaster (erc20)・Circle の見積 0.2 USDC (Pimlico の見積 0.1 は使わない)',
    setup: () => setUsdc({ paymaster: 'erc20', circle: true, quote: 100_000n, circleQuote: 200_000n }),
    params: usdcParams(),
    want: {
      subtotal: '55 USDC',
      gas: gasQuote('gasRow', 'gasInfoUsdcCircle', 'ETH', '0.2 USDC'),
      total: totalRow('55.2 USDC'),
      hint: k('gaslessHintUsdc'),
      approval: APPROVAL_URL,
    },
  },
  {
    name: 'USDC・Circle・見積の取得中',
    setup: () => setUsdc({ paymaster: 'erc20', circle: true, quote: 100_000n, circleQuote: undefined }),
    params: usdcParams(),
    want: {
      subtotal: '55 USDC',
      gas: gasQuote('gasRow', 'gasInfoUsdcCircle', 'ETH'),
      total: totalRow('55 USDC'),
      hint: k('gaslessHintUsdc'),
      approval: APPROVAL_URL,
    },
  },
  {
    name: 'USDC・Pimlico の sponsorship (erc20 でない)・見積 0.3 USDC (承認の確認のリンクは出ない)',
    setup: () => setUsdc({ paymaster: 'sponsorship', quote: 300_000n }),
    params: usdcParams(),
    want: {
      subtotal: '55 USDC',
      gas: gasQuote('gasRow', 'gasInfoJpyc', 'ETH', '0.3 USDC'),
      total: totalRow('55.3 USDC'),
      hint: k('gaslessHintJpyc'),
    },
  },
  {
    name: 'USDC・standard (ネイティブトークンは ETH・erc20 でも承認の確認のリンクは出ない)',
    setup: () => setUsdc({ paymaster: 'erc20', quote: 100_000n }),
    params: usdcParams({ mode: 'standard' }),
    want: {
      subtotal: '55 USDC',
      gas: GAS_STANDARD,
      total: totalStandard('ETH', '55 USDC'),
      hint: k('standardHint', { nativeToken: 'ETH' }),
    },
  },
  {
    name: 'USDC・Arc・standard (ネイティブトークンは USDC・Arc の説明)',
    setup: () => {
      vi.mocked(resolveJpycGaslessProvider).mockReturnValue('pimlico-7702');
      setAccount({ isConnected: true, chainId: arcTestnet.id });
      setBalance(200_000_000n);
    },
    params: usdcParams({ chain: 'arc', mode: 'standard' }),
    want: {
      subtotal: '55 USDC',
      gas: GAS_STANDARD,
      total: totalStandard('USDC', '55 USDC'),
      hint: k('standardArcHint'),
    },
  },
  // --- モバイル注文の利用料 ---
  {
    name: 'モバイル注文・店頭 (1%・店舗負担・relay の回収): 利用料の行があり、ネットワーク手数料の行はない',
    setup: () => {
      feeFlags.enableMobileOrderFee = true;
      setRelayRecover();
    },
    params: jpycParams({ feeKind: 'storefront' }),
    want: {
      subtotal: '3000 JPYC',
      fee: { label: 'feeRowMerchant', value: '30 JPYC' },
      total: totalMerchantGas('3000 JPYC'),
      hint: k('gaslessHintMobile'),
    },
  },
  {
    name: 'モバイル注文・事前注文 (3%)・お客様負担: 利用料の見出しは補足なし・お支払い額に上乗せ',
    setup: () => {
      feeFlags.enableMobileOrderFee = true;
      setRelayRecover();
    },
    params: jpycParams({ feeKind: 'preorder', feePayer: 'customer' }),
    want: {
      subtotal: '3000 JPYC',
      fee: { label: 'feeRow', value: '90 JPYC' },
      total: totalRow('3090 JPYC'),
      hint: k('gaslessHintMobile'),
    },
  },
  {
    name: 'モバイル注文・事前注文・店舗負担',
    setup: () => {
      feeFlags.enableMobileOrderFee = true;
      setRelayRecover();
    },
    params: jpycParams({ feeKind: 'preorder', feePayer: 'merchant' }),
    want: {
      subtotal: '3000 JPYC',
      fee: { label: 'feeRowMerchant', value: '90 JPYC' },
      total: totalMerchantGas('3000 JPYC'),
      hint: k('gaslessHintMobile'),
    },
  },
  {
    name: 'モバイル注文・店頭・standard (standard の行と説明がモバイル注文より先)',
    setup: () => {
      feeFlags.enableMobileOrderFee = true;
    },
    params: jpycParams({ feeKind: 'storefront', mode: 'standard' }),
    want: {
      subtotal: '3000 JPYC',
      fee: { label: 'feeRowMerchant', value: '30 JPYC' },
      gas: GAS_STANDARD,
      total: totalStandard('POL', '3000 JPYC'),
      hint: k('standardHint', { nativeToken: 'POL' }),
    },
  },
  {
    name: 'モバイル注文・店頭・利用料が 0 になる極小額 (利用料の行は出ない・モバイル注文の説明のまま)',
    setup: () => {
      feeFlags.enableMobileOrderFee = true;
      setRelayRecover();
    },
    params: jpycParams({ feeKind: 'storefront', items: [{ name: '試供品', qty: 1, price: '0.00000000000000009' }] }),
    want: {
      subtotal: '0.00000000000000009 JPYC',
      total: totalMerchantGas('0.00000000000000009 JPYC'),
      hint: k('gaslessHintMobile'),
    },
  },
  {
    name: 'モバイル注文・店頭・USDC の erc20 (ネットワーク手数料の行は出ず、承認の確認のリンクは出る)',
    setup: () => {
      feeFlags.enableMobileOrderFee = true;
      setUsdc({ paymaster: 'erc20', quote: 100_000n });
    },
    params: usdcParams({ feeKind: 'storefront' }),
    want: {
      subtotal: '55 USDC',
      fee: { label: 'feeRowMerchant', value: '0.55 USDC' },
      total: totalMerchantGas('55 USDC'),
      hint: k('gaslessHintMobile'),
      approval: APPROVAL_URL,
    },
  },
  {
    name: 'モバイル注文の flag OFF (feeKind=storefront でも利用料なし・relay の回収のまま)',
    setup: setRelayRecover,
    params: jpycParams({ feeKind: 'storefront' }),
    want: { subtotal: '3000 JPYC', gas: gasRecover('2 JPYC'), total: totalMerchantGas('3000 JPYC'), hint: k('gaslessHintJpycRecover') },
  },
  // --- 値引き ---
  {
    name: '値引きあり・JPYC の relay の無料 (小計は値引き前・以降は値引き後)',
    params: jpycParams({ items: DISCOUNT_ITEMS, discount: '500' }),
    want: {
      subtotal: '5500 JPYC',
      discount: '−500 JPYC',
      gas: GAS_FREE,
      total: totalRow('5000 JPYC'),
      hint: k('gaslessHintJpycRelay'),
    },
  },
  {
    name: '値引きあり・モバイル注文の事前注文・お客様負担 (利用料は値引き後の額の 3%)',
    setup: () => {
      feeFlags.enableMobileOrderFee = true;
      setRelayRecover();
    },
    params: jpycParams({ items: DISCOUNT_ITEMS, discount: '500', feeKind: 'preorder', feePayer: 'customer' }),
    want: {
      subtotal: '5500 JPYC',
      discount: '−500 JPYC',
      fee: { label: 'feeRow', value: '150 JPYC' },
      total: totalRow('5150 JPYC'),
      hint: k('gaslessHintMobile'),
    },
  },
  {
    name: '値引きあり・USDC の erc20 (小数の値引き・見積 0.1 USDC)',
    setup: () => setUsdc({ paymaster: 'erc20', quote: 100_000n }),
    params: usdcParams({ discount: '5.5' }),
    want: {
      subtotal: '55 USDC',
      discount: '−5.5 USDC',
      gas: gasQuote('gasRow', 'gasInfoUsdc', 'ETH', '0.1 USDC'),
      total: totalRow('49.6 USDC'),
      hint: k('gaslessHintUsdc'),
      approval: APPROVAL_URL,
    },
  },
  // --- 消費税 ---
  {
    name: '消費税とインボイス (品目の税率・会計の税率・登録番号・店名・レシート番号): 内訳は変わらない',
    params: jpycParams({
      items: [{ name: 'ランチ', qty: 1, price: '3000', taxRate: 8, taxCategory: 'taxable_8' }],
      taxRate: 8,
      taxCategory: 'taxable_8',
      invoiceNo: 'T1234567890123',
      storeName: '食堂',
      receiptNo: 'R-1',
    }),
    want: { subtotal: '3000 JPYC', gas: GAS_FREE, total: totalRow('3000 JPYC'), hint: k('gaslessHintJpycRelay') },
  },
  // --- mock でだけ作れる組み合わせ (条件を単独で効かせる) ---
  {
    name: '(mock だけ) USDC で relay の経路: JPYC でなくても relay なら無料の行と relay の説明 (erc20 なのでリンクは出る)',
    setup: () => setUsdc({ paymaster: 'erc20', relay: true, quote: 100_000n }),
    params: usdcParams(),
    want: {
      subtotal: '55 USDC',
      gas: GAS_FREE,
      total: totalRow('55 USDC'),
      hint: k('gaslessHintJpycRelay'),
      approval: APPROVAL_URL,
    },
  },
  {
    name: '(mock だけ) USDC の Circle で paymaster が sponsorship: (?) は Circle の説明・表の下は sponsorship の説明',
    setup: () => setUsdc({ paymaster: 'sponsorship', circle: true, quote: 300_000n, circleQuote: 200_000n }),
    params: usdcParams(),
    want: {
      subtotal: '55 USDC',
      gas: gasQuote('gasRow', 'gasInfoUsdcCircle', 'ETH', '0.2 USDC'),
      total: totalRow('55.2 USDC'),
      hint: k('gaslessHintJpyc'),
    },
  },
];

const CATALOGS: ReadonlyArray<[string, Catalog]> = [
  ['ja', 'ja'],
  ['en', 'en'],
  ['文言のキー (値が同じキーを見分ける)', 'keys'],
];

describe('CheckoutForm — お支払い額の欄の後半 = 合計の内訳 (CheckoutAmountBreakdown の characterization・第 9 回レビュー F-04)', () => {
  it('組み合わせの名前は重ならない', () => {
    expect(new Set(CASES.map((c) => c.name)).size).toBe(CASES.length);
  });

  describe.each(CATALOGS)('%s', (_label, catalog) => {
    it.each(CASES)('$name', ({ setup, params, want }) => {
      setup?.();
      renderIn(catalog, <CheckoutForm params={params} />);
      expect(breakdownArea()).toEqual(expectedArea(catalog, want, false));

      const button = amountSection().querySelector(':scope > div > dl button');
      if (!want.gas?.tooltip) {
        expect(button).toBeNull();
        return;
      }
      // (?) を開くと吹き出しに説明の本文が出る。ボタンの aria-describedby は吹き出しの id を指す。
      fireEvent.click(button!);
      const popover = amountSection().querySelector('[role="tooltip"]');
      expect(popover).not.toBeNull();
      expect(popover!.id).toMatch(TIP_ID);
      expect(button!.getAttribute('aria-describedby')).toBe(popover!.id);
      expect(breakdownArea()).toEqual(expectedArea(catalog, want, true));
    });
  });
});
