// /checkout (CheckoutForm) の支払い完了の枠 = 見出し「決済が完了しました」・説明・結果の行 (ガスレスの UserOp/Tx/ブロック・
// relay の Tx・通常決済の店舗送金/手数料/ブロック・受付番号)・「お店に知らせる / 注文を送る」・「注文状況を見る」・電子レシート・
// success_url への移動の案内・「ホームへ戻る」の描画を、出しうる状態ごとに固定する characterization test (第 9 回レビュー F-04・
// PR-23 の 7 本目・Q11)。
//
// CheckoutForm から表示だけの部品 (components/checkout/CheckoutCompletion.tsx) を切り出す前に、このテストを変更前のコードで green に
// し、切り出した後も無変更で green であることを確かめた。だから部品は直接 render しない: CheckoutForm を render して、描かれた
// DOM (要素・属性 (class 等すべて)・可視テキスト・入れ子・並び・要素のあいだのテキストノード) だけを見る。部品の props の形には
// 依存しない。
//
// 見る範囲: CheckoutForm の一番外の div の子のうち、最初の子が見出し「決済が完了しました」の p である要素 (= 完了の枠・ちょうど 1 つ)
// (復元した前の支払いの確定で、この会計の支払いでないと証明できたときは、見出しが「前に確認中だった支払いが完了しました。この画面の
// 支払いではありません。」に替わる = 第 10 回レビュー H-S。枠はどちらの見出しでも探し、どちらを出したかは期待の DOM で比べる)
// を子まで木にしたもの。枠の前の兄弟 (ふつうはお支払い額の section・受注を登録できないときはその案内) と後ろの兄弟 (「powered by」
// の p) の要素の種類と属性も見る (枠の前後にテキストノード等が紛れていないこと)。テキストノードはつながずに 1 つずつ比べる。
// 枠の中の別の部品 (「お店に知らせる」の NotifyShopButton・電子レシートの PayerReceiptCompletion) の中身は、期待する props で
// その部品を単独で描いた DOM と比べる。電子レシートに渡す候補 (candidateIds) は、PayerReceiptCompletion を実物のまま包んだ spy で
// 並びと値 (null / undefined の違いを含む) まで見る。
//
// 文言は 3 つのカタログで見る: ja・en と、CheckoutForm の文言の先頭に「⟦キー⟧」を付けたもの。successUserOp は ja と en で同じ値
// (「UserOp Hash」) なので、どのキーを出したかは 3 つめで見分ける。
//
// 状態 (下の CASES) は、枠の中の出し分けの条件を 1 つずつ単独で効かせる: 経路 (ガスレス・relay・通常決済) と経路ごとの data の
// 有無 (mock で別の経路の data も同時に持たせ、経路の判定だけで行が決まることを見る)・受付番号の出どころ (注文の束縛・前の
// 支払いの受注の控え・URL・読み直した画面では URL の番号を出さない)・「お店に知らせる」の有無・「注文状況を見る」の 3 条件
// (お渡し準備完了の flag・statusToken・受注を登録できない)・success_url の移動の案内 (redirectIn が null / >0 / 0・注文の束縛の
// 受け取りの確認の前後・受注を登録できない・読み直した画面)・「ホームへ戻る」の 2 条件。
//
// 単独で効かせられない条件 (ほかの条件と必ず同時に立つもの):
// - 経路ごとの行の条件のうち data の有無 (ガスレスの `gasless.data`・relay の `relay.data?.success`・通常決済の `standard.data`):
//   枠は `completed` のときだけ出て、completed は今の経路の data (と success) をそのまま要求する (ガスレスは gasless.data.success・
//   relay は relay.data.success・通常決済は standard.data)。だから今の経路の data が無い・成功でない状態では枠そのものが出ず、
//   経路の判定が立っている行で data の側だけを外せる状態が無い (その経路の data が無いときの「枠を出さない」は下の 2 状態で固定)。
// - 移動の案内の文言の `redirectIn !== null`: null は `> 0` でも偽になるので、外しても振る舞いは同じ (型の検査だけが止める)。
// - 受付番号の行の値の `(束縛 ?? 控え)?.orderId ?? params.orderId` の `??` (条件の `||` との違い): 2 つが別の値になるのは、選ばれた
//   束縛か受注の控えの orderId が空文字で、読み直しでなく、URL の orderId が空でないときだけ (`??` は空の行・`||` は URL の番号)。
//   この組み合わせは作れない: 束縛は lib/orderBind の canonicalOrder が作り、orderId が空 (trim・正規化の後も) なら
//   order_binding_mismatch で throw する (CheckoutForm は束縛を立てずに止める)。URL の orderId が空でなければ束縛の orderId はそれと
//   同じ値。受注の控えは lib/orderDeliveryContext の matchesOrderDeliveryContext が、URL の orderId があるときは控えの orderId が
//   それと同じものだけを選ぶ (空の控えは選ばれない)。だから `??` を `||` にしても、作れる状態では振る舞いは同じ。
//
// mock の作法は tests/components/CheckoutHeader.test.tsx に合わせる (hook は mockHook で ReturnType に型づけ)。

import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { polygonAmoy } from 'viem/chains';
import type { Address, Hex } from 'viem';
import messages from '@/messages/ja.json';
import enMessages from '@/messages/en.json';
import { mockHook } from '../_helpers/wagmiMock';
import { bindingFixture } from '../_helpers/orderBinding';
import { latestOrderDelivery } from '../_helpers/orderDeliveryView';

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
// お渡し準備完了通知の flag を切り替えられるようにする (既定 OFF・tests/components/CheckoutForm.test.tsx と同じ作法)。
const flags = vi.hoisted(() => ({ enableOrderPickup: false }));
// hermetic: 手元の shell の NEXT_PUBLIC_RECOVER_FEE_BPS に左右されないよう 0 に固定する。モバイル注文の利用料は OFF。
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      recoverFeeBps: 0,
      enableMobileOrderFee: false,
      get enableOrderPickup() {
        return flags.enableOrderPickup;
      },
    },
  };
});
// 「注文状況を見る」を押したときに音を解錠するか (primeChimeAudio) を見る。ほかの関数は実物のまま。
vi.mock('@/lib/successChime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/successChime')>();
  return { ...actual, primeChimeAudio: vi.fn() };
});
// 電子レシートに渡す候補 (candidateIds) を見るため、実物を包んだ spy にする (描画は実物のまま)。期待する DOM を作るときに
// 単独で描くのは包む前の実物 (realReceipt.Component) にして、spy の呼び出しは CheckoutForm の中の描画だけにする (期待の DOM を
// 作った後に候補を読んでも、CheckoutForm が渡した値を読む・#1025 の Codex レビュー)。
const realReceipt = vi.hoisted(() => ({
  Component: null as null | typeof import('@/components/PayerReceiptCompletion').PayerReceiptCompletion,
}));
vi.mock('@/components/PayerReceiptCompletion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/PayerReceiptCompletion')>();
  realReceipt.Component = actual.PayerReceiptCompletion;
  return { PayerReceiptCompletion: vi.fn(actual.PayerReceiptCompletion) };
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
import { primeChimeAudio } from '@/lib/successChime';
import { storeConfirmationSignature } from '@/lib/orderConfirmation';
import { resolveOrderDelivery, saveOrderDelivery, type OrderDelivery } from '@/lib/orderDelivery';
import { deploymentForSlug } from '@/lib/tokens';
import { env } from '@/lib/env';
import { orderPaymentContextKey } from '@/lib/orderPaidLookup';
import { isOrderTokenLike } from '@/lib/orderToken';
import { notifyShopData } from '@/components/checkout/notifyShopData';
import { NotifyShopButton, type NotifyShopData } from '@/components/NotifyShopButton';
import { PayerReceiptCompletion } from '@/components/PayerReceiptCompletion';
import { CheckoutForm } from '@/components/CheckoutForm';
import type { CheckoutItem, CheckoutParams } from '@/lib/url';

const MERCHANT: Address = '0x2222222222222222222222222222222222222222';
const CUSTOMER: Address = '0x9999999999999999999999999999999999999999';
const JPYC = (n: bigint) => n * 10n ** 18n;
const ITEMS: CheckoutItem[] = [{ name: 'チケット', qty: 1, price: '3000' }];
const SUCCESS_URL = 'https://shop.example.com/thanks';

// 経路ごとの結果 (hash は経路ごとに別の値にして、どの経路の値を出したかを見分ける)。
const GASLESS_DATA = {
  userOpHash: `0x${'aa'.repeat(32)}` as Hex,
  txHash: `0x${'bb'.repeat(32)}` as Hex,
  blockNumber: 99n,
  success: true,
};
const RELAY_TX: Hex = `0x${'ee'.repeat(32)}`;
const STANDARD_DATA = {
  merchantTxHash: `0x${'cc'.repeat(32)}` as Hex,
  feeTxHash: `0x${'dd'.repeat(32)}` as Hex,
  blockNumber: 123n,
};

