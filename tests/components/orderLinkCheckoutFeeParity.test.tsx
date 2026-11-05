// 注文リンク (lib/orderLink.ts) がお店に見せる利用料と届く額が、お客様がそのリンクを開いた /checkout (CheckoutForm) の
// 実際の差し引きと一致することを、注文リンクで選べる JPYC の全チェーン × ガスレス / 通常決済で固定する
// (第 9 回レビュー F-01・characterization test・コードは変えない)。
//
// orderLinkFeeWei は CheckoutForm の手数料の決め方 (resolvedRoute → effectiveGas → relayGasEquiv → breakdown) の
// 第 2 の実装で、同じ共有関数を呼ぶが両者を結ぶテストが無かった。tests/lib/orderLink.test.ts は forwarderConfig と env を
// mock し、tests/components/CheckoutForm.test.tsx は経路の解決 (jpycGaslessProvider・forwarderConfig) を mock するので、
// 片方だけ決め方を変えても両方とも緑のまま、お店に見せる「届く額」と /checkout の差し引きが食い違いうる。
//
// ここでは手数料に関わる lib (env・forwarderConfig の relayGasFeeValue / jpycForwarderFor・jpycGaslessProvider・
// circlePaymaster・pimlico・paymentRoute・recoverFee・paymentMoney・tokens・chains) を mock しない。env は vi.stubEnv で
// 本番と同じ名前の変数を立て、vi.resetModules + 動的 import で読み込み直す (env・forwarder・フロア・チェーンの表は
// 読み込み時に決まるため)。mock するのはウォレットと支払いの hook と、内訳を受け取る履歴の hook だけ。
//
// /checkout 側で見るもの:
//   1. 内訳: usePaymentHistory に渡る historyCtx (breakdown.merchantReceives と totalWei。受注の通知・控え・履歴と同じ値)。
//   2. 画面: 内訳の「お支払い額」と、回収の経路ならネットワーク手数料の行に出る額。
//   3. 実際の差し引き: 払うボタンで呼ばれる mutate の引数。通常決済とガスレス (Pimlico) は merchantAmount をそのまま送る。
//      relay は value と gasMode を渡し、hooks/useJpycEip3009Payment.ts の mutationFn が、ウォレットの chainId に forwarder が
//      あれば recoverFeeValue(value, gasMode, chainId) を分けて送る。その分割は hook と同じ式でここで出す
//      (tests/lib/recoverFeeConsistency.test.ts の (a) と同じ方針)。

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { parseUnits, type Address } from 'viem';
import messages from '@/messages/ja.json';
import type { ChainSlug } from '@/lib/chains';
import type { GasMode, PayMode } from '@/lib/fee';
import type { OrderLinkInput } from '@/lib/orderLink';

// vi.resetModules の後も同じ関数を返すよう、mock の実体を hoisted に置く (読み込み直した CheckoutForm と、
// ここで値を設定する関数が同じものになる)。
const h = vi.hoisted(() => ({
  useAccount: vi.fn(),
  useReadContract: vi.fn(),
  useSwitchChain: vi.fn(),
  useSmartAccount: vi.fn(),
  useBatchPayment: vi.fn(),
  useStandardPayment: vi.fn(),
  useGasQuoteUsdc: vi.fn(),
  useGasQuoteJpyc: vi.fn(),
  useGasQuoteCircle: vi.fn(),
  useJpycEip3009Payment: vi.fn(),
  usePaymentHistory: vi.fn(),
  relayMutate: vi.fn(),
  standardMutate: vi.fn(),
  gaslessMutate: vi.fn(),
}));

