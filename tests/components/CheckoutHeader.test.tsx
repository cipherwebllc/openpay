// /checkout (CheckoutForm) の会計の頭の部分 (header) = 見出し「ご注文のお支払い」・店名と店名の注記・受付番号 (または
// 「OpenPay Checkout」)・説明・何度でも使える注文リンク (ship=ask) の案内・支払先の行 (支払先・チェーン名・通貨・ガス代の扱い)・
// 「別のチェーンで払う」ボタン の描画を、出しうる状態ごとに固定する characterization test (第 9 回レビュー F-04・PR-23 の
// 6 本目・Q11)。
//
// CheckoutForm から表示だけの部品 (components/checkout/CheckoutHeader.tsx) を切り出す前に、このテストを変更前のコードで green に
// し、切り出した後も無変更で green であることを確かめた。だから部品は直接 render しない: CheckoutForm を render して、描かれた
// DOM (要素・属性 (class 等すべて)・可視テキスト・入れ子・並び・要素のあいだのテキストノード) だけを見る。部品の props の形には
// 依存しない。
//
// 見る範囲: CheckoutForm の一番外の div の最初のノード (= header) を子まで木にしたもの。header の前にノードが無いこと (header が
// 先頭) と、header の次のノードが要素 (section) であること (header の後ろにテキストノード等が紛れていない) も見る。要素は子まで
// 木のまま比べ、テキストノードはつながずに 1 つずつ比べる (支払先の行は「支払先 0x…」・「 ·」・「 」・チェーン名・「 · 」・
// 通貨・「 ·」・「 」・ガス代の扱い の 9 つのテキストノードで、その境界も固定する)。
//
// 文言は 3 つのカタログで見る: ja・en と、CheckoutForm の文言の先頭に「⟦キー⟧」を付けたもの。checkoutTitle は ja と en で
// 同じ値 (「OpenPay Checkout」) なので、どのキーを出したかは 3 つめで見分ける。
//
// 状態 (下の CASES) は、頭の部分の出し分けの条件 (店名・受付番号・説明・ship=ask と遠隔の注文か (モバイル注文の @handle と
// feeKind・お店の端末で送る会計 submit=store は遠隔の注文でない)・送り先の有無と種類・通常決済か・通貨とチェーン・受け付ける
// チェーンが 2 つ以上か・支払いを始めたか) を 1 つずつ単独で効かせる。「別のチェーンで払う」を止める条件 (切り替えの待ち・
// 送信中・完了・通常決済の途中・このタブで払った記録) も 1 つずつ固定する。描き直し (切り替えの待ちが始まって終わる・ガスレスから
// 通常決済へ・このタブで払った記録から「新しい注文として払う」) で、header と行の DOM が同じものを使い続けることも見る。
//
// mock の作法は tests/components/CheckoutAmountBreakdown.test.tsx に合わせる (hook は mockHook で ReturnType に型づけ)。

import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { baseSepolia, polygonAmoy } from 'viem/chains';
import type { Address, Hex } from 'viem';
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
// hermetic: 手元の shell の NEXT_PUBLIC_RECOVER_FEE_BPS に左右されないよう 0 に固定する。
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
import { useRouter } from 'next/navigation';
import { useSmartAccount } from '@/hooks/useSmartAccount';
import { useBatchPayment } from '@/hooks/useBatchPayment';
import { useStandardPayment } from '@/hooks/useStandardPayment';
import { useGasQuoteUsdc } from '@/hooks/useGasQuoteUsdc';
import { useGasQuoteJpyc } from '@/hooks/useGasQuoteJpyc';
import { useGasQuoteCircle } from '@/hooks/useGasQuoteCircle';
import { useJpycEip3009Payment } from '@/hooks/useJpycEip3009Payment';
import { resolvePaymasterMode } from '@/lib/pimlico';
import { resolveJpycGaslessProvider } from '@/lib/jpycGaslessProvider';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { rememberOrderPayment } from '@/lib/orderConfirmation';
import { orderPaymentContextKey } from '@/lib/orderPaidLookup';
import { CheckoutForm } from '@/components/CheckoutForm';
import type { ChainSlug } from '@/lib/chains';
import type { CheckoutItem, CheckoutParams } from '@/lib/url';

const MERCHANT: Address = '0x2222222222222222222222222222222222222222';
const CUSTOMER: Address = '0x9999999999999999999999999999999999999999';
// 支払先の行の短縮表示 (先頭 6 文字…末尾 4 文字)。
const MERCHANT_SHORT = '0x2222…2222';
const TX_HASH: Hex = `0x${'ab'.repeat(32)}`;
const JPYC = (n: bigint) => n * 10n ** 18n;