// JPYC (Polygon) の会計 (test env の 'polygon' は Amoy に解決される)。
const jpycParams = (extra: Partial<CheckoutParams> = {}): CheckoutParams => ({
  to: MERCHANT,
  token: 'jpyc',
  chain: 'polygon',
  gas: 'customer',
  items: ITEMS,
  ...extra,
});
/** 同じ origin の受注の通知先 (モバイル注文の @handle の店 alice)。 */
const ownWebhook = () => `${window.location.origin}/api/order/notify?h=alice`;

// ---- hook の mock --------------------------------------------------------------------------------------------------

function setAccount(state: { isConnected: boolean; chainId?: number }) {
  mockHook(useAccount, {
    address: state.isConnected ? CUSTOMER : undefined,
    isConnected: state.isConnected,
    chainId: state.chainId,
  });
}

/** ガスレス (Pimlico) の結果。extra は、この画面から最後に送った支払いと別の intent の確定 (settledOtherIntent) と保存した params。 */
function setGasless(
  data: typeof GASLESS_DATA | undefined,
  extra: Pick<Partial<ReturnType<typeof useBatchPayment>>, 'settledOtherIntent' | 'variables'> = {},
) {
  mockHook(useBatchPayment, {
    ...extra,
    mutate: vi.fn(),
    retryReceipt: vi.fn(),
    isPending: false,
    isUnknown: false,
    isSuccess: data !== undefined,
    isError: false,
    data,
    error: null,
  } as Partial<ReturnType<typeof useBatchPayment>>);
}

let relayMutate: ReturnType<typeof vi.fn>;
/** relay (JPYC のガスレス) の結果・受注の控え・読み直した画面で復元した支払い。 */
function setRelay(
  state: {
    data?: ReturnType<typeof useJpycEip3009Payment>['data'];
    orderDelivery?: OrderDelivery;
    restoredIntent?: ReturnType<typeof useJpycEip3009Payment>['restoredIntent'];
  } = {},
) {
  relayMutate = vi.fn();
  mockHook(useJpycEip3009Payment, {
    mutate: relayMutate,
    isPending: false,
    data: state.data,
    error: null,
    retryRelay: vi.fn(),
    retrySamePayload: vi.fn(),
    recoveryState: null,
    restoredIntent: state.restoredIntent ?? null,
    orderDelivery: state.orderDelivery ?? null,
    previousPaymentPending: false,
    previousPaymentSameMerchant: false,
  } as Partial<ReturnType<typeof useJpycEip3009Payment>>);
}

let standardMutate: ReturnType<typeof vi.fn>;
/**
 * 通常決済の結果。phase は送金の段階・hasAttempt は通常決済の記録がある (経路を通常決済に固定する)・restoredFromStorage は
 * 読み直した画面で復元した支払い。
 */
function setStandard(
  state: {
    data?: { merchantTxHash: Hex; feeTxHash: Hex | undefined; blockNumber: bigint };
    phase?: ReturnType<typeof useStandardPayment>['phase'];
    hasAttempt?: boolean;
    restoredFromStorage?: boolean;
    /** 復元した支払いの中身 (hook が保存した印から戻す params)。 */
    lastSubmittedParams?: ReturnType<typeof useStandardPayment>['lastSubmittedParams'];
  } = {},
) {
  standardMutate = vi.fn();
  mockHook(useStandardPayment, {
    mutate: standardMutate,
    retryFee: vi.fn(),
    retryReceipt: vi.fn(),
    phase: state.phase ?? 'idle',
    isPending: false,
    isSuccess: state.data !== undefined,
    isError: false,
    isFeeError: false,
    isMerchantError: false,
    isUnknown: false,
    isMerchantUnknown: false,
    isFeeUnknown: false,
    data: state.data,
    error: null,
    merchantTxHash: state.data?.merchantTxHash,
    feeTxHash: state.data?.feeTxHash,
    merchantBlockNumber: state.data?.blockNumber,
    isRestoring: false,
    hasActiveIntent: false,
    hasAttempt: state.hasAttempt ?? false,
    restoredFromStorage: state.restoredFromStorage ?? false,
    restoredAttempt: state.restoredFromStorage ?? false,
    lastSubmittedParams: state.lastSubmittedParams ?? null,
  } as Partial<ReturnType<typeof useStandardPayment>>);
}

/** 通常決済の完了 (払った後の hook の状態)。 */
const standardDone = (
  data: { merchantTxHash: Hex; feeTxHash: Hex | undefined; blockNumber: bigint } = STANDARD_DATA,
  extra: {
    restoredFromStorage?: boolean;
    lastSubmittedParams?: ReturnType<typeof useStandardPayment>['lastSubmittedParams'];
  } = {},
) => setStandard({ data, phase: 'success', hasAttempt: true, ...extra });

/** ガスレス (Pimlico) の経路: JPYC の gasless provider を Pimlico にし、Smart Account を用意する。 */
function gaslessRoute() {
  vi.mocked(resolveJpycGaslessProvider).mockReturnValue('pimlico-7702');
  mockHook(useSmartAccount, {
    data: { smartAccountClient: {}, pimlicoClient: {} },
    isLoading: false,
    error: null,
  } as Partial<ReturnType<typeof useSmartAccount>>);
}

// 前の支払いの受注の控え (lib/orderDelivery)。店 alice・受付番号 saved-id・注文状況のトークン 's' × 43・3000 JPYC。
const SAVED_STATUS_TOKEN = 's'.repeat(43);
function savedOrderRecord(): OrderDelivery {
  const dep = deploymentForSlug('jpyc', 'polygon');
  return bindingFixture(
    'free',
    {
      chainId: dep.chainId,
      tokenAddress: dep.address,
      merchant: MERCHANT,
      handle: 'alice',
      orderId: 'saved-id',
      items: [{ name: 'Saved Tea', qty: 1, price: '3000' }],
      statusToken: SAVED_STATUS_TOKEN,
      description: 'Saved Table',
      customerMemo: 'Saved memo',
    },
    JPYC(3000n),
  ).record;
}
/** 控えの支払いが on-chain で確定した (受注を送る前)。txHash は bindingFixture の BIND_TX。 */
const SAVED_TX: Hex = `0x${'ab'.repeat(32)}`;
const paidSavedRecord = () => resolveOrderDelivery(savedOrderRecord(), SAVED_TX);
/** 読み直した画面で、控えの支払いを復元して確定した (tests/components/CheckoutForm.test.tsx の A2c と同じ)。 */
function restoredSavedPayment() {
  const record = paidSavedRecord();
  saveOrderDelivery(record);
  setRelay({ data: { txHash: SAVED_TX, success: true }, orderDelivery: record, restoredIntent: record.intent });
}
/** 読み直した画面で復元した relay の支払い (受注の控えなし)。 */
const RESTORED_INTENT: NonNullable<ReturnType<typeof useJpycEip3009Payment>['restoredIntent']> = {
  chainId: polygonAmoy.id,
  from: CUSTOMER,
  merchant: MERCHANT,
  merchantValue: JPYC(3000n).toString(),
  feeValue: '0',
  nonce: `0x${'12'.repeat(32)}`,
  validBefore: '9999999999',
  routeKind: 'free',
  issuedAt: 1_700_000_000_000,
};