vi.mock('wagmi', () => ({
  useAccount: h.useAccount,
  useReadContract: h.useReadContract,
  useSwitchChain: h.useSwitchChain,
  useWalletClient: () => ({ data: undefined }),
  usePublicClient: () => undefined,
  useConnect: () => ({ connectors: [], connect: () => undefined, isPending: false, error: null }),
  useDisconnect: () => ({ disconnect: () => undefined }),
  useSignMessage: () => ({ signMessageAsync: async () => '0x', isPending: false }),
}));
vi.mock('@/hooks/useSmartAccount', () => ({ useSmartAccount: h.useSmartAccount }));
vi.mock('@/hooks/useBatchPayment', () => ({ useBatchPayment: h.useBatchPayment }));
vi.mock('@/hooks/useStandardPayment', () => ({ useStandardPayment: h.useStandardPayment }));
vi.mock('@/hooks/useGasQuoteUsdc', () => ({ useGasQuoteUsdc: h.useGasQuoteUsdc }));
vi.mock('@/hooks/useGasQuoteJpyc', () => ({ useGasQuoteJpyc: h.useGasQuoteJpyc }));
vi.mock('@/hooks/useGasQuoteCircle', () => ({ useGasQuoteCircle: h.useGasQuoteCircle }));
vi.mock('@/hooks/useJpycEip3009Payment', () => ({ useJpycEip3009Payment: h.useJpycEip3009Payment }));
vi.mock('@/hooks/useRelayHealth', () => ({ useRelayHealth: () => ({ degraded: false }) }));
vi.mock('@/hooks/usePaymentHistory', () => ({ usePaymentHistory: h.usePaymentHistory }));
vi.mock('@/lib/logger', () => ({
  logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));
// 実物の ConnectButton は jsdom で wagmi の module graph を評価して重い (tests/_helpers/connectButtonStub.tsx)。
vi.mock('@/components/ConnectButton', async () => ({
  ConnectButton: (await import('../_helpers/connectButtonStub')).ConnectButtonStub,
}));

const MERCHANT = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' as Address;
const CUSTOMER = '0x9999999999999999999999999999999999999999' as Address;
const JPYC = 10n ** 18n;
const CF = messages.CheckoutForm;
const MAINNET_CHAIN_IDS: Partial<Record<ChainSlug, number>> = { polygon: 137, kaia: 8217, avalanche: 43114 };

// 本番と同じ名前の env。値は本番の形 (relay ON・1%・Avalanche と Ethereum の JPYC・forwarder は Polygon / Kaia / Avalanche)。
// mainnet で lib/env.ts が読み込み時に求める値 (受取・Pimlico・Sentry) は vitest.config の env にある。
// 関わる変数はすべて明示して立てる (手元の shell の値に左右されないように・空 = 未設定と同じ)。
const FORWARDERS = {
  NEXT_PUBLIC_JPYC_FORWARDER_POLYGON: '0x1111111111111111111111111111111111111111',
  NEXT_PUBLIC_JPYC_FORWARDER_KAIA: '0x2222222222222222222222222222222222222222',
  NEXT_PUBLIC_JPYC_FORWARDER_AVALANCHE: '0x3333333333333333333333333333333333333333',
};
const PRODUCTION_ENV: Record<string, string> = {
  NEXT_PUBLIC_NETWORK_ENV: 'mainnet',
  NEXT_PUBLIC_ENABLE_JPYC_EIP3009: '1',
  NEXT_PUBLIC_RECOVER_FEE_BPS: '100',
  NEXT_PUBLIC_ENABLE_JPYC_AVALANCHE: '1',
  NEXT_PUBLIC_ENABLE_JPYC_ETHEREUM: '1',
  NEXT_PUBLIC_ENABLE_USAGE_FEE: '',
  NEXT_PUBLIC_ENABLE_MOBILE_ORDER_FEE: '',
  NEXT_PUBLIC_ENABLE_CIRCLE_PAYMASTER: '',
  ...FORWARDERS,
  NEXT_PUBLIC_RELAY_GAS_FEE_JPYC: '',
  NEXT_PUBLIC_RELAY_GAS_FEE_JPYC_POLYGON: '',
  NEXT_PUBLIC_RELAY_GAS_FEE_JPYC_KAIA: '',
  NEXT_PUBLIC_RELAY_GAS_FEE_JPYC_AVALANCHE: '',
};

/** /checkout で払うときに通る経路 (払うボタンで呼ばれる hook)。 */
type CheckoutRoute = 'relay' | 'standard' | 'gasless';

type Variant = 'plain' | 'discount' | 'tax' | 'small';

type Profile = {
  name: string;
  env: Record<string, string>;
  /** orderLinkChains(JPYC_CHAINS) = 注文リンクで選べるチェーン (Ethereum は通常決済だけなので入らない)。 */
  chains: ChainSlug[];
  /** ガスレスのリンクで /checkout が通る経路。 */
  gaslessRoute: CheckoutRoute;
  /** 利用料が付くチェーン (relay + forwarder = 回収の経路)。 */
  recoverChains: ChainSlug[];
  gaslessVariants: Variant[];
  standardVariants: Variant[];
};

const PROFILES: Profile[] = [
  {
    name: '本番 (relay + forwarder = 回収・1%・フロア 2 JPYC)',
    env: PRODUCTION_ENV,
    chains: ['polygon', 'kaia', 'avalanche'],
    gaslessRoute: 'relay',
    recoverChains: ['polygon', 'kaia', 'avalanche'],
    // 値引きあり・消費税あり・フロアが効く小さい額を 1 つずつ。
    gaslessVariants: ['plain', 'discount', 'tax', 'small'],
    standardVariants: ['plain', 'discount'],
  },
  {
    // チェーンを取り違えると額が変わる設定 (Kaia は forwarder なし = 無料・Avalanche はフロア 20 JPYC)。
    name: 'チェーンで違う設定 (Kaia は forwarder なし・Avalanche のフロア 20 JPYC)',
    env: {
      ...PRODUCTION_ENV,
      NEXT_PUBLIC_JPYC_FORWARDER_KAIA: '',
      NEXT_PUBLIC_RELAY_GAS_FEE_JPYC_AVALANCHE: '20',
    },
    chains: ['polygon', 'kaia', 'avalanche'],
    gaslessRoute: 'relay',
    recoverChains: ['polygon', 'avalanche'],
    gaslessVariants: ['plain', 'small'],
    standardVariants: ['plain'],
  },
  {
    // forwarder が無い relay は OpenPay がガスを持ち、利用料は 0。Avalanche は forwarder が無いと通常決済だけなので選べない。
    name: 'forwarder なし (relay の無料の経路)',
    env: {
      ...PRODUCTION_ENV,
      NEXT_PUBLIC_JPYC_FORWARDER_POLYGON: '',
      NEXT_PUBLIC_JPYC_FORWARDER_KAIA: '',
      NEXT_PUBLIC_JPYC_FORWARDER_AVALANCHE: '',
    },
    chains: ['polygon', 'kaia'],
    gaslessRoute: 'relay',
    recoverChains: [],
    gaslessVariants: ['plain', 'small'],
    standardVariants: ['plain'],
  },
  {
    // relay を切ると forwarder があっても Pimlico の肩代わり (利用料 0)。
    name: 'relay OFF (Pimlico の肩代わり・forwarder は設定済み)',
    env: { ...PRODUCTION_ENV, NEXT_PUBLIC_ENABLE_JPYC_EIP3009: '' },
    chains: ['polygon', 'kaia', 'avalanche'],
    gaslessRoute: 'gasless',
    recoverChains: [],
    gaslessVariants: ['plain'],
    standardVariants: ['plain'],
  },
  {
    // 月額の利用料 (a1) が ON だと forwarder は効かない (jpycForwarderFor が null・relay は無料の経路)。
    name: '月額の利用料 (a1) ON (forwarder は設定済みでも効かない)',
    env: { ...PRODUCTION_ENV, NEXT_PUBLIC_ENABLE_USAGE_FEE: '1' },
    chains: ['polygon', 'kaia'],
    gaslessRoute: 'relay',
    recoverChains: [],
    gaslessVariants: ['plain'],
    standardVariants: [],
  },
];

function orderInput(chains: ChainSlug[], mode: PayMode, variant: Variant): OrderLinkInput {
  return {
    origin: 'https://open-pay.jp',
    to: MERCHANT,
    chains,
    mode,
    reusable: false,
    orderId: 'A-001',
    contact: null,
    description: '',
    storeName: '',
    lines:
      variant === 'small'
        ? [{ name: 'ステッカー', qty: '1', price: '150' }]
        : [{ name: 'Tシャツ M', qty: '2', price: '3000' }],
    shipping: variant === 'small' ? '' : '500',
    shippingLabel: '送料',
    ...(variant === 'discount' ? { discount: '500' } : {}),
    ...(variant === 'tax' ? { tax: 'taxable_10' as const, invoiceNo: 'T1234567890123' } : {}),
  };
}

async function loadModules() {
  const [orderLink, chains, tokens, checkoutUrl, forwarderConfig, recoverFee, format, checkoutForm, i18n] =
    await Promise.all([
      import('@/lib/orderLink'),
      import('@/lib/chains'),
      import('@/lib/tokens'),
      import('@/lib/url/checkout'),
      import('@/lib/relay/forwarderConfig'),
      import('@/lib/relay/recoverFee'),
      import('@/lib/format'),
      import('@/components/CheckoutForm'),
      // 画面と同じ読み込みの世代の next-intl を使う (読み込み直した CheckoutForm と provider を揃える)。
      import('../_helpers/i18n'),
    ]);
  return { orderLink, chains, tokens, checkoutUrl, forwarderConfig, recoverFee, format, checkoutForm, i18n };
}

type Modules = Awaited<ReturnType<typeof loadModules>>;

/** 内訳の 1 行 (<dt> がラベルで始まる行の <dd>)。 */
function rowValue(label: string): string | null {
  for (const dt of Array.from(document.querySelectorAll('dt'))) {
    if (!(dt.textContent ?? '').trim().startsWith(label)) continue;
    const dd = dt.nextElementSibling;
    if (dd?.tagName === 'DD') return (dd.textContent ?? '').trim();
  }
  return null;
}

function setPaymentHooks(chainId: number) {
  h.useAccount.mockReturnValue({ address: CUSTOMER, isConnected: true, chainId });
  h.useReadContract.mockReturnValue({ data: 1_000_000n * JPYC, isLoading: false, error: null });
  h.useSwitchChain.mockReturnValue({ switchChain: () => undefined, isPending: false });
  h.useSmartAccount.mockReturnValue({
    data: { smartAccountClient: {}, pimlicoClient: {} },
    isLoading: false,
    error: null,
  });
  h.useBatchPayment.mockReturnValue({
    mutate: h.gaslessMutate,
    isPending: false,
    isUnknown: false,
    retryReceipt: () => undefined,
    isSuccess: false,
    isError: false,
    data: undefined,
    error: null,
  });
  h.useStandardPayment.mockReturnValue({
    mutate: h.standardMutate,
    retryFee: () => undefined,
    retryReceipt: () => undefined,
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
  });
  // JPYC の非 relay のガスレスは見積もりを内訳に入れない (OpenPay が持つ)。入れてしまう変更が分かるよう 0 でない額にする。
  const quote = { data: { gasAmount: 1n * JPYC }, isLoading: false, isError: false, error: null };
  h.useGasQuoteUsdc.mockReturnValue(quote);
  h.useGasQuoteJpyc.mockReturnValue(quote);
  h.useGasQuoteCircle.mockReturnValue({ data: undefined, error: null, fetchStatus: 'idle' });
  h.useJpycEip3009Payment.mockReturnValue({
    mutate: h.relayMutate,
    isPending: false,
    data: undefined,
    error: null,
    retryRelay: () => undefined,
    retrySamePayload: () => undefined,
    recoveryState: null,
    variables: undefined,
    restoredIntent: null,
    orderDelivery: null,
  });
}

/**
 * relay の hook (hooks/useJpycEip3009Payment.ts の mutationFn) が送る分割と同じ式: ウォレットの chainId に forwarder が
 * あれば recoverFeeValue(value, gasMode, chainId) を分け、店舗負担 (merchant) なら店の受取から引く。forwarder が無ければ
 * 全額が店へ (利用料 0)。gasMode を渡さなければ hook の既定 'customer'。
 */
function relaySplit(m: Modules, value: bigint, gasMode: GasMode | undefined, chainId: number) {
  if (m.forwarderConfig.jpycForwarderFor(chainId) === null) return { merchantValue: value, feeValue: 0n };
  const mode = gasMode ?? 'customer';
  const feeValue = m.recoverFee.recoverFeeValue(value, mode, chainId);
  return { merchantValue: mode === 'merchant' ? value - feeValue : value, feeValue };
}

describe.each(PROFILES)('注文リンクの利用料と /checkout の差し引きの一致 — $name', (profile) => {
  let m: Modules;

  beforeAll(async () => {
    for (const [key, value] of Object.entries(profile.env)) vi.stubEnv(key, value);
    vi.resetModules();
    m = await loadModules();
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  it('本番 (mainnet) の設定で読み込まれ、注文リンクで選べるチェーンが想定どおり (下の組み合わせが空回りしない)', () => {
    // Ethereum の JPYC は mainnet だけで点き、通常決済だけなので注文リンクには入らない。
    expect(m.chains.JPYC_CHAINS).toEqual(['polygon', 'kaia', 'avalanche', 'ethereum']);
    expect(m.orderLink.orderLinkChains(m.chains.JPYC_CHAINS)).toEqual(profile.chains);
    expect(profile.chains.map((chain) => m.tokens.deploymentForSlug('jpyc', chain).chainId)).toEqual(
      profile.chains.map((chain) => MAINNET_CHAIN_IDS[chain]),
    );
  });

  const cases = [
    ...profile.gaslessVariants.map((variant) => ({ mode: 'gasless' as const, variant })),
    ...profile.standardVariants.map((variant) => ({ mode: 'standard' as const, variant })),
  ].flatMap(({ mode, variant }) => profile.chains.map((chain) => ({ chain, mode, variant })));

  it.each(cases)('$chain / $mode / $variant', async ({ chain, mode, variant }) => {
    const user = userEvent.setup();
    const deployment = m.tokens.deploymentForSlug('jpyc', chain);
    const recover = mode === 'gasless' && profile.recoverChains.includes(chain);
    const route: CheckoutRoute = mode === 'standard' ? 'standard' : profile.gaslessRoute;

    // --- 注文リンク: このチェーンだけのリンクと、全チェーンを受け付けるリンク (チェーンごとの額は byChain) ---
    // 複数のチェーンを受け付けるガスレスのリンクは relay のチェーンだけ (lib/url/checkout.ts の parseOfferedChains)。
    // relay OFF では作れないので、このチェーンだけのリンクで比べる。
    const single = m.orderLink.buildOrderLink(orderInput([chain], mode, variant));
    if (!single.ok) throw new Error(`single-chain order link failed: ${single.error}`);
    let link = single;
    if (mode === 'standard' || profile.gaslessRoute === 'relay') {
      const multi = m.orderLink.buildOrderLink(orderInput(profile.chains, mode, variant));
      if (!multi.ok) throw new Error(`order link failed: ${multi.error}`);
      const entry = multi.byChain.find((item) => item.chain === chain);
      if (!entry) throw new Error(`no byChain entry for ${chain}`);
      expect({ total: multi.total, fee: entry.fee, receive: entry.receive }).toEqual({
        total: single.total,
        fee: single.fee,
        receive: single.receive,
      });
      link = multi;
    }
    const totalWei = parseUnits(single.total, deployment.decimals);
    const feeWei = parseUnits(single.fee, deployment.decimals);
    const receiveWei = parseUnits(single.receive, deployment.decimals);
    expect(m.orderLink.orderLinkFeeWei(totalWei, chain, mode)).toBe(feeWei);
    expect(receiveWei).toBe(totalWei - feeWei);

    // --- /checkout: お客様がチェーンを選ぶと ?chain= が付いて読み直される (components/checkout/CheckoutChainPicker.tsx) ---
    const url = new URL(link.url);
    url.searchParams.set('chain', chain);
    const parsed = m.checkoutUrl.parseCheckoutParams(url.searchParams);
    if (!parsed.ok) throw new Error('checkout params failed to parse');
    expect(parsed.params.chain).toBe(chain);
    expect(parsed.params.pickChain).toBeUndefined();
    // お客様が払う額 (/checkout の calcCheckoutPayable) が注文リンクの合計と同じ。
    expect(m.checkoutUrl.calcCheckoutPayable(parsed.params, deployment.decimals)).toBe(totalWei);

    setPaymentHooks(deployment.chainId);
    const view = m.i18n.renderWithIntl(<m.checkoutForm.CheckoutForm params={parsed.params} />);

    // 1. 内訳 (受注の通知・控え・履歴に使う値)。
    const ctx = h.usePaymentHistory.mock.lastCall?.[0] as { saleAmount: bigint; merchantAmount: bigint };
    expect(ctx.saleAmount).toBe(totalWei);
    expect(ctx.merchantAmount).toBe(receiveWei);

    // 2. 画面: お客様が払う額 (通常決済の行は「お支払い額 (+ ウォレット側 … gas)」) と、回収の経路のネットワーク手数料の行
    // (店主負担)。
    expect(rowValue(CF.totalRow)).toBe(m.format.formatTokenAmount(totalWei, deployment));
    if (recover) {
      expect(rowValue(CF.gasRowMerchant)).toBe(m.format.formatTokenAmount(feeWei, deployment));
    }

    // 3. 実際の差し引き: 払うボタンで呼ばれる送金の引数。
    await user.click(screen.getByRole('button', { name: /を支払う/ }));
    const mutate = { relay: h.relayMutate, standard: h.standardMutate, gasless: h.gaslessMutate }[route];
    await waitFor(() => expect(mutate).toHaveBeenCalledOnce());
    for (const other of [h.relayMutate, h.standardMutate, h.gaslessMutate]) {
      if (other !== mutate) expect(other).not.toHaveBeenCalled();
    }
    const args = mutate.mock.calls[0][0] as {
      merchant: Address;
      value?: bigint;
      gasMode?: GasMode;
      merchantAmount?: bigint;
      saleAmount?: bigint;
      gasReimbursement?: bigint;
    };
    expect(args.merchant).toBe(MERCHANT);
    if (route === 'relay') {
      expect(args.value).toBe(totalWei);
      const split = relaySplit(m, args.value!, args.gasMode, deployment.chainId);
      expect(split.merchantValue).toBe(receiveWei);
      expect(split.feeValue).toBe(feeWei);
    } else {
      expect(args.saleAmount).toBe(totalWei);
      expect(args.merchantAmount).toBe(receiveWei);
      // JPYC の Pimlico の肩代わりはお客様にもお店にもガス代を請求しない。
      if (route === 'gasless') expect(args.gasReimbursement).toBe(0n);
    }

    // 回収の経路だけが利用料を取る (この組み合わせが想定の経路を通っていて、比べた額が空でないことの確認)。
    if (recover) expect(feeWei).toBeGreaterThan(0n);
    else expect(feeWei).toBe(0n);

    view.unmount();
  });
});