const JPYC_ITEMS: CheckoutItem[] = [{ name: 'チケット', qty: 1, price: '3000' }];
const USDC_ITEMS: CheckoutItem[] = [{ name: 'Tシャツ', qty: 1, price: '25' }];

// JPYC の会計 (test env の 'polygon' は Amoy に解決される)。
const jpycParams = (extra: Partial<CheckoutParams> = {}): CheckoutParams => ({
  to: MERCHANT,
  token: 'jpyc',
  chain: 'polygon',
  gas: 'customer',
  items: JPYC_ITEMS,
  ...extra,
});
// USDC の会計 (test env の 'base' は Base Sepolia に解決される)。
const usdcParams = (extra: Partial<CheckoutParams> = {}): CheckoutParams => ({
  to: MERCHANT,
  token: 'usdc',
  chain: 'base',
  gas: 'customer',
  items: USDC_ITEMS,
  ...extra,
});
// 受け付けるチェーンが 2 つの注文リンク (Polygon を選んだ後)。
const MULTI: Partial<CheckoutParams> = { chains: ['polygon', 'kaia'] };

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

/** ウォレットのチェーンの切り替え (useSwitchChain)。isPending = 切り替えの待ち。 */
function setSwitching(isPending: boolean) {
  mockHook(useSwitchChain, {
    switchChain: vi.fn(),
    isPending,
    error: null,
    variables: undefined,
  } as Partial<ReturnType<typeof useSwitchChain>>);
}

/** relay (JPYC のガスレス) の状態。isPending = 送信中・data = 結果・restoredIntent = 読み直した画面で復元した支払い。 */
function setRelay(
  state: {
    isPending?: boolean;
    data?: ReturnType<typeof useJpycEip3009Payment>['data'];
    restoredIntent?: ReturnType<typeof useJpycEip3009Payment>['restoredIntent'];
  } = {},
) {
  mockHook(useJpycEip3009Payment, {
    mutate: vi.fn(),
    isPending: state.isPending ?? false,
    data: state.data,
    error: null,
    retryRelay: vi.fn(),
    retrySamePayload: vi.fn(),
    recoveryState: null,
    restoredIntent: state.restoredIntent ?? null,
    orderDelivery: null,
    previousPaymentPending: false,
    previousPaymentSameMerchant: false,
  } as Partial<ReturnType<typeof useJpycEip3009Payment>>);
}

/** 通常決済の hook の状態。phase = 送金の段階・hasAttempt = 前の通常決済の記録がある (経路を通常決済に固定する)。 */
function setStandard(state: { phase?: ReturnType<typeof useStandardPayment>['phase']; hasAttempt?: boolean } = {}) {
  mockHook(useStandardPayment, {
    mutate: vi.fn(),
    retryFee: vi.fn(),
    retryReceipt: vi.fn(),
    phase: state.phase ?? 'idle',
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
    hasAttempt: state.hasAttempt ?? false,
  } as Partial<ReturnType<typeof useStandardPayment>>);
}

/** USDC の会計に要るもの (Smart Account)。ウォレットは Base Sepolia にいる。 */
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
}

/** このタブでこの会計を払った記録 (lib/orderConfirmation.ts の rememberOrderPayment)。 */
function rememberPaid(params: CheckoutParams, chain: ChainSlug) {
  rememberOrderPayment(orderPaymentContextKey(params, chain), { txHash: TX_HASH, paidAt: Date.now() });
}

function setDefaults() {
  feeFlags.enableMobileOrderFee = false;
  vi.mocked(resolveJpycGaslessProvider).mockReturnValue('eip3009-relay');
  vi.mocked(jpycForwarderFor).mockReturnValue(null);
  vi.mocked(resolvePaymasterMode).mockImplementation(() => 'sponsorship');
  vi.mocked(useRouter).mockImplementation(() => ({ push: vi.fn(), replace: vi.fn() }) as unknown as ReturnType<typeof useRouter>);
  // 既定: 接続中で、ウォレットは要求のチェーン (Amoy) にいて、残高は足りる。
  setAccount({ isConnected: true, chainId: polygonAmoy.id });
  setBalance(JPYC(10_000_000_000n));
  setSwitching(false);
  setRelay();
  setStandard();
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
  for (const hook of [useGasQuoteUsdc, useGasQuoteJpyc]) {
    mockHook(hook, { data: undefined, isLoading: false, isError: false, error: null } as Partial<
      ReturnType<typeof useGasQuoteUsdc>
    >);
  }
  mockHook(useGasQuoteCircle, { data: undefined, error: null, fetchStatus: 'idle' } as Partial<
    ReturnType<typeof useGasQuoteCircle>
  >);
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
}

