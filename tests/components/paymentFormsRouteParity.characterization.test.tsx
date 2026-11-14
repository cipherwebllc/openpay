// 第 10 回レビュー PR-15 (F-03 の前段): 3 つの支払いフォーム (PaymentForm・CheckoutForm・TipForm) の「経路を決めて、そこから
// 派生する値を作る」所の、いまの動きを固定する。
//
// この後の PR-16〜18 (経路の決め方を hooks/usePaymentRoute.ts へ出す) は、この file を 1 字も変えずに緑のまま通す。そのため、
// 見るのは描かれた DOM (明細の行・ボタン) と外への呼び出し (mock した hook と resolver に渡った引数・mutate に渡った値) だけで、
// 部品の中の変数名・式の形・hook や resolver を呼んだ回数と順番には触れない (見るのは「渡った引数の組の集合」。hook は引数の
// 全部を比べ、省いた引数は既定値として読む)。
//
// 3 つのフォームの、意図して違う 5 点 (どれも今の動き。表の期待の列をフォームごとに持つ理由):
//
//   |                                    | Pay (/pay)                        | Checkout (/checkout)                 | Tip (/tip・@handle)   |
//   |------------------------------------|-----------------------------------|--------------------------------------|-----------------------|
//   | (a) JPYC の resolver と forwarder  | ウォレットの chain                | ウォレットの chain                   | deployment の chain   |
//   |     に聞く chain (経路の判定)      | (未接続なら deployment の chain)  | (未接続なら deployment の chain)     |                       |
//   |     USDC の resolver に聞く chain  | deployment の chain               | deployment の chain                  | deployment の chain   |
//   | (b) 通常決済になる条件             | URL の mode・「通常決済に切替」   | 同じ                                 | params の mode だけ   |
//   |                                    | ・復元した通常決済の試み          |                                      | (Arc だけが standard) |
//   | (c) relay を止める条件             | 分配 (split) つきの QR            | なし                                 | なし                  |
//   | (d) 経路の固定                     | 送った後、試みの間は固定          | 同じ + 復元した relay の注文で上書き | 毎回決め直す          |
//   | (e) ガス代の負担                   | URL の gas (recover はお店で固定) | 同じ + モバイル注文の負担者で上書き  | お客様の負担で固定    |
//
//   resolver = resolveJpycGaslessProvider (JPYC を relay で送るか)・jpycForwarderFor (recover か free か)・
//   resolveUsdcGaslessProvider (USDC を Circle で送るか)。
//
// 表は 3 つ。1 行 = 同じ入力と、フォームごとの期待の列 (列が無いフォームは、その入力を受け付けない)。1 つの列 = 1 つの test =
// 1 回の描画。locale は ja だけ (en の内訳は、兄弟の *.test.tsx の「内訳行 fixture」の snapshot が固定している)。
//   表 1 経路の表     準備ができた状態で、経路 × token × paymaster の組ごとに、hook の引数・resolver の引数・明細の行・ボタン・
//                     押した後に mutate へ渡る値。
//   表 2 ボタンの表   経路の類 × ウォレットの状態ごとに、ボタンの文言と押せるか。
//   表 3 経路が変わる・変わらない場面  ウォレットが別の chain・復元した通常決済の試み・「通常決済に切替」・描いた後に入力が
//                     変わる (params の chain・ウォレットの chain・復元した試み)・送った後の固定・復元した relay の注文。
//
// 期待の書き方: 画面の文は i18n の key で書き (文言を直す PR で動かないように)、テストの中で messages/ja.json から引いて比べる。
// 額は字で書く。
//   注意: ja の文が同じ key の組 (PaymentForm の gasRowFree と gasRowStandard・CheckoutForm の totalRow と totalRowMerchantGas) は、
//   ラベルの文では区別できない (値の列・hook の引数・mutate の値で区別している)。
//
// mock は、兄弟の 3 つのフォームのテストと同じ線: wagmi・ConnectButton と CrossChainHint (stub)・支払いの hook・resolver・
// next/navigation・logger・env の getter。切り出す先 (usePaymentRoute) も、純関数 (lib/paymentRoute・lib/paymentMoney・
// lib/paymentFlowGuards/*・lib/fee・lib/mobileOrderFee・lib/relay/recoverFee) も mock しない。useGasQuote も本物が内側の 2 つを呼ぶ。
//   - resolver の mock は chain を見る: 行が「どの chain で relay / forwarder あり / Circle と答えるか」を指定する。兄弟の 3 file は
//     引数を見ない mock (vi.fn(() => 'pimlico-7702')) なので、上の (a) はここで初めて固定される。token も本物と同じく見る
//     (JPYC でなければ relay と答えない・USDC でなければ Circle と答えない)。
//   - 支払いの hook の mock は enabled を見る: enabled=false なら data を返さない (本物と同じ向き)。
//   - 経路が変わる場面は、resolver の答えの表を変えずに、実際の入力 (URL / params・ウォレットの chain・hook が返す状態) を変えて
//     描き直す。入力が同じなら答えも同じなので、経路の計算を (入力を全部依存に入れて) memo しても、この file は通る。
//   - env は、手元の設定に左右されないよう enableTipMessage=false に固定し、enableMobileOrderFee (本番と同じ ON が既定)・
//     enableUsdcArc (既定 OFF)・recoverFeeBps (既定 0) を getter にする。recover の利用料の下限 (relayGasFeeValue) も env で
//     決まる値なので mock し、行が chain ごとの値を与える (既定は 2 JPYC)。enableUsdcArc を ON にするのは Pay の Arc の行だけで、URL の chain=arc を
//     通すため (lib/chains の isValidChainSlug が呼ばれたときに読む)。module の読み込みで決まる定数 (USDC_CHAINS など) は動かない。
//
// 表に入れていないもの (ここでは固定しない): 止める理由の文 (error の箱・fallback の案内)・受注通知 (PR-12 の
// CheckoutForm.orderNotify.characterization.test.tsx)・cross-chain と Arc の復旧・履歴の保存・tooltip の本文と表の下の説明
// (兄弟の「内訳行 fixture」の snapshot)・preview の Tip。Checkout は額が 0 の会計を URL の parser が通さないので、表 2 の
// 「額が 0」の列は無い。
import type { ReactElement } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { arbitrumSepolia, baseSepolia, kairos, polygonAmoy } from 'viem/chains';
import { parseUnits, type Address } from 'viem';
import ja from '../../messages/ja.json';
import { renderWithIntl as render } from '../_helpers/i18n';
import { bindingFixture } from '../_helpers/orderBinding';
import { mockHook } from '../_helpers/wagmiMock';

vi.mock('next/navigation', () => ({
  useSearchParams: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn() })),
}));
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
vi.mock('@/hooks/useJpycEip3009Payment', () => ({ useJpycEip3009Payment: vi.fn() }));
vi.mock('@/hooks/useGasQuoteUsdc', () => ({ useGasQuoteUsdc: vi.fn() }));
vi.mock('@/hooks/useGasQuoteJpyc', () => ({ useGasQuoteJpyc: vi.fn() }));
vi.mock('@/hooks/useGasQuoteCircle', () => ({ useGasQuoteCircle: vi.fn() }));
vi.mock('@/hooks/useRelayHealth', () => ({ useRelayHealth: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/circlePaymaster', async () => {
  const actual = await vi.importActual<typeof import('@/lib/circlePaymaster')>('@/lib/circlePaymaster');
  return { ...actual, resolveUsdcGaslessProvider: vi.fn() };
});
vi.mock('@/lib/jpycGaslessProvider', async () => {
  const actual = await vi.importActual<typeof import('@/lib/jpycGaslessProvider')>('@/lib/jpycGaslessProvider');
  return { ...actual, resolveJpycGaslessProvider: vi.fn() };
});
vi.mock('@/lib/relay/forwarderConfig', async () => {
  const actual = await vi.importActual<typeof import('@/lib/relay/forwarderConfig')>('@/lib/relay/forwarderConfig');
  // relayGasFeeValue = recover の利用料の下限。env で決まる値なので、行が chain ごとの値を与える (既定は 2 JPYC)。
  return { ...actual, jpycForwarderFor: vi.fn(() => null), relayGasFeeValue: vi.fn(() => 2n * 10n ** 18n) };
});
vi.mock('@/lib/pimlico', async () => {
  const actual = await vi.importActual<typeof import('@/lib/pimlico')>('@/lib/pimlico');
  return { ...actual, resolvePaymasterMode: vi.fn(actual.resolvePaymasterMode) };
});
// ConnectButton の実物は jsdom で重い wagmi の graph を評価する (兄弟のテストと同じ stub)。
vi.mock('@/components/ConnectButton', async () => ({
  ConnectButton: (await import('../_helpers/connectButtonStub')).ConnectButtonStub,
}));
// CrossChainHint の実物は wagmi と react-query に依る。stub は実物と同じく、mount で onExecutingChange(false) を呼ぶ
// (Arc の復旧の scan が終わったことを親に伝える契約。呼ばないと Arc の送信のボタンが押せないままになる。TipForm.test と同じ)。
vi.mock('@/components/CrossChainHint', async () => {
  const React = await import('react');
  return {
    CrossChainHint: (props: { onExecutingChange?: (executing: boolean) => void }) => {
      const report = props.onExecutingChange;
      React.useEffect(() => {
        report?.(false);
      }, [report]);
      return null;
    },
  };
});
const flags = vi.hoisted(() => ({ enableMobileOrderFee: true, enableUsdcArc: false, recoverFeeBps: 0 }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      enableTipMessage: false,
      get recoverFeeBps() {
        return flags.recoverFeeBps;
      },
      get enableMobileOrderFee() {
        return flags.enableMobileOrderFee;
      },
      get enableUsdcArc() {
        return flags.enableUsdcArc;
      },
    },
  };
});

import { useRouter, useSearchParams, type ReadonlyURLSearchParams } from 'next/navigation';
import { useAccount, useReadContract, useSwitchChain } from 'wagmi';
import { useSmartAccount } from '@/hooks/useSmartAccount';
import { useBatchPayment } from '@/hooks/useBatchPayment';
import { useStandardPayment } from '@/hooks/useStandardPayment';
import { useJpycEip3009Payment } from '@/hooks/useJpycEip3009Payment';
import { useGasQuoteUsdc } from '@/hooks/useGasQuoteUsdc';
import { useGasQuoteJpyc } from '@/hooks/useGasQuoteJpyc';
import { useGasQuoteCircle } from '@/hooks/useGasQuoteCircle';
import { useRelayHealth } from '@/hooks/useRelayHealth';
import { resolveUsdcGaslessProvider } from '@/lib/circlePaymaster';
import { resolveJpycGaslessProvider } from '@/lib/jpycGaslessProvider';
import { jpycForwarderFor, relayGasFeeValue } from '@/lib/relay/forwarderConfig';
import { resolvePaymasterMode } from '@/lib/pimlico';
import { IncompatibleSmartAccountError } from '@/lib/accountDetection';
import { PaymentForm } from '@/components/PaymentForm';
import { CheckoutForm } from '@/components/CheckoutForm';
import { TipForm } from '@/components/TipForm';
import { env } from '@/lib/env';
import { deploymentForSlug, type TokenDeployment } from '@/lib/tokens';
import type { CheckoutParams, TipParams } from '@/lib/url';

// ---------------------------------------------------------------------------------------------------------------------
// 定数 (vitest.config.ts の NEXT_PUBLIC_NETWORK_ENV=testnet の chain と deployment)
// ---------------------------------------------------------------------------------------------------------------------
const MERCHANT: Address = '0x2222222222222222222222222222222222222222';
const CUSTOMER: Address = '0x9999999999999999999999999999999999999999';
const SPLIT_TO: Address = '0x3333333333333333333333333333333333333333';
const FORWARDER: Address = '0x1111111111111111111111111111111111111111';
const DELEGATE: Address = '0x4444444444444444444444444444444444444444';
const FEE_RECEIVER = env.feeReceiver;

const JPYC_POLYGON = deploymentForSlug('jpyc', 'polygon');
const USDC_BASE = deploymentForSlug('usdc', 'base');
const USDC_POLYGON = deploymentForSlug('usdc', 'polygon'); // JPYC_POLYGON と同じ chain の、別の token
const USDC_ARC = deploymentForSlug('usdc', 'arc');
const AMOY = polygonAmoy.id; // JPYC の Polygon (testnet)
const KAIROS = kairos.id; // JPYC の Kaia (testnet)。JPYC_POLYGON のフォームから見た「別の chain」
const BASE = baseSepolia.id; // USDC の Base (testnet)
const ARBITRUM = arbitrumSepolia.id; // USDC_BASE のフォームから見た「別の chain」
const ARC = USDC_ARC.chainId;

// 額 (字で書く)。J('1000') = 1000 JPYC (18 桁)・U('10') = 10 USDC (6 桁)。
const J = (human: string) => parseUnits(human, 18);
const U = (human: string) => parseUnits(human, 6);
// 見積の hook が返す額 (enabled のときだけ)。
const QUOTE_USDC = U('0.1'); // Pimlico の見積 (USDC の単位)
const QUOTE_JPYC = J('3'); // Pimlico の見積 (JPYC の単位)。JPYC は徴収しないので、どの行の額にも出てこないこと
const QUOTE_CIRCLE = { gasAmount: U('0.06'), permitAmount: U('10.5') };

type Form = 'pay' | 'checkout' | 'tip';
const NAMESPACE = { pay: 'PaymentForm', checkout: 'CheckoutForm', tip: 'TipForm' } as const;

// 画面の文の期待。m('btnPay', { amount: '1000 JPYC' }) = そのフォームの namespace の key (と値)。
type Message = { key: string; values?: Record<string, string | number> };
const m = (key: string, values?: Record<string, string | number>): Message => ({ key, values });
type Translate = (key: string, values?: Record<string, string | number>) => string;
const translators = Object.fromEntries(
  (Object.keys(NAMESPACE) as Form[]).map((form) => [
    form,
    createTranslator({ locale: 'ja', messages: ja, namespace: NAMESPACE[form] }) as unknown as Translate,
  ]),
) as Record<Form, Translate>;
const text = (form: Form, message: Message | string): string =>
  typeof message === 'string' ? translators[form](message) : translators[form](message.key, message.values);
const SWITCH_TO_STANDARD = ja.SmartAccountFallback.switchButton; // SmartAccountFallbackBanner の「通常決済に切替」

