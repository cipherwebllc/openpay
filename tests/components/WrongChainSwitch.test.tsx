// /checkout (CheckoutForm) のウォレットの欄にある、チェーンの切り替えのボタンと切り替え失敗の知らせの描画を、出しうる状態ごとに
// 固定する characterization test (第 9 回レビュー F-04・PR-23 の 2 本目・Q11)。
//
// CheckoutForm から表示だけの部品 (components/checkout/WrongChainSwitch.tsx) を切り出す前に、このテストを変更前のコードで
// green にし、切り出した後も無変更で green であることを確かめた。だから部品は直接 render しない: CheckoutForm を render して、
// 描かれた DOM (要素・可視テキスト・role・ボタンの disabled・class・並び) と、ボタンで呼ばれるものだけを見る。部品の props の形には
// 依存しない。
//
// 見る範囲: ウォレットの欄 (section) の中で、接続のボタン (ConnectButton) と注文確認メールの案内 (params.customerEmail) に
// 挟まれた兄弟の要素すべて。そこには切り替えのボタン・切り替え失敗の知らせ・残高・残高不足が、この順で入る。前後を目印で
// 挟むので、並びと位置も固定される。
//
// 切り替えの hook (useSwitchChainWithFeedback) は本物を使い、その下の wagmi の useSwitchChain だけを差し替える。待ち (isPending)・
// 失敗 (error)・失敗した切り替えの目的のチェーン (variables.chainId) を、それぞれ 1 つずつ変えて見る。
//
// mock の作法は tests/components/RelayStatusBanners.test.tsx に合わせる (hook は mockHook で ReturnType に型づけ)。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { kairos, polygonAmoy, sepolia } from 'viem/chains';
import type { Address } from 'viem';
import messages from '@/messages/ja.json';
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
// 既定では本物 (wrongChain = 接続中で、ウォレットのチェーンが要求と違う) を通す。未接続のガードを単独で確かめる 1 件だけ
// 戻り値を差し替える (beforeEach の mockReset で本物に戻る)。
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
import { CheckoutForm } from '@/components/CheckoutForm';
import type { CheckoutParams } from '@/lib/url';

const CF = messages.CheckoutForm;
const MERCHANT: Address = '0x2222222222222222222222222222222222222222';
const CUSTOMER: Address = '0x9999999999999999999999999999999999999999';
const TX_HASH = `0x${'e'.repeat(64)}` as const;
const BALANCE = 10_000n * 10n ** 18n;
// test env の 'polygon' は Amoy に解決される (要求のチェーン)。ウォレットは Sepolia にいる (違うチェーン)。
const REQUIRED = polygonAmoy;
const WALLET_CHAIN_ID = sepolia.id;
const EMAIL = 'buyer@example.com';

const PARAMS: CheckoutParams = {
  to: MERCHANT,
  token: 'jpyc',
  chain: 'polygon',
  gas: 'customer',
  items: [{ name: 'チケット', qty: 1, price: '3000' }],
  // 見る範囲の後ろの目印 (注文確認メールの案内・ウォレットの欄の最後の要素)。
  customerEmail: EMAIL,
};

// 切り替えが失敗したときの error (取り消しでない・wagmi は失敗を switchChain の throw でなく error に出す)。
const SWITCH_ERROR = new Error('Unrecognized chain ID "0x13882".');
// ウォレットでの取り消し (useSwitchChainWithFeedback は失敗に数えない)。
const SWITCH_REJECTED = new Error('User rejected the request.');

let switchChainFn: ReturnType<typeof vi.fn>;
let relayMutate: ReturnType<typeof vi.fn>;

type SwitchState = {
  isPending?: boolean;
  error?: Error | null;
  /** 最後に呼んだ切り替えの目的のチェーン (失敗した切り替えの目的のチェーン = failedChainId になる)。 */
  variablesChainId?: number;
};

function setSwitch(state: SwitchState = {}) {
  switchChainFn = vi.fn();
  mockHook(useSwitchChain, {
    switchChain: switchChainFn,
    isPending: state.isPending ?? false,
    error: state.error ?? null,
    variables: state.variablesChainId === undefined ? undefined : { chainId: state.variablesChainId },
  } as Partial<ReturnType<typeof useSwitchChain>>);
}