beforeEach(() => {
  vi.clearAllMocks();
  setDefaults();
});

// ---- 文言のカタログ ----------------------------------------------------------------------------------------------

type Catalog = 'ja' | 'en' | 'keys';
type Messages = typeof messages;
type CheckoutKey = keyof Messages['CheckoutForm'];

// CheckoutForm の文言の先頭に「⟦キー⟧」を付けたカタログ (ja が元)。ja と en で値が同じキー (checkoutTitle) を出したことと、
// 似た文言 (shipAskNote と shipAskNoteWithContact 等) のどれを出したかを見分けるため。
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

/** 文言のキーと、差し込む値 ({id}・{dest}・{addr})。 */
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

// ---- DOM を木にして比べる ----------------------------------------------------------------------------------------

/** 要素を子まで木にしたもの。属性はすべて (class・type 等)、テキストは text node 1 つを 1 つの文字列で持つ (つながない)。 */
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

/** CheckoutForm の一番外の div。 */
function formRoot(container: HTMLElement): Element {
  const root = container.firstElementChild;
  expect(root).not.toBeNull();
  return root!;
}

/** 頭の部分 (header) の要素。一番外の div の直下にちょうど 1 つ。 */
function headerEl(container: HTMLElement): HTMLElement {
  const found = formRoot(container).querySelectorAll(':scope > header');
  expect(found).toHaveLength(1);
  return found[0] as HTMLElement;
}

/**
 * 頭の部分: 一番外の div の最初のノードから header の次のノードの手前まで (= header だけのはず) を木にしたものと、header の
 * 次のノードの種類 (要素ならタグ名)。
 */
function headerArea(container: HTMLElement): { nodes: DomNode[]; next: string | null } {
  const root = formRoot(container);
  const header = headerEl(container);
  const next = header.nextSibling;
  return {
    nodes: nodes(root.firstChild, next),
    next: next === null ? null : next.nodeType === Node.ELEMENT_NODE ? (next as Element).tagName.toLowerCase() : `#node-${next.nodeType}`,
  };
}

// ---- 期待する DOM ------------------------------------------------------------------------------------------------

const HEADER_CLASS = 'rounded-2xl border border-slate-200 bg-white p-5 shadow-sm';
const OTHER_CHAIN_CLASS = 'mt-1 inline-flex min-h-11 items-center text-sm font-medium text-brand hover:text-brand-dark';

const p = (cls: string, children: DomNode[]): Dom => ({ tag: 'p', attrs: { class: cls }, children });

/** 状態ごとに期待する頭の部分。文言はキー (と差し込む値)、店名・説明・チェーン名・通貨は表示の文字列。 */
type Want = {
  /** 店名。無ければ店名と注記を出さない。 */
  storeName?: string;
  /** 見出し (受付番号か「OpenPay Checkout」)。 */
  title: Msg;
  /** 説明。無ければ出さない。 */
  description?: string;
  /** 何度でも使える注文リンクの案内。無ければ出さない。 */
  shipAsk?: Msg;
  /** 支払先の行のチェーン名。 */
  chain: string;
  /** 支払先の行の通貨。 */
  symbol: string;
  /** 支払先の行のガス代の扱い。 */
  mode: 'modeBadgeStandard' | 'modeBadgeGasless';
  /** 「別のチェーンで払う」を出す。 */
  otherChain?: boolean;
};

const TITLE = k('checkoutTitle');
const order = (id: string) => k('orderHeading', { id });

function expectedArea(c: Catalog, want: Want): { nodes: DomNode[]; next: string | null } {
  const children: DomNode[] = [p('text-xs uppercase tracking-wider text-slate-500', [tx(c, k('header'))])];
  if (want.storeName !== undefined) {
    children.push(p('mt-1 break-words text-lg font-bold text-slate-900', [want.storeName]));
    children.push(p('mt-0.5 text-xs text-slate-600 [word-break:auto-phrase]', [tx(c, k('storeNameUnverified'))]));
  }
  children.push(p('mt-1 text-base font-semibold text-slate-800', [tx(c, want.title)]));
  if (want.description !== undefined) {
    children.push(p('mt-2 whitespace-pre-wrap text-sm text-slate-600', [want.description]));
  }
  if (want.shipAsk) children.push(p('mt-2 rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900', [tx(c, want.shipAsk)]));
  // 支払先の行: テキストノード 9 つ (区切りの「 ·」と「 」は別のノード)。
  children.push(
    p('mt-3 text-xs text-slate-500', [
      tx(c, k('payToLabel', { addr: MERCHANT_SHORT })),
      ' ·',
      ' ',
      want.chain,
      ' · ',
      want.symbol,
      ' ·',
      ' ',
      tx(c, k(want.mode)),
    ]),
  );
  if (want.otherChain) {
    children.push({ tag: 'button', attrs: { type: 'button', class: OTHER_CHAIN_CLASS }, children: [tx(c, k('payOnOtherChain'))] });
  }
  return { nodes: [{ tag: 'header', attrs: { class: HEADER_CLASS }, children }], next: 'section' };
}

