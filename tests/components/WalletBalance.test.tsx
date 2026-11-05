// /checkout (CheckoutForm) のウォレットの欄にある、残高の表示と残高不足の案内 (取引所で買う導線つき) の描画を、出しうる状態
// ごとに固定する characterization test (第 9 回レビュー F-04・PR-23 の 3 本目・Q11)。
//
// CheckoutForm から表示だけの部品 (components/checkout/WalletBalance.tsx) を切り出す前に、このテストを変更前のコードで green
// にし、切り出した後も無変更で green であることを確かめた。だから部品は直接 render しない: CheckoutForm を render して、描かれた
// DOM (要素・属性 (class・role・リンクの href/target/rel)・可視テキスト (額の表記を含む)・入れ子・並び) だけを見る。部品の props の
// 形には依存しない。
//
// 見る範囲: ウォレットの欄 (section) の中で、接続のボタン (ConnectButton) と注文確認メールの案内 (params.customerEmail) に
// 挟まれた兄弟の要素すべて (tests/components/WrongChainSwitch.test.tsx と同じ範囲)。そこには切り替えのボタン・切り替え失敗の
// 知らせ・残高・残高不足が、この順で入る。前後を目印で挟むので、並びと位置も固定される。要素は子まで木のまま比べる (残高の額は
// 子の span・取引所の導線は子のリンク)。
//
// 残高を読む hook (useErc20BalanceAndChain) は本物を使い、その下の wagmi の useReadContract (残高)・useAccount (接続・チェーン)
// だけを差し替える。出す条件のうち 1 つだけを単独で効かせたいとき (本物では一緒に動く印) に限って、hook の戻り値を差し替える
// (beforeEach の mockReset で本物に戻る)。
//
// mock の作法は tests/components/WrongChainSwitch.test.tsx に合わせる (hook は mockHook で ReturnType に型づけ)。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { baseSepolia, polygonAmoy, sepolia } from 'viem/chains';
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
// 既定では本物 (残高の読み取り・残高不足 = 読めた残高 < お客様が払う額・wrongChain) を通す。
vi.mock('@/hooks/useErc20BalanceAndChain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useErc20BalanceAndChain')>();
  return { useErc20BalanceAndChain: vi.fn(actual.useErc20BalanceAndChain) };
});
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
// stub は data-testid="connect-button" の div 1 つ (見る範囲の前の目印)。
vi.mock('@/components/ConnectButton', async () => ({
  ConnectButton: (await import('../_helpers/connectButtonStub')).ConnectButtonStub,
}));
// hermetic: 手元の shell の NEXT_PUBLIC_RECOVER_FEE_BPS に左右されないよう 0 に固定する (CheckoutForm.test と同じ)。
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, recoverFeeBps: 0 } };
});

import { useAccount, useReadContract, useSwitchChain } from 'wagmi';
import { useErc20BalanceAndChain } from '@/hooks/useErc20BalanceAndChain';
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
import type { CheckoutParams } from '@/lib/url';

const CF = messages.CheckoutForm;
const MERCHANT: Address = '0x2222222222222222222222222222222222222222';
const CUSTOMER: Address = '0x9999999999999999999999999999999999999999';
const TX_HASH = `0x${'e'.repeat(64)}` as const;
const JPYC = (n: bigint) => n * 10n ** 18n;
const EMAIL = 'buyer@example.com';

// JPYC の会計 (test env の 'polygon' は Amoy に解決される)。お客様が払う額は品代と同じ 3000 JPYC (forwarder のない relay
// なので利用料の回収がなく、JPYC はガス代も取らない)。
const JPYC_PARAMS: CheckoutParams = {
  to: MERCHANT,
  token: 'jpyc',
  chain: 'polygon',
  gas: 'customer',
  items: [{ name: 'チケット', qty: 1, price: '3000' }],
  // 見る範囲の後ろの目印 (注文確認メールの案内・ウォレットの欄の最後の要素)。
  customerEmail: EMAIL,
};
// USDC の会計 (test env の 'base' は Base Sepolia に解決される)。ガス代はお客様の負担なので、お客様が払う額は品代 55 USDC に
// ガス代の見積 (0.1 USDC) を足した 55.1 USDC (残高不足の案内の額は品代でなく、この払う額)。
const USDC_PARAMS: CheckoutParams = {
  to: MERCHANT,
  token: 'usdc',
  chain: 'base',
  gas: 'customer',
  items: [
    { name: 'Tシャツ', qty: 1, price: '25.00' },
    { name: 'マグ', qty: 2, price: '15.00' },
  ],
  customerEmail: EMAIL,
};
const USDC_GAS = 100_000n;