// ---------------------------------------------------------------------------------------------------------------------
// 行の入力 (3 フォーム共通)。ここから Pay の URL・Checkout の params・Tip の params を組む。
// ---------------------------------------------------------------------------------------------------------------------
type Wallet =
  | 'ready' // 接続済み・正しい chain・残高あり・smart account と見積は enabled なら用意できている
  | 'disconnected'
  | 'wrong-chain' // 接続済み・別の chain (otherChain)
  | 'sa-init' // smart account の準備中 (enabled でも data なし)
  | 'sa-incompatible' // smart account が合わない (IncompatibleSmartAccountError)
  | 'quote-loading' // 見積の取得中 (enabled でも data なし)
  | 'insufficient'; // 残高が足りない (最小の単位で 1)
type Chains = 'all' | readonly number[];
type Input = {
  token: 'jpyc' | 'usdc';
  chain?: 'polygon' | 'kaia' | 'base' | 'arc'; // 既定は jpyc = Polygon・usdc = Base
  mode?: 'standard';
  gas?: 'customer' | 'merchant';
  amount?: string; // 額 (token の単位)。既定は jpyc = 1000・usdc = 10
  noAmount?: true; // 額なし (Pay = 金額なしの QR・Tip = カスタム額の欄を選んで空のまま)
  split?: true; // Pay だけ: 30% を SPLIT_TO へ分配する QR
  mobile?: { feeKind: 'storefront' | 'preorder'; feePayer?: 'merchant' | 'customer'; flagOff?: true }; // Checkout だけ
  strayGas?: 'merchant'; // Tip だけ: TipParams に無い gas の欄を紛れ込ませる (読まれないこと)
  // resolver の答え (chain ごと)。書かなければ、どの chain でも relay でない・forwarder なし・Circle でない。
  relayOn?: Chains; // resolveJpycGaslessProvider が 'eip3009-relay' と答える chain
  forwarderOn?: Chains; // jpycForwarderFor が forwarder の address を返す chain
  circleOn?: Chains; // resolveUsdcGaslessProvider が 'circle' と答える chain
  paymaster?: 'erc20'; // resolvePaymasterMode の答え。書かなければ本物 (testnet: sponsorship・Arc: unavailable)
  // recover の利用料の設定。書かなければ、率は 0 (下限だけ)・下限はどの chain でも 2 JPYC。
  recoverBps?: number; // env.recoverFeeBps (100 = 1%。お店の負担のときだけ掛かる)
  floorJpyc?: Record<number, string>; // relayGasFeeValue (下限) を chain ごとに変える
  wallet?: Wallet;
  balance?: string; // 残高 (token の単位)。書かなければ十分にある (wallet = 'insufficient' なら最小の単位で 1)
  hasStandardAttempt?: true; // useStandardPayment が「復元した通常決済の試みがある」(hasAttempt) を返す
};

const chainSlugOf = (input: Input) => input.chain ?? (input.token === 'jpyc' ? 'polygon' : 'base');
const deploymentOf = (input: Input): TokenDeployment => deploymentForSlug(input.token, chainSlugOf(input));
const amountOf = (input: Input) => input.amount ?? (input.token === 'jpyc' ? '1000' : '10');
// 「別の chain」: フォームの deployment とは別の、ウォレットがつながっている chain。
const OTHER_CHAIN = { polygon: KAIROS, kaia: AMOY, base: ARBITRUM, arc: BASE } as const;
const otherChainOf = (input: Input) => OTHER_CHAIN[chainSlugOf(input)];

const answersOn = (chains: Chains | undefined, chainId: number) =>
  chains === 'all' || (chains?.includes(chainId) ?? false);

let actualResolvePaymasterMode: typeof resolvePaymasterMode;
beforeAll(async () => {
  actualResolvePaymasterMode = (await vi.importActual<typeof import('@/lib/pimlico')>('@/lib/pimlico')).resolvePaymasterMode;
});

// mutate の mock。行ごとに作り直す (描いた後に入力を変える行は、同じものを使い続ける)。
let standardMutate: ReturnType<typeof vi.fn>;
let relayMutate: ReturnType<typeof vi.fn>;
let gaslessMutate: ReturnType<typeof vi.fn>;

// 行の入力から、境界の mock を全部入れ直す (前の行の値を残さない)。
function arrange(
  input: Input,
  opts: { relayState?: Partial<ReturnType<typeof useJpycEip3009Payment>>; keepMutates?: true } = {},
) {
  const wallet = input.wallet ?? 'ready';
  const deployment = deploymentOf(input);
  const connected = wallet !== 'disconnected';
  flags.enableMobileOrderFee = !input.mobile?.flagOff;
  flags.enableUsdcArc = false;
  flags.recoverFeeBps = input.recoverBps ?? 0;

  // resolver と、env で決まる値。chain (と token) を見て答える。
  vi.mocked(resolveJpycGaslessProvider).mockImplementation((asked, chainId) =>
    asked.symbol === 'jpyc' && answersOn(input.relayOn, chainId) ? 'eip3009-relay' : 'pimlico-7702',
  );
  vi.mocked(jpycForwarderFor).mockImplementation((chainId) => (answersOn(input.forwarderOn, chainId) ? FORWARDER : null));
  vi.mocked(resolveUsdcGaslessProvider).mockImplementation((asked, chainId) =>
    asked.symbol === 'usdc' && answersOn(input.circleOn, chainId) ? 'circle' : 'pimlico',
  );
  vi.mocked(resolvePaymasterMode).mockImplementation((asked) => input.paymaster ?? actualResolvePaymasterMode(asked));
  vi.mocked(relayGasFeeValue).mockImplementation((chainId) => J(input.floorJpyc?.[chainId] ?? '2'));

  mockHook(useAccount, {
    address: connected ? CUSTOMER : undefined,
    isConnected: connected,
    chainId: !connected ? undefined : wallet === 'wrong-chain' ? otherChainOf(input) : deployment.chainId,
  });
  mockHook(useSwitchChain, { switchChain: vi.fn(), isPending: false, error: null, variables: undefined });
  mockHook(useReadContract, {
    data: !connected
      ? undefined
      : input.balance !== undefined
        ? parseUnits(input.balance, deployment.decimals)
        : wallet === 'insufficient'
          ? 1n
          : parseUnits('100000', deployment.decimals),
    isLoading: false,
    error: null,
  });

  const saReady = wallet !== 'sa-init' && wallet !== 'sa-incompatible' && connected;
  const saError =
    wallet === 'sa-incompatible'
      ? new IncompatibleSmartAccountError({ delegateAddress: DELEGATE, i18nKey: 'errorIncompatibleSmartAccount' })
      : null;
  vi.mocked(useSmartAccount).mockImplementation(
    (_deployment, enabled) =>
      ({
        data: enabled && saReady ? { smartAccountClient: {}, pimlicoClient: {} } : undefined,
        isLoading: !!enabled && !saReady && !saError,
        error: enabled ? saError : null,
      }) as unknown as ReturnType<typeof useSmartAccount>,
  );
  const quoteReady = wallet !== 'quote-loading';
  const quote = (gasAmount: bigint) => (_deployment: TokenDeployment, enabled?: boolean) => ({
    data: enabled && quoteReady ? { gasAmount } : undefined,
    isLoading: !!enabled && !quoteReady,
    isError: false,
    error: null,
  });
  vi.mocked(useGasQuoteUsdc).mockImplementation(quote(QUOTE_USDC) as unknown as typeof useGasQuoteUsdc);
  vi.mocked(useGasQuoteJpyc).mockImplementation(
    quote(input.token === 'jpyc' ? QUOTE_JPYC : QUOTE_USDC) as unknown as typeof useGasQuoteJpyc,
  );
  vi.mocked(useGasQuoteCircle).mockImplementation(
    (_deployment, enabled) =>
      ({
        data: enabled && quoteReady ? QUOTE_CIRCLE : undefined,
        error: null,
        fetchStatus: 'idle',
      }) as unknown as ReturnType<typeof useGasQuoteCircle>,
  );
  vi.mocked(useRelayHealth).mockReturnValue({ degraded: false });

  if (!opts.keepMutates) {
    gaslessMutate = vi.fn();
    standardMutate = vi.fn();
    relayMutate = vi.fn();
  }
  mockHook(useBatchPayment, {
    mutate: gaslessMutate,
    retryReceipt: vi.fn(),
    isPending: false,
    isUnknown: false,
    isSuccess: false,
    isError: false,
    pendingStoreUnavailable: false,
    pendingUserOpHash: undefined,
    settledOtherIntent: false,
    recoveredIntent: null,
    variables: undefined,
    data: undefined,
    error: null,
  } as Partial<ReturnType<typeof useBatchPayment>>);
  mockHook(useStandardPayment, {
    mutate: standardMutate,
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
    hasAttempt: input.hasStandardAttempt ?? false,
    lastSubmittedParams: undefined,
    lastSubmittedFrom: undefined,
    restoredFromStorage: false,
    restoredAttempt: false,
  } as Partial<ReturnType<typeof useStandardPayment>>);
  mockHook(useJpycEip3009Payment, {
    mutate: relayMutate,
    retryRelay: vi.fn(),
    retrySamePayload: vi.fn(),
    isPending: false,
    isRestoring: false,
    hasActiveIntent: false,
    orderPaymentHold: false,
    data: undefined,
    error: null,
    recoveryState: null,
    variables: undefined,
    lastSignedFrom: undefined,
    restoredIntent: null,
    orderDelivery: null,
    backgroundOrderDeliveries: [],
    orderDeliveryLoadError: false,
    previousPaymentPending: false,
    previousPaymentSameMerchant: false,
    ...opts.relayState,
  } as Partial<ReturnType<typeof useJpycEip3009Payment>>);
}

// 行の入力 → 各フォームの入口。
function payQuery(input: Input): string {
  const query = new URLSearchParams({ to: MERCHANT, token: input.token, chain: chainSlugOf(input) });
  if (!input.noAmount) query.set('amount', amountOf(input));
  if (input.mode) query.set('mode', input.mode);
  if (input.gas) query.set('gas', input.gas);
  if (input.split) query.set('split', `${SPLIT_TO}:30`);
  return query.toString();
}
function checkoutParams(input: Input, extra: Partial<CheckoutParams> = {}): CheckoutParams {
  return {
    to: MERCHANT,
    token: input.token,
    chain: chainSlugOf(input),
    gas: input.gas ?? 'customer',
    mode: input.mode ?? 'gasless',
    items: [{ name: '商品', qty: 1, price: amountOf(input) }],
    ...(input.mobile ? { feeKind: input.mobile.feeKind } : {}),
    ...(input.mobile?.feePayer ? { feePayer: input.mobile.feePayer } : {}),
    ...extra,
  };
}
function tipParams(input: Input): TipParams {
  return {
    mode: input.mode ?? 'gasless',
    to: MERCHANT,
    token: input.token,
    chain: chainSlugOf(input),
    presets: [amountOf(input)],
    ...(input.strayGas ? { gas: input.strayGas } : {}),
  };
}
function formElement(form: Form, input: Input, checkoutExtra?: Partial<CheckoutParams>): ReactElement {
  if (form === 'pay') {
    // Arc は flag が OFF だと URL の parser が chain を通さない。Pay の Arc の行だけ ON にする (冒頭の env の節)。
    flags.enableUsdcArc = input.chain === 'arc';
    vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams(payQuery(input)) as unknown as ReadonlyURLSearchParams);
    return <PaymentForm />;
  }
  if (form === 'checkout') return <CheckoutForm params={checkoutParams(input, checkoutExtra)} />;
  return <TipForm params={tipParams(input)} />;
}

// 遅れて読み込む部品 (next/dynamic の CrossChainHint・SignReassurance・Tip の standard の engine) と、その後の state の更新を待つ。
async function settle() {
  await act(async () => {
    await vi.dynamicImportSettled();
  });
}

type View = ReturnType<typeof render>;
type MountOptions = { relayState?: Partial<ReturnType<typeof useJpycEip3009Payment>>; checkoutExtra?: Partial<CheckoutParams> };
async function mount(form: Form, input: Input, opts: MountOptions = {}): Promise<View> {
  arrange(input, { relayState: opts.relayState });
  const view = render(formElement(form, input, opts.checkoutExtra));
  await settle();
  if (input.noAmount && form === 'tip') {
    // カスタム額の欄を選ぶ (空のまま)。Tip で額が 0 になるのはこの形だけ (preset は既定で 1 つ目が選ばれる)。
    fireEvent.focus(screen.getByRole('textbox'));
  }
  return view;
}

// ここまでに支払いの hook へ渡った引数の記録を消す (この後の描画で渡った引数だけを見るため)。mock の答えは残る。
// resolver の記録は消さない: 入力が変わらなければ resolver を聞き直さない実装 (memo) も正しいので、resolver が聞かれた chain は
// 「描いてからの全部」の集合で見る。
function forgetHookCalls() {
  for (const mock of [
    useSmartAccount,
    useBatchPayment,
    useGasQuoteUsdc,
    useGasQuoteJpyc,
    useGasQuoteCircle,
    useRelayHealth,
    useJpycEip3009Payment,
    useStandardPayment,
  ]) {
    vi.mocked(mock).mockClear();
  }
}

// 描いた後に、実際の入力 (URL / params・ウォレットの chain・hook が返す状態) が変わる。境界の mock を次の入力に入れ直して
// (mutate の mock は同じものを使い続ける)、同じ画面を描き直す。resolver の答えの表 (relayOn など) は前と同じにしておき、
// 「同じ入力に対する答え」は変えない (変わるのは入力のほう)。
async function changeInput(view: View, form: Form, next: Input, opts: MountOptions = {}) {
  arrange(next, { relayState: opts.relayState, keepMutates: true });
  forgetHookCalls();
  view.rerender(formElement(form, next, opts.checkoutExtra));
  await settle();
}

// ---------------------------------------------------------------------------------------------------------------------
// 観察 (描かれた DOM と、mock に渡った引数)
// ---------------------------------------------------------------------------------------------------------------------
// hook の enabled (行ではこの形で書く)。
type HookEnabled = {
  smartAccount: boolean; // useSmartAccount
  batch: boolean; // useBatchPayment
  quoteUsdc: boolean; // useGasQuoteUsdc (useGasQuote の内側。paymaster = erc20 のときだけ有効)
  quoteJpyc: boolean; // useGasQuoteJpyc (useGasQuote の内側。paymaster = sponsorship のときだけ有効。USDC の sponsorship もこちら)
  quoteCircle: boolean; // useGasQuoteCircle
};
// 経路ごとの hook の enabled (行ではこの名前で書く)。
// 通常決済・relay: smart account も見積も要らない。
const OFF: HookEnabled = { smartAccount: false, batch: false, quoteUsdc: false, quoteJpyc: false, quoteCircle: false };
// Pimlico・paymaster = sponsorship (testnet の USDC・JPYC の relay でないガスレス)。
const SPONSORSHIP: HookEnabled = { smartAccount: true, batch: true, quoteUsdc: false, quoteJpyc: true, quoteCircle: false };
// Pimlico・paymaster = erc20 (USDC)。
const ERC20: HookEnabled = { smartAccount: true, batch: true, quoteUsdc: true, quoteJpyc: false, quoteCircle: false };
// Circle (paymaster = erc20 の USDC)。Pimlico の USDC の見積も有効のまま (今の動き。使うのは Circle の見積)。
const CIRCLE: HookEnabled = { smartAccount: true, batch: true, quoteUsdc: true, quoteJpyc: false, quoteCircle: true };