const JPYC_POLYGON = { chain: 'Polygon Amoy', symbol: 'JPYC' } as const;
const GASLESS = 'modeBadgeGasless' as const;
const STANDARD = 'modeBadgeStandard' as const;

// 長い店名 (上限 48 文字) と、空白のない長い説明 (上限 200 文字)。折り返しは class (break-words・whitespace-pre-wrap) に任せ、
// 文字列はそのまま出す。
const LONG_STORE_NAME = 'とても長い名前のお店'.repeat(4) + 'カフェベーカリー';
const LONG_DESCRIPTION = 'A'.repeat(120) + 'あ'.repeat(80);

type Case = {
  name: string;
  setup?: () => void;
  params: CheckoutParams;
  want: Want;
};

const CASES: Case[] = [
  {
    name: '最小 (JPYC・Polygon・relay のガスレス・店名/受付番号/説明なし・チェーン 1 つ)',
    params: jpycParams(),
    want: { title: TITLE, ...JPYC_POLYGON, mode: GASLESS },
  },
  // --- 店名・受付番号・説明 (それぞれ単独で) ---
  {
    name: '店名あり: 店名と、その下に確かめていない名前の注記',
    params: jpycParams({ storeName: 'OpenPay 工房' }),
    want: { storeName: 'OpenPay 工房', title: TITLE, ...JPYC_POLYGON, mode: GASLESS },
  },
  {
    name: '受付番号あり: 見出しが受付番号 (ship=ask でないので案内は出ない)',
    params: jpycParams({ orderId: 'ORD-42' }),
    want: { title: order('ORD-42'), ...JPYC_POLYGON, mode: GASLESS },
  },
  {
    name: '説明あり',
    params: jpycParams({ description: 'Summer sale' }),
    want: { title: TITLE, description: 'Summer sale', ...JPYC_POLYGON, mode: GASLESS },
  },
  {
    name: '説明に改行 (1 つのテキストノードのまま・改行は whitespace-pre-wrap で出す)',
    params: jpycParams({ description: '1 行目\n2 行目' }),
    want: { title: TITLE, description: '1 行目\n2 行目', ...JPYC_POLYGON, mode: GASLESS },
  },
  {
    name: '長い店名と空白のない長い説明 (折り返しは class に任せる)',
    params: jpycParams({ storeName: LONG_STORE_NAME, description: LONG_DESCRIPTION }),
    want: { storeName: LONG_STORE_NAME, title: TITLE, description: LONG_DESCRIPTION, ...JPYC_POLYGON, mode: GASLESS },
  },
  // 空文字 (URL からは来ない: lib/url の sanitizeText が空を undefined にする)。条件は値の有無 (truthy) で見るので、空の
  // 要素も空のテキストノードも出さない。
  {
    name: '(URL からは来ない) 店名が空文字: 店名と注記を出さない',
    params: jpycParams({ storeName: '' }),
    want: { title: TITLE, ...JPYC_POLYGON, mode: GASLESS },
  },
  {
    name: '(URL からは来ない) 受付番号が空文字: 見出しは「OpenPay Checkout」',
    params: jpycParams({ orderId: '' }),
    want: { title: TITLE, ...JPYC_POLYGON, mode: GASLESS },
  },
  {
    name: '(URL からは来ない) 説明が空文字: 出さない',
    params: jpycParams({ description: '' }),
    want: { title: TITLE, ...JPYC_POLYGON, mode: GASLESS },
  },
  // --- 何度でも使える注文リンク (ship=ask) の案内 ---
  {
    name: 'ship=ask・送り先なし: 案内 (送り先なし)',
    params: jpycParams({ ship: 'ask' }),
    want: { title: TITLE, shipAsk: k('shipAskNote'), ...JPYC_POLYGON, mode: GASLESS },
  },
  {
    name: 'ship=ask・送り先が LINE: 案内に「LINE @id」',
    params: jpycParams({ ship: 'ask', contact: { kind: 'line', id: '@openpay' } }),
    want: { title: TITLE, shipAsk: k('shipAskNoteWithContact', { dest: 'LINE @openpay' }), ...JPYC_POLYGON, mode: GASLESS },
  },
  {
    name: 'ship=ask・送り先がメール: 案内にメールアドレス',
    params: jpycParams({ ship: 'ask', contact: { kind: 'mail', address: 'shop@example.com' } }),
    want: { title: TITLE, shipAsk: k('shipAskNoteWithContact', { dest: 'shop@example.com' }), ...JPYC_POLYGON, mode: GASLESS },
  },
  {
    name: '送り先だけ (ship=ask なし): 案内は出ない',
    params: jpycParams({ contact: { kind: 'line', id: '@openpay' } }),
    want: { title: TITLE, ...JPYC_POLYGON, mode: GASLESS },
  },
  {
    name: 'ship=ask と受付番号: 見出しは受付番号・案内も出る',
    params: jpycParams({ ship: 'ask', orderId: 'ORD-7' }),
    want: { title: order('ORD-7'), shipAsk: k('shipAskNote'), ...JPYC_POLYGON, mode: GASLESS },
  },
  {
    name: 'ship=ask でもモバイル注文 (@handle) なら案内は出ない',
    params: jpycParams({ ship: 'ask', storeHandle: 'cafe' }),
    want: { title: TITLE, ...JPYC_POLYGON, mode: GASLESS },
  },
  {
    name: 'ship=ask でもモバイル注文 (feeKind・利用料の flag OFF) なら案内は出ない',
    params: jpycParams({ ship: 'ask', feeKind: 'preorder' }),
    want: { title: TITLE, ...JPYC_POLYGON, mode: GASLESS },
  },
  {
    name: 'ship=ask でもモバイル注文 (feeKind・利用料の flag ON) なら案内は出ない',
    setup: () => {
      feeFlags.enableMobileOrderFee = true;
    },
    params: jpycParams({ ship: 'ask', feeKind: 'storefront' }),
    want: { title: TITLE, ...JPYC_POLYGON, mode: GASLESS },
  },
  {
    name: 'ship=ask でもお店の端末で送る会計 (submit=store) なら案内は出ない',
    params: jpycParams({ ship: 'ask', submit: 'store' }),
    want: { title: TITLE, ...JPYC_POLYGON, mode: GASLESS },
  },
  {
    name: 'モバイル注文 (@handle・受付番号つき): 見出しは受付番号・案内は出ない',
    params: jpycParams({ storeHandle: 'cafe', orderId: 'M-12' }),
    want: { title: order('M-12'), ...JPYC_POLYGON, mode: GASLESS },
  },
  // --- 支払先の行 (通貨・チェーン・ガス代の扱い) ---
  {
    name: 'mode=standard: ガス代の扱いが「通常決済」',
    params: jpycParams({ mode: 'standard' }),
    want: { title: TITLE, ...JPYC_POLYGON, mode: STANDARD },
  },
  {
    name: '前の通常決済の記録 (standard.hasAttempt) で経路が通常決済: ガス代の扱いが「通常決済」',
    setup: () => setStandard({ hasAttempt: true }),
    params: jpycParams(),
    want: { title: TITLE, ...JPYC_POLYGON, mode: STANDARD },
  },
  {
    name: 'JPYC・Kaia: チェーン名が Kaia (Kairos)',
    setup: () => setAccount({ isConnected: false }),
    params: jpycParams({ chain: 'kaia' }),
    want: { title: TITLE, chain: 'Kairos Testnet', symbol: 'JPYC', mode: GASLESS },
  },
  {
    name: 'USDC・Base: チェーン名と通貨',
    setup: setUsdcReady,
    params: usdcParams(),
    want: { title: TITLE, chain: 'Base Sepolia', symbol: 'USDC', mode: GASLESS },
  },
  {
    name: 'USDC・Base・mode=standard',
    setup: setUsdcReady,
    params: usdcParams({ mode: 'standard' }),
    want: { title: TITLE, chain: 'Base Sepolia', symbol: 'USDC', mode: STANDARD },
  },
  {
    name: 'USDC・Arc・mode=standard',
    setup: () => {
      vi.mocked(resolveJpycGaslessProvider).mockReturnValue('pimlico-7702');
      setAccount({ isConnected: true, chainId: arcTestnet.id });
      setBalance(200_000_000n);
    },
    params: usdcParams({ chain: 'arc', mode: 'standard' }),
    want: { title: TITLE, chain: 'Arc Testnet', symbol: 'USDC', mode: STANDARD },
  },
  {
    name: '未接続: 頭の部分は同じ (接続の有無を見ない)',
    setup: () => {
      setAccount({ isConnected: false });
      setBalance(undefined);
    },
    params: jpycParams({ orderId: 'ORD-1' }),
    want: { title: order('ORD-1'), ...JPYC_POLYGON, mode: GASLESS },
  },
  {
    name: 'ウォレットが別のチェーン: 支払先の行は要求のチェーン (Amoy) のまま',
    setup: () => setAccount({ isConnected: true, chainId: baseSepolia.id }),
    params: jpycParams(),
    want: { title: TITLE, ...JPYC_POLYGON, mode: GASLESS },
  },
  // --- 「別のチェーンで払う」 ---
  {
    name: '受け付けるチェーンが 2 つ: 「別のチェーンで払う」を出す',
    params: jpycParams(MULTI),
    want: { title: TITLE, ...JPYC_POLYGON, mode: GASLESS, otherChain: true },
  },
  {
    name: '受け付けるチェーンが 1 つ (chains に 1 つだけ): 出さない',
    params: jpycParams({ chains: ['polygon'] }),
    want: { title: TITLE, ...JPYC_POLYGON, mode: GASLESS },
  },
  {
    name: 'チェーン 2 つ・ship=ask (遠隔の注文): 案内とボタンの両方',
    params: jpycParams({ ...MULTI, ship: 'ask' }),
    want: { title: TITLE, shipAsk: k('shipAskNote'), ...JPYC_POLYGON, mode: GASLESS, otherChain: true },
  },
  {
    name: 'チェーン 2 つ・mode=standard (通常決済の待ち受け): 出す',
    params: jpycParams({ ...MULTI, mode: 'standard' }),
    want: { title: TITLE, ...JPYC_POLYGON, mode: STANDARD, otherChain: true },
  },
  {
    name: 'チェーン 2 つ・ウォレットのチェーンの切り替えの待ち: 出さない',
    setup: () => setSwitching(true),
    params: jpycParams(MULTI),
    want: { title: TITLE, ...JPYC_POLYGON, mode: GASLESS },
  },
  {
    name: 'チェーン 2 つ・relay の送信中: 出さない',
    setup: () => setRelay({ isPending: true }),
    params: jpycParams(MULTI),
    want: { title: TITLE, ...JPYC_POLYGON, mode: GASLESS },
  },
  // 「別のチェーンで払う」を止める条件 (CheckoutForm の chainSwitchLocked) は重なって立つことが多い。relay の完了では
  // completed と settledNoRetry (relay.data.success) が同時に立つので、片方を外しても上の状態では落ちない (#1024 の Codex
  // レビュー)。下の 2 つは 1 つの条件だけが立つ状態で、settledNoRetry と restoredCheckoutCompletion をそれぞれ単独で固定する。
  {
    name: 'チェーン 2 つ・relay の結果が保留 (pending・送信は終わった・未完了): 出さない (settledNoRetry だけが立つ)',
    // relay が broadcast 済みで結果が保留: 送信中でも完了でもない (isPending false・success false) が、再送を止める
    // settledNoRetry (relay.data.pending) だけが立つ。
    setup: () => setRelay({ data: { txHash: TX_HASH, success: false, pending: true } }),
    params: jpycParams(MULTI),
    want: { title: TITLE, ...JPYC_POLYGON, mode: GASLESS },
  },
  {
    name: 'チェーン 2 つ・読み直した画面で復元した relay の支払いが revert で確定: 出さない (restoredCheckoutCompletion だけが立つ)',
    // 実際の hook (useJpycEip3009Payment) で起きる組み合わせ: 保存した intent を復元して状態を確かめ、on-chain で revert
    // (success false) と確定すると、保持していた payload を捨てる (hasActiveIntent false・recoveryState null) が restoredIntent は
    // 残り、data は復元の結果 { txHash, success: false } になる。completed・settledNoRetry・flowPending はどれも立たず、
    // restoredCheckoutCompletion (useRelay && relay.restoredIntent) だけが立つ。もう半分の通常決済の復元
    // (isStandard && standard.restoredFromStorage) は、useStandardPayment が復元のときに phase を merchant-unknown /
    // fee-unknown / fee-error にして idle に戻さないので、実際の hook では standard.phase !== 'idle' と必ず重なり単独にならない。
    setup: () =>
      setRelay({
        data: { txHash: TX_HASH, success: false },
        restoredIntent: {
          chainId: polygonAmoy.id,
          from: CUSTOMER,
          merchant: MERCHANT,
          merchantValue: JPYC(3000n).toString(),
          feeValue: '0',
          nonce: `0x${'12'.repeat(32)}`,
          validBefore: '9999999999',
          routeKind: 'free',
          issuedAt: 1_700_000_000_000,
        },
      }),
    params: jpycParams(MULTI),
    want: { title: TITLE, ...JPYC_POLYGON, mode: GASLESS },
  },
  {
    name: 'チェーン 2 つ・relay の完了: 出さない',
    setup: () => setRelay({ data: { txHash: TX_HASH, success: true } }),
    params: jpycParams(MULTI),
    want: { title: TITLE, ...JPYC_POLYGON, mode: GASLESS },
  },
  {
    name: 'チェーン 2 つ・mode=standard・通常決済の送金中 (phase): 出さない',
    setup: () => setStandard({ phase: 'merchant-sending' }),
    params: jpycParams({ ...MULTI, mode: 'standard' }),
    want: { title: TITLE, ...JPYC_POLYGON, mode: STANDARD },
  },
  {
    name: 'チェーン 2 つ・ship=ask・このタブで払った記録 (Kaia で払った): 出さない',
    setup: () => rememberPaid(jpycParams({ ...MULTI, ship: 'ask' }), 'kaia'),
    params: jpycParams({ ...MULTI, ship: 'ask' }),
    want: { title: TITLE, shipAsk: k('shipAskNote'), ...JPYC_POLYGON, mode: GASLESS },
  },
  {
    name: 'チェーン 2 つ・払った記録があっても遠隔の注文でない (ship=ask も受付番号もない): 出す',
    setup: () => rememberPaid(jpycParams(MULTI), 'polygon'),
    params: jpycParams(MULTI),
    want: { title: TITLE, ...JPYC_POLYGON, mode: GASLESS, otherChain: true },
  },
  // --- 全部 ---
  {
    name: '全部 (店名・受付番号・説明・ship=ask と LINE・チェーン 2 つ・mode=standard)',
    params: jpycParams({
      ...MULTI,
      storeName: 'OpenPay 工房',
      orderId: 'ORD-99',
      description: '店頭受け取り',
      ship: 'ask',
      contact: { kind: 'line', id: '@openpay' },
      mode: 'standard',
    }),
    want: {
      storeName: 'OpenPay 工房',
      title: order('ORD-99'),
      description: '店頭受け取り',
      shipAsk: k('shipAskNoteWithContact', { dest: 'LINE @openpay' }),
      ...JPYC_POLYGON,
      mode: STANDARD,
      otherChain: true,
    },
  },
];