const OTHER_MERCHANT: Address = '0x3333333333333333333333333333333333333333';
/** 読み直した画面で復元した通常決済の中身: paid の会計 (JPYC・Polygon・3000 JPYC) を払ったときに hook が保存する params。 */
function restoredStandardParams(paid: CheckoutParams): NonNullable<ReturnType<typeof useStandardPayment>['lastSubmittedParams']> {
  const dep = deploymentForSlug('jpyc', 'polygon');
  return {
    tokenAddress: dep.address,
    merchant: paid.to,
    merchantAmount: JPYC(3000n),
    feeReceiver: env.feeReceiver,
    feeAmount: 0n,
    chainId: dep.chainId,
    saleAmount: JPYC(3000n),
    contextKey: orderPaymentContextKey(paid, 'polygon') as Hex,
  };
}
/** 保存した Pimlico の intent の params (useBatchPayment の variables)。3000 JPYC を merchant へ。 */
function gaslessVariables(merchant: Address): NonNullable<ReturnType<typeof useBatchPayment>['variables']> {
  return {
    tokenAddress: deploymentForSlug('jpyc', 'polygon').address,
    merchant,
    merchantAmount: JPYC(3000n),
    feeReceiver: env.feeReceiver,
    feeAmount: 0n,
    saleAmount: JPYC(3000n),
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
let routerPush: ReturnType<typeof vi.fn>;

function setDefaults() {
  flags.enableOrderPickup = false;
  vi.mocked(resolveJpycGaslessProvider).mockReturnValue('eip3009-relay');
  vi.mocked(jpycForwarderFor).mockReturnValue(null);
  vi.mocked(resolvePaymasterMode).mockImplementation(() => 'sponsorship');
  routerPush = vi.fn();
  vi.mocked(useRouter).mockImplementation(() => ({ push: routerPush, replace: vi.fn() }) as unknown as ReturnType<typeof useRouter>);
  // 既定: 接続中で、ウォレットは要求のチェーン (Amoy) にいて、残高は足りる。
  setAccount({ isConnected: true, chainId: polygonAmoy.id });
  mockHook(useReadContract, {
    data: JPYC(10_000_000n),
    isLoading: false,
    isError: false,
    error: null,
  } as Partial<ReturnType<typeof useReadContract>>);
  mockHook(useSwitchChain, {
    switchChain: vi.fn(),
    isPending: false,
    error: null,
    variables: undefined,
  } as Partial<ReturnType<typeof useSwitchChain>>);
  setGasless(undefined);
  setRelay();
  setStandard();
  mockHook(useSmartAccount, { data: undefined, isLoading: false, error: null } as Partial<ReturnType<typeof useSmartAccount>>);
  for (const hook of [useGasQuoteUsdc, useGasQuoteJpyc]) {
    mockHook(hook, { data: undefined, isLoading: false, isError: false, error: null } as Partial<
      ReturnType<typeof useGasQuoteUsdc>
    >);
  }
  mockHook(useGasQuoteCircle, { data: undefined, error: null, fetchStatus: 'idle' } as Partial<
    ReturnType<typeof useGasQuoteCircle>
  >);
  // 受注の通知 (同じ origin の /api/order/notify) と支払いの記録の送信は、既定で ok:true を返す。
  fetchMock = vi.fn(async () => Response.json({ ok: true }));
  vi.stubGlobal('fetch', fetchMock);
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
}

const realLocation = window.location;
beforeEach(() => {
  vi.clearAllMocks();
  setDefaults();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
});

/** window.location.assign (success_url への移動) を spy にする。onAssign は移動を呼んだ時点に呼ぶ。 */
function stubAssign(onAssign?: (url: string) => void) {
  const assign = vi.fn((url: string) => onAssign?.(url));
  Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, assign } });
  return assign;
}

/** window.location.reload (「読み込み直す」) を spy にする。 */
function stubReload() {
  const reload = vi.fn();
  Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, reload } });
  return reload;
}

// ---- 文言のカタログ ----------------------------------------------------------------------------------------------

type Catalog = 'ja' | 'en' | 'keys';
type Messages = typeof messages;
type CheckoutKey = keyof Messages['CheckoutForm'];

// CheckoutForm の文言の先頭に「⟦キー⟧」を付けたカタログ (ja が元)。ja と en で値が同じキー (successUserOp) を出したことを
// 見分けるため。
const KEYED_MESSAGES: Messages = {
  ...messages,
  CheckoutForm: Object.fromEntries(
    Object.entries(messages.CheckoutForm).map(([key, value]) => [key, typeof value === 'string' ? `⟦${key}⟧${value}` : value]),
  ) as Messages['CheckoutForm'],
};

const catalogMessages = (c: Catalog): Messages =>
  c === 'ja' ? messages : c === 'en' ? (enMessages as Messages) : KEYED_MESSAGES;
const localeOf = (c: Catalog) => (c === 'en' ? 'en' : 'ja');

function renderIn(c: Catalog, ui: ReactElement) {
  return render(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <NextIntlClientProvider locale={localeOf(c)} messages={catalogMessages(c)}>
        {children}
      </NextIntlClientProvider>
    ),
  });
}

/** 文言のキーと、差し込む値 ({sec}・{amount})。 */
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

/** 支払うボタン (3000 JPYC)。 */
function payButton(container: HTMLElement, c: Catalog): HTMLElement {
  const name = tx(c, k('btnPay', { amount: '3000 JPYC' }));
  const found = Array.from(container.querySelectorAll('button')).filter((b) => b.textContent === name);
  expect(found).toHaveLength(1);
  return found[0];
}

// ---- DOM を木にして比べる ----------------------------------------------------------------------------------------

/** 要素を子まで木にしたもの。属性はすべて (class・type 等)、テキストは text node 1 つを 1 つの文字列で持つ (つながない)。 */
type Dom = { tag: string; attrs: Record<string, string>; children: DomNode[] };
type DomNode = string | Dom;
/** 枠の前後の兄弟: 要素は種類と属性だけ (中身は見ない)、テキストノードはその文字列。 */
type Sibling = { tag: string; attrs: Record<string, string> } | string | null;

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

function sibling(n: ChildNode | null): Sibling {
  if (n === null) return null;
  if (n.nodeType === Node.ELEMENT_NODE) {
    const el = n as Element;
    return { tag: el.tagName.toLowerCase(), attrs: attrsOf(el) };
  }
  return `#node-${n.nodeType}:${n.textContent ?? ''}`;
}

/**
 * CheckoutForm の一番外の div の子のうち、最初の子が見出し「決済が完了しました」の p である要素 (= 完了の枠)。この会計の支払いで
 * ない確定のときの見出し (foreignSettlementTitle) の枠も同じ枠として拾う (どちらの見出しかは期待の DOM で比べる)。
 */
function completionFrames(container: HTMLElement, c: Catalog): Element[] {
  const root = container.firstElementChild;
  expect(root).not.toBeNull();
  const titles = [tx(c, k('successTitle')), tx(c, k('foreignSettlementTitle'))];
  return Array.from(root!.children).filter(
    (el) => el.firstElementChild?.tagName === 'P' && titles.includes(el.firstElementChild.textContent ?? ''),
  );
}

function frameEl(container: HTMLElement, c: Catalog): HTMLElement {
  const frames = completionFrames(container, c);
  expect(frames).toHaveLength(1);
  return frames[0] as HTMLElement;
}

type Area = { prev: Sibling; nodes: DomNode[]; next: Sibling };

/** 完了の枠を子まで木にしたものと、前後の兄弟。枠がちょうど 1 つでなければ null (移動を呼んだ時点の記録用・throw しない)。 */
function readArea(container: HTMLElement, c: Catalog): Area | null {
  const frames = completionFrames(container, c);
  if (frames.length !== 1) return null;
  const frame = frames[0];
  return { prev: sibling(frame.previousSibling), nodes: nodes(frame, frame.nextSibling), next: sibling(frame.nextSibling) };
}

function completionArea(container: HTMLElement, c: Catalog): Area {
  frameEl(container, c);
  return readArea(container, c)!;
}

/**
 * 電子レシートに最後に渡した候補 (CheckoutForm の描画の中の呼び出し・期待の DOM の単独の描画は spy を通らない)。まだ呼ばれて
 * いなければ null (移動を呼んだ時点の記録用・throw しない)。
 */
function readReceiptIds(): unknown {
  const calls = vi.mocked(PayerReceiptCompletion).mock.calls;
  return calls.length === 0 ? null : calls[calls.length - 1][0].candidateIds;
}

function lastReceiptIds(): unknown {
  expect(vi.mocked(PayerReceiptCompletion).mock.calls.length).toBeGreaterThan(0);
  return readReceiptIds();
}

// ---- 期待する DOM ------------------------------------------------------------------------------------------------

const FRAME_CLASS = 'rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800';
const STATUS_LINK_CLASS =
  'mt-4 flex items-center justify-center rounded-xl border border-brand/30 bg-brand/5 px-4 py-3 text-sm font-semibold text-brand transition hover:bg-brand/10';
const REDIRECT_CLASS = 'mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between';
const REDIRECT_BUTTON_CLASS = 'rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700';
const RELOAD_BUTTON_CLASS =
  'mt-3 inline-flex min-h-11 items-center rounded-md bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700';
const HOME_BUTTON_CLASS =
  'mt-4 inline-block rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700';
// 枠の前の兄弟: ふつうはお支払い額の section。受注を登録できないときはその案内。
const AMOUNT_SECTION: Sibling = { tag: 'section', attrs: { class: 'rounded-2xl border border-slate-200 bg-white p-4 text-sm' } };
const TOO_OLD_ALERT: Sibling = {
  tag: 'p',
  attrs: { role: 'alert', class: 'rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900' },
};
// 枠の後ろの兄弟: 「powered by OpenPay」。
const POWERED_BY: Sibling = { tag: 'p', attrs: { class: 'pt-2 text-center text-[10px] text-slate-500' } };

const p = (cls: string, children: DomNode[]): Dom => ({ tag: 'p', attrs: { class: cls }, children });

/** 結果の行 (ResultRow)。copyable はコピーできる値 (jsdom は clipboard が無いので、名前を読み上げる span に落ちる)。 */
type Row = { label: Msg; value: string; copyable?: boolean };

function resultRow(c: Catalog, row: Row): Dom {
  const label = tx(c, row.label);
  const value: Dom = row.copyable
    ? {
      tag: 'span',
      attrs: { class: 'break-all font-mono ' },
      children: [{ tag: 'span', attrs: { class: 'sr-only' }, children: [label, ': '] }, row.value],
    }
    : { tag: 'span', attrs: { class: 'break-all font-mono' }, children: [row.value] };
  return {
    tag: 'div',
    attrs: { class: 'flex justify-between gap-2' },
    children: [
      { tag: 'dt', attrs: { class: 'opacity-70' }, children: [label] },
      { tag: 'dd', attrs: { class: 'min-w-0 flex-1 text-right' }, children: [value] },
    ],
  };
}