// 行の左 (ラベル) は key か m(…)・右 (値) は字 ('1000 JPYC') か m(…)。
type Row = [label: Message | string, value: Message | string];
// resolver が聞かれた chain の集合 (小さい順)。jpyc = resolveJpycGaslessProvider の第 2 引数・forwarder = jpycForwarderFor の引数・
// usdc = resolveUsdcGaslessProvider の第 2 引数。呼ばれた回数と順番は見ない。
type AskedOn = { jpyc: number[]; forwarder: number[]; usdc: number[] };

// hook に渡った引数の見方: 見ている区間 (描いてから、または forgetHookCalls の後) に渡った **引数の組の集合** を、引数の全部で比べる。
// 呼んだ回数と順番は見ない。省いた引数は、hook の既定値として読む (enabled の既定は true・ほかの真偽の既定は false)。
// 期待の集合は、どの行も 1 つだけ (= その区間のどの描画でも同じ引数)。途中の描画だけ別の値になる行は無い。
// extra = 知らない引数・知らない option の数 (0 のはず。足したら、ここに読み方を足す)。
// (deployment, enabled = true, disableCircle = false) の形: useSmartAccount・useBatchPayment。
type AccountCall = { deployment: string; enabled: boolean; disableCircle: boolean; extra: number };
// (deployment, enabled = true) の形: useGasQuoteUsdc・useGasQuoteJpyc・useGasQuoteCircle。
type QuoteCall = { deployment: string; enabled: boolean; extra: number };
type Observed = {
  smartAccount: AccountCall[];
  batch: AccountCall[];
  quoteUsdc: QuoteCall[];
  quoteJpyc: QuoteCall[];
  quoteCircle: QuoteCall[];
  // useRelayHealth({ chainId, enabled })。Tip は呼ばない (空)。
  health: Array<{ chainId: number; enabled: boolean; extra: number }>;
  // useJpycEip3009Payment(deployment, { restoreOrderDelivery = false, orderContext, skipIntentStorageCheck = false })。
  // orderContext は、渡したかどうかだけ (中身は見ない)。
  relay: Array<{ deployment: string; restoreOrderDelivery: boolean; skipIntentStorageCheck: boolean; orderContext: boolean; extra: number }>;
  // useStandardPayment({ enabled = true })。Tip は standard の engine が出たときだけ呼ぶ (それ以外は空)。
  standard: Array<{ enabled: boolean; extra: number }>;
  askedOn: AskedOn;
  // 2 つの resolver が聞かれた deployment (第 1 引数) の集合。
  askedAbout: string[];
  rows: Array<[string, string]>;
  button: [string, boolean];
};

const deploymentKey = (deployment: TokenDeployment) => `${deployment.symbol}@${deployment.chainId}`;
const sortedSet = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);
// 同じ中身の組を 1 つにまとめる (集合にする)。
const distinct = <T,>(values: T[]): T[] => [...new Map(values.map((value) => [JSON.stringify(value), value])).values()];
const unknownKeys = (options: object, known: string[]) => Object.keys(options).filter((key) => !known.includes(key)).length;
type Calls = { mock: { calls: unknown[][] } };

function accountCalls(hook: Calls): AccountCall[] {
  return distinct(
    hook.mock.calls.map(([deployment, enabled = true, disableCircle = false, ...rest]) => ({
      deployment: deploymentKey(deployment as TokenDeployment),
      enabled: enabled as boolean,
      disableCircle: disableCircle as boolean,
      extra: rest.length,
    })),
  );
}
function quoteCalls(hook: Calls): QuoteCall[] {
  return distinct(
    hook.mock.calls.map(([deployment, enabled = true, ...rest]) => ({
      deployment: deploymentKey(deployment as TokenDeployment),
      enabled: enabled as boolean,
      extra: rest.length,
    })),
  );
}

// 明細の表 (最初の dl) の行。ラベルは dt の文 (tooltip の「?」のボタンは除く)・値は dd の文。
function breakdownRows(view: View): Array<[string, string]> {
  const list = view.container.querySelector('dl');
  return Array.from(list?.querySelectorAll('dt') ?? []).map((dt) => [
    dt.firstChild?.textContent ?? '',
    dt.nextElementSibling?.textContent ?? '',
  ]);
}

// 支払いのボタン。期待の文言で探し、無ければ、今あるボタンの一覧を差分に出す。
function findSubmit(label: string): HTMLButtonElement | null {
  return screen.queryByRole<HTMLButtonElement>('button', { name: label });
}
function observeButton(label: string): [string, boolean] {
  const button = findSubmit(label);
  if (button) return [label, !button.disabled];
  const names = screen.getAllByRole('button').map((el) => el.textContent);
  return [`(「${label}」のボタンが無い。今あるボタン: ${names.join(' / ')})`, false];
}

function observe(view: View, buttonLabel: string): Observed {
  return {
    smartAccount: accountCalls(vi.mocked(useSmartAccount)),
    batch: accountCalls(vi.mocked(useBatchPayment)),
    quoteUsdc: quoteCalls(vi.mocked(useGasQuoteUsdc)),
    quoteJpyc: quoteCalls(vi.mocked(useGasQuoteJpyc)),
    quoteCircle: quoteCalls(vi.mocked(useGasQuoteCircle)),
    health: distinct(
      vi.mocked(useRelayHealth).mock.calls.map(([options, ...rest]) => ({
        chainId: options.chainId,
        enabled: options.enabled,
        extra: rest.length + unknownKeys(options, ['chainId', 'enabled']),
      })),
    ),
    relay: distinct(
      vi.mocked(useJpycEip3009Payment).mock.calls.map(([deployment, options = {}, ...rest]) => ({
        deployment: deploymentKey(deployment),
        restoreOrderDelivery: options.restoreOrderDelivery ?? false,
        skipIntentStorageCheck: options.skipIntentStorageCheck ?? false,
        orderContext: options.orderContext !== undefined,
        extra: rest.length + unknownKeys(options, ['restoreOrderDelivery', 'orderContext', 'skipIntentStorageCheck']),
      })),
    ),
    standard: distinct(
      vi.mocked(useStandardPayment).mock.calls.map(([options = {}, ...rest]) => ({
        enabled: options.enabled ?? true,
        extra: rest.length + unknownKeys(options, ['enabled']),
      })),
    ),
    askedOn: {
      jpyc: sortedSet(vi.mocked(resolveJpycGaslessProvider).mock.calls.map(([, chainId]) => chainId)),
      forwarder: sortedSet(vi.mocked(jpycForwarderFor).mock.calls.map(([chainId]) => chainId)),
      usdc: sortedSet(vi.mocked(resolveUsdcGaslessProvider).mock.calls.map(([, chainId]) => chainId)),
    },
    askedAbout: distinct(
      [resolveJpycGaslessProvider, resolveUsdcGaslessProvider].flatMap((resolver) =>
        vi.mocked(resolver).mock.calls.map(([asked]) => deploymentKey(asked)),
      ),
    ).sort(),
    rows: breakdownRows(view),
    button: observeButton(buttonLabel),
  };
}

// 行の期待 (経路と、そこから派生するもの)。
type MutateKind = 'standard' | 'relay' | 'gasless';
type Mutate = [MutateKind, Record<string, unknown>];
type RouteExpect = {
  hooks: HookEnabled;
  // useRelayHealth の enabled。Tip は呼ばない ('never')。
  health: boolean | 'never';
  // resolver が聞かれる chain の集合。書かなければ、3 つとも deployment の chain だけ (ウォレットが正しい chain にいる行は、
  // どのフォームも同じ)。
  askedOn?: AskedOn;
  // resolver が聞かれる deployment。書かなければ、その行の deployment だけ (描いた後に token が変わる行だけが書く)。
  askedAbout?: TokenDeployment[];
  rows: Row[];
  // [文言, 押せるか]
  button: [Message | string, boolean];
  // 押した後に呼ばれる mutate と、渡る値。null = 押してもどれも呼ばれない。書かなければ押さない (準備ができていない行)。
  mutate?: Mutate | null;
  // Tip だけ: standard の engine が出て、useStandardPayment が呼ばれる。
  engine?: true;
};

// 期待の観察。フォームごとに決まっているもの (どの deployment を渡すか・useRelayHealth の chainId・useJpycEip3009Payment の
// option・useStandardPayment を呼ぶか) は、ここで足す。
function expectedObservation(form: Form, input: Input, expected: RouteExpect): Observed {
  const deployment = deploymentOf(input);
  const key = deploymentKey(deployment);
  const account = (enabled: boolean): AccountCall[] => [{ deployment: key, enabled, disableCircle: false, extra: 0 }];
  const quote = (enabled: boolean): QuoteCall[] => [{ deployment: key, enabled, extra: 0 }];
  const askedOn = expected.askedOn ?? { jpyc: [deployment.chainId], forwarder: [deployment.chainId], usdc: [deployment.chainId] };
  return {
    smartAccount: account(expected.hooks.smartAccount),
    batch: account(expected.hooks.batch),
    quoteUsdc: quote(expected.hooks.quoteUsdc),
    quoteJpyc: quote(expected.hooks.quoteJpyc),
    quoteCircle: quote(expected.hooks.quoteCircle),
    // useRelayHealth の chainId は、ウォレットの chain でなく deployment の chain。
    health: expected.health === 'never' ? [] : [{ chainId: deployment.chainId, enabled: expected.health, extra: 0 }],
    // Pay は option なし・Checkout は注文の復元を頼む・Tip は埋め込みかどうか (jsdom は最上位の window なので false = 既定と同じ)。
    relay: [
      {
        deployment: key,
        restoreOrderDelivery: form === 'checkout',
        skipIntentStorageCheck: false,
        orderContext: form === 'checkout',
        extra: 0,
      },
    ],
    // Pay と Checkout は必ず呼ぶ。Tip は standard の engine が出たときだけ。
    standard: form !== 'tip' || expected.engine ? [{ enabled: true, extra: 0 }] : [],
    askedOn: { jpyc: sortedSet(askedOn.jpyc), forwarder: sortedSet(askedOn.forwarder), usdc: sortedSet(askedOn.usdc) },
    askedAbout: (expected.askedAbout ?? [deployment]).map(deploymentKey).sort(),
    rows: expected.rows.map(([label, value]) => [
      text(form, label),
      typeof value === 'string' ? value : text(form, value),
    ]),
    button: [text(form, expected.button[0]), expected.button[1]],
  };
}

// mutate に渡った値 (押した順)。書いていない mutate は、1 回も呼ばれていないこと。
function expectMutates(expected: Partial<Record<MutateKind, Array<Record<string, unknown>>>>) {
  const mutates = { standard: standardMutate, relay: relayMutate, gasless: gaslessMutate };
  for (const kind of Object.keys(mutates) as MutateKind[]) {
    expect(mutates[kind].mock.calls, `${kind} の mutate に渡った値`).toEqual((expected[kind] ?? []).map((payload) => [payload]));
  }
}

// 1 行の確かめ: 観察を期待と比べる → (mutate が書いてあれば) ボタンを押して、mutate に渡った値を比べる。
function check(form: Form, input: Input, expected: RouteExpect, view: View) {
  const buttonLabel = text(form, expected.button[0]);
  expect(observe(view, buttonLabel)).toEqual(expectedObservation(form, input, expected));
  if (expected.mutate === undefined) return;
  const button = findSubmit(buttonLabel);
  if (button) fireEvent.click(button);
  expectMutates(expected.mutate ? { [expected.mutate[0]]: [expected.mutate[1]] } : {});
}

// 表の 1 行 = 同じ入力と、フォームごとの期待の列。列が無いフォームは、その入力を受け付けない。
type FormExpect = {
  rows: Row[];
  button: [Message | string, boolean];
  // 下の 4 つは、行の共通の値と違うときだけ書く。
  hooks?: HookEnabled;
  health?: boolean;
  mutate?: Mutate | null;
  askedOn?: AskedOn;
  engine?: true;
};
type Case = {
  name: string;
  input: Input;
  // 3 フォーム共通の期待 (フォームの列に書けば、そちらが勝つ)。
  hooks: HookEnabled;
  health: boolean; // useRelayHealth の enabled (Pay と Checkout)。Tip は呼ばないので、Tip の期待は常に 'never'
  mutate?: Mutate | null;
  pay?: FormExpect;
  checkout?: FormExpect;
  tip?: FormExpect;
};
const FORMS: Form[] = ['pay', 'checkout', 'tip'];
// it.each に渡す [test の題, 行] の組。題は自分で組んで '%s' で渡す (vitest は '$name' で差し込む値を 40 字で切るので、
// 長い名前の行が同じ題になってしまう)。
type Titled<T> = [title: string, row: T];
type RouteRow = { form: Form; input: Input; expected: RouteExpect };
const perForm = (cases: Case[]): Array<Titled<RouteRow>> =>
  cases.flatMap((row) =>
    FORMS.flatMap((form): Array<Titled<RouteRow>> => {
      const column = row[form];
      if (!column) return [];
      const expected: RouteExpect = {
        hooks: column.hooks ?? row.hooks,
        health: form === 'tip' ? 'never' : (column.health ?? row.health),
        askedOn: column.askedOn,
        rows: column.rows,
        button: column.button,
        mutate: 'mutate' in column ? column.mutate : row.mutate,
        engine: column.engine,
      };
      return [[`${form}: ${row.name}`, { form, input: row.input, expected }]];
    }),
  );

// mutate に渡る値の、お金でない欄 (受取先・token・利用料の受取先) を足す。お金の欄は行に字で書く。
const standardPayload = (
  deployment: TokenDeployment,
  money: { merchantAmount: bigint; feeAmount: bigint; saleAmount: bigint },
) => ({
  tokenAddress: deployment.address,
  merchant: MERCHANT,
  feeReceiver: FEE_RECEIVER,
  chainId: deployment.chainId,
  ...money,
});
// Checkout の通常決済は、会計の指紋 (contextKey) も渡す。値は会計ごとに変わるので、欄があることだけを見る。
const checkoutStandardPayload = (...args: Parameters<typeof standardPayload>) => ({
  ...standardPayload(...args),
  contextKey: expect.any(String),
});
const gaslessPayload = (
  deployment: TokenDeployment,
  money: {
    merchantAmount: bigint;
    feeAmount: bigint;
    gasReimbursement: bigint;
    saleAmount: bigint;
    networkFeeEquivalent: bigint | undefined;
    circlePermitAmount: bigint | undefined;
  },
) => ({ tokenAddress: deployment.address, merchant: MERCHANT, feeReceiver: FEE_RECEIVER, ...money });