let relayMutate: ReturnType<typeof vi.fn>;

function setAccount(state: { isConnected: boolean; chainId?: number }) {
  mockHook(useAccount, {
    address: state.isConnected ? CUSTOMER : undefined,
    isConnected: state.isConnected,
    chainId: state.chainId,
  });
}

/** 残高の読み取り (useErc20BalanceAndChain の下の useReadContract)。data=undefined は読み込み中・読めない。 */
function setBalance(state: { data: bigint | undefined; isLoading?: boolean; errorMessage?: string }) {
  mockHook(useReadContract, {
    data: state.data,
    isLoading: state.isLoading ?? false,
    isError: state.errorMessage !== undefined,
    error: state.errorMessage === undefined ? null : { message: state.errorMessage },
  } as Partial<ReturnType<typeof useReadContract>>);
}

function setSwitch(state: { error?: Error | null; variablesChainId?: number } = {}) {
  mockHook(useSwitchChain, {
    switchChain: vi.fn(),
    isPending: false,
    error: state.error ?? null,
    variables: state.variablesChainId === undefined ? undefined : { chainId: state.variablesChainId },
  } as Partial<ReturnType<typeof useSwitchChain>>);
}

function setRelay(state: { data?: ReturnType<typeof useJpycEip3009Payment>['data'] } = {}) {
  relayMutate = vi.fn();
  mockHook(useJpycEip3009Payment, {
    mutate: relayMutate,
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

/** USDC の会計に要るもの (Smart Account とガス代の見積)。ウォレットは Base Sepolia にいる。 */
function setUsdcReady() {
  // 本物と同じく USDC は relay に倒さない (resolveJpycGaslessProvider は JPYC 以外で 'pimlico-7702')。ガス代は本番の USDC と
  // 同じ ERC20 Paymaster (USDC で払う・見積は useGasQuoteUsdc)。
  vi.mocked(resolveJpycGaslessProvider).mockReturnValue('pimlico-7702');
  vi.mocked(resolvePaymasterMode).mockImplementation((dep) => (dep.symbol === 'usdc' ? 'erc20' : 'sponsorship'));
  setAccount({ isConnected: true, chainId: baseSepolia.id });
  mockHook(useSmartAccount, {
    data: { smartAccountClient: {}, pimlicoClient: {} },
    isLoading: false,
    error: null,
  } as Partial<ReturnType<typeof useSmartAccount>>);
  mockHook(useGasQuoteUsdc, {
    data: { gasAmount: USDC_GAS },
    isLoading: false,
    isError: false,
    error: null,
  } as Partial<ReturnType<typeof useGasQuoteUsdc>>);
}

function setDefaults() {
  vi.mocked(useErc20BalanceAndChain).mockReset();
  vi.mocked(resolveJpycGaslessProvider).mockReturnValue('eip3009-relay');
  vi.mocked(resolvePaymasterMode).mockImplementation(() => 'sponsorship');
  // 既定: 接続中で、ウォレットは要求のチェーン (Amoy) にいて、残高は足りる (10,000 JPYC)。
  setAccount({ isConnected: true, chainId: polygonAmoy.id });
  setBalance({ data: JPYC(10_000n) });
  setSwitch();
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

/** 要素を子まで木にしたもの。属性はすべて (class・role・href 等)、テキストは隣り合う text node をつないだ文字列で持つ。 */
type Dom = { tag: string; attrs: Record<string, string>; children: Array<string | Dom> };

function dom(el: Element): Dom {
  const attrs: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) attrs[a.name] = a.value;
  const children: Array<string | Dom> = [];
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? '';
      const last = children[children.length - 1];
      if (typeof last === 'string') children[children.length - 1] = last + text;
      else children.push(text);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      children.push(dom(node as Element));
    }
  }
  return { tag: el.tagName.toLowerCase(), attrs, children };
}

const msgs = (locale: 'ja' | 'en') => (locale === 'ja' ? messages : enMessages).CheckoutForm;
const emailHint = (locale: 'ja' | 'en') => msgs(locale).emailHint.replace('{email}', EMAIL);

/** ウォレットの欄で、接続のボタンと注文確認メールの案内のあいだの兄弟の要素を、並びどおりに (子まで) 返す。 */
function walletArea(locale: 'ja' | 'en' = 'ja'): Dom[] {
  const before = screen.getByTestId('connect-button');
  const after = screen.getByText(emailHint(locale));
  expect(before.parentElement).toBe(after.parentElement);
  expect(before.parentElement?.tagName.toLowerCase()).toBe('section');
  const out: Dom[] = [];
  for (let el = before.nextElementSibling; el && el !== after; el = el.nextElementSibling) out.push(dom(el));
  return out;
}

/** 残高の行 (「現在残高: 」+ 等幅の額)。 */
const balanceLine = (amount: string, locale: 'ja' | 'en' = 'ja'): Dom => ({
  tag: 'p',
  attrs: { class: 'text-xs text-slate-500' },
  children: [`${msgs(locale).balanceLabel} `, { tag: 'span', attrs: { class: 'font-mono' }, children: [amount] }],
});

type Onramp = { url: string; label: string; token: string; jaResidentsOnly?: boolean; blocksJapaneseResidents?: boolean };
const ONRAMP = {
  jpycJa: { url: 'https://jpyc.co.jp/', label: 'JPYC EX', token: 'JPYC' },
  jpycEn: { url: 'https://jpyc.co.jp/', label: 'JPYC EX', token: 'JPYC', jaResidentsOnly: true },
  usdcJa: { url: 'https://www.sbivc.co.jp/', label: 'SBI VC トレード', token: 'USDC' },
  usdcEn: { url: 'https://www.coinbase.com/', label: 'Coinbase', token: 'USDC', blocksJapaneseResidents: true },
} satisfies Record<string, Onramp>;

/** 残高不足の案内 (赤い枠: 必要な額の文 + 取引所で買うリンク (OnrampCta))。 */
const shortfallBox = (amount: string, onramp: Onramp, locale: 'ja' | 'en' = 'ja'): Dom => {
  const m = msgs(locale);
  const cta: Dom = {
    tag: 'span',
    attrs: { class: 'mt-1 block' },
    children: [
      {
        tag: 'a',
        attrs: {
          href: onramp.url,
          target: '_blank',
          rel: 'noopener noreferrer',
          class: 'font-medium text-red-700 underline hover:text-red-800',
        },
        children: [m.onrampCta.replace('{label}', onramp.label).replace('{token}', onramp.token)],
      },
      ...(onramp.jaResidentsOnly
        ? [{ tag: 'span', attrs: { class: 'ml-1 text-red-600' }, children: [m.onrampJaResidentsOnlyNote] }]
        : []),
      ...(onramp.blocksJapaneseResidents
        ? [{ tag: 'span', attrs: { class: 'mt-0.5 block text-red-600' }, children: [m.onrampJapaneseUserHint] }]
        : []),
    ],
  };
  return {
    tag: 'div',
    attrs: { class: 'rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700' },
    children: [{ tag: 'p', attrs: {}, children: [m.insufficientBalance.replace('{amount}', amount)] }, cta],
  };
};

/** 違うチェーンのときの切り替えのボタン (WrongChainSwitch・並びの目印として見る)。 */
const switchButton = (chainName: string): Dom => ({
  tag: 'button',
  attrs: {
    type: 'button',
    class:
      'w-full rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600 disabled:opacity-50',
  },
  children: [CF.switchChain.replace('{chainName}', chainName)],
});
const failedAlert = (chainName: string): Dom => ({
  tag: 'p',
  attrs: { role: 'alert', class: 'text-xs leading-relaxed text-red-700' },
  children: [CF.switchChainFailed.replaceAll('{chainName}', chainName)],
});

describe('CheckoutForm — 残高の表示と残高不足の案内 (WalletBalance の characterization・第 9 回レビュー F-04)', () => {
  describe('接続中で、ウォレットが要求のチェーンにいる (JPYC)', () => {
    it('残高が足りる: 残高の行だけ (額は 18 桁を整えた JPYC の表記)', () => {
      render(<CheckoutForm params={JPYC_PARAMS} />);
      expect(walletArea()).toEqual([balanceLine('10000 JPYC')]);
    });

    it('残高が足りない: 残高の行の下に、払う額 (3000 JPYC) と JPYC EX で買うリンクの赤い枠', () => {
      setBalance({ data: JPYC(1_000n) });
      render(<CheckoutForm params={JPYC_PARAMS} />);
      expect(walletArea()).toEqual([balanceLine('1000 JPYC'), shortfallBox('3000 JPYC', ONRAMP.jpycJa)]);
    });

    it('残高が 0: 残高の行は「0 JPYC」で出し (0 でも隠さない)、残高不足の枠も出す', () => {
      setBalance({ data: 0n });
      render(<CheckoutForm params={JPYC_PARAMS} />);
      expect(walletArea()).toEqual([balanceLine('0 JPYC'), shortfallBox('3000 JPYC', ONRAMP.jpycJa)]);
    });

    it('残高がちょうど払う額: 足りるので残高の行だけ', () => {
      setBalance({ data: JPYC(3_000n) });
      render(<CheckoutForm params={JPYC_PARAMS} />);
      expect(walletArea()).toEqual([balanceLine('3000 JPYC')]);
    });

    it('払う額に 1 wei 足りない: 残高の行は端数まで出し、残高不足の枠も出す', () => {
      setBalance({ data: JPYC(3_000n) - 1n });
      render(<CheckoutForm params={JPYC_PARAMS} />);
      expect(walletArea()).toEqual([
        balanceLine('2999.999999999999999999 JPYC'),
        shortfallBox('3000 JPYC', ONRAMP.jpycJa),
      ]);
    });
  });

  describe('トークンの違い (USDC) と英語', () => {
    it('USDC で足りない: 額は 6 桁の USDC の表記・必要な額はガス代込みの払う額 (55.1 USDC)・SBI VC トレードで買うリンク', () => {
      setUsdcReady();
      setBalance({ data: 1_500_000n });
      render(<CheckoutForm params={USDC_PARAMS} />);
      expect(walletArea()).toEqual([balanceLine('1.5 USDC'), shortfallBox('55.1 USDC', ONRAMP.usdcJa)]);
    });

    it('USDC で足りる: 残高の行だけ', () => {
      setUsdcReady();
      setBalance({ data: 200_000_000n });
      render(<CheckoutForm params={USDC_PARAMS} />);
      expect(walletArea()).toEqual([balanceLine('200 USDC')]);
    });

    it('英語・JPYC で足りない: 「Balance: 」と英語の文・JPYC EX のリンクに「(Japan residents only)」', () => {
      setBalance({ data: JPYC(1_000n) });
      render(<CheckoutForm params={JPYC_PARAMS} />, { locale: 'en' });
      expect(walletArea('en')).toEqual([
        balanceLine('1000 JPYC', 'en'),
        shortfallBox('3000 JPYC', ONRAMP.jpycEn, 'en'),
      ]);
    });

    it('英語・USDC で足りない: Coinbase のリンクと、日本居住者への案内', () => {
      setUsdcReady();
      setBalance({ data: 1_500_000n });
      render(<CheckoutForm params={USDC_PARAMS} />, { locale: 'en' });
      expect(walletArea('en')).toEqual([
        balanceLine('1.5 USDC', 'en'),
        shortfallBox('55.1 USDC', ONRAMP.usdcEn, 'en'),
      ]);
    });
  });

  describe('残高を読めていない', () => {
    it('読み込み中 (data=undefined・isLoading): 残高の行も残高不足の枠も出さない', () => {
      setBalance({ data: undefined, isLoading: true });
      render(<CheckoutForm params={JPYC_PARAMS} />);
      expect(walletArea()).toEqual([]);
    });

    it('読めない (data=undefined・error): 残高の行も残高不足の枠も出さない', () => {
      setBalance({ data: undefined, errorMessage: 'RPC error' });
      render(<CheckoutForm params={JPYC_PARAMS} />);
      expect(walletArea()).toEqual([]);
    });
  });

  // 出す条件を 1 つずつ: ほかの条件はすべて「出す」側にそろえ、その 1 つだけで止める。残高の行の条件 (接続中・正しいチェーン・
  // 残高を読めた) と残高不足の枠の条件 (insufficientBalance) は別々なので、片方だけが止まることも固定する。
  describe('出さない条件 (それぞれ単独で効く)', () => {
    it('違うチェーン: 残高の行は出さない (切り替えのボタンを出す)・足りる残高なら残高不足の枠もない', () => {
      setAccount({ isConnected: true, chainId: sepolia.id });
      render(<CheckoutForm params={JPYC_PARAMS} />);
      expect(walletArea()).toEqual([switchButton(polygonAmoy.name)]);
    });

    it('違うチェーンでも、残高不足の枠は出す (残高不足の枠はチェーンを見ない・切り替えの知らせの後ろ)', () => {
      setAccount({ isConnected: true, chainId: sepolia.id });
      setSwitch({ error: new Error('Unrecognized chain ID "0x13882".'), variablesChainId: polygonAmoy.id });
      setBalance({ data: JPYC(1_000n) });
      render(<CheckoutForm params={JPYC_PARAMS} />);
      expect(walletArea()).toEqual([
        switchButton(polygonAmoy.name),
        failedAlert(polygonAmoy.name),
        shortfallBox('3000 JPYC', ONRAMP.jpycJa),
      ]);
    });

    it('未接続 (isConnected=false) の印だけで残高の行が止まる: 残高を読めていて正しいチェーンでも出さない', () => {
      // 実際の hook は未接続なら残高を読まない (data=undefined) ので、ここでは CheckoutForm の isConnected の印だけを単独で
      // 効かせるため、useErc20BalanceAndChain の戻り値を差し替える (残高あり・不足なし・wrongChain=false)。
      vi.mocked(useErc20BalanceAndChain).mockReturnValue({ balance: JPYC(10_000n), insufficientBalance: false, wrongChain: false });
      setAccount({ isConnected: false });
      render(<CheckoutForm params={JPYC_PARAMS} />);
      expect(walletArea()).toEqual([]);
    });

    it('残高不足の枠は insufficientBalance だけで決まる: 未接続の印でも残高を読めていない印でも止まらない', () => {
      // 本物では一緒に動く印を離す: 未接続で残高は undefined だが insufficientBalance=true。残高の行は止まり、枠だけが出る。
      vi.mocked(useErc20BalanceAndChain).mockReturnValue({ balance: undefined, insufficientBalance: true, wrongChain: false });
      setAccount({ isConnected: false });
      render(<CheckoutForm params={JPYC_PARAMS} />);
      expect(walletArea()).toEqual([shortfallBox('3000 JPYC', ONRAMP.jpycJa)]);
    });

    it('残高を読めていない印 (balance=undefined) だけで残高の行が止まる: 接続中・正しいチェーンでも', () => {
      vi.mocked(useErc20BalanceAndChain).mockReturnValue({ balance: undefined, insufficientBalance: false, wrongChain: false });
      render(<CheckoutForm params={JPYC_PARAMS} />);
      expect(walletArea()).toEqual([]);
    });

    it('未接続 (実際の状態・残高は読まない): 何も出さない', () => {
      setAccount({ isConnected: false });
      setBalance({ data: undefined });
      render(<CheckoutForm params={JPYC_PARAMS} />);
      expect(walletArea()).toEqual([]);
    });

    it('支払いが完了したら (relay.data.success) ウォレットの欄ごと出さない: 残高が足りなくても', () => {
      setRelay({ data: { txHash: TX_HASH, success: true } });
      setBalance({ data: JPYC(1_000n) });
      render(<CheckoutForm params={JPYC_PARAMS} />);
      expect(screen.queryByTestId('connect-button')).toBeNull();
      expect(screen.queryByText(CF.balanceLabel, { exact: false })).toBeNull();
      expect(screen.queryByText(CF.insufficientBalance.replace('{amount}', '3000 JPYC'))).toBeNull();
      expect(
        screen.queryByRole('link', {
          name: CF.onrampCta.replace('{label}', ONRAMP.jpycJa.label).replace('{token}', ONRAMP.jpycJa.token),
        }),
      ).toBeNull();
    });
  });
});