const GASLESS_ROWS: Row[] = [
  { label: k('successUserOp'), value: GASLESS_DATA.userOpHash, copyable: true },
  { label: k('successTx'), value: GASLESS_DATA.txHash, copyable: true },
  { label: k('successBlock'), value: '99' },
];
const relayRow = (txHash: string): Row => ({ label: k('successTx'), value: txHash, copyable: true });
const STANDARD_ROWS: Row[] = [
  { label: k('standardMerchantTxLabel'), value: STANDARD_DATA.merchantTxHash, copyable: true },
  { label: k('standardFeeTxLabel'), value: STANDARD_DATA.feeTxHash, copyable: true },
  { label: k('successBlock'), value: '123' },
];
const STANDARD_ROWS_NO_FEE: Row[] = [STANDARD_ROWS[0], STANDARD_ROWS[2]];
const orderRow = (id: string): Row => ({ label: k('orderIdLabel'), value: id });

/** 状態ごとに期待する完了の枠。 */
type Want = {
  /**
   * 復元した前の支払いの確定で、この会計の支払いでないと証明できた (第 10 回レビュー H-S): 見出しと説明が替わり (お礼を
   * 出さない)、「読み込み直す」が説明のすぐ下に出る。結果の行から下は同じ。
   */
  foreign?: boolean;
  /** 結果の行 (dl の子) の並び。 */
  rows: Row[];
  /** 「お店に知らせる / 注文を送る」に渡す中身。無ければ出さない。 */
  notify?: NotifyShopData;
  /** 「注文状況を見る」のリンク先。無ければ出さない。 */
  statusHref?: string;
  /** 電子レシートに渡す候補 (並び・null と undefined の違いも見る)。 */
  receiptIds: Array<string | null | undefined>;
  /** success_url への移動の案内: 'now' = 「移動しています…」・数 = 「N 秒後に…」。無ければ出さない。 */
  redirect?: 'now' | number;
  /** 「ホームへ戻る」を出す。 */
  home?: boolean;
  /** 枠の前の兄弟 (既定はお支払い額の section)。 */
  prev?: Sibling;
};

/** 枠の中の別の部品を、同じカタログで単独で描いた DOM。 */
function standaloneNodes(c: Catalog, ui: ReactElement): DomNode[] {
  const { container, unmount } = renderIn(c, ui);
  const out = nodes(container.firstChild, null);
  unmount();
  return out;
}

function expectedArea(c: Catalog, want: Want): Area {
  const children: DomNode[] = [
    p('font-semibold', [tx(c, k(want.foreign ? 'foreignSettlementTitle' : 'successTitle'))]),
    p('mt-1 text-xs', [tx(c, k(want.foreign ? 'foreignSettlementBody' : 'successBody'))]),
    ...(want.foreign
      ? [{ tag: 'button', attrs: { type: 'button', class: RELOAD_BUTTON_CLASS }, children: [tx(c, k('foreignSettlementReload'))] }]
      : []),
    { tag: 'dl', attrs: { class: 'mt-3 space-y-1 text-xs' }, children: want.rows.map((row) => resultRow(c, row)) },
  ];
  if (want.notify) {
    children.push({
      tag: 'div',
      attrs: { class: 'mt-4' },
      children: standaloneNodes(c, <NotifyShopButton {...want.notify} tone="panel" />),
    });
  }
  if (want.statusHref !== undefined) {
    children.push({ tag: 'a', attrs: { class: STATUS_LINK_CLASS, href: want.statusHref }, children: [tx(c, k('viewOrderStatus'))] });
  }
  // 包む前の実物で描く (spy の呼び出しを増やさない・上の realReceipt)。
  const RealPayerReceiptCompletion = realReceipt.Component!;
  children.push({
    tag: 'div',
    attrs: { class: 'mt-4' },
    children: standaloneNodes(c, <RealPayerReceiptCompletion candidateIds={want.receiptIds} />),
  });
  if (want.redirect !== undefined) {
    children.push({
      tag: 'div',
      attrs: { class: REDIRECT_CLASS },
      children: [
        p('text-xs', [
          want.redirect === 'now' ? tx(c, k('redirectingNow')) : tx(c, k('redirectingIn', { sec: String(want.redirect) })),
        ]),
        { tag: 'button', attrs: { type: 'button', class: REDIRECT_BUTTON_CLASS }, children: [tx(c, k('redirectNowButton'))] },
      ],
    });
  }
  if (want.home) {
    children.push({ tag: 'button', attrs: { type: 'button', class: HOME_BUTTON_CLASS }, children: [tx(c, k('returnHomeButton'))] });
  }
  return { prev: want.prev ?? AMOUNT_SECTION, nodes: [{ tag: 'div', attrs: { class: FRAME_CLASS }, children }], next: POWERED_BY };
}

/** 枠を描いた CheckoutForm と比べる (枠の DOM と電子レシートの候補を、期待の DOM を作る前に読む)。 */
function expectArea(container: HTMLElement, c: Catalog, want: Want) {
  const actual = completionArea(container, c);
  const receiptIds = lastReceiptIds();
  expect(receiptIds).toStrictEqual(want.receiptIds);
  expect(actual).toEqual(expectedArea(c, want));
}

/** 「お店に知らせる / 注文を送る」の中身 (JPYC・Polygon・3000 JPYC。payer は払ったウォレット・分からなければ undefined)。 */
const notifyFor = (params: CheckoutParams, txHash: string, payer?: Address): NotifyShopData =>
  notifyShopData({ params, customerPays: JPYC(3000n), deployment: deploymentForSlug('jpyc', 'polygon'), txHash, payer, chain: 'polygon' });

// 電子レシートの候補 [通常決済の店舗送金・ガスレスの Tx・ガスレスの UserOp・relay の Tx]。
const U = undefined;

// ---- 状態 ------------------------------------------------------------------------------------------------------

type Ctx = {
  c: Catalog;
  container: HTMLElement;
  rerender: (ui: ReactElement) => void;
  makeUi: () => ReactElement;
  /** run で読んだ値 (作った受付番号・注文状況のトークン)。 */
  got: Record<string, string>;
};

type Case = {
  name: string;
  setup?: () => void;
  params: () => CheckoutParams;
  /** 描いた後にすること (支払うボタンを押して結果を返す・受注の通知を待つ等)。 */
  run?: (ctx: Ctx) => Promise<void>;
  /** 期待する枠。null なら枠を出さない。 */
  want: (ctx: Ctx) => Want | null;
};

/** relay の経路で、同じ origin の受注の通知先がある会計の支払うボタンを押し、注文の束縛 (受付番号) を固めて送るまで待つ。 */
async function submitBoundRelay(ctx: Ctx) {
  fireEvent.click(payButton(ctx.container, ctx.c));
  // 署名までに注文の束縛 (lib/orderBind) を非同期で読むので、送るまで待つ。
  await waitFor(() => expect(relayMutate).toHaveBeenCalledOnce());
  const order = relayMutate.mock.calls[0][0].order as OrderDelivery['order'];
  ctx.got.boundOrderId = order.orderId;
  return order;
}

/** 通常決済の経路で支払うボタンを押し、完了 (店舗送金・手数料・ブロック) を返す。 */
function submitStandardThenDone(ctx: Ctx) {
  fireEvent.click(payButton(ctx.container, ctx.c));
  expect(standardMutate).toHaveBeenCalledOnce();
  standardDone();
  ctx.rerender(ctx.makeUi());
}

/** 送った受注の通知の body から、注文状況のトークンを読む。 */
async function statusTokenSent(ctx: Ctx) {
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === ownWebhook())).toBe(true));
  const call = fetchMock.mock.calls.find(([url]) => url === ownWebhook())!;
  const token = JSON.parse((call[1] as RequestInit).body as string).statusToken as string;
  expect(isOrderTokenLike(token)).toBe(true);
  ctx.got.statusToken = token;
}

const statusHref = (c: Catalog, token: string) => `/${localeOf(c)}/order/status?t=${token}`;