// 行の間で何も持ち越さない: storage を空にし、境界の mock を既定に戻す (vitest の clearMocks は呼び出しの履歴だけを消し、
// mockReturnValue / mockImplementation は残す)。各行は mount の中の arrange で、自分の入力に入れ直す。
beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  vi.mocked(useRouter).mockReturnValue({ push: vi.fn(), replace: vi.fn() } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams() as unknown as ReadonlyURLSearchParams);
  arrange({ token: 'jpyc' });
});

// ---------------------------------------------------------------------------------------------------------------------
// 表 1: 経路の表 (準備ができた状態)
// ---------------------------------------------------------------------------------------------------------------------
// 行 = 経路 × token × paymaster の 9 つの組 (通常決済 × {JPYC・USDC・USDC の Arc}・relay の free・relay の recover・Circle・
// Pimlico × {USDC の erc20・USDC の sponsorship・JPYC の sponsorship}) × ガス代の負担 (意味のある組だけ)。
// 足した行: recover の率と下限・見積の取得中・分配つき (Pay)・モバイル注文 (Checkout)・Tip に gas が紛れ込んだとき。フォームが受け付けない組は列を
// 書かない (Tip の通常決済は Arc だけ・Tip にガス代の負担の軸は無い)。
// 額: JPYC は 1000・USDC は 10。recover の利用料は 2 JPYC (率と下限を変える 2 行を除く)。見積は Pimlico の USDC = 0.1・Circle = 0.06 (permit の上限 10.5)・
// Pimlico の JPYC = 3 (JPYC は徴収しないので、どの行にも出てこない)。
const ROUTE_TABLE: Case[] = [
  // ---- 通常決済 (mode=standard が、resolver の答えより先) ----
  {
    name: '通常決済・JPYC (resolver は relay・forwarder ありと答えるが、通常決済が先)',
    input: { token: 'jpyc', mode: 'standard', relayOn: 'all', forwarderOn: 'all' },
    hooks: OFF,
    health: false,
    pay: {
      rows: [
        ['merchantRowAfterFee', '1000 JPYC'],
        ['gasRowStandard', m('gasRowStandardValue')],
        [m('customerStandard', { nativeToken: 'POL' }), '1000 JPYC'],
      ],
      button: [m('btnPay', { amount: '1000 JPYC' }), true],
      mutate: ['standard', standardPayload(JPYC_POLYGON, { merchantAmount: J('1000'), feeAmount: 0n, saleAmount: J('1000') })],
    },
    checkout: {
      rows: [
        ['subtotalRow', '1000 JPYC'],
        ['gasRowStandard', m('gasRowStandardValue')],
        [m('totalRowStandard', { nativeToken: 'POL' }), '1000 JPYC'],
      ],
      button: [m('btnPay', { amount: '1000 JPYC' }), true],
      mutate: [
        'standard',
        checkoutStandardPayload(JPYC_POLYGON, { merchantAmount: J('1000'), feeAmount: 0n, saleAmount: J('1000') }),
      ],
    },
  },
  {
    name: '通常決済・USDC・gas=merchant (通常決済はガス代の負担を見ない。resolver は Circle と答えるが、通常決済が先)',
    input: { token: 'usdc', mode: 'standard', gas: 'merchant', circleOn: 'all', paymaster: 'erc20' },
    hooks: OFF,
    health: false,
    pay: {
      rows: [
        ['merchantRowAfterFee', '10 USDC'],
        ['gasRowStandard', m('gasRowStandardValue')],
        [m('customerStandard', { nativeToken: 'ETH' }), '10 USDC'],
      ],
      button: [m('btnPay', { amount: '10 USDC' }), true],
      mutate: ['standard', standardPayload(USDC_BASE, { merchantAmount: U('10'), feeAmount: 0n, saleAmount: U('10') })],
    },
    checkout: {
      rows: [
        ['subtotalRow', '10 USDC'],
        ['gasRowStandard', m('gasRowStandardValue')],
        [m('totalRowStandard', { nativeToken: 'ETH' }), '10 USDC'],
      ],
      button: [m('btnPay', { amount: '10 USDC' }), true],
      mutate: ['standard', checkoutStandardPayload(USDC_BASE, { merchantAmount: U('10'), feeAmount: 0n, saleAmount: U('10') })],
    },
  },
  {
    name: '通常決済・USDC の Arc (Tip が通常決済になる唯一の組)',
    input: { token: 'usdc', chain: 'arc', mode: 'standard' },
    hooks: OFF,
    health: false,
    pay: {
      rows: [
        ['merchantRowAfterFee', '10 USDC'],
        ['gasRowStandard', m('gasRowStandardValue')],
        [m('customerStandard', { nativeToken: 'USDC' }), '10 USDC'],
      ],
      button: [m('btnPay', { amount: '10 USDC' }), true],
      mutate: ['standard', standardPayload(USDC_ARC, { merchantAmount: U('10'), feeAmount: 0n, saleAmount: U('10') })],
    },
    checkout: {
      rows: [
        ['subtotalRow', '10 USDC'],
        ['gasRowStandard', m('gasRowStandardValue')],
        [m('totalRowStandard', { nativeToken: 'USDC' }), '10 USDC'],
      ],
      button: [m('btnPay', { amount: '10 USDC' }), true],
      mutate: ['standard', checkoutStandardPayload(USDC_ARC, { merchantAmount: U('10'), feeAmount: 0n, saleAmount: U('10') })],
    },
    tip: {
      engine: true,
      rows: [
        ['creatorRow', '10 USDC'],
        ['gasRow', m('gasRowUsdcArc')],
        ['customerRow', '10 USDC'],
      ],
      button: [m('btnSend', { amount: '10 USDC' }), true],
      // Tip の通常決済は別の形: 利用料は 0 で固定・送った人 (customer)・tip の印・chain の slug・mode を持ち、saleAmount は無い。
      mutate: [
        'standard',
        {
          chainId: ARC,
          tokenAddress: USDC_ARC.address,
          merchant: MERCHANT,
          merchantAmount: U('10'),
          feeReceiver: FEE_RECEIVER,
          feeAmount: 0n,
          customer: CUSTOMER,
          tip: true,
          chainSlug: 'arc',
          mode: 'standard',
        },
      ],
    },
  },

  // ---- relay の free (JPYC・forwarder なし = OpenPay がガス代を負担) ----
  {
    name: 'relay の free・JPYC・gas=customer',
    input: { token: 'jpyc', gas: 'customer', relayOn: 'all' },
    hooks: OFF,
    health: true,
    mutate: ['relay', { merchant: MERCHANT, value: J('1000'), gasMode: 'customer' }],
    pay: {
      rows: [
        ['merchantRowAfterFee', '1000 JPYC'],
        ['gasRowFree', m('gasRowRelayFree')],
        ['customerCustomerGas', '1000 JPYC'],
      ],
      button: [m('btnPay', { amount: '1000 JPYC' }), true],
    },
    checkout: {
      rows: [
        ['subtotalRow', '1000 JPYC'],
        ['gasRowFree', m('gasRowRelayFree')],
        ['totalRow', '1000 JPYC'],
      ],
      button: [m('btnPay', { amount: '1000 JPYC' }), true],
    },
    tip: {
      rows: [
        ['creatorRow', '1000 JPYC'],
        ['gasRowFree', m('gasRowRelayFree')],
        ['customerRow', '1000 JPYC'],
      ],
      button: [m('btnSend', { amount: '1000 JPYC' }), true],
    },
  },
  {
    name: 'relay の free・JPYC・gas=merchant (額は同じ。合計のラベルと relay に渡す gasMode だけが変わる)',
    input: { token: 'jpyc', gas: 'merchant', relayOn: 'all' },
    hooks: OFF,
    health: true,
    mutate: ['relay', { merchant: MERCHANT, value: J('1000'), gasMode: 'merchant' }],
    pay: {
      rows: [
        ['merchantRowAfterFee', '1000 JPYC'],
        ['gasRowFree', m('gasRowRelayFree')],
        ['customerMerchantGas', '1000 JPYC'],
      ],
      button: [m('btnPay', { amount: '1000 JPYC' }), true],
    },
    checkout: {
      rows: [
        ['subtotalRow', '1000 JPYC'],
        ['gasRowFree', m('gasRowRelayFree')],
        ['totalRowMerchantGas', '1000 JPYC'],
      ],
      button: [m('btnPay', { amount: '1000 JPYC' }), true],
    },
  },

  // ---- relay の recover (JPYC・forwarder あり = 利用料 2 JPYC を回収) ----
  {
    name: 'relay の recover・JPYC・gas=customer (Pay と Checkout は URL の customer を見ずにお店の負担・Tip はお客様の負担)',
    input: { token: 'jpyc', gas: 'customer', relayOn: 'all', forwarderOn: 'all' },
    hooks: OFF,
    health: true,
    mutate: ['relay', { merchant: MERCHANT, value: J('1000'), gasMode: 'merchant' }],
    pay: {
      rows: [
        ['merchantRowAfterFee', '998 JPYC'],
        ['gasRowMerchant', '2 JPYC'],
        ['customerMerchantGas', '1000 JPYC'],
      ],
      button: [m('btnPay', { amount: '1000 JPYC' }), true],
    },
    checkout: {
      rows: [
        ['subtotalRow', '1000 JPYC'],
        ['gasRowMerchant', '2 JPYC'],
        ['totalRowMerchantGas', '1000 JPYC'],
      ],
      button: [m('btnPay', { amount: '1000 JPYC' }), true],
    },
    tip: {
      rows: [
        ['creatorRow', '1000 JPYC'],
        ['gasRow', '2 JPYC'],
        ['customerRow', '1002 JPYC'],
      ],
      button: [m('btnSend', { amount: '1002 JPYC' }), true],
      mutate: ['relay', { merchant: MERCHANT, value: J('1000'), gasMode: 'customer' }],
    },
  },
  {
    name: 'relay の recover・JPYC・gas=merchant (gas=customer の行と同じになる)',
    input: { token: 'jpyc', gas: 'merchant', relayOn: 'all', forwarderOn: 'all' },
    hooks: OFF,
    health: true,
    mutate: ['relay', { merchant: MERCHANT, value: J('1000'), gasMode: 'merchant' }],
    pay: {
      rows: [
        ['merchantRowAfterFee', '998 JPYC'],
        ['gasRowMerchant', '2 JPYC'],
        ['customerMerchantGas', '1000 JPYC'],
      ],
      button: [m('btnPay', { amount: '1000 JPYC' }), true],
    },
    checkout: {
      rows: [
        ['subtotalRow', '1000 JPYC'],
        ['gasRowMerchant', '2 JPYC'],
        ['totalRowMerchantGas', '1000 JPYC'],
      ],
      button: [m('btnPay', { amount: '1000 JPYC' }), true],
    },
  },

  {
    name: 'relay の recover・率 1% (recoverFeeBps=100): Pay と Checkout はお店の負担なので 1000 の 1% = 10 JPYC・Tip はお客様の負担なので下限の 2 JPYC のまま',
    input: { token: 'jpyc', relayOn: 'all', forwarderOn: 'all', recoverBps: 100 },
    hooks: OFF,
    health: true,
    mutate: ['relay', { merchant: MERCHANT, value: J('1000'), gasMode: 'merchant' }],
    pay: {
      rows: [
        ['merchantRowAfterFee', '990 JPYC'],
        ['gasRowMerchant', '10 JPYC'],
        ['customerMerchantGas', '1000 JPYC'],
      ],
      button: [m('btnPay', { amount: '1000 JPYC' }), true],
    },
    checkout: {
      rows: [
        ['subtotalRow', '1000 JPYC'],
        ['gasRowMerchant', '10 JPYC'],
        ['totalRowMerchantGas', '1000 JPYC'],
      ],
      button: [m('btnPay', { amount: '1000 JPYC' }), true],
    },
    tip: {
      rows: [
        ['creatorRow', '1000 JPYC'],
        ['gasRow', '2 JPYC'],
        ['customerRow', '1002 JPYC'],
      ],
      button: [m('btnSend', { amount: '1002 JPYC' }), true],
      mutate: ['relay', { merchant: MERCHANT, value: J('1000'), gasMode: 'customer' }],
    },
  },
  {
    name: 'relay の recover・JPYC の Kaia・下限が chain で違う (Kaia だけ 5 JPYC): Kaia の画面は 5 JPYC',
    input: { token: 'jpyc', chain: 'kaia', relayOn: 'all', forwarderOn: 'all', floorJpyc: { [KAIROS]: '5' } },
    hooks: OFF,
    health: true,
    mutate: ['relay', { merchant: MERCHANT, value: J('1000'), gasMode: 'merchant' }],
    pay: {
      rows: [
        ['merchantRowAfterFee', '995 JPYC'],
        ['gasRowMerchant', '5 JPYC'],
        ['customerMerchantGas', '1000 JPYC'],
      ],
      button: [m('btnPay', { amount: '1000 JPYC' }), true],
    },
    checkout: {
      rows: [
        ['subtotalRow', '1000 JPYC'],
        ['gasRowMerchant', '5 JPYC'],
        ['totalRowMerchantGas', '1000 JPYC'],
      ],
      button: [m('btnPay', { amount: '1000 JPYC' }), true],
    },
    tip: {
      rows: [
        ['creatorRow', '1000 JPYC'],
        ['gasRow', '5 JPYC'],
        ['customerRow', '1005 JPYC'],
      ],
      button: [m('btnSend', { amount: '1005 JPYC' }), true],
      mutate: ['relay', { merchant: MERCHANT, value: J('1000'), gasMode: 'customer' }],
    },
  },

  // ---- Circle (USDC・paymaster = erc20)。見積 0.06 USDC・permit の上限 10.5 USDC。ネットワーク手数料相当額は記録しない ----
  {
    name: 'Circle・USDC・gas=customer',
    input: { token: 'usdc', gas: 'customer', circleOn: 'all', paymaster: 'erc20' },
    hooks: CIRCLE,
    health: false,
    mutate: [
      'gasless',
      gaslessPayload(USDC_BASE, {
        merchantAmount: U('10'),
        feeAmount: 0n,
        gasReimbursement: 0n,
        saleAmount: U('10'),
        networkFeeEquivalent: undefined,
        circlePermitAmount: U('10.5'),
      }),
    ],
    pay: {
      rows: [
        ['merchantRowAfterFee', '10 USDC'],
        ['gasRow', m('gasRowValue', { amount: '0.06 USDC' })],
        ['customerCustomerGas', '10.06 USDC'],
      ],
      button: [m('btnPay', { amount: '10.06 USDC' }), true],
    },
    checkout: {
      rows: [
        ['subtotalRow', '10 USDC'],
        ['gasRow', m('gasRowValue', { amount: '0.06 USDC' })],
        ['totalRow', '10.06 USDC'],
      ],
      button: [m('btnPay', { amount: '10.06 USDC' }), true],
    },
    tip: {
      rows: [
        ['creatorRow', '10 USDC'],
        ['gasRow', m('gasRowValue', { amount: '0.06 USDC' })],
        ['customerRow', '10.06 USDC'],
      ],
      button: [m('btnSend', { amount: '10.06 USDC' }), true],
    },
  },
  {
    name: 'Circle・USDC・gas=merchant (お店の受取から見積を引く)',
    input: { token: 'usdc', gas: 'merchant', circleOn: 'all', paymaster: 'erc20' },
    hooks: CIRCLE,
    health: false,
    mutate: [
      'gasless',
      gaslessPayload(USDC_BASE, {
        merchantAmount: U('9.94'),
        feeAmount: 0n,
        gasReimbursement: 0n,
        saleAmount: U('10'),
        networkFeeEquivalent: undefined,
        circlePermitAmount: U('10.5'),
      }),
    ],
    pay: {
      rows: [
        ['merchantRowAfterFee', '9.94 USDC'],
        ['gasRowMerchant', m('gasRowValue', { amount: '0.06 USDC' })],
        ['customerMerchantGas', '10 USDC'],
      ],
      button: [m('btnPay', { amount: '10 USDC' }), true],
    },
    checkout: {
      rows: [
        ['subtotalRow', '10 USDC'],
        ['gasRowMerchant', m('gasRowValue', { amount: '0.06 USDC' })],
        ['totalRowMerchantGas', '10 USDC'],
      ],
      button: [m('btnPay', { amount: '10 USDC' }), true],
    },
  },

  // ---- Pimlico・USDC・paymaster = erc20 (paymaster がお客様の USDC からガス代を取る)。見積 0.1 USDC ----
  {
    name: 'Pimlico・USDC の erc20・gas=customer',
    input: { token: 'usdc', gas: 'customer', paymaster: 'erc20' },
    hooks: ERC20,
    health: false,
    mutate: [
      'gasless',
      gaslessPayload(USDC_BASE, {
        merchantAmount: U('10'),
        feeAmount: 0n,
        gasReimbursement: 0n,
        saleAmount: U('10'),
        networkFeeEquivalent: U('0.1'),
        circlePermitAmount: undefined,
      }),
    ],
    pay: {
      rows: [
        ['merchantRowAfterFee', '10 USDC'],
        ['gasRow', m('gasRowValue', { amount: '0.1 USDC' })],
        ['customerCustomerGas', '10.1 USDC'],
      ],
      button: [m('btnPay', { amount: '10.1 USDC' }), true],
    },
    checkout: {
      rows: [
        ['subtotalRow', '10 USDC'],
        ['gasRow', m('gasRowValue', { amount: '0.1 USDC' })],
        ['totalRow', '10.1 USDC'],
      ],
      button: [m('btnPay', { amount: '10.1 USDC' }), true],
    },
    tip: {
      rows: [
        ['creatorRow', '10 USDC'],
        ['gasRow', m('gasRowValue', { amount: '0.1 USDC' })],
        ['customerRow', '10.1 USDC'],
      ],
      button: [m('btnSend', { amount: '10.1 USDC' }), true],
    },
  },
  {
    name: 'Pimlico・USDC の erc20・gas=merchant',
    input: { token: 'usdc', gas: 'merchant', paymaster: 'erc20' },
    hooks: ERC20,
    health: false,
    mutate: [
      'gasless',
      gaslessPayload(USDC_BASE, {
        merchantAmount: U('9.9'),
        feeAmount: 0n,
        gasReimbursement: 0n,
        saleAmount: U('10'),
        networkFeeEquivalent: U('0.1'),
        circlePermitAmount: undefined,
      }),
    ],
    pay: {
      rows: [
        ['merchantRowAfterFee', '9.9 USDC'],
        ['gasRowMerchant', m('gasRowValue', { amount: '0.1 USDC' })],
        ['customerMerchantGas', '10 USDC'],
      ],
      button: [m('btnPay', { amount: '10 USDC' }), true],
    },
    checkout: {
      rows: [
        ['subtotalRow', '10 USDC'],
        ['gasRowMerchant', m('gasRowValue', { amount: '0.1 USDC' })],
        ['totalRowMerchantGas', '10 USDC'],
      ],
      button: [m('btnPay', { amount: '10 USDC' }), true],
    },
  },

  // ---- Pimlico・USDC・paymaster = sponsorship (testnet の既定。立て替えたガス代を gasReimbursement で回収する) ----
  {
    name: 'Pimlico・USDC の sponsorship・gas=customer',
    input: { token: 'usdc', gas: 'customer' },
    hooks: SPONSORSHIP,
    health: false,
    mutate: [
      'gasless',
      gaslessPayload(USDC_BASE, {
        merchantAmount: U('10'),
        feeAmount: 0n,
        gasReimbursement: U('0.1'),
        saleAmount: U('10'),
        networkFeeEquivalent: U('0.1'),
        circlePermitAmount: undefined,
      }),
    ],
    pay: {
      rows: [
        ['merchantRowAfterFee', '10 USDC'],
        ['gasRow', m('gasRowValue', { amount: '0.1 USDC' })],
        ['customerCustomerGas', '10.1 USDC'],
      ],
      button: [m('btnPay', { amount: '10.1 USDC' }), true],
    },
    checkout: {
      rows: [
        ['subtotalRow', '10 USDC'],
        ['gasRow', m('gasRowValue', { amount: '0.1 USDC' })],
        ['totalRow', '10.1 USDC'],
      ],
      button: [m('btnPay', { amount: '10.1 USDC' }), true],
    },
    tip: {
      rows: [
        ['creatorRow', '10 USDC'],
        ['gasRow', m('gasRowValue', { amount: '0.1 USDC' })],
        ['customerRow', '10.1 USDC'],
      ],
      button: [m('btnSend', { amount: '10.1 USDC' }), true],
    },
  },
  {
    name: 'Pimlico・USDC の sponsorship・gas=merchant',
    input: { token: 'usdc', gas: 'merchant' },
    hooks: SPONSORSHIP,
    health: false,
    mutate: [
      'gasless',
      gaslessPayload(USDC_BASE, {
        merchantAmount: U('9.9'),
        feeAmount: 0n,
        gasReimbursement: U('0.1'),
        saleAmount: U('10'),
        networkFeeEquivalent: U('0.1'),
        circlePermitAmount: undefined,
      }),
    ],
    pay: {
      rows: [
        ['merchantRowAfterFee', '9.9 USDC'],
        ['gasRowMerchant', m('gasRowValue', { amount: '0.1 USDC' })],
        ['customerMerchantGas', '10 USDC'],
      ],
      button: [m('btnPay', { amount: '10 USDC' }), true],
    },
    checkout: {
      rows: [
        ['subtotalRow', '10 USDC'],
        ['gasRowMerchant', m('gasRowValue', { amount: '0.1 USDC' })],
        ['totalRowMerchantGas', '10 USDC'],
      ],
      button: [m('btnPay', { amount: '10 USDC' }), true],
    },
  },
  {
    name: 'Tip の params に gas=merchant が紛れ込んでも、お客様の負担のまま (Pimlico・USDC の sponsorship)',
    input: { token: 'usdc', strayGas: 'merchant' },
    hooks: SPONSORSHIP,
    health: false,
    mutate: [
      'gasless',
      gaslessPayload(USDC_BASE, {
        merchantAmount: U('10'),
        feeAmount: 0n,
        gasReimbursement: U('0.1'),
        saleAmount: U('10'),
        networkFeeEquivalent: U('0.1'),
        circlePermitAmount: undefined,
      }),
    ],
    tip: {
      rows: [
        ['creatorRow', '10 USDC'],
        ['gasRow', m('gasRowValue', { amount: '0.1 USDC' })],
        ['customerRow', '10.1 USDC'],
      ],
      button: [m('btnSend', { amount: '10.1 USDC' }), true],
    },
  },
  {
    name: 'Pimlico・USDC の sponsorship・見積の取得中 (ネットワーク手数料は「見積取得中」・合計は見積を足す前の額・押せない)',
    input: { token: 'usdc', wallet: 'quote-loading' },
    hooks: SPONSORSHIP,
    health: false,
    mutate: null,
    pay: {
      rows: [
        ['merchantRowAfterFee', '10 USDC'],
        ['gasRow', m('gasRowPending')],
        ['customerCustomerGas', '10 USDC'],
      ],
      button: ['btnGasQuoteLoading', false],
    },
    checkout: {
      rows: [
        ['subtotalRow', '10 USDC'],
        ['gasRow', m('gasRowPending')],
        ['totalRow', '10 USDC'],
      ],
      button: ['btnGasQuoteLoading', false],
    },
    tip: {
      rows: [
        ['creatorRow', '10 USDC'],
        ['gasRow', m('gasRowPending')],
        ['customerRow', '10 USDC'],
      ],
      button: ['btnGasQuoteLoading', false],
    },
  },

  // ---- Pimlico・JPYC・paymaster = sponsorship (relay でないガスレス。ガス代は取らない) ----
  {
    name: 'Pimlico・JPYC の sponsorship・gas=customer',
    input: { token: 'jpyc', gas: 'customer' },
    hooks: SPONSORSHIP,
    health: false,
    mutate: [
      'gasless',
      gaslessPayload(JPYC_POLYGON, {
        merchantAmount: J('1000'),
        feeAmount: 0n,
        gasReimbursement: 0n,
        saleAmount: J('1000'),
        networkFeeEquivalent: 0n,
        circlePermitAmount: undefined,
      }),
    ],
    pay: {
      rows: [
        ['merchantRowAfterFee', '1000 JPYC'],
        ['gasRowFree', m('gasRowRelayFree')],
        ['customerCustomerGas', '1000 JPYC'],
      ],
      button: [m('btnPay', { amount: '1000 JPYC' }), true],
    },
    checkout: {
      rows: [
        ['subtotalRow', '1000 JPYC'],
        ['gasRowFree', m('gasRowRelayFree')],
        ['totalRow', '1000 JPYC'],
      ],
      button: [m('btnPay', { amount: '1000 JPYC' }), true],
    },
    tip: {
      rows: [
        ['creatorRow', '1000 JPYC'],
        ['gasRowFree', m('gasRowRelayFree')],
        ['customerRow', '1000 JPYC'],
      ],
      button: [m('btnSend', { amount: '1000 JPYC' }), true],
    },
  },
  {
    name: 'Pimlico・JPYC の sponsorship・gas=merchant (額は同じ。合計のラベルだけが変わる)',
    input: { token: 'jpyc', gas: 'merchant' },
    hooks: SPONSORSHIP,
    health: false,
    mutate: [
      'gasless',
      gaslessPayload(JPYC_POLYGON, {
        merchantAmount: J('1000'),
        feeAmount: 0n,
        gasReimbursement: 0n,
        saleAmount: J('1000'),
        networkFeeEquivalent: 0n,
        circlePermitAmount: undefined,
      }),
    ],
    pay: {
      rows: [
        ['merchantRowAfterFee', '1000 JPYC'],
        ['gasRowFree', m('gasRowRelayFree')],
        ['customerMerchantGas', '1000 JPYC'],
      ],
      button: [m('btnPay', { amount: '1000 JPYC' }), true],
    },
    checkout: {
      rows: [
        ['subtotalRow', '1000 JPYC'],
        ['gasRowFree', m('gasRowRelayFree')],
        ['totalRowMerchantGas', '1000 JPYC'],
      ],
      button: [m('btnPay', { amount: '1000 JPYC' }), true],
    },
  },

  // ---- 分配 (split) つきの QR (Pay だけ)。30% を SPLIT_TO へ ----
  {
    name: '分配つき・JPYC (resolver は relay と答えるが、分配つきは relay を止めて Pimlico にする。JPYC の分配は払えない)',
    input: { token: 'jpyc', split: true, relayOn: 'all', forwarderOn: 'all' },
    hooks: SPONSORSHIP,
    health: false,
    mutate: null,
    pay: {
      // 払えない QR では、ネットワーク手数料の行を出さない。
      rows: [
        [m('primaryRecipientRow', { percent: 70, addr: '0x2222…2222' }), '700 JPYC'],
        [m('splitRecipientRow', { percent: 30, addr: '0x3333…3333' }), '300 JPYC'],
        ['customerMerchantGas', '1000 JPYC'],
      ],
      button: ['btnSplitBlocked', false],
    },
  },
  {
    name: '分配つき・USDC の sponsorship (受取人ごとに送る)',
    input: { token: 'usdc', split: true },
    hooks: SPONSORSHIP,
    health: false,
    mutate: [
      'gasless',
      {
        ...gaslessPayload(USDC_BASE, {
          merchantAmount: U('7'),
          feeAmount: 0n,
          gasReimbursement: U('0.1'),
          saleAmount: U('10'),
          networkFeeEquivalent: U('0.1'),
          circlePermitAmount: undefined,
        }),
        extraRecipients: [{ to: SPLIT_TO, amount: U('3') }],
      },
    ],
    pay: {
      rows: [
        [m('primaryRecipientRow', { percent: 70, addr: '0x2222…2222' }), '7 USDC'],
        [m('splitRecipientRow', { percent: 30, addr: '0x3333…3333' }), '3 USDC'],
        ['gasRow', m('gasRowValue', { amount: '0.1 USDC' })],
        ['customerCustomerGas', '10.1 USDC'],
      ],
      button: [m('btnPay', { amount: '10.1 USDC' }), true],
    },
  },
  {
    name: '分配つき・USDC・通常決済 (通常決済は分配を送れないので払えない)',
    input: { token: 'usdc', split: true, mode: 'standard' },
    hooks: OFF,
    health: false,
    mutate: null,
    pay: {
      rows: [
        ['merchantRowAfterFee', '10 USDC'],
        ['customerMerchantGas', '10 USDC'],
      ],
      button: ['btnSplitBlocked', false],
    },
  },

  // ---- モバイル注文の利用料 (Checkout だけ)。利用料は経路に依らず付き、ガス代の負担を上書きする ----
  {
    name: 'モバイル注文・店頭 1% (お店の負担)・relay の recover: 利用料の行が出て、ネットワーク手数料の行は出ない',
    input: { token: 'jpyc', mobile: { feeKind: 'storefront' }, relayOn: 'all', forwarderOn: 'all' },
    hooks: OFF,
    health: true,
    mutate: ['relay', { merchant: MERCHANT, value: J('1000'), gasMode: 'merchant', feeKind: 'storefront' }],
    checkout: {
      rows: [
        ['subtotalRow', '1000 JPYC'],
        ['feeRowMerchant', '10 JPYC'],
        ['totalRowMerchantGas', '1000 JPYC'],
      ],
      button: [m('btnPay', { amount: '1000 JPYC' }), true],
    },
  },
  {
    name: 'モバイル注文・事前 3% (お客様の負担)・relay の recover: recover でもお客様の負担になる',
    input: { token: 'jpyc', mobile: { feeKind: 'preorder', feePayer: 'customer' }, relayOn: 'all', forwarderOn: 'all' },
    hooks: OFF,
    health: true,
    mutate: ['relay', { merchant: MERCHANT, value: J('1000'), gasMode: 'customer', feeKind: 'preorder' }],
    checkout: {
      rows: [
        ['subtotalRow', '1000 JPYC'],
        ['feeRow', '30 JPYC'],
        ['totalRow', '1030 JPYC'],
      ],
      button: [m('btnPay', { amount: '1030 JPYC' }), true],
    },
  },
  {
    name: 'モバイル注文・店頭 1%・通常決済: 利用料は通常決済でも付き、ネットワーク手数料の行は出る',
    input: { token: 'jpyc', mode: 'standard', mobile: { feeKind: 'storefront' } },
    hooks: OFF,
    health: false,
    mutate: [
      'standard',
      checkoutStandardPayload(JPYC_POLYGON, { merchantAmount: J('990'), feeAmount: J('10'), saleAmount: J('1000') }),
    ],
    checkout: {
      rows: [
        ['subtotalRow', '1000 JPYC'],
        ['feeRowMerchant', '10 JPYC'],
        ['gasRowStandard', m('gasRowStandardValue')],
        [m('totalRowStandard', { nativeToken: 'POL' }), '1000 JPYC'],
      ],
      button: [m('btnPay', { amount: '1000 JPYC' }), true],
    },
  },
  {
    name: 'モバイル注文・店頭 1%・Pimlico の JPYC: 利用料は feeAmount に入り、ネットワーク手数料相当額は記録しない',
    input: { token: 'jpyc', mobile: { feeKind: 'storefront' } },
    hooks: SPONSORSHIP,
    health: false,
    mutate: [
      'gasless',
      gaslessPayload(JPYC_POLYGON, {
        merchantAmount: J('990'),
        feeAmount: J('10'),
        gasReimbursement: 0n,
        saleAmount: J('1000'),
        networkFeeEquivalent: undefined,
        circlePermitAmount: undefined,
      }),
    ],
    checkout: {
      rows: [
        ['subtotalRow', '1000 JPYC'],
        ['feeRowMerchant', '10 JPYC'],
        ['totalRowMerchantGas', '1000 JPYC'],
      ],
      button: [m('btnPay', { amount: '1000 JPYC' }), true],
    },
  },
  {
    name: 'モバイル注文の flag が OFF なら、feeKind があっても利用料は付かない (ただの relay の recover)',
    input: { token: 'jpyc', mobile: { feeKind: 'storefront', flagOff: true }, relayOn: 'all', forwarderOn: 'all' },
    hooks: OFF,
    health: true,
    mutate: ['relay', { merchant: MERCHANT, value: J('1000'), gasMode: 'merchant' }],
    checkout: {
      rows: [
        ['subtotalRow', '1000 JPYC'],
        ['gasRowMerchant', '2 JPYC'],
        ['totalRowMerchantGas', '1000 JPYC'],
      ],
      button: [m('btnPay', { amount: '1000 JPYC' }), true],
    },
  },
];