const CATALOGS: ReadonlyArray<[string, Catalog]> = [
  ['ja', 'ja'],
  ['en', 'en'],
  ['文言のキー (値が同じキーを見分ける)', 'keys'],
];

describe('CheckoutForm — 会計の頭の部分 (CheckoutHeader の characterization・第 9 回レビュー F-04)', () => {
  it('状態の名前は重ならない', () => {
    expect(new Set(CASES.map((c) => c.name)).size).toBe(CASES.length);
  });

  describe.each(CATALOGS)('%s', (_label, catalog) => {
    it.each(CASES)('$name', ({ setup, params, want }) => {
      setup?.();
      const { container } = renderIn(catalog, <CheckoutForm params={params} />);
      expect(headerArea(container)).toEqual(expectedArea(catalog, want));
    });
  });

  it('「別のチェーンで払う」を押すと、URL から chain だけを外してチェーンを選ぶ画面へ戻す (router.replace・scroll しない)', () => {
    const replace = vi.fn();
    vi.mocked(useRouter).mockImplementation(() => ({ push: vi.fn(), replace }) as unknown as ReturnType<typeof useRouter>);
    window.history.replaceState({}, '', '/ja/checkout?to=0x2&token=jpyc&chains=polygon%2Ckaia&chain=polygon&order_id=A1');
    renderIn('ja', <CheckoutForm params={jpycParams(MULTI)} />);
    fireEvent.click(screen.getByRole('button', { name: '別のチェーンで払う' }));
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('?to=0x2&token=jpyc&chains=polygon%2Ckaia&order_id=A1', { scroll: false });
  });

  // 描き直し (実際に起きるもの)。header と、変わらない行の要素・テキストノードは同じ DOM を使い続け、変わるところだけが
  // 変わる (切り出し前の要素の形のまま)。どれも変更前のコードで同じことを確かめた。
  describe('描き直し', () => {
    /** 支払先の行 (header の子の p で、文言が「支払先」で始まるもの)。 */
    function payToRow(container: HTMLElement): HTMLElement {
      const rows = Array.from(headerEl(container).querySelectorAll(':scope > p')).filter((el) =>
        (el.textContent ?? '').startsWith('支払先'),
      );
      expect(rows).toHaveLength(1);
      return rows[0] as HTMLElement;
    }
    const otherChainButton = (container: HTMLElement) => headerEl(container).querySelector(':scope > button');
    /** 同じ DOM のノード (同一のもの) が同じ並びにあること。toEqual は DOM を中身で比べる (isEqualNode) ので、1 つずつ toBe で見る。 */
    function expectSameNodes(actual: ReadonlyArray<Node>, expected: ReadonlyArray<Node>) {
      expect(actual).toHaveLength(expected.length);
      actual.forEach((node, i) => expect(node).toBe(expected[i]));
    }

    it('チェーンの切り替えの待ちが始まって終わる (チェーン 2 つ): ボタンが消えて戻り、他の行は同じ DOM のまま', () => {
      const params = jpycParams({ ...MULTI, orderId: 'ORD-5' });
      const shown: Want = { title: order('ORD-5'), ...JPYC_POLYGON, mode: GASLESS, otherChain: true };
      const { container, rerender } = renderIn('ja', <CheckoutForm params={params} />);
      expect(headerArea(container)).toEqual(expectedArea('ja', shown));
      const header = headerEl(container);
      const title = header.children[1];
      const payTo = payToRow(container);
      const payToTexts = Array.from(payTo.childNodes);
      const buttonBefore = otherChainButton(container);
      expect(buttonBefore).not.toBeNull();

      setSwitching(true);
      rerender(<CheckoutForm params={params} />);
      expect(headerArea(container)).toEqual(expectedArea('ja', { ...shown, otherChain: false }));
      expect(headerEl(container)).toBe(header);
      expect(header.children[1]).toBe(title);
      expect(payToRow(container)).toBe(payTo);
      expectSameNodes(Array.from(payTo.childNodes), payToTexts);

      setSwitching(false);
      rerender(<CheckoutForm params={params} />);
      expect(headerArea(container)).toEqual(expectedArea('ja', shown));
      expect(headerEl(container)).toBe(header);
      expect(header.children[1]).toBe(title);
      expect(payToRow(container)).toBe(payTo);
      expectSameNodes(Array.from(payTo.childNodes), payToTexts);
      // 戻ったボタンは作り直した要素 (消えた間は DOM に無い)。
      const buttonAfter = otherChainButton(container);
      expect(buttonAfter).not.toBeNull();
      expect(buttonAfter).not.toBe(buttonBefore);
    });

    it('ガスレス → 通常決済 (前の通常決済の記録が付いた): ガス代の扱いのテキストノードだけが書き換わる', () => {
      const params = jpycParams({ storeName: 'OpenPay 工房', description: 'Summer sale' });
      const want: Want = { storeName: 'OpenPay 工房', title: TITLE, description: 'Summer sale', ...JPYC_POLYGON, mode: GASLESS };
      const { container, rerender } = renderIn('ja', <CheckoutForm params={params} />);
      expect(headerArea(container)).toEqual(expectedArea('ja', want));
      const header = headerEl(container);
      const children = Array.from(header.children);
      const payTo = payToRow(container);
      const payToTexts = Array.from(payTo.childNodes);
      expect(payToTexts).toHaveLength(9);

      setStandard({ hasAttempt: true });
      rerender(<CheckoutForm params={params} />);
      expect(headerArea(container)).toEqual(expectedArea('ja', { ...want, mode: STANDARD }));
      expect(headerEl(container)).toBe(header);
      expectSameNodes(Array.from(header.children), children);
      // 同じテキストノード (9 つ目) の中身が「ガス代不要」から「通常決済…」に変わる。
      expectSameNodes(Array.from(payTo.childNodes), payToTexts);
      expect(payToTexts[8].textContent).toBe(tx('ja', k(STANDARD)));
    });

    it('このタブで払った記録 (チェーン 2 つ・ship=ask) → 「新しい注文として払う」: ボタンが出る・他の行は同じ DOM のまま', () => {
      const params = jpycParams({ ...MULTI, ship: 'ask' });
      rememberPaid(params, 'polygon');
      const hidden: Want = { title: TITLE, shipAsk: k('shipAskNote'), ...JPYC_POLYGON, mode: GASLESS };
      const { container } = renderIn('ja', <CheckoutForm params={params} />);
      expect(headerArea(container)).toEqual(expectedArea('ja', hidden));
      const header = headerEl(container);
      const children = Array.from(header.children);

      fireEvent.click(screen.getByRole('button', { name: '新しい注文として払う' }));
      expect(headerArea(container)).toEqual(expectedArea('ja', { ...hidden, otherChain: true }));
      expect(headerEl(container)).toBe(header);
      // 前からあった行は同じ要素のまま、末尾にボタンが加わる。
      expectSameNodes(Array.from(header.children).slice(0, children.length), children);
      expect(header.lastElementChild).toBe(otherChainButton(container));
    });
  });
});