const CASES: Case[] = [
  // --- 経路ごとの行 ---
  {
    name: 'ガスレス (Pimlico) の完了: UserOp・Tx・ブロックの 3 行 (ブロックはコピーなし)・ホームへ戻る',
    setup: () => {
      gaslessRoute();
      setGasless(GASLESS_DATA);
    },
    params: () => jpycParams(),
    want: () => ({ rows: GASLESS_ROWS, receiptIds: [U, GASLESS_DATA.txHash, GASLESS_DATA.userOpHash, U], home: true }),
  },
  {
    name: 'relay の完了 (txHash あり): Tx の 1 行',
    setup: () => setRelay({ data: { txHash: RELAY_TX, success: true } }),
    params: () => jpycParams(),
    want: () => ({ rows: [relayRow(RELAY_TX)], receiptIds: [U, U, U, RELAY_TX], home: true }),
  },
  {
    name: '(mock だけ) relay の完了で txHash が null: 行なし・電子レシートの候補の 4 つめは null でなく undefined',
    setup: () => setRelay({ data: { txHash: null, success: true } }),
    params: () => jpycParams(),
    want: () => ({ rows: [], receiptIds: [U, U, U, U], home: true }),
  },
  {
    // relay の Tx の行の条件は値の有無 (truthy) で見る: 空文字なら行を出さない (null と同じ)。電子レシートの候補は
    // `?? undefined` なので空文字のまま渡る。
    name: '(hook からは来ない) relay の完了で txHash が空文字: 行なし・電子レシートの候補の 4 つめは空文字のまま',
    setup: () => setRelay({ data: { txHash: '' as Hex, success: true } }),
    params: () => jpycParams(),
    want: () => ({ rows: [], receiptIds: [U, U, U, ''], home: true }),
  },
  {
    name: '通常決済の完了 (手数料の Tx あり): 店舗送金・手数料・ブロックの 3 行',
    setup: () => standardDone(),
    params: () => jpycParams({ mode: 'standard' }),
    want: () => ({ rows: STANDARD_ROWS, receiptIds: [STANDARD_DATA.merchantTxHash, U, U, U], home: true }),
  },
  {
    name: '通常決済の完了 (手数料の Tx なし = 利用料 0): 店舗送金・ブロックの 2 行',
    setup: () => standardDone({ ...STANDARD_DATA, feeTxHash: undefined }),
    params: () => jpycParams({ mode: 'standard' }),
    want: () => ({ rows: STANDARD_ROWS_NO_FEE, receiptIds: [STANDARD_DATA.merchantTxHash, U, U, U], home: true }),
  },
  {
    name: '(hook からは来ない) 通常決済の手数料の Tx が空文字: 手数料の行を出さない',
    setup: () => standardDone({ ...STANDARD_DATA, feeTxHash: '' as Hex }),
    params: () => jpycParams({ mode: 'standard' }),
    want: () => ({ rows: STANDARD_ROWS_NO_FEE, receiptIds: [STANDARD_DATA.merchantTxHash, U, U, U], home: true }),
  },
  {
    name: '(mock だけ) relay の経路でガスレスと通常決済の data もある: relay の行だけ (電子レシートの候補は 4 つとも読む)',
    setup: () => {
      setRelay({ data: { txHash: RELAY_TX, success: true } });
      setGasless(GASLESS_DATA);
      setStandard({ data: STANDARD_DATA });
    },
    params: () => jpycParams(),
    want: () => ({
      rows: [relayRow(RELAY_TX)],
      receiptIds: [STANDARD_DATA.merchantTxHash, GASLESS_DATA.txHash, GASLESS_DATA.userOpHash, RELAY_TX],
      home: true,
    }),
  },
  {
    name: '(mock だけ) 通常決済の経路でガスレスと relay の data もある: 通常決済の行だけ',
    setup: () => {
      standardDone();
      setGasless(GASLESS_DATA);
      setRelay({ data: { txHash: RELAY_TX, success: true } });
    },
    params: () => jpycParams({ mode: 'standard' }),
    want: () => ({
      rows: STANDARD_ROWS,
      receiptIds: [STANDARD_DATA.merchantTxHash, GASLESS_DATA.txHash, GASLESS_DATA.userOpHash, RELAY_TX],
      home: true,
    }),
  },
  {
    name: '(mock だけ) ガスレスの経路で relay と通常決済の data もある: ガスレスの行だけ',
    setup: () => {
      gaslessRoute();
      setGasless(GASLESS_DATA);
      setRelay({ data: { txHash: RELAY_TX, success: true } });
      setStandard({ data: STANDARD_DATA });
    },
    params: () => jpycParams(),
    want: () => ({
      rows: GASLESS_ROWS,
      receiptIds: [STANDARD_DATA.merchantTxHash, GASLESS_DATA.txHash, GASLESS_DATA.userOpHash, RELAY_TX],
      home: true,
    }),
  },
  // --- 枠を出さない (外側の条件 completed は CheckoutForm に残る) ---
  {
    name: 'relay の結果が保留 (未完了): 枠を出さない',
    setup: () => setRelay({ data: { txHash: RELAY_TX, success: false, pending: true } }),
    params: () => jpycParams(),
    want: () => null,
  },
  {
    name: '(mock だけ) 通常決済の経路でガスレスの data だけある (今の経路は未完了): 枠を出さない',
    setup: () => setGasless(GASLESS_DATA),
    params: () => jpycParams({ mode: 'standard' }),
    want: () => null,
  },
  // --- 受付番号の行 ---
  {
    name: 'URL の受付番号だけ (店頭のモバイル注文 @handle なので「お店に知らせる」は出ない): 受付番号の行 (コピーなし)',
    setup: () => setRelay({ data: { txHash: RELAY_TX, success: true } }),
    params: () => jpycParams({ orderId: 'ORD-1', storeHandle: 'cafe' }),
    want: () => ({ rows: [relayRow(RELAY_TX), orderRow('ORD-1')], receiptIds: [U, U, U, RELAY_TX], home: true }),
  },
  {
    name: '注文の束縛だけ (同じ origin の受注・URL に番号が無く送る前に作った): 作った番号の行',
    params: () => jpycParams({ webhook: ownWebhook() }),
    run: async (ctx) => {
      await submitBoundRelay(ctx);
      setRelay({ data: { txHash: RELAY_TX, success: true } });
      ctx.rerender(ctx.makeUi());
    },
    want: ({ got }) => ({ rows: [relayRow(RELAY_TX), orderRow(got.boundOrderId)], receiptIds: [U, U, U, RELAY_TX], home: true }),
  },
  {
    name: '(mock だけ) 前の支払いの受注の控え (matchingDelivery) だけ (読み直しでない・URL に番号なし): 控えの番号の行',
    setup: () => setRelay({ data: { txHash: RELAY_TX, success: true }, orderDelivery: savedOrderRecord() }),
    params: () => jpycParams({ webhook: ownWebhook() }),
    want: () => ({ rows: [relayRow(RELAY_TX), orderRow('saved-id')], receiptIds: [U, U, U, RELAY_TX], home: true }),
  },
  {
    name: '注文の束縛と受注の控えの両方: 束縛の番号を先に見る',
    params: () => jpycParams({ webhook: ownWebhook() }),
    run: async (ctx) => {
      await submitBoundRelay(ctx);
      setRelay({ data: { txHash: RELAY_TX, success: true }, orderDelivery: savedOrderRecord() });
      ctx.rerender(ctx.makeUi());
    },
    want: ({ got }) => {
      expect(got.boundOrderId).not.toBe('saved-id');
      return { rows: [relayRow(RELAY_TX), orderRow(got.boundOrderId)], receiptIds: [U, U, U, RELAY_TX], home: true };
    },
  },
  {
    name: '読み直した画面で復元した relay の支払いと一致する受注の控え (URL に番号なし): 控えの番号の行・電子レシートは作らない',
    setup: restoredSavedPayment,
    params: () => jpycParams({ webhook: ownWebhook() }),
    run: async () => {
      // 控えの受注を届け終わるまで待つ (読み直した画面でも受注は届ける)。
      await waitFor(() => expect(latestOrderDelivery()).toEqual({ kind: 'empty' }));
    },
    want: () => ({ rows: [relayRow(SAVED_TX), orderRow('saved-id')], receiptIds: [U, U, U, SAVED_TX], home: true }),
  },
  {
    // 受付番号つきの会計 = 注文リンク。注文リンクの鍵を持たない復元は、2026-11-05 より前に保存した同じ注文リンクの支払いで
    // ありうるので鍵では比べず、受取先と合計がこの会計と同じ = 今までどおりの見出し (第 10 回レビュー H-S・Codex MUST 1)。
    name: '読み直した画面で復元した relay の支払い (控えなし) + URL の受付番号: 受付番号の行を出さない・「お店に知らせる」も出さない',
    setup: () => setRelay({ data: { txHash: RELAY_TX, success: true }, restoredIntent: RESTORED_INTENT }),
    params: () => jpycParams({ orderId: 'ORD-9' }),
    want: () => ({ rows: [relayRow(RELAY_TX)], receiptIds: [U, U, U, RELAY_TX], home: true }),
  },
  {
    name: '読み直した画面で復元した relay の支払い (控えなし・受取先も合計もこの会計と同じ): 今までどおりの見出し',
    setup: () => setRelay({ data: { txHash: RELAY_TX, success: true }, restoredIntent: RESTORED_INTENT }),
    params: () => jpycParams(),
    want: () => ({ rows: [relayRow(RELAY_TX)], receiptIds: [U, U, U, RELAY_TX], home: true }),
  },
  {
    name: '読み直した画面で復元した relay の支払い (控えなし・別の店): この会計の支払いでない見出しと「読み込み直す」',
    setup: () =>
      setRelay({ data: { txHash: RELAY_TX, success: true }, restoredIntent: { ...RESTORED_INTENT, merchant: OTHER_MERCHANT } }),
    params: () => jpycParams(),
    want: () => ({ foreign: true, rows: [relayRow(RELAY_TX)], receiptIds: [U, U, U, RELAY_TX], home: true }),
  },
  {
    name: '読み直した画面で復元した通常決済 (別のお店の会計): この会計の支払いでない見出しと「読み込み直す」',
    setup: () =>
      standardDone(STANDARD_DATA, {
        restoredFromStorage: true,
        lastSubmittedParams: restoredStandardParams(jpycParams({ mode: 'standard', to: OTHER_MERCHANT })),
      }),
    params: () => jpycParams({ mode: 'standard' }),
    want: () => ({ foreign: true, rows: STANDARD_ROWS, receiptIds: [STANDARD_DATA.merchantTxHash, U, U, U], home: true }),
  },
  {
    name: '読み直した画面で復元した通常決済 (会計の鍵がこの会計): 今までどおりの見出し',
    setup: () =>
      standardDone(STANDARD_DATA, {
        restoredFromStorage: true,
        lastSubmittedParams: restoredStandardParams(jpycParams({ mode: 'standard' })),
      }),
    params: () => jpycParams({ mode: 'standard' }),
    want: () => ({ rows: STANDARD_ROWS, receiptIds: [STANDARD_DATA.merchantTxHash, U, U, U], home: true }),
  },
  {
    name: 'ガスレス: 別の intent の確定 (保存した params の受取先が別の店): この会計の支払いでない見出しと「読み込み直す」',
    setup: () => {
      gaslessRoute();
      setGasless(GASLESS_DATA, { settledOtherIntent: true, variables: gaslessVariables(OTHER_MERCHANT) });
    },
    params: () => jpycParams(),
    want: () => ({ foreign: true, rows: GASLESS_ROWS, receiptIds: [U, GASLESS_DATA.txHash, GASLESS_DATA.userOpHash, U], home: true }),
  },
  {
    name: 'ガスレス: 別の intent の確定 (保存した params の受取先・token・売上の額がこの会計と同じ): 今までどおりの見出し',
    setup: () => {
      gaslessRoute();
      setGasless(GASLESS_DATA, { settledOtherIntent: true, variables: gaslessVariables(MERCHANT) });
    },
    params: () => jpycParams(),
    want: () => ({ rows: GASLESS_ROWS, receiptIds: [U, GASLESS_DATA.txHash, GASLESS_DATA.userOpHash, U], home: true }),
  },
  {
    name: '読み直した画面で復元した通常決済 + URL の受付番号: 受付番号の行を出さない',
    setup: () => standardDone(STANDARD_DATA, { restoredFromStorage: true }),
    params: () => jpycParams({ mode: 'standard', orderId: 'ORD-9' }),
    want: () => ({ rows: STANDARD_ROWS, receiptIds: [STANDARD_DATA.merchantTxHash, U, U, U], home: true }),
  },
  {
    name: '(URL からは来ない) 受付番号が空文字: 受付番号の行を出さない',
    setup: () => setRelay({ data: { txHash: RELAY_TX, success: true } }),
    params: () => jpycParams({ orderId: '' }),
    want: () => ({ rows: [relayRow(RELAY_TX)], receiptIds: [U, U, U, RELAY_TX], home: true }),
  },
  // --- 「お店に知らせる / 注文を送る」 ---
  {
    name: '受付番号つきの遠隔の注文 (relay): 受付番号の行と「お店に知らせる」(確認の署名の前)',
    setup: () => setRelay({ data: { txHash: RELAY_TX, success: true } }),
    params: () => jpycParams({ orderId: 'ORD-7' }),
    want: () => ({
      rows: [relayRow(RELAY_TX), orderRow('ORD-7')],
      notify: notifyFor(jpycParams({ orderId: 'ORD-7' }), RELAY_TX),
      receiptIds: [U, U, U, RELAY_TX],
      home: true,
    }),
  },
  {
    name: '何度でも使える注文リンク (ship=ask)・送り先が LINE・確認の署名あり: 「LINE で送る」(リンクの本文に商品・額・Tx Hash・署名)',
    setup: () => {
      const signedTx: Hex = `0x${'ef'.repeat(32)}`;
      setRelay({ data: { txHash: signedTx, success: true } });
      storeConfirmationSignature({ chain: 'polygon', shop: MERCHANT, txHash: signedTx }, `0x${'1b'.repeat(65)}`);
    },
    params: () => jpycParams({ ship: 'ask', contact: { kind: 'line', id: '@openpay' } }),
    want: () => ({
      rows: [relayRow(`0x${'ef'.repeat(32)}`)],
      notify: notifyFor(jpycParams({ ship: 'ask', contact: { kind: 'line', id: '@openpay' } }), `0x${'ef'.repeat(32)}`),
      receiptIds: [U, U, U, `0x${'ef'.repeat(32)}`],
      home: true,
    }),
  },
  {
    name: '受付番号つきの遠隔の注文 (通常決済で払った): 「お店に知らせる」の払ったウォレットは送ったときの接続先',
    params: () => jpycParams({ mode: 'standard', orderId: 'ORD-8' }),
    run: async (ctx) => submitStandardThenDone(ctx),
    want: () => ({
      rows: [...STANDARD_ROWS, orderRow('ORD-8')],
      notify: notifyFor(jpycParams({ mode: 'standard', orderId: 'ORD-8' }), STANDARD_DATA.merchantTxHash, CUSTOMER),
      receiptIds: [STANDARD_DATA.merchantTxHash, U, U, U],
      home: true,
    }),
  },
  // --- 「注文状況を見る」 ---
  {
    name: 'お渡し準備完了 ON・通常決済で払って受注を送った (statusToken あり): 「注文状況を見る」',
    setup: () => {
      flags.enableOrderPickup = true;
    },
    params: () => jpycParams({ mode: 'standard', webhook: ownWebhook() }),
    run: async (ctx) => {
      submitStandardThenDone(ctx);
      await statusTokenSent(ctx);
    },
    want: ({ c, got }) => ({
      rows: STANDARD_ROWS,
      statusHref: statusHref(c, got.statusToken),
      receiptIds: [STANDARD_DATA.merchantTxHash, U, U, U],
      home: true,
    }),
  },
  {
    // 「お店に知らせる」と「注文状況を見る」が両方出る状態 (2 つの並びを固定する)。同じ origin の受注の通知先があって @handle の
    // 無い、受付番号つきの会計 (遠隔の注文)。
    name: 'お渡し準備完了 ON・受付番号つきの遠隔の注文を通常決済で払って受注を送った: 「お店に知らせる」の後に「注文状況を見る」',
    setup: () => {
      flags.enableOrderPickup = true;
    },
    params: () => jpycParams({ mode: 'standard', orderId: 'ORD-5', webhook: ownWebhook() }),
    run: async (ctx) => {
      submitStandardThenDone(ctx);
      await statusTokenSent(ctx);
    },
    want: ({ c, got }) => ({
      rows: [...STANDARD_ROWS, orderRow('ORD-5')],
      notify: notifyFor(jpycParams({ mode: 'standard', orderId: 'ORD-5', webhook: ownWebhook() }), STANDARD_DATA.merchantTxHash, CUSTOMER),
      statusHref: statusHref(c, got.statusToken),
      receiptIds: [STANDARD_DATA.merchantTxHash, U, U, U],
      home: true,
    }),
  },
  {
    name: 'お渡し準備完了 ON・statusToken なし (受注を送らない会計): 出さない',
    setup: () => {
      flags.enableOrderPickup = true;
      standardDone();
    },
    params: () => jpycParams({ mode: 'standard' }),
    want: () => ({ rows: STANDARD_ROWS, receiptIds: [STANDARD_DATA.merchantTxHash, U, U, U], home: true }),
  },
  {
    name: 'お渡し準備完了 OFF・読み直した画面で受注を届けた (控えの statusToken を受け取る): 出さない',
    setup: restoredSavedPayment,
    params: () => jpycParams({ orderId: 'saved-id', webhook: ownWebhook() }),
    run: async () => {
      await waitFor(() => expect(latestOrderDelivery()).toEqual({ kind: 'empty' }));
    },
    want: () => ({ rows: [relayRow(SAVED_TX), orderRow('saved-id')], receiptIds: [U, U, U, SAVED_TX], home: true }),
  },
  {
    name: 'お渡し準備完了 ON・読み直した画面で受注を届けた (控えの statusToken): 出す',
    setup: () => {
      flags.enableOrderPickup = true;
      restoredSavedPayment();
    },
    params: () => jpycParams({ orderId: 'saved-id', webhook: ownWebhook() }),
    run: async () => {
      await waitFor(() => expect(latestOrderDelivery()).toEqual({ kind: 'empty' }));
    },
    want: ({ c }) => ({
      rows: [relayRow(SAVED_TX), orderRow('saved-id')],
      statusHref: statusHref(c, SAVED_STATUS_TOKEN),
      receiptIds: [U, U, U, SAVED_TX],
      home: true,
    }),
  },
  {
    name: 'お渡し準備完了 ON・statusToken あり・受注が古すぎて登録できない (orderNotifyTooOld): 出さない (枠の前に案内)',
    setup: () => {
      flags.enableOrderPickup = true;
      fetchMock.mockImplementation(async () => Response.json({ ok: false, error: 'tx_too_old' }, { status: 422 }));
    },
    params: () => jpycParams({ mode: 'standard', webhook: ownWebhook() }),
    run: async (ctx) => {
      submitStandardThenDone(ctx);
      await statusTokenSent(ctx);
      await waitFor(() => expect(ctx.container.querySelector('p[role="alert"]')?.textContent).toBe(tx(ctx.c, k('orderNotifyTooOld'))));
    },
    want: () => ({ rows: STANDARD_ROWS, receiptIds: [STANDARD_DATA.merchantTxHash, U, U, U], home: true, prev: TOO_OLD_ALERT }),
  },
  // --- success_url への移動の案内と「ホームへ戻る」 ---
  {
    name: 'success_url あり・カウントダウンの前 (redirectIn が null): 「移動しています…」と「今すぐ」・ホームは出さない',
    setup: () => setRelay({ data: { txHash: RELAY_TX, success: true } }),
    params: () => jpycParams({ successUrl: SUCCESS_URL }),
    want: () => ({ rows: [relayRow(RELAY_TX)], receiptIds: [U, U, U, RELAY_TX], redirect: 'now' }),
  },
  {
    name: 'success_url あり・払った直後 (redirectIn が 3): 「3 秒後に…」',
    setup: () => {
      vi.useFakeTimers();
    },
    params: () => jpycParams({ mode: 'standard', successUrl: SUCCESS_URL }),
    run: async (ctx) => submitStandardThenDone(ctx),
    want: () => ({ rows: STANDARD_ROWS, receiptIds: [STANDARD_DATA.merchantTxHash, U, U, U], redirect: 3 }),
  },
  {
    name: 'success_url あり・注文の束縛あり・受注の受け取りを確かめる前: 移動の案内もホームも出さない',
    setup: () => {
      // 受注の通知の応答を返さない (確かめる前のまま)。
      fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    },
    params: () => jpycParams({ webhook: ownWebhook(), successUrl: SUCCESS_URL }),
    run: async (ctx) => {
      const order = await submitBoundRelay(ctx);
      const record = resolveOrderDelivery(bindingFixture('free', order, JPYC(3000n)).record, RELAY_TX);
      saveOrderDelivery(record);
      setRelay({ data: { txHash: RELAY_TX, success: true }, orderDelivery: record });
      ctx.rerender(ctx.makeUi());
      await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === ownWebhook())).toBe(true));
    },
    want: ({ got }) => ({ rows: [relayRow(RELAY_TX), orderRow(got.boundOrderId)], receiptIds: [U, U, U, RELAY_TX] }),
  },
  {
    name: 'success_url あり・受注が古すぎて登録できない: 移動の案内もホームも出さない (枠の前に案内)',
    setup: () => {
      fetchMock.mockImplementation(async () => Response.json({ ok: false, error: 'tx_too_old' }, { status: 422 }));
    },
    params: () => jpycParams({ mode: 'standard', webhook: ownWebhook(), successUrl: SUCCESS_URL }),
    run: async (ctx) => {
      submitStandardThenDone(ctx);
      await waitFor(() => expect(ctx.container.querySelector('p[role="alert"]')?.textContent).toBe(tx(ctx.c, k('orderNotifyTooOld'))));
    },
    want: () => ({ rows: STANDARD_ROWS, receiptIds: [STANDARD_DATA.merchantTxHash, U, U, U], prev: TOO_OLD_ALERT }),
  },
  {
    name: 'success_url あり・読み直した画面で復元した relay の支払い: 移動の案内は出さずホームへ戻る',
    setup: () => setRelay({ data: { txHash: RELAY_TX, success: true }, restoredIntent: RESTORED_INTENT }),
    params: () => jpycParams({ successUrl: SUCCESS_URL }),
    want: () => ({ rows: [relayRow(RELAY_TX)], receiptIds: [U, U, U, RELAY_TX], home: true }),
  },
  {
    name: 'success_url あり・読み直した画面で復元した通常決済: 移動の案内は出さずホームへ戻る',
    setup: () => standardDone(STANDARD_DATA, { restoredFromStorage: true }),
    params: () => jpycParams({ mode: 'standard', successUrl: SUCCESS_URL }),
    want: () => ({ rows: STANDARD_ROWS, receiptIds: [STANDARD_DATA.merchantTxHash, U, U, U], home: true }),
  },
  {
    name: '(URL からは来ない) success_url が空文字: 移動の案内は出さずホームへ戻る',
    setup: () => setRelay({ data: { txHash: RELAY_TX, success: true } }),
    params: () => jpycParams({ successUrl: '' }),
    want: () => ({ rows: [relayRow(RELAY_TX)], receiptIds: [U, U, U, RELAY_TX], home: true }),
  },
];