function setAccount(state: { isConnected: boolean; chainId?: number }) {
  mockHook(useAccount, {
    address: state.isConnected ? CUSTOMER : undefined,
    isConnected: state.isConnected,
    chainId: state.chainId,
  });
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

function setDefaults() {
  vi.mocked(useErc20BalanceAndChain).mockReset();
  setSwitch();
  setAccount({ isConnected: true, chainId: WALLET_CHAIN_ID });
  setRelay();
  mockHook(useReadContract, { data: BALANCE, isLoading: false, error: null });
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

type ElementDom = {
  tag: string;
  role: string | null;
  type: string | null;
  text: string;
  className: string | null;
  /** button だけ (それ以外は null)。 */
  disabled: boolean | null;
};

function elementDom(el: HTMLElement): ElementDom {
  return {
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role'),
    type: el.getAttribute('type'),
    text: el.textContent ?? '',
    className: el.getAttribute('class'),
    disabled: el instanceof HTMLButtonElement ? el.disabled : null,
  };
}

/** ウォレットの欄で、接続のボタンと注文確認メールの案内のあいだの兄弟の要素を、並びどおりに返す。 */
function walletArea(): ElementDom[] {
  const before = screen.getByTestId('connect-button');
  const after = screen.getByText(CF.emailHint.replace('{email}', EMAIL));
  expect(before.parentElement).toBe(after.parentElement);
  expect(before.parentElement?.tagName.toLowerCase()).toBe('section');
  const out: ElementDom[] = [];
  for (let el = before.nextElementSibling; el && el !== after; el = el.nextElementSibling) {
    out.push(elementDom(el as HTMLElement));
  }
  return out;
}

const switchLabel = (chainName: string) => CF.switchChain.replace('{chainName}', chainName);
const failedText = (chainName: string) => CF.switchChainFailed.replaceAll('{chainName}', chainName);

const switchButton = (opts: { chainName: string; switching?: boolean }): ElementDom => ({
  tag: 'button',
  role: null,
  type: 'button',
  text: opts.switching ? CF.switchingChain : switchLabel(opts.chainName),
  className:
    'w-full rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600 disabled:opacity-50',
  disabled: opts.switching ?? false,
});

const failedAlert = (chainName: string): ElementDom => ({
  tag: 'p',
  role: 'alert',
  type: null,
  text: failedText(chainName),
  className: 'text-xs leading-relaxed text-red-700',
  disabled: null,
});

// 残高の行 (正しいチェーンのときだけ出る)。額の書式はこの欄の切り出しと関係ないので、頭の文言だけ見る。
const balanceLine = (): ElementDom => ({
  tag: 'p',
  role: null,
  type: null,
  text: expect.stringMatching(new RegExp(`^${CF.balanceLabel}\\s`)) as unknown as string,
  className: 'text-xs text-slate-500',
  disabled: null,
});

describe('CheckoutForm — チェーンの切り替えのボタンと切り替え失敗の知らせ (WrongChainSwitch の characterization・第 9 回レビュー F-04)', () => {
  describe('ウォレットが違うチェーンにいる (接続中)', () => {
    it('待ち: 「Polygon Amoy へ切り替え」のボタンだけ (押せる・知らせはない)', () => {
      render(<CheckoutForm params={PARAMS} />);
      expect(walletArea()).toEqual([switchButton({ chainName: REQUIRED.name })]);
    });

    it('ボタンを押すと、要求のチェーンへの切り替え (switchChain({ chainId })) を 1 回だけ呼ぶ', async () => {
      const user = userEvent.setup();
      render(<CheckoutForm params={PARAMS} />);
      // 開いたときの自動の切り替え (useAutoSwitchChain) の分を除いて、押した分だけを見る。
      switchChainFn.mockClear();
      await user.click(screen.getByRole('button', { name: switchLabel(REQUIRED.name) }));
      expect(switchChainFn).toHaveBeenCalledOnce();
      expect(switchChainFn).toHaveBeenCalledWith({ chainId: REQUIRED.id });
      // 支払いは始めない。
      expect(relayMutate).not.toHaveBeenCalled();
    });

    it('切り替え中 (isPending): ボタンは「チェーン切替中…」で押せない (押しても呼ばない)', async () => {
      const user = userEvent.setup();
      setSwitch({ isPending: true, variablesChainId: REQUIRED.id });
      render(<CheckoutForm params={PARAMS} />);
      expect(walletArea()).toEqual([switchButton({ chainName: REQUIRED.name, switching: true })]);
      await user.click(screen.getByRole('button', { name: CF.switchingChain }));
      expect(switchChainFn).not.toHaveBeenCalled();
    });

    it('切り替えが失敗した: ボタン (押せる) の下に role="alert" の知らせ', () => {
      setSwitch({ error: SWITCH_ERROR, variablesChainId: REQUIRED.id });
      render(<CheckoutForm params={PARAMS} />);
      expect(walletArea()).toEqual([switchButton({ chainName: REQUIRED.name }), failedAlert(REQUIRED.name)]);
    });

    it('失敗のあとに押し直せる: もう一度 switchChain({ chainId }) を呼ぶ', async () => {
      const user = userEvent.setup();
      setSwitch({ error: SWITCH_ERROR, variablesChainId: REQUIRED.id });
      render(<CheckoutForm params={PARAMS} />);
      switchChainFn.mockClear();
      await user.click(screen.getByRole('button', { name: switchLabel(REQUIRED.name) }));
      expect(switchChainFn).toHaveBeenCalledOnce();
      expect(switchChainFn).toHaveBeenCalledWith({ chainId: REQUIRED.id });
    });

    it('ウォレットでの取り消し (user rejected) は失敗にしない: ボタンだけ', () => {
      setSwitch({ error: SWITCH_REJECTED, variablesChainId: REQUIRED.id });
      render(<CheckoutForm params={PARAMS} />);
      expect(walletArea()).toEqual([switchButton({ chainName: REQUIRED.name })]);
    });

    it('失敗した切り替えの目的のチェーンが今の要求と違っても知らせは出す (CheckoutForm は failed だけを見る・文言は要求のチェーン)', () => {
      // failedChainId (#1007) は使っていない: 要求のチェーンが変わると page が CheckoutForm を key で作り直すので、
      // 別のチェーンへの前の失敗は残らない。ここでは今の描画 (failed だけで出す) を固定する。
      setSwitch({ error: SWITCH_ERROR, variablesChainId: kairos.id });
      render(<CheckoutForm params={PARAMS} />);
      expect(walletArea()).toEqual([switchButton({ chainName: REQUIRED.name }), failedAlert(REQUIRED.name)]);
    });

    it('チェーンの名前と切り替え先は要求のチェーンから取る (Kaia の会計なら Kairos Testnet)', async () => {
      const user = userEvent.setup();
      setSwitch({ error: SWITCH_ERROR, variablesChainId: kairos.id });
      render(<CheckoutForm params={{ ...PARAMS, chain: 'kaia' }} />);
      expect(walletArea()).toEqual([switchButton({ chainName: kairos.name }), failedAlert(kairos.name)]);
      switchChainFn.mockClear();
      await user.click(screen.getByRole('button', { name: switchLabel(kairos.name) }));
      expect(switchChainFn).toHaveBeenCalledOnce();
      expect(switchChainFn).toHaveBeenCalledWith({ chainId: kairos.id });
    });
  });

  // 出さない条件を 1 つずつ: ほかの条件はすべて「出す」側にそろえ (接続中・違うチェーン・切り替えが失敗)、その 1 つだけで止める。
  describe('出さない条件 (それぞれ単独で効く)', () => {
    it('正しいチェーン: 切り替えが失敗した後でも (ウォレットのアプリで選んだ) ボタンも知らせも出さず、残高を出す', () => {
      setAccount({ isConnected: true, chainId: REQUIRED.id });
      setSwitch({ error: SWITCH_ERROR, variablesChainId: REQUIRED.id });
      render(<CheckoutForm params={PARAMS} />);
      expect(walletArea()).toEqual([balanceLine()]);
      expect(screen.queryByText(failedText(REQUIRED.name))).toBeNull();
    });

    it('未接続 (isConnected=false) の印だけで止まる: wrongChain が立っていてもボタンも知らせも出さない', () => {
      // 実際の wrongChain は「接続中で」チェーンが違う、なので未接続なら wrongChain も false になる。ここでは CheckoutForm の
      // isConnected の印だけを単独で効かせるため、useErc20BalanceAndChain の戻り値を wrongChain=true に差し替える。
      vi.mocked(useErc20BalanceAndChain).mockReturnValue({ balance: BALANCE, insufficientBalance: false, wrongChain: true });
      setAccount({ isConnected: false });
      setSwitch({ error: SWITCH_ERROR, variablesChainId: REQUIRED.id });
      render(<CheckoutForm params={PARAMS} />);
      expect(walletArea()).toEqual([]);
    });

    it('未接続 (実際の状態): 何も出さない', () => {
      setAccount({ isConnected: false });
      setSwitch({ error: SWITCH_ERROR, variablesChainId: REQUIRED.id });
      render(<CheckoutForm params={PARAMS} />);
      expect(walletArea()).toEqual([]);
    });

    it('切り替えの失敗がない (error=null): 知らせは出さない (ボタンだけ)', () => {
      // 「待ち」と同じ状態。知らせの印 (switchFailed) だけが止める。
      setSwitch({ error: null, variablesChainId: REQUIRED.id });
      render(<CheckoutForm params={PARAMS} />);
      expect(walletArea()).toEqual([switchButton({ chainName: REQUIRED.name })]);
    });

    it('支払いが完了したら (relay.data.success) ウォレットの欄ごと出さない: 違うチェーンで切り替えが失敗していても', () => {
      setRelay({ data: { txHash: TX_HASH, success: true } });
      setSwitch({ error: SWITCH_ERROR, variablesChainId: REQUIRED.id });
      render(<CheckoutForm params={PARAMS} />);
      expect(screen.queryByTestId('connect-button')).toBeNull();
      expect(screen.queryByRole('button', { name: switchLabel(REQUIRED.name) })).toBeNull();
      expect(screen.queryByRole('button', { name: CF.switchingChain })).toBeNull();
      expect(screen.queryByText(failedText(REQUIRED.name))).toBeNull();
    });
  });
});