describe('表 1: 経路の表 (準備ができた状態の hook の引数・resolver の引数・明細の行・ボタン・mutate の値)', () => {
  it.each(perForm(ROUTE_TABLE))('%s', async (_title, { form, input, expected }) => {
    const view = await mount(form, input);
    check(form, input, expected, view);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 表 2: ボタンの表 (経路の類 × ウォレットの状態)
// ---------------------------------------------------------------------------------------------------------------------
// 経路の類ごとの入力。resolver はどの chain でも同じ答え (ウォレットが別の chain にいても経路は変わらない。chain で答えが
// 変わる場面は表 3)。通常決済は、Pay と Checkout が JPYC の mode=standard・Tip が USDC の Arc。
type RouteClass = 'standard' | 'relay' | 'circle' | 'pimlico-usdc' | 'pimlico-jpyc';
const ROUTE_CLASS: Record<RouteClass, { payAndCheckout: Input; tip: Input }> = {
  standard: {
    payAndCheckout: { token: 'jpyc', mode: 'standard' },
    tip: { token: 'usdc', chain: 'arc', mode: 'standard' },
  },
  relay: { payAndCheckout: { token: 'jpyc', relayOn: 'all' }, tip: { token: 'jpyc', relayOn: 'all' } },
  circle: {
    payAndCheckout: { token: 'usdc', circleOn: 'all', paymaster: 'erc20' },
    tip: { token: 'usdc', circleOn: 'all', paymaster: 'erc20' },
  },
  'pimlico-usdc': { payAndCheckout: { token: 'usdc' }, tip: { token: 'usdc' } },
  'pimlico-jpyc': { payAndCheckout: { token: 'jpyc' }, tip: { token: 'jpyc' } },
};
// [文言, 押せるか]。null = その状態が成り立たない (Checkout は額 0 の会計を parser が通さない)。
type ButtonExpect = [Message | string, boolean] | null;
type ButtonCase = {
  route: RouteClass;
  state: Exclude<Wallet, 'sa-incompatible'> | 'no-amount';
  pay: ButtonExpect;
  checkout: ButtonExpect;
  tip: ButtonExpect;
};
// 文言の優先の順 (上が先): 未接続 → 違う chain → smart account の準備中 → 見積の取得中 → 額が 0 → 支払う。
// 残高不足は文言に出ない (「支払う」のまま押せない)。未接続のときは押せる (押すとウォレットの選択へ移る)。
// smart account の準備中と見積の取得中は、smart account を使う経路 (Circle・Pimlico) にだけある。
const PAY_JPYC: Message = m('btnPay', { amount: '1000 JPYC' });
const SEND_JPYC: Message = m('btnSend', { amount: '1000 JPYC' });
const BUTTON_TABLE: ButtonCase[] = [
  // ---- 通常決済 (Pay と Checkout = JPYC 1000・Tip = USDC の Arc 10) ----
  { route: 'standard', state: 'disconnected', pay: ['btnConnect', true], checkout: ['btnConnect', true], tip: ['btnConnect', true] },
  { route: 'standard', state: 'wrong-chain', pay: ['btnSwitchChain', false], checkout: ['btnSwitchChain', false], tip: ['btnSwitchChain', false] },
  { route: 'standard', state: 'no-amount', pay: ['btnEnterAmount', false], checkout: null, tip: ['btnSelectAmount', false] },
  { route: 'standard', state: 'insufficient', pay: [PAY_JPYC, false], checkout: [PAY_JPYC, false], tip: [m('btnSend', { amount: '10 USDC' }), false] },
  { route: 'standard', state: 'ready', pay: [PAY_JPYC, true], checkout: [PAY_JPYC, true], tip: [m('btnSend', { amount: '10 USDC' }), true] },
  // ---- relay (JPYC 1000・free) ----
  { route: 'relay', state: 'disconnected', pay: ['btnConnect', true], checkout: ['btnConnect', true], tip: ['btnConnect', true] },
  { route: 'relay', state: 'wrong-chain', pay: ['btnSwitchChain', false], checkout: ['btnSwitchChain', false], tip: ['btnSwitchChain', false] },
  { route: 'relay', state: 'no-amount', pay: ['btnEnterAmount', false], checkout: null, tip: ['btnSelectAmount', false] },
  { route: 'relay', state: 'insufficient', pay: [PAY_JPYC, false], checkout: [PAY_JPYC, false], tip: [SEND_JPYC, false] },
  { route: 'relay', state: 'ready', pay: [PAY_JPYC, true], checkout: [PAY_JPYC, true], tip: [SEND_JPYC, true] },
  // ---- Circle (USDC 10 + 見積 0.06) ----
  { route: 'circle', state: 'disconnected', pay: ['btnConnect', true], checkout: ['btnConnect', true], tip: ['btnConnect', true] },
  { route: 'circle', state: 'wrong-chain', pay: ['btnSwitchChain', false], checkout: ['btnSwitchChain', false], tip: ['btnSwitchChain', false] },
  { route: 'circle', state: 'sa-init', pay: ['btnSaInit', false], checkout: ['btnSaInit', false], tip: ['btnSaInit', false] },
  { route: 'circle', state: 'quote-loading', pay: ['btnGasQuoteLoading', false], checkout: ['btnGasQuoteLoading', false], tip: ['btnGasQuoteLoading', false] },
  { route: 'circle', state: 'no-amount', pay: ['btnEnterAmount', false], checkout: null, tip: ['btnSelectAmount', false] },
  { route: 'circle', state: 'insufficient', pay: [m('btnPay', { amount: '10.06 USDC' }), false], checkout: [m('btnPay', { amount: '10.06 USDC' }), false], tip: [m('btnSend', { amount: '10.06 USDC' }), false] },
  { route: 'circle', state: 'ready', pay: [m('btnPay', { amount: '10.06 USDC' }), true], checkout: [m('btnPay', { amount: '10.06 USDC' }), true], tip: [m('btnSend', { amount: '10.06 USDC' }), true] },
  // ---- Pimlico・USDC (10 + 見積 0.1) ----
  { route: 'pimlico-usdc', state: 'disconnected', pay: ['btnConnect', true], checkout: ['btnConnect', true], tip: ['btnConnect', true] },
  { route: 'pimlico-usdc', state: 'wrong-chain', pay: ['btnSwitchChain', false], checkout: ['btnSwitchChain', false], tip: ['btnSwitchChain', false] },
  { route: 'pimlico-usdc', state: 'sa-init', pay: ['btnSaInit', false], checkout: ['btnSaInit', false], tip: ['btnSaInit', false] },
  { route: 'pimlico-usdc', state: 'quote-loading', pay: ['btnGasQuoteLoading', false], checkout: ['btnGasQuoteLoading', false], tip: ['btnGasQuoteLoading', false] },
  { route: 'pimlico-usdc', state: 'no-amount', pay: ['btnEnterAmount', false], checkout: null, tip: ['btnSelectAmount', false] },
  { route: 'pimlico-usdc', state: 'insufficient', pay: [m('btnPay', { amount: '10.1 USDC' }), false], checkout: [m('btnPay', { amount: '10.1 USDC' }), false], tip: [m('btnSend', { amount: '10.1 USDC' }), false] },
  { route: 'pimlico-usdc', state: 'ready', pay: [m('btnPay', { amount: '10.1 USDC' }), true], checkout: [m('btnPay', { amount: '10.1 USDC' }), true], tip: [m('btnSend', { amount: '10.1 USDC' }), true] },
  // ---- Pimlico・JPYC (1000。ガス代は取らない) ----
  { route: 'pimlico-jpyc', state: 'disconnected', pay: ['btnConnect', true], checkout: ['btnConnect', true], tip: ['btnConnect', true] },
  { route: 'pimlico-jpyc', state: 'wrong-chain', pay: ['btnSwitchChain', false], checkout: ['btnSwitchChain', false], tip: ['btnSwitchChain', false] },
  { route: 'pimlico-jpyc', state: 'sa-init', pay: ['btnSaInit', false], checkout: ['btnSaInit', false], tip: ['btnSaInit', false] },
  { route: 'pimlico-jpyc', state: 'quote-loading', pay: ['btnGasQuoteLoading', false], checkout: ['btnGasQuoteLoading', false], tip: ['btnGasQuoteLoading', false] },
  { route: 'pimlico-jpyc', state: 'no-amount', pay: ['btnEnterAmount', false], checkout: null, tip: ['btnSelectAmount', false] },
  { route: 'pimlico-jpyc', state: 'insufficient', pay: [PAY_JPYC, false], checkout: [PAY_JPYC, false], tip: [SEND_JPYC, false] },
  { route: 'pimlico-jpyc', state: 'ready', pay: [PAY_JPYC, true], checkout: [PAY_JPYC, true], tip: [SEND_JPYC, true] },
];
type ButtonRow = { form: Form; input: Input; expected: NonNullable<ButtonExpect> };
const buttonRows = BUTTON_TABLE.flatMap(({ route, state, ...byForm }) =>
  FORMS.flatMap((form): Array<Titled<ButtonRow>> => {
    const expected = byForm[form];
    if (!expected) return [];
    const base = form === 'tip' ? ROUTE_CLASS[route].tip : ROUTE_CLASS[route].payAndCheckout;
    const input: Input = state === 'no-amount' ? { ...base, noAmount: true } : { ...base, wallet: state };
    return [[`${form}: ${route}・${state}`, { form, input, expected }]];
  }),
);

// 残高の境目。残高と比べるのは、額面でなく、お客様が払う総額 (額面 + お客様が負担するガス代・利用料)。
// 「額面には足りるが総額には足りない残高」は押せず、「総額ちょうどの残高」は押せる。
type BalanceCase = { name: string; input: Input; pay?: ButtonExpect; checkout?: ButtonExpect; tip?: ButtonExpect };
const PIMLICO_USDC_PAY: Message = m('btnPay', { amount: '10.1 USDC' });
const PIMLICO_USDC_SEND: Message = m('btnSend', { amount: '10.1 USDC' });
const BALANCE_TABLE: BalanceCase[] = [
  // ---- Pimlico・USDC (額面 10 + 見積 0.1 = 総額 10.1) ----
  {
    name: 'Pimlico・USDC・残高 10 (額面ちょうど。総額 10.1 に足りない)',
    input: { token: 'usdc', balance: '10' },
    pay: [PIMLICO_USDC_PAY, false],
    checkout: [PIMLICO_USDC_PAY, false],
    tip: [PIMLICO_USDC_SEND, false],
  },
  {
    name: 'Pimlico・USDC・残高 10.1 (総額ちょうど)',
    input: { token: 'usdc', balance: '10.1' },
    pay: [PIMLICO_USDC_PAY, true],
    checkout: [PIMLICO_USDC_PAY, true],
    tip: [PIMLICO_USDC_SEND, true],
  },
  // ---- Tip の recover (額面 1000 + 利用料 2 = 総額 1002。Pay と Checkout の recover はお店の負担なので総額 = 額面) ----
  {
    name: 'relay の recover・JPYC・残高 1000 (Tip は総額 1002 に足りない・Pay と Checkout は総額 1000 ちょうど)',
    input: { token: 'jpyc', relayOn: 'all', forwarderOn: 'all', balance: '1000' },
    pay: [PAY_JPYC, true],
    checkout: [PAY_JPYC, true],
    tip: [m('btnSend', { amount: '1002 JPYC' }), false],
  },
  {
    name: 'relay の recover・JPYC・残高 1002 (Tip の総額ちょうど)',
    input: { token: 'jpyc', relayOn: 'all', forwarderOn: 'all', balance: '1002' },
    tip: [m('btnSend', { amount: '1002 JPYC' }), true],
  },
  // ---- Checkout のモバイル注文・事前 3% (お客様の負担。額面 1000 + 利用料 30 = 総額 1030) ----
  {
    name: 'モバイル注文・事前 3% (お客様の負担)・残高 1000 (総額 1030 に足りない)',
    input: { token: 'jpyc', mobile: { feeKind: 'preorder', feePayer: 'customer' }, relayOn: 'all', forwarderOn: 'all', balance: '1000' },
    checkout: [m('btnPay', { amount: '1030 JPYC' }), false],
  },
  {
    name: 'モバイル注文・事前 3% (お客様の負担)・残高 1030 (総額ちょうど)',
    input: { token: 'jpyc', mobile: { feeKind: 'preorder', feePayer: 'customer' }, relayOn: 'all', forwarderOn: 'all', balance: '1030' },
    checkout: [m('btnPay', { amount: '1030 JPYC' }), true],
  },
];
const balanceRows = BALANCE_TABLE.flatMap(({ name, input, ...byForm }) =>
  FORMS.flatMap((form): Array<Titled<ButtonRow>> => {
    const expected = byForm[form];
    return expected ? [[`${form}: ${name}`, { form, input, expected }]] : [];
  }),
);

describe('表 2: ボタンの表 (経路の類 × ウォレットの状態ごとの、ボタンの文言と押せるか)', () => {
  it.each([...buttonRows, ...balanceRows])('%s', async (_title, { form, input, expected }) => {
    await mount(form, input);
    const label = text(form, expected[0]);
    expect(observeButton(label)).toEqual([label, expected[1]]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 表 3: 経路が変わる・変わらない場面
// ---------------------------------------------------------------------------------------------------------------------
// (a) resolver に渡す chain。resolver の答えを chain ごとに変えて、聞かれた chain (askedOn) と、選ばれた経路 (hook の引数・
// ネットワーク手数料の行) の両方で固定する。Pay と Checkout はウォレットの chain・Tip は deployment の chain。
// resolveUsdcGaslessProvider は 3 つとも deployment の chain。
const RELAY_RECOVER_ROWS = {
  pay: [
    ['merchantRowAfterFee', '998 JPYC'],
    ['gasRowMerchant', '2 JPYC'],
    ['customerMerchantGas', '1000 JPYC'],
  ],
  checkout: [
    ['subtotalRow', '1000 JPYC'],
    ['gasRowMerchant', '2 JPYC'],
    ['totalRowMerchantGas', '1000 JPYC'],
  ],
  tip: [
    ['creatorRow', '1000 JPYC'],
    ['gasRow', '2 JPYC'],
    ['customerRow', '1002 JPYC'],
  ],
} satisfies Record<Form, Row[]>;
// relay の free と、Pimlico の JPYC は、明細の行が同じ (どちらも「無料 (OpenPay が負担)」)。区別は hook の引数でする。
const JPYC_FREE_ROWS = {
  pay: [
    ['merchantRowAfterFee', '1000 JPYC'],
    ['gasRowFree', m('gasRowRelayFree')],
    ['customerCustomerGas', '1000 JPYC'],
  ],
  checkout: [
    ['subtotalRow', '1000 JPYC'],
    ['gasRowFree', m('gasRowRelayFree')],
    ['totalRow', '1000 JPYC'],
  ],
  tip: [
    ['creatorRow', '1000 JPYC'],
    ['gasRowFree', m('gasRowRelayFree')],
    ['customerRow', '1000 JPYC'],
  ],
} satisfies Record<Form, Row[]>;
const CIRCLE_ROWS = {
  pay: [
    ['merchantRowAfterFee', '10 USDC'],
    ['gasRow', m('gasRowValue', { amount: '0.06 USDC' })],
    ['customerCustomerGas', '10.06 USDC'],
  ],
  checkout: [
    ['subtotalRow', '10 USDC'],
    ['gasRow', m('gasRowValue', { amount: '0.06 USDC' })],
    ['totalRow', '10.06 USDC'],
  ],
  tip: [
    ['creatorRow', '10 USDC'],
    ['gasRow', m('gasRowValue', { amount: '0.06 USDC' })],
    ['customerRow', '10.06 USDC'],
  ],
} satisfies Record<Form, Row[]>;
// Pimlico・USDC の sponsorship (額面 10 + 見積 0.1)。描いた後に token が USDC に変わる行で使う。
const USDC_SPONSORSHIP_ROWS = {
  pay: [
    ['merchantRowAfterFee', '10 USDC'],
    ['gasRow', m('gasRowValue', { amount: '0.1 USDC' })],
    ['customerCustomerGas', '10.1 USDC'],
  ],
  checkout: [
    ['subtotalRow', '10 USDC'],
    ['gasRow', m('gasRowValue', { amount: '0.1 USDC' })],
    ['totalRow', '10.1 USDC'],
  ],
  tip: [
    ['creatorRow', '10 USDC'],
    ['gasRow', m('gasRowValue', { amount: '0.1 USDC' })],
    ['customerRow', '10.1 USDC'],
  ],
} satisfies Record<Form, Row[]>;
const USDC_POLYGON_PAYLOAD = gaslessPayload(USDC_POLYGON, {
  merchantAmount: U('10'),
  feeAmount: 0n,
  gasReimbursement: U('0.1'),
  saleAmount: U('10'),
  networkFeeEquivalent: U('0.1'),
  circlePermitAmount: undefined,
});
// Pay と Checkout (ウォレットは Kaia): JPYC の resolver と forwarder は Kaia で聞かれ、USDC の resolver は Polygon で聞かれる。
const ASKED_ON_WALLET: AskedOn = { jpyc: [KAIROS], forwarder: [KAIROS], usdc: [AMOY] };
// 同じく Pay と Checkout で、経路が recover になったとき: recover の利用料の案内 (RecoverFeeNotice) も forwarder を聞き、
// こちらは deployment の chain (Polygon) で聞く (経路の判定とは別の呼び出し。今の動き)。
const ASKED_ON_WALLET_RECOVER: AskedOn = { jpyc: [KAIROS], forwarder: [KAIROS, AMOY], usdc: [AMOY] };
// Tip と未接続: どれも deployment の chain (Polygon) で聞かれる。
const ASKED_ON_DEPLOYMENT: AskedOn = { jpyc: [AMOY], forwarder: [AMOY], usdc: [AMOY] };

const CHAIN_TABLE: Case[] = [
  {
    name: 'JPYC (Polygon) の画面・ウォレットは Kaia・relay と forwarder は Kaia でだけ答える → Pay と Checkout は recover・Tip は Pimlico',
    input: { token: 'jpyc', wallet: 'wrong-chain', relayOn: [KAIROS], forwarderOn: [KAIROS] },
    hooks: OFF,
    health: true,
    pay: { askedOn: ASKED_ON_WALLET_RECOVER, rows: RELAY_RECOVER_ROWS.pay, button: ['btnSwitchChain', false] },
    checkout: { askedOn: ASKED_ON_WALLET_RECOVER, rows: RELAY_RECOVER_ROWS.checkout, button: ['btnSwitchChain', false] },
    tip: { hooks: SPONSORSHIP, askedOn: ASKED_ON_DEPLOYMENT, rows: JPYC_FREE_ROWS.tip, button: ['btnSwitchChain', false] },
  },
  {
    name: 'JPYC (Polygon) の画面・ウォレットは Kaia・relay と forwarder は Polygon でだけ答える → Pay と Checkout は Pimlico・Tip は recover',
    input: { token: 'jpyc', wallet: 'wrong-chain', relayOn: [AMOY], forwarderOn: [AMOY] },
    hooks: SPONSORSHIP,
    health: false,
    pay: { askedOn: ASKED_ON_WALLET, rows: JPYC_FREE_ROWS.pay, button: ['btnSwitchChain', false] },
    checkout: { askedOn: ASKED_ON_WALLET, rows: JPYC_FREE_ROWS.checkout, button: ['btnSwitchChain', false] },
    tip: { hooks: OFF, askedOn: ASKED_ON_DEPLOYMENT, rows: RELAY_RECOVER_ROWS.tip, button: ['btnSwitchChain', false] },
  },
  {
    name: 'JPYC (Polygon) の画面・ウォレットは Kaia・relay はどの chain でも・forwarder は Kaia でだけ → Pay と Checkout は recover・Tip は free',
    input: { token: 'jpyc', wallet: 'wrong-chain', relayOn: 'all', forwarderOn: [KAIROS] },
    hooks: OFF,
    health: true,
    pay: { askedOn: ASKED_ON_WALLET_RECOVER, rows: RELAY_RECOVER_ROWS.pay, button: ['btnSwitchChain', false] },
    checkout: { askedOn: ASKED_ON_WALLET_RECOVER, rows: RELAY_RECOVER_ROWS.checkout, button: ['btnSwitchChain', false] },
    tip: { askedOn: ASKED_ON_DEPLOYMENT, rows: JPYC_FREE_ROWS.tip, button: ['btnSwitchChain', false] },
  },
  {
    name: 'JPYC (Polygon) の画面・ウォレットは Kaia・recover の下限は Kaia だけ 5 JPYC → 3 つとも 2 JPYC (下限は deployment の chain で引く)',
    input: { token: 'jpyc', wallet: 'wrong-chain', relayOn: 'all', forwarderOn: 'all', floorJpyc: { [KAIROS]: '5' } },
    hooks: OFF,
    health: true,
    pay: { askedOn: ASKED_ON_WALLET_RECOVER, rows: RELAY_RECOVER_ROWS.pay, button: ['btnSwitchChain', false] },
    checkout: { askedOn: ASKED_ON_WALLET_RECOVER, rows: RELAY_RECOVER_ROWS.checkout, button: ['btnSwitchChain', false] },
    tip: { askedOn: ASKED_ON_DEPLOYMENT, rows: RELAY_RECOVER_ROWS.tip, button: ['btnSwitchChain', false] },
  },
  {
    name: 'USDC (Base) の画面・ウォレットは Arbitrum・Circle は Base でだけ答える → 3 つとも Circle (USDC の resolver は deployment の chain で聞く)',
    input: { token: 'usdc', wallet: 'wrong-chain', circleOn: [BASE], paymaster: 'erc20' },
    hooks: CIRCLE,
    health: false,
    pay: { askedOn: { jpyc: [ARBITRUM], forwarder: [ARBITRUM], usdc: [BASE] }, rows: CIRCLE_ROWS.pay, button: ['btnSwitchChain', false] },
    checkout: { askedOn: { jpyc: [ARBITRUM], forwarder: [ARBITRUM], usdc: [BASE] }, rows: CIRCLE_ROWS.checkout, button: ['btnSwitchChain', false] },
    tip: { askedOn: { jpyc: [BASE], forwarder: [BASE], usdc: [BASE] }, rows: CIRCLE_ROWS.tip, button: ['btnSwitchChain', false] },
  },
  {
    name: 'JPYC (Polygon) の画面・ウォレットは未接続・relay と forwarder は Polygon でだけ答える → 3 つとも recover (未接続は deployment の chain で聞く)',
    input: { token: 'jpyc', wallet: 'disconnected', relayOn: [AMOY], forwarderOn: [AMOY] },
    hooks: OFF,
    health: true,
    pay: { askedOn: ASKED_ON_DEPLOYMENT, rows: RELAY_RECOVER_ROWS.pay, button: ['btnConnect', true] },
    checkout: { askedOn: ASKED_ON_DEPLOYMENT, rows: RELAY_RECOVER_ROWS.checkout, button: ['btnConnect', true] },
    tip: { askedOn: ASKED_ON_DEPLOYMENT, rows: RELAY_RECOVER_ROWS.tip, button: ['btnConnect', true] },
  },
];

// (b) 通常決済になる条件。Pay と Checkout は「復元した通常決済の試み」(useStandardPayment の hasAttempt) でも通常決済になる。
// Tip は standard の engine を出さない限り useStandardPayment を呼ばないので、同じ入力でガスレスのまま。
const STANDARD_ATTEMPT_TABLE: Case[] = [
  {
    name: 'USDC・URL はガスレス・復元した通常決済の試みがある → Pay と Checkout は通常決済・Tip はガスレスのまま',
    input: { token: 'usdc', hasStandardAttempt: true },
    hooks: OFF,
    health: false,
    pay: {
      rows: [
        ['merchantRowAfterFee', '10 USDC'],
        ['gasRowStandard', m('gasRowStandardValue')],
        [m('customerStandard', { nativeToken: 'ETH' }), '10 USDC'],
      ],
      button: [m('btnPay', { amount: '10 USDC' }), true],
      mutate: ['standard', standardPayload(USDC_BASE, { merchantAmount: U('10'), feeAmount: 0n, saleAmount: U('10') })],
    },
    checkout: {
      rows: [
        ['subtotalRow', '10 USDC'],
        ['gasRowStandard', m('gasRowStandardValue')],
        [m('totalRowStandard', { nativeToken: 'ETH' }), '10 USDC'],
      ],
      button: [m('btnPay', { amount: '10 USDC' }), true],
      mutate: ['standard', checkoutStandardPayload(USDC_BASE, { merchantAmount: U('10'), feeAmount: 0n, saleAmount: U('10') })],
    },
    tip: {
      hooks: SPONSORSHIP,
      rows: [
        ['creatorRow', '10 USDC'],
        ['gasRow', m('gasRowValue', { amount: '0.1 USDC' })],
        ['customerRow', '10.1 USDC'],
      ],
      button: [m('btnSend', { amount: '10.1 USDC' }), true],
      mutate: [
        'gasless',
        gaslessPayload(USDC_BASE, {
          merchantAmount: U('10'),
          feeAmount: 0n,
          gasReimbursement: U('0.1'),
          saleAmount: U('10'),
          networkFeeEquivalent: U('0.1'),
          circlePermitAmount: undefined,
        }),
      ],
    },
  },
];

describe('表 3: 経路が変わる・変わらない場面', () => {
  describe('(a) resolver に渡す chain (Pay と Checkout = ウォレットの chain・Tip = deployment の chain)', () => {
    it.each(perForm(CHAIN_TABLE))('%s', async (_title, { form, input, expected }) => {
      const view = await mount(form, input);
      check(form, input, expected, view);
    });
  });

  describe('(b) 通常決済になる条件 (Pay と Checkout だけが、復元した試みと「通常決済に切替」で通常決済になる)', () => {
    it.each(perForm(STANDARD_ATTEMPT_TABLE))('%s', async (_title, { form, input, expected }) => {
      const view = await mount(form, input);
      check(form, input, expected, view);
    });

    // smart account が合わないウォレット (USDC・Pimlico)。Pay と Checkout は案内に「通常決済に切替」のボタンが出て、押すと
    // 通常決済になる。Tip の案内にはボタンが無く、ガスレスのまま (送れない)。
    const SA_INCOMPATIBLE: Input = { token: 'usdc', wallet: 'sa-incompatible' };
    const BEFORE_SWITCH = {
      pay: {
        hooks: SPONSORSHIP,
        health: false,
        rows: [
          ['merchantRowAfterFee', '10 USDC'],
          ['gasRow', m('gasRowValue', { amount: '0.1 USDC' })],
          ['customerCustomerGas', '10.1 USDC'],
        ],
        button: ['btnSaInit', false],
      },
      checkout: {
        hooks: SPONSORSHIP,
        health: false,
        rows: [
          ['subtotalRow', '10 USDC'],
          ['gasRow', m('gasRowValue', { amount: '0.1 USDC' })],
          ['totalRow', '10.1 USDC'],
        ],
        button: ['btnSaInit', false],
      },
      tip: {
        hooks: SPONSORSHIP,
        health: 'never',
        rows: [
          ['creatorRow', '10 USDC'],
          ['gasRow', m('gasRowValue', { amount: '0.1 USDC' })],
          ['customerRow', '10.1 USDC'],
        ],
        button: ['btnSaInit', false],
      },
    } satisfies Record<Form, RouteExpect>;
    const AFTER_SWITCH = {
      pay: {
        hooks: OFF,
        health: false,
        rows: [
          ['merchantRowAfterFee', '10 USDC'],
          ['gasRowStandard', m('gasRowStandardValue')],
          [m('customerStandard', { nativeToken: 'ETH' }), '10 USDC'],
        ],
        button: [m('btnPay', { amount: '10 USDC' }), true],
        mutate: ['standard', standardPayload(USDC_BASE, { merchantAmount: U('10'), feeAmount: 0n, saleAmount: U('10') })],
      },
      checkout: {
        hooks: OFF,
        health: false,
        rows: [
          ['subtotalRow', '10 USDC'],
          ['gasRowStandard', m('gasRowStandardValue')],
          [m('totalRowStandard', { nativeToken: 'ETH' }), '10 USDC'],
        ],
        button: [m('btnPay', { amount: '10 USDC' }), true],
        mutate: ['standard', checkoutStandardPayload(USDC_BASE, { merchantAmount: U('10'), feeAmount: 0n, saleAmount: U('10') })],
      },
    } satisfies Record<'pay' | 'checkout', RouteExpect>;

    it.each(['pay', 'checkout'] as const)('%s: smart account が合わない → 「通常決済に切替」を押すと通常決済になる', async (form) => {
      const view = await mount(form, SA_INCOMPATIBLE);
      check(form, SA_INCOMPATIBLE, BEFORE_SWITCH[form], view);

      forgetHookCalls();
      fireEvent.click(screen.getByRole('button', { name: SWITCH_TO_STANDARD }));
      await settle();

      check(form, SA_INCOMPATIBLE, AFTER_SWITCH[form], view);
    });

    it('tip: smart account が合わない → 「通常決済に切替」のボタンは無く、ガスレスのまま', async () => {
      const view = await mount('tip', SA_INCOMPATIBLE);
      check('tip', SA_INCOMPATIBLE, BEFORE_SWITCH.tip, view);
      expect(screen.queryByRole('button', { name: SWITCH_TO_STANDARD })).toBeNull();
    });
  });

  // 描いた後に、実際の入力が変わる場面。resolver の答えの表 (どの chain で relay / forwarder ありと答えるか) は変えない。
  // 経路の計算を memo するなら、ここで変わる入力 (deployment・ウォレットの chain・hasAttempt。「通常決済に切替」は (b)) を
  // 依存に入れること (入れ忘れると、ここの行が落ちる)。入力が変わらないフォーム (ウォレットの chain を見ない Tip など) は、
  // resolver を聞き直さなくてよい (聞かれた chain は、描いてからの全部の集合で見る)。
  describe('描いた後に入力が変わる (送る前は、どのフォームも経路を決め直す)', () => {
    // URL / params の token が JPYC → USDC に変わる (同じ Polygon・ウォレットもそのまま)。変わるのは deployment だけ。
    // JPYC の画面は relay。USDC の画面は、relay と答える token でないので Pimlico (3 つとも)。
    it.each(FORMS)('%s: params の token が変わる (同じ Polygon の JPYC → USDC) → 新しい deployment で決め直す', async (form) => {
      const view = await mount(form, { token: 'jpyc', amount: '10', relayOn: 'all' });
      const usdc: Input = { token: 'usdc', chain: 'polygon', amount: '10', relayOn: 'all' };
      await changeInput(view, form, usdc);
      check(
        form,
        usdc,
        {
          hooks: SPONSORSHIP,
          health: form === 'tip' ? 'never' : false,
          askedAbout: [JPYC_POLYGON, USDC_POLYGON],
          rows: USDC_SPONSORSHIP_ROWS[form],
          button: [m(form === 'tip' ? 'btnSend' : 'btnPay', { amount: '10.1 USDC' }), true],
          mutate: ['gasless', USDC_POLYGON_PAYLOAD],
        },
        view,
      );
    });

    // ウォレットが Kaia → Polygon に切り替わる (「ネットワークを切替え」の後)。relay と forwarder は Polygon でだけ答える。
    // 切り替える前は表 3 (a) の 2 行目と同じ入力 (Pay と Checkout は Kaia で聞いて Pimlico・Tip は Polygon で聞いて recover)。
    // 切り替えた後は 3 つとも recover。Pay と Checkout は Kaia と Polygon の両方で聞いたことになり、Tip は Polygon だけ。
    const ONLY_ON_POLYGON = { relayOn: [AMOY], forwarderOn: [AMOY] } satisfies Partial<Input>;
    const ASKED_ON_BOTH: AskedOn = { jpyc: [KAIROS, AMOY], forwarder: [KAIROS, AMOY], usdc: [AMOY] };
    const afterWalletSwitch = {
      pay: {
        askedOn: ASKED_ON_BOTH,
        button: [PAY_JPYC, true],
        mutate: ['relay', { merchant: MERCHANT, value: J('1000'), gasMode: 'merchant' }],
      },
      checkout: {
        askedOn: ASKED_ON_BOTH,
        button: [PAY_JPYC, true],
        mutate: ['relay', { merchant: MERCHANT, value: J('1000'), gasMode: 'merchant' }],
      },
      tip: {
        askedOn: ASKED_ON_DEPLOYMENT,
        button: [m('btnSend', { amount: '1002 JPYC' }), true],
        mutate: ['relay', { merchant: MERCHANT, value: J('1000'), gasMode: 'customer' }],
      },
    } satisfies Record<Form, Pick<RouteExpect, 'askedOn' | 'button' | 'mutate'>>;
    it.each(FORMS)('%s: ウォレットの chain が変わる (Kaia → Polygon) → Pay と Checkout は決め直す (Tip は元から Polygon で聞いている)', async (form) => {
      const view = await mount(form, { token: 'jpyc', wallet: 'wrong-chain', ...ONLY_ON_POLYGON });
      const onPolygon: Input = { token: 'jpyc', ...ONLY_ON_POLYGON };
      await changeInput(view, form, onPolygon);
      check(
        form,
        onPolygon,
        { hooks: OFF, health: form === 'tip' ? 'never' : true, rows: RELAY_RECOVER_ROWS[form], ...afterWalletSwitch[form] },
        view,
      );
    });

    // 描いた後に、useStandardPayment が「復元した通常決済の試みがある」を返すようになる (別の画面の要求が出たまま、など)。
    // 期待は (b) の表と同じ (Pay と Checkout は通常決済・Tip はガスレスのまま)。
    it.each(perForm(STANDARD_ATTEMPT_TABLE))('描いた後に見つかる → %s', async (_title, { form, input, expected }) => {
      const view = await mount(form, { ...input, hasStandardAttempt: undefined });
      await changeInput(view, form, input);
      check(form, input, expected, view);
    });
  });

  describe('(d) 経路の固定 (Pay と Checkout は送った後、試みの間は経路を変えない・Tip は固定しない)', () => {
    const RECOVER_PAYLOAD = { merchant: MERCHANT, value: J('1000'), gasMode: 'merchant' };

    // relay の recover で送った後に、useStandardPayment が hasAttempt を返すようになる (送る前なら通常決済に変わる入力)。
    // Pay と Checkout は recover のまま。もう一度押すと、通常決済でなく relay へ、同じ値で送る (表示だけでなく、送る先も固定)。
    it.each(['pay', 'checkout'] as const)(
      '%s: recover で送った後に hasAttempt が立っても recover のまま・もう一度押しても relay へ送る',
      async (form) => {
        const recover: Input = { token: 'jpyc', relayOn: 'all', forwarderOn: 'all' };
        const view = await mount(form, recover);
        fireEvent.click(screen.getByRole('button', { name: text(form, PAY_JPYC) }));
        expectMutates({ relay: [RECOVER_PAYLOAD] });

        const withAttempt: Input = { ...recover, hasStandardAttempt: true };
        await changeInput(view, form, withAttempt);
        check(form, withAttempt, { hooks: OFF, health: true, rows: RELAY_RECOVER_ROWS[form], button: [PAY_JPYC, true] }, view);

        fireEvent.click(screen.getByRole('button', { name: text(form, PAY_JPYC) }));
        expectMutates({ relay: [RECOVER_PAYLOAD, RECOVER_PAYLOAD] });
      },
    );

    // recover で送った後に、ウォレットが forwarder の無い chain (Kaia) へ移る (送る前なら relay の free に変わる入力)。
    // Pay と Checkout は recover のまま (利用料 2 JPYC の行が残る)。違う chain なので押せない。
    it.each(['pay', 'checkout'] as const)(
      '%s: recover で送った後にウォレットが forwarder の無い chain へ移っても recover のまま (free にならない)',
      async (form) => {
        const recover: Input = { token: 'jpyc', relayOn: 'all', forwarderOn: [AMOY] };
        const view = await mount(form, recover);
        fireEvent.click(screen.getByRole('button', { name: text(form, PAY_JPYC) }));

        const walletMoved: Input = { ...recover, wallet: 'wrong-chain' };
        await changeInput(view, form, walletMoved);
        check(
          form,
          walletMoved,
          {
            hooks: OFF,
            health: true,
            // 送る前は Polygon で、移った後は Kaia で聞いている (recover の利用料の案内は Polygon で聞く)。
            askedOn: { jpyc: [AMOY, KAIROS], forwarder: [AMOY, KAIROS], usdc: [AMOY] },
            rows: RELAY_RECOVER_ROWS[form],
            button: ['btnSwitchChain', false],
          },
          view,
        );
        expectMutates({ relay: [RECOVER_PAYLOAD] });
      },
    );

    // Tip は固定しない: relay の free で送った後に params の token が変わる (同じ Polygon の JPYC → USDC) と、新しい deployment の
    // 経路 (Pimlico) になり、もう一度押すと Pimlico へ送る。
    it('tip: relay で送った後でも、params の token が変わると経路を決め直す・もう一度押すと新しい経路へ送る', async () => {
      const view = await mount('tip', { token: 'jpyc', amount: '10', relayOn: 'all' });
      fireEvent.click(screen.getByRole('button', { name: text('tip', m('btnSend', { amount: '10 JPYC' })) }));
      const sentByRelay = { merchant: MERCHANT, value: J('10'), gasMode: 'customer' };
      expectMutates({ relay: [sentByRelay] });

      const usdc: Input = { token: 'usdc', chain: 'polygon', amount: '10', relayOn: 'all' };
      await changeInput(view, 'tip', usdc);
      const sendUsdc = m('btnSend', { amount: '10.1 USDC' });
      check(
        'tip',
        usdc,
        {
          hooks: SPONSORSHIP,
          health: 'never',
          askedAbout: [JPYC_POLYGON, USDC_POLYGON],
          rows: USDC_SPONSORSHIP_ROWS.tip,
          button: [sendUsdc, true],
        },
        view,
      );

      fireEvent.click(screen.getByRole('button', { name: text('tip', sendUsdc) }));
      expectMutates({ relay: [sentByRelay], gasless: [USDC_POLYGON_PAYLOAD] });
    });

    // Checkout だけ: 復元した relay の注文 (この会計と一致する、束縛した注文の記録) があるときは、resolver の答えでなく、
    // 記録の経路 (free / recover) になる。
    const OWN_NOTIFY = `${window.location.origin}/api/order/notify?h=alice`;
    const savedOrder = (routeKind: 'free' | 'recover') => {
      const { record } = bindingFixture(
        routeKind,
        {
          chainId: JPYC_POLYGON.chainId,
          tokenAddress: JPYC_POLYGON.address,
          merchant: MERCHANT,
          handle: 'alice',
          orderId: 'ord-1',
          items: [{ name: '商品', qty: 1, price: '1000' }],
        },
        routeKind === 'recover' ? J('998') : J('1000'),
        J('2'),
      );
      // 本物の hook は、支払いを復元したとき hasActiveIntent も立てる (同じ支払いの確かめが終わるまで、新しく払わせない)。
      return { orderDelivery: record, restoredIntent: record.intent, hasActiveIntent: true };
    };
    it.each([
      {
        name: 'resolver は「relay でない」と答えるが、復元した注文は recover → relay の recover',
        saved: 'recover' as const,
        resolvers: {},
        expected: { hooks: OFF, health: true, rows: RELAY_RECOVER_ROWS.checkout, button: [PAY_JPYC, false] } satisfies RouteExpect,
      },
      {
        name: 'resolver は「relay・forwarder あり」(recover) と答えるが、復元した注文は free → relay の free',
        saved: 'free' as const,
        resolvers: { relayOn: 'all', forwarderOn: 'all' } satisfies Partial<Input>,
        expected: { hooks: OFF, health: true, rows: JPYC_FREE_ROWS.checkout, button: [PAY_JPYC, false] } satisfies RouteExpect,
      },
    ].map((row): Titled<typeof row> => [`checkout: ${row.name}`, row]))('%s', async (_title, { saved, resolvers, expected }) => {
      const input: Input = { token: 'jpyc', ...resolvers };
      const view = await mount('checkout', input, {
        relayState: savedOrder(saved),
        checkoutExtra: { orderId: 'ord-1', webhook: OWN_NOTIFY },
      });
      check('checkout', input, expected, view);
    });
  });
});