const CATALOGS: ReadonlyArray<[string, Catalog]> = [
  ['ja', 'ja'],
  ['en', 'en'],
  ['文言のキー (値が同じキーを見分ける)', 'keys'],
];

/** 状態を 1 つ描いて、run まで済ませる。 */
async function renderCase(c: Catalog, kase: Pick<Case, 'setup' | 'params' | 'run'>): Promise<Ctx> {
  kase.setup?.();
  const params = kase.params();
  const makeUi = () => <CheckoutForm params={params} />;
  const { container, rerender } = renderIn(c, makeUi());
  const ctx: Ctx = { c, container, rerender, makeUi, got: {} };
  await kase.run?.(ctx);
  return ctx;
}

describe('CheckoutForm — 支払い完了の枠 (CheckoutCompletion の characterization・第 9 回レビュー F-04)', () => {
  it('状態の名前は重ならない', () => {
    expect(new Set(CASES.map((c) => c.name)).size).toBe(CASES.length);
  });

  describe.each(CATALOGS)('%s', (_label, catalog) => {
    // 名前は %s で渡す ($name だと長い名前が途中で切れて、似た状態の名前が同じに見える)。
    it.each(CASES.map((kase) => [kase.name, kase] as const))('%s', async (_name, kase) => {
      const ctx = await renderCase(catalog, kase);
      const want = kase.want(ctx);
      if (want === null) {
        expect(completionFrames(ctx.container, catalog)).toHaveLength(0);
        return;
      }
      expectArea(ctx.container, catalog, want);
    });
  });

  // 押したときの呼び先。
  describe('押したとき', () => {
    it('「今すぐ確認ページへ」: success_url に結果を付けて移動する (doRedirect)', async () => {
      const assign = stubAssign();
      standardDone();
      const ctx = await renderCase('ja', { params: () => jpycParams({ mode: 'standard', orderId: 'ORD-1', successUrl: SUCCESS_URL }) });
      const button = Array.from(frameEl(ctx.container, 'ja').querySelectorAll('button')).find(
        (b) => b.textContent === tx('ja', k('redirectNowButton')),
      );
      expect(button).toBeDefined();
      fireEvent.click(button!);
      expect(assign).toHaveBeenCalledTimes(1);
      expect(assign).toHaveBeenCalledWith(
        `${SUCCESS_URL}?tx_hash=${STANDARD_DATA.merchantTxHash}&fee_tx_hash=${STANDARD_DATA.feeTxHash}&block=123&order_id=ORD-1&chain=polygon&token=jpyc&mode=standard`,
      );
      expect(routerPush).not.toHaveBeenCalled();
    });

    it('「読み込み直す」(この会計の支払いでない確定): window.location.reload を呼ぶ・ほかへは移動しない', async () => {
      const reload = stubReload();
      setRelay({ data: { txHash: RELAY_TX, success: true }, restoredIntent: { ...RESTORED_INTENT, merchant: OTHER_MERCHANT } });
      const ctx = await renderCase('ja', { params: () => jpycParams() });
      const button = Array.from(frameEl(ctx.container, 'ja').querySelectorAll('button')).find(
        (b) => b.textContent === tx('ja', k('foreignSettlementReload')),
      );
      expect(button).toBeDefined();
      fireEvent.click(button!);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(routerPush).not.toHaveBeenCalled();
    });

    it('「ホームへ戻る」: router.push("/")', async () => {
      const assign = stubAssign();
      setRelay({ data: { txHash: RELAY_TX, success: true } });
      const ctx = await renderCase('ja', { params: () => jpycParams() });
      const button = Array.from(frameEl(ctx.container, 'ja').querySelectorAll('button')).find(
        (b) => b.textContent === tx('ja', k('returnHomeButton')),
      );
      expect(button).toBeDefined();
      fireEvent.click(button!);
      expect(routerPush).toHaveBeenCalledTimes(1);
      expect(routerPush).toHaveBeenCalledWith('/');
      expect(assign).not.toHaveBeenCalled();
    });

    it('「注文状況を見る」: 音を解錠する (primeChimeAudio・押した操作の中で)', async () => {
      flags.enableOrderPickup = true;
      restoredSavedPayment();
      const ctx = await renderCase('ja', {
        params: () => jpycParams({ orderId: 'saved-id', webhook: ownWebhook() }),
        run: async () => {
          await waitFor(() => expect(latestOrderDelivery()).toEqual({ kind: 'empty' }));
        },
      });
      const link = frameEl(ctx.container, 'ja').querySelector('a');
      expect(link?.textContent).toBe(tx('ja', k('viewOrderStatus')));
      vi.mocked(primeChimeAudio).mockClear();
      // jsdom は移動を実装しないので、既定の動作 (移動) だけを止めて onClick を見る。
      link!.addEventListener('click', (event) => event.preventDefault());
      fireEvent.click(link!);
      expect(primeChimeAudio).toHaveBeenCalledTimes(1);
      expect(primeChimeAudio).toHaveBeenCalledWith();
      expect(routerPush).not.toHaveBeenCalled();
    });
  });

  // 描き直し (実際に起きるもの)。枠と、変わらない行の要素・テキストノードは同じ DOM を使い続け、変わるところだけが変わる
  // (切り出し前の要素の形のまま)。どれも変更前のコードで同じことを確かめた。
  describe.each(CATALOGS)('描き直し (%s)', (_label, c) => {
    /** 同じ DOM のノード (同一のもの) が同じ並びにあること。toEqual は DOM を中身で比べる (isEqualNode) ので、1 つずつ toBe で見る。 */
    function expectSameNodes(actual: ReadonlyArray<Node>, expected: ReadonlyArray<Node>) {
      expect(actual).toHaveLength(expected.length);
      actual.forEach((node, i) => expect(node).toBe(expected[i]));
    }
    const dlOf = (frame: Element) => frame.querySelector(':scope > dl')!;

    it('success_url のカウントダウン 3 → 2 → 1 → 0 (移動を呼ぶ時点) → null: 案内の行とテキストノードは同じ DOM のまま', async () => {
      vi.useFakeTimers();
      // 移動を呼んだ時点 (redirectIn が 0 の描画) の枠の DOM と電子レシートの候補。
      const atAssign: Array<{ area: Area | null; receiptIds: unknown }> = [];
      let container!: HTMLElement;
      const assign = stubAssign(() => atAssign.push({ area: readArea(container, c), receiptIds: readReceiptIds() }));
      const ctx = await renderCase(c, {
        params: () => jpycParams({ mode: 'standard', successUrl: SUCCESS_URL }),
        run: async (x) => submitStandardThenDone(x),
      });
      container = ctx.container;
      const want = (redirect: 'now' | number): Want => ({
        rows: STANDARD_ROWS,
        receiptIds: [STANDARD_DATA.merchantTxHash, U, U, U],
        redirect,
      });
      expectArea(container, c, want(3));
      const frame = frameEl(container, c);
      const children = Array.from(frame.children);
      const rows = Array.from(dlOf(frame).children);
      const redirectBox = frame.children[4];
      const redirectTexts = Array.from(redirectBox.querySelector('p')!.childNodes);
      expect(redirectTexts).toHaveLength(1);

      for (const sec of [2, 1]) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
        expectArea(container, c, want(sec));
        expect(frameEl(container, c)).toBe(frame);
        expectSameNodes(Array.from(frame.children), children);
        expectSameNodes(Array.from(dlOf(frame).children), rows);
        expectSameNodes(Array.from(redirectBox.querySelector('p')!.childNodes), redirectTexts);
      }
      expect(assign).not.toHaveBeenCalled();

      // 0 になった描画の effect が移動を呼ぶ (その時点の DOM は redirectIn が 0 の描画)。
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(assign).toHaveBeenCalledTimes(1);
      expect(assign).toHaveBeenCalledWith(
        `${SUCCESS_URL}?tx_hash=${STANDARD_DATA.merchantTxHash}&fee_tx_hash=${STANDARD_DATA.feeTxHash}&block=123&chain=polygon&token=jpyc&mode=standard`,
      );
      // 移動を呼んだ後は redirectIn が null (同じ文言のまま)。枠の DOM と電子レシートの候補は、期待の DOM を作る前に読む。
      const afterAssign = completionArea(container, c);
      const receiptIdsAfterAssign = lastReceiptIds();
      expect(atAssign).toHaveLength(1);
      expect(atAssign[0].receiptIds).toStrictEqual(want('now').receiptIds);
      expect(receiptIdsAfterAssign).toStrictEqual(want('now').receiptIds);
      expect(atAssign[0].area).toEqual(expectedArea(c, want('now')));
      expect(afterAssign).toEqual(expectedArea(c, want('now')));
      expect(frameEl(container, c)).toBe(frame);
      expectSameNodes(Array.from(frame.children), children);
      expectSameNodes(Array.from(redirectBox.querySelector('p')!.childNodes), redirectTexts);
    });

    it('(mock だけ) relay の Tx Hash が後から届く (受付番号つき): Tx の行と「お店に知らせる」が加わり、ほかは同じ DOM のまま', async () => {
      setRelay({ data: { txHash: null, success: true } });
      const params = jpycParams({ orderId: 'ORD-7' });
      const ctx = await renderCase(c, { params: () => params });
      expectArea(ctx.container, c, { rows: [orderRow('ORD-7')], receiptIds: [U, U, U, U], home: true });
      const frame = frameEl(ctx.container, c);
      const [title, body, dl, receiptBox, home] = Array.from(frame.children);
      const orderIdRow = dl.children[0];

      setRelay({ data: { txHash: RELAY_TX, success: true } });
      ctx.rerender(ctx.makeUi());
      expectArea(ctx.container, c, {
        rows: [relayRow(RELAY_TX), orderRow('ORD-7')],
        notify: notifyFor(params, RELAY_TX),
        receiptIds: [U, U, U, RELAY_TX],
        home: true,
      });
      expect(frameEl(ctx.container, c)).toBe(frame);
      expectSameNodes([frame.children[0], frame.children[1], frame.children[2], frame.children[4], frame.children[5]], [
        title,
        body,
        dl,
        receiptBox,
        home,
      ]);
      // 受付番号の行は同じ要素のまま、前に Tx の行が加わる。
      expect(dl.children[1]).toBe(orderIdRow);
    });

    it('success_url あり・注文の束縛: 受注の受け取りを確かめると「注文状況を見る」と「3 秒後に…」が加わり、ほかは同じ DOM のまま', async () => {
      vi.useFakeTimers();
      stubAssign();
      flags.enableOrderPickup = true;
      let acknowledge!: (response: Response) => void;
      fetchMock.mockImplementation((url: string) =>
        url === ownWebhook()
          ? new Promise<Response>((resolve) => {
            acknowledge = resolve;
          })
          : Promise.resolve(Response.json({ ok: true })),
      );
      const params = jpycParams({ webhook: ownWebhook(), successUrl: SUCCESS_URL });
      const makeUi = () => <CheckoutForm params={params} />;
      const { container, rerender } = renderIn(c, makeUi());
      fireEvent.click(payButton(container, c));
      // 署名までに注文の束縛 (lib/orderBind) を非同期で読む。
      await act(async () => {
        await vi.dynamicImportSettled();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(relayMutate).toHaveBeenCalledOnce();
      const order = relayMutate.mock.calls[0][0].order as OrderDelivery['order'];
      expect(isOrderTokenLike(order.statusToken)).toBe(true);
      const record = resolveOrderDelivery(bindingFixture('free', order, JPYC(3000n)).record, RELAY_TX);
      saveOrderDelivery(record);
      setRelay({ data: { txHash: RELAY_TX, success: true }, orderDelivery: record });
      rerender(makeUi());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(fetchMock.mock.calls.filter(([url]) => url === ownWebhook())).toHaveLength(1);
      const before: Want = { rows: [relayRow(RELAY_TX), orderRow(order.orderId)], receiptIds: [U, U, U, RELAY_TX] };
      expectArea(container, c, before);
      const frame = frameEl(container, c);
      const children = Array.from(frame.children);
      const rows = Array.from(dlOf(frame).children);

      await act(async () => {
        acknowledge(Response.json({ ok: true }));
        await vi.dynamicImportSettled();
        await vi.advanceTimersByTimeAsync(0);
      });
      expectArea(container, c, { ...before, statusHref: statusHref(c, order.statusToken), redirect: 3 });
      expect(frameEl(container, c)).toBe(frame);
      // 前からあった子 (見出し・説明・行・電子レシート) は同じ要素のまま、リンクは電子レシートの前に、案内は後ろに加わる。
      expectSameNodes([frame.children[0], frame.children[1], frame.children[2], frame.children[4]], children);
      expectSameNodes(Array.from(dlOf(frame).children), rows);
    });
  });
});
