import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
import userEvent from '@testing-library/user-event';
import { baseSepolia, polygonAmoy } from 'viem/chains';
import type { Address } from 'viem';

vi.mock('wagmi', () => ({
  useAccount: vi.fn(),
  useReadContract: vi.fn(),
  useSwitchChain: vi.fn(),
  useConnect: vi.fn(() => ({
    connectors: [],
    connect: vi.fn(),
    isPending: false,
    error: null,
  })),
  useDisconnect: vi.fn(() => ({ disconnect: vi.fn() })),
}));
vi.mock('@/hooks/useSmartAccount', () => ({ useSmartAccount: vi.fn() }));
vi.mock('@/hooks/useBatchPayment', () => ({ useBatchPayment: vi.fn() }));
vi.mock('@/hooks/useStandardPayment', () => ({ useStandardPayment: vi.fn() }));
vi.mock('@/hooks/useGasQuoteUsdc', () => ({ useGasQuoteUsdc: vi.fn() }));
vi.mock('@/hooks/useGasQuoteJpyc', () => ({ useGasQuoteJpyc: vi.fn() }));
// Circle quote は flag OFF (resolveUsdcGaslessProvider→pimlico) で非 active。useQuery を
// 走らせないよう stub (QueryClientProvider 無しで render する既存 test を壊さない)。
vi.mock('@/hooks/useGasQuoteCircle', () => ({
  useGasQuoteCircle: vi.fn(() => ({
    data: undefined,
    error: null,
    fetchStatus: 'idle',
  })),
}));
// useJpycEip3009Payment は real だと wagmi useWalletClient + react-query (useMutation) に依存し、
// 本 test は QueryClientProvider 無しで render するため mock 必須 (PaymentForm.test と同方針)。
vi.mock('@/hooks/useJpycEip3009Payment', () => ({
  useJpycEip3009Payment: vi.fn(),
}));
// relay 経路の発火は env flag (module-load) ではなく resolveJpycGaslessProvider を直接制御する。
// 既定は 'pimlico-7702' (= 従来挙動) で、relay テストのみ 'eip3009-relay' に切替える。
vi.mock('@/lib/jpycGaslessProvider', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/jpycGaslessProvider')
  >('@/lib/jpycGaslessProvider');
  return { ...actual, resolveJpycGaslessProvider: vi.fn(() => 'pimlico-7702') };
});
// forwarder 設定は env 依存なので test で決定論的に制御する。既定 null = free モード
// (OpenPay がガス負担)。recover モードは jpycForwarderFor をアドレスに差し替える。
vi.mock('@/lib/relay/forwarderConfig', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/relay/forwarderConfig')
  >('@/lib/relay/forwarderConfig');
  return {
    ...actual,
    jpycForwarderFor: vi.fn(() => null),
    relayGasFeeValue: vi.fn(() => 2n * 10n ** 18n),
  };
});
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn() })),
}));
vi.mock('@/lib/pimlico', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/pimlico')>('@/lib/pimlico');
  return {
    ...actual,
    resolvePaymasterMode: vi.fn(actual.resolvePaymasterMode),
  };
});
// ConnectButton は実物だと jsdom で重い wagmi graph を render 評価し worker OOM
// (memory:paymentform-oom-rootcause)。軽量 stub に差し替え。
vi.mock('@/components/ConnectButton', async () => ({
  ConnectButton: (await import('../_helpers/connectButtonStub')).ConnectButtonStub,
}));

import { useAccount, useReadContract, useSwitchChain } from 'wagmi';
import { useSmartAccount } from '@/hooks/useSmartAccount';
import { useBatchPayment } from '@/hooks/useBatchPayment';
import { useStandardPayment } from '@/hooks/useStandardPayment';
import { useJpycEip3009Payment } from '@/hooks/useJpycEip3009Payment';
import { useGasQuoteUsdc } from '@/hooks/useGasQuoteUsdc';
import { useGasQuoteJpyc } from '@/hooks/useGasQuoteJpyc';
import { resolvePaymasterMode } from '@/lib/pimlico';
import { resolveJpycGaslessProvider } from '@/lib/jpycGaslessProvider';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { CheckoutForm } from '@/components/CheckoutForm';
import type { CheckoutParams } from '@/lib/url';
import { loadHistory } from '@/lib/history';
import { loadPayerReceipts } from '@/lib/payerReceipt';
import { mockHook } from '../_helpers/wagmiMock';

const MERCHANT: Address = '0x2222222222222222222222222222222222222222';
const CUSTOMER: Address = '0x9999999999999999999999999999999999999999';

function setAccount(opts: { connected: boolean; chainId?: number }) {
  mockHook(useAccount, {
    address: opts.connected ? CUSTOMER : undefined,
    isConnected: opts.connected,
    chainId: opts.connected ? opts.chainId : undefined,
  });
}

function setBalance(value: bigint | undefined) {
  mockHook(useReadContract, {
    data: value,
    isLoading: false,
    error: null,
  });
}

function setSmartAccount(ready: boolean, error?: Error) {
  mockHook(useSmartAccount, {
    data: ready ? { smartAccountClient: {}, pimlicoClient: {} } : undefined,
    isLoading: !ready && !error,
    error: error ?? null,
  } as Partial<ReturnType<typeof useSmartAccount>>);
}

let mutate: ReturnType<typeof vi.fn>;
function setBatchPayment(
  state: 'idle' | 'pending' | 'success' | 'error',
  errMsg?: string,
) {
  mutate = vi.fn();
  mockHook(useBatchPayment, {
    mutate,
    isPending: state === 'pending',
    isSuccess: state === 'success',
    isError: state === 'error',
    data:
      state === 'success'
        ? {
            userOpHash: `0x${'a'.repeat(64)}`,
            txHash: `0x${'b'.repeat(64)}`,
            blockNumber: 99n,
            success: true,
          }
        : undefined,
    error: state === 'error' ? new Error(errMsg ?? 'AA21 fail') : null,
  } as Partial<ReturnType<typeof useBatchPayment>>);
}

let relayMutate: ReturnType<typeof vi.fn>;
function setRelayPayment(
  state:
    | 'idle'
    | 'pending-flow'
    | 'success'
    | 'reverted'
    | 'broadcast-pending'
    | 'error',
  opts?: {
    txHash?: `0x${string}`;
    errMsg?: string;
    variables?: { merchant: Address; value: bigint; gasMode?: 'customer' | 'merchant' };
  },
) {
  relayMutate = vi.fn();
  const txHash = opts?.txHash ?? (`0x${'e'.repeat(64)}` as `0x${string}`);
  const data =
    state === 'success'
      ? { txHash, success: true }
      : state === 'reverted'
        ? { txHash, success: false }
        : state === 'broadcast-pending'
          ? { txHash, success: false, pending: true }
          : undefined;
  mockHook(useJpycEip3009Payment, {
    mutate: relayMutate,
    isPending: state === 'pending-flow',
    data,
    error: state === 'error' ? new Error(opts?.errMsg ?? 'rate_limited') : null,
    variables: opts?.variables,
  } as Partial<ReturnType<typeof useJpycEip3009Payment>>);
}

function setSwitchChain() {
  mockHook(useSwitchChain, {
    switchChain: vi.fn(),
    isPending: false,
  });
}

function setGasQuote(state: 'disabled' | 'pending' | 'ready' | 'error', amount?: bigint) {
  const mockState = {
    data: state === 'ready' ? { gasAmount: amount ?? 100_000n } : undefined,
    isLoading: state === 'pending',
    isError: state === 'error',
    error: state === 'error' ? new Error('quote failed') : null,
  };
  mockHook(useGasQuoteUsdc, mockState as Partial<ReturnType<typeof useGasQuoteUsdc>>);
  mockHook(useGasQuoteJpyc, mockState as Partial<ReturnType<typeof useGasQuoteJpyc>>);
}

let standardMutate: ReturnType<typeof vi.fn>;
let standardRetryFee: ReturnType<typeof vi.fn>;
function setStandardPaymentDefault() {
  // CheckoutForm は useStandardPayment を必ず call する (条件付きフック禁止)。
  // gasless 系テストは standard side が idle のままで動くため、共通 default を提供。
  standardMutate = vi.fn();
  standardRetryFee = vi.fn();
  mockHook(useStandardPayment, {
    mutate: standardMutate,
    retryFee: standardRetryFee,
    phase: 'idle',
    isPending: false,
    isSuccess: false,
    isError: false,
    isFeeError: false,
    isMerchantError: false,
    data: undefined,
    error: null,
    merchantTxHash: undefined,
    feeTxHash: undefined,
  } as Partial<ReturnType<typeof useStandardPayment>>);
}

// standard mode 用の state helper (PaymentForm の同名 helper と同じ shape)。
function setStandardPayment(
  state:
    | 'idle'
    | 'merchant-sending'
    | 'merchant-mining'
    | 'fee-sending'
    | 'fee-mining'
    | 'success'
    | 'success-no-fee'
    | 'merchant-error'
    | 'fee-error',
) {
  standardMutate = vi.fn();
  standardRetryFee = vi.fn();
  const phase: ReturnType<typeof useStandardPayment>['phase'] =
    state === 'success-no-fee' ? 'success' : state === 'idle' ? 'idle' : state;
  const isPending =
    state === 'merchant-sending' ||
    state === 'merchant-mining' ||
    state === 'fee-sending' ||
    state === 'fee-mining';
  mockHook(useStandardPayment, {
    mutate: standardMutate,
    retryFee: standardRetryFee,
    phase,
    isPending,
    isSuccess: state === 'success' || state === 'success-no-fee',
    isError: state === 'merchant-error' || state === 'fee-error',
    isFeeError: state === 'fee-error',
    isMerchantError: state === 'merchant-error',
    data:
      state === 'success'
        ? {
            merchantTxHash: `0x${'c'.repeat(64)}`,
            feeTxHash: `0x${'d'.repeat(64)}`,
            blockNumber: 123n,
          }
        : state === 'success-no-fee'
          ? {
              merchantTxHash: `0x${'c'.repeat(64)}`,
              feeTxHash: undefined,
              blockNumber: 123n,
            }
          : undefined,
    error:
      state === 'merchant-error'
        ? new Error('user rejected request')
        : state === 'fee-error'
          ? new Error('fee tx reverted')
          : null,
    merchantTxHash: undefined,
    feeTxHash: undefined,
  } as Partial<ReturnType<typeof useStandardPayment>>);
}

// webhook / redirect は submit 時点の snapshot を真実とするため、成功 data を mock するだけでは
// 発火しない (submit を経て snapshot ref が固定される必要がある)。これらの helper は idle→submit→
// success を 1 component インスタンスで踏み、snapshot を正しく固定したうえで成功描画させる。
// (success data を直接 mock するのは「submit 無しで mutation data が存在する」= 本番では起こらない
// 状態なので、実際の submit を経由するこの helper で置き換える。)
//
// rerender には毎回 fresh な element を渡す (makeUi() で生成)。同一 element 参照を渡すと React が
// root で bailout して再 render が走らず、success mock が反映されないため。
type MakeUi = () => ReactElement;

// gasless (useBatchPayment) 成功までを踏む。data は setBatchPayment('success') と同形。
async function submitGaslessThenSucceed(
  user: ReturnType<typeof userEvent.setup>,
  rerender: (ui: ReactElement) => void,
  makeUi: MakeUi,
) {
  await user.click(screen.getByRole('button', { name: /を支払う/ }));
  expect(mutate).toHaveBeenCalledOnce();
  setBatchPayment('success');
  rerender(makeUi());
}

// standard 成功までを踏む。
async function submitStandardThenSucceed(
  user: ReturnType<typeof userEvent.setup>,
  rerender: (ui: ReactElement) => void,
  makeUi: MakeUi,
) {
  await user.click(screen.getByRole('button', { name: /を支払う/ }));
  expect(standardMutate).toHaveBeenCalledOnce();
  setStandardPayment('success');
  rerender(makeUi());
}

// fake timers 下では userEvent が使えないため fireEvent で同期 submit する版。
// gasless 経路の支払いボタンを click → snapshot 固定 → success に遷移 → rerender。
function submitGaslessThenSucceedSync(
  rerender: (ui: ReactElement) => void,
  makeUi: MakeUi,
) {
  fireEvent.click(screen.getByRole('button', { name: /を支払う/ }));
  expect(mutate).toHaveBeenCalledOnce();
  setBatchPayment('success');
  rerender(makeUi());
}

// relay (useJpycEip3009Payment) 成功までを踏む。
async function submitRelayThenSucceed(
  user: ReturnType<typeof userEvent.setup>,
  rerender: (ui: ReactElement) => void,
  makeUi: MakeUi,
  opts: {
    txHash: `0x${string}`;
    variables: { merchant: Address; value: bigint; gasMode?: 'customer' | 'merchant' };
  },
) {
  await user.click(screen.getByRole('button', { name: /を支払う/ }));
  expect(relayMutate).toHaveBeenCalledOnce();
  setRelayPayment('success', opts);
  rerender(makeUi());
}

beforeEach(() => {
  vi.clearAllMocks();
  setSwitchChain();
  setBalance(undefined);
  setSmartAccount(false);
  setBatchPayment('idle');
  setStandardPaymentDefault();
  setRelayPayment('idle');
  setGasQuote('disabled');
  setAccount({ connected: false });
  vi.mocked(resolvePaymasterMode).mockImplementation(() => 'sponsorship');
  // 既定は従来の Pimlico 経路。relay テストのみ 'eip3009-relay' に切替える。
  // (clearAllMocks は mockReturnValue を消さないので beforeEach で明示リセットが必要。)
  vi.mocked(resolveJpycGaslessProvider).mockReturnValue('pimlico-7702');
  vi.mocked(jpycForwarderFor).mockReturnValue(null);
});

const USDC_PARAMS: CheckoutParams = {
  to: MERCHANT,
  token: 'usdc',
  chain: 'base',
  gas: 'customer',
  items: [
    { name: 'Tシャツ', qty: 1, price: '25.00' },
    { name: 'マグ', qty: 2, price: '15.00' },
  ],
  orderId: 'ord-42',
  description: 'Summer sale',
};

const JPYC_PARAMS: CheckoutParams = {
  to: MERCHANT,
  token: 'jpyc',
  chain: 'polygon',
  gas: 'customer',
  items: [{ name: 'チケット', qty: 1, price: '3000' }],
};

describe('CheckoutForm — レンダリング', () => {
  it('order_id / description / items / 合計が表示される', () => {
    setAccount({ connected: false });
    render(<CheckoutForm params={USDC_PARAMS} />);
    expect(screen.getByText(/注文 #ord-42/)).toBeInTheDocument();
    expect(screen.getByText('Summer sale')).toBeInTheDocument();
    expect(screen.getByText('Tシャツ')).toBeInTheDocument();
    expect(screen.getByText('マグ')).toBeInTheDocument();
    // line totals: T 25 USDC, マグ 30 USDC, subtotal 55 USDC が画面のどこかに存在する
    // (subtotal もボタン文言にも出るため複数 match の可能性あり、getAllByText で確認)
    expect(screen.getByText('25 USDC')).toBeInTheDocument();
    expect(screen.getByText('30 USDC')).toBeInTheDocument();
    expect(screen.getAllByText(/55 USDC/).length).toBeGreaterThan(0);
  });

  it('order_id 未指定時は generic タイトル', () => {
    const { container } = render(
      <CheckoutForm
        params={{ ...USDC_PARAMS, orderId: undefined, description: undefined }}
      />,
    );
    expect(container.textContent).toContain('OpenPay Checkout');
  });

  it('JPYC params: chain Polygon と通貨表示', () => {
    render(<CheckoutForm params={JPYC_PARAMS} />);
    expect(screen.getByText(/Polygon/)).toBeInTheDocument();
    // JPYC は header と price 行で複数 match。少なくとも 1 つあれば OK。
    expect(screen.getAllByText(/JPYC/).length).toBeGreaterThan(0);
  });
});

describe('CheckoutForm — 接続フロー', () => {
  it('未接続: 「ウォレットを接続」ボタン', () => {
    render(<CheckoutForm params={USDC_PARAMS} />);
    expect(
      screen.getByRole('button', { name: /ウォレットを接続/ }),
    ).toBeDisabled();
  });

  it('wrong chain: switch ボタン表示', () => {
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(0n);
    setSmartAccount(false);
    render(<CheckoutForm params={USDC_PARAMS} />);
    expect(screen.getByRole('button', { name: /へ切り替え/ })).toBeInTheDocument();
  });

  it('SA 初期化中: ボタン disabled で初期化中文言', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(false);
    render(<CheckoutForm params={USDC_PARAMS} />);
    expect(
      screen.getByRole('button', { name: /決済の準備中/ }),
    ).toBeDisabled();
  });

  it('gas quote pending: ボタン disabled で見積中', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('pending');
    render(<CheckoutForm params={USDC_PARAMS} />);
    expect(
      screen.getByRole('button', { name: /ガス代見積取得中/ }),
    ).toBeDisabled();
  });

  it('準備完了: 支払いボタン enabled で合計が表示される', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 100_000n); // 0.1 USDC
    render(<CheckoutForm params={USDC_PARAMS} />);
    // 55 + 0.1 = 55.1 USDC
    expect(
      screen.getByRole('button', { name: /55\.1 USDC を支払う/ }),
    ).toBeEnabled();
  });

  it('残高不足: ボタン disabled + 警告', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(10_000_000n); // 10 USDC < 55 USDC
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);
    render(<CheckoutForm params={USDC_PARAMS} />);
    expect(screen.getByText(/残高が不足/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /55\.1 USDC を支払う/ }),
    ).toBeDisabled();
  });

  it('残高不足 (USDC) → onramp link が SBI VC トレード で正しい security 属性', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(10_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);
    render(<CheckoutForm params={USDC_PARAMS} />);
    const onramp = screen.getByRole('link', {
      name: /SBI VC トレード で USDC を購入/,
    });
    expect(onramp).toHaveAttribute('href', 'https://www.sbivc.co.jp/');
    expect(onramp).toHaveAttribute('target', '_blank');
    expect(onramp).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('残高不足 (JPYC) → onramp link が JPYC 公式 (token prop の wiring 確認)', () => {
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(0n);
    setSmartAccount(true);
    setGasQuote('ready', 0n);
    render(<CheckoutForm params={JPYC_PARAMS} />);
    expect(screen.getByText(/残高が不足/)).toBeInTheDocument();
    const onramp = screen.getByRole('link', {
      name: /JPYC 公式 で JPYC を購入/,
    });
    expect(onramp).toHaveAttribute('href', 'https://jpyc.co.jp/');
  });
});

describe('CheckoutForm — 送信', () => {
  it('支払いボタン → useBatchPayment.mutate に正しい breakdown', async () => {
    const user = userEvent.setup();
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);
    render(<CheckoutForm params={USDC_PARAMS} />);

    await user.click(
      screen.getByRole('button', { name: /55\.1 USDC を支払う/ }),
    );

    expect(mutate).toHaveBeenCalledOnce();
    const call = mutate.mock.calls[0][0];
    // total 55 USDC, fee=0 → merchant = 55 満額。gas (0.1) を回収: networkFeeEquivalent=会計記録、
    // gasReimbursement=useBatchPayment が実 on-chain で feeReceiver へ加算送金する額。
    expect(call.merchantAmount).toBe(55_000_000n);
    expect(call.feeAmount).toBe(0n);
    expect(call.networkFeeEquivalent).toBe(100_000n);
    expect(call.gasReimbursement).toBe(100_000n);
  });

  it('ERC20 mode (USDC mainnet 相当): feeAmount に gas を含めない', async () => {
    vi.mocked(resolvePaymasterMode).mockImplementation((dep) =>
      dep.symbol === 'usdc' ? 'erc20' : 'sponsorship',
    );
    const user = userEvent.setup();
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);
    render(<CheckoutForm params={USDC_PARAMS} />);

    await user.click(
      screen.getByRole('button', { name: /55\.1 USDC を支払う/ }),
    );

    const call = mutate.mock.calls[0][0];
    expect(call.merchantAmount).toBe(55_000_000n);
    // fee=0。erc20 paymaster は gas を顧客から直接徴収するので feeAmount=0。
    expect(call.feeAmount).toBe(0n);
  });

  it('gas=merchant: customer は subtotal だけ払い、gas は merchant から控除', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);
    render(
      <CheckoutForm params={{ ...USDC_PARAMS, gas: 'merchant' }} />,
    );
    // customer = subtotal = 55 USDC (gas は乗らない)
    expect(
      screen.getByRole('button', { name: /^55 USDC を支払う$/ }),
    ).toBeEnabled();
  });

  it('gas=merchant で amount < gas の merchant underflow → 送信 block + エラー文言', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(1_000_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);
    // 1% プロポーショナル単独では fee = amount × 1% ≤ amount のため必ず
    // merchant > 0 (underflow 不発火)。gas=merchant モードで amount (0.04)
    // < gas (0.1) のとき merchant = 0 になる。
    render(
      <CheckoutForm
        params={{
          ...USDC_PARAMS,
          gas: 'merchant',
          items: [{ name: 'Cheap', qty: 1, price: '0.04' }],
        }}
      />,
    );
    // fee=0 なので underflow は gas が原因 → メッセージは「gas を引くと店主受取が 0」
    expect(screen.getByText(/店主受取が 0/)).toBeInTheDocument();
  });
});

describe('CheckoutForm — 成功時の挙動', () => {
  it('成功 panel に txHash / userOpHash / orderId 表示', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setBatchPayment('success');
    setGasQuote('ready', 100_000n);
    render(<CheckoutForm params={USDC_PARAMS} />);
    expect(screen.getByText(/お支払いが完了しました/)).toBeInTheDocument();
    expect(screen.getByText(`0x${'a'.repeat(64)}`)).toBeInTheDocument();
    // この test の対象は ResultRow の txHash 表示 (受領控えの全文表示と併せ複数箇所に出る)。
    // 受領控えの埋め込み自体は次の専用 test で実検証する。
    expect(screen.getAllByText(`0x${'b'.repeat(64)}`).length).toBeGreaterThan(0);
    // orderId
    expect(screen.getByText('ord-42')).toBeInTheDocument();
  });

  it('成功 → 顧客向け電子レシート控えを保存し完了画面に埋め込む (/checkout・明細付き)', () => {
    window.localStorage.clear();
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setBatchPayment('success');
    setGasQuote('ready', 100_000n);
    render(<CheckoutForm params={USDC_PARAMS} />);
    // (a) 控えが保存される (sourceRoute=/checkout・明細あり)。
    const receipts = loadPayerReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0].sourceRoute).toBe('/checkout');
    expect(receipts[0].receiptId).toBe(`0x${'b'.repeat(64)}`); // = txHash
    expect(receipts[0].lineItems?.map((li) => li.name)).toEqual(['Tシャツ', 'マグ']);
    // (b) 完了画面に控え詳細 (PayerReceiptDetail) + 明細 + /scan 導線が描画される。
    expect(screen.getByText('OpenPay 電子レシート')).toBeInTheDocument();
    expect(screen.getByText(/\/scan で支払い履歴/).closest('a')).toHaveAttribute(
      'href',
      '/scan',
    );
  });

  it('success_url 指定時: 「今すぐ確認ページへ」ボタンが表示される', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setBatchPayment('success');
    setGasQuote('ready', 100_000n);
    render(
      <CheckoutForm
        params={{ ...USDC_PARAMS, successUrl: 'https://shop.example.com/thanks' }}
      />,
    );
    expect(
      screen.getByRole('button', { name: /今すぐ確認ページへ/ }),
    ).toBeInTheDocument();
  });

  it('success_url 未指定時: ホームに戻るボタン', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setBatchPayment('success');
    setGasQuote('ready', 100_000n);
    render(<CheckoutForm params={{ ...USDC_PARAMS, successUrl: undefined }} />);
    expect(
      screen.getByRole('button', { name: /OpenPay ホームへ戻る/ }),
    ).toBeInTheDocument();
  });

  it('success_url 指定 + 「今すぐ」クリック → window.location.assign に query 付き URL', async () => {
    const user = userEvent.setup();
    const assignSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, assign: assignSpy },
    });
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setBatchPayment('success');
    setGasQuote('ready', 100_000n);
    render(
      <CheckoutForm
        params={{ ...USDC_PARAMS, successUrl: 'https://shop.example.com/thanks' }}
      />,
    );
    await user.click(
      screen.getByRole('button', { name: /今すぐ確認ページへ/ }),
    );
    expect(assignSpy).toHaveBeenCalledOnce();
    const url = new URL(assignSpy.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe(
      'https://shop.example.com/thanks',
    );
    expect(url.searchParams.get('tx_hash')).toBe(`0x${'b'.repeat(64)}`);
    expect(url.searchParams.get('user_op_hash')).toBe(`0x${'a'.repeat(64)}`);
    expect(url.searchParams.get('order_id')).toBe('ord-42');
    expect(url.searchParams.get('chain')).toBe('base');
    expect(url.searchParams.get('token')).toBe('usdc');
  });

  it('webhook 指定 → POST が発火 (Tip と互換シェイプ + items・customerEmail は不在)', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchSpy);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);
    const makeUi = () => (
      <CheckoutForm
        params={{
          ...USDC_PARAMS,
          // customerEmail を URL に持つ状態でも payload には載らないことを確認する。
          customerEmail: 'alice@example.com',
          webhook: 'https://shop.example.com/hook',
        }}
      />
    );
    const { rerender } = render(makeUi());
    // submit を経て snapshot を固定 → 成功描画で webhook 発火。
    await submitGaslessThenSucceed(user, rerender, makeUi);

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://shop.example.com/hook');
    expect(opts.method).toBe('POST');
    const payload = JSON.parse(opts.body);
    expect(payload.type).toBe('openpay.checkout.success');
    expect(payload.merchant).toBe(MERCHANT);
    expect(payload.token).toBe('usdc');
    expect(payload.chain).toBe('base');
    expect(payload.items).toEqual(USDC_PARAMS.items);
    expect(payload.orderId).toBe('ord-42');
    expect(payload.txHash).toBe(`0x${'b'.repeat(64)}`);
    // URL 仕様で customerEmail は prefill 専用・クライアントから送信しない → payload に不在。
    expect('customerEmail' in payload).toBe(false);
    vi.unstubAllGlobals();
  });

  it('[regression] 異なる userOpHash (新規送金) では webhook が再発火する (ref が永久 lock しない)', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchSpy);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);
    const makeUi = () => (
      <CheckoutForm
        params={{
          ...USDC_PARAMS,
          webhook: 'https://shop.example.com/hook',
        }}
      />
    );

    // 1 回目の送信 → 成功 (userOpHash = aaaa...・setBatchPayment('success') の既定 data)。
    const { rerender } = render(makeUi());
    await submitGaslessThenSucceed(user, rerender, makeUi);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const firstPayload = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(firstPayload.userOpHash).toBe(`0x${'a'.repeat(64)}`);

    // 同一 component で 2 回目の送信 (= 新規 mutate)。idle に戻すと支払いボタンが再表示され、
    // click で snapshot が再固定される。異なる userOpHash の成功 → webhook が再発火する。
    const secondHash = `0x${'c'.repeat(64)}`;
    setBatchPayment('idle');
    rerender(makeUi());
    await user.click(screen.getByRole('button', { name: /を支払う/ }));
    mockHook(useBatchPayment, {
      mutate: vi.fn(),
      isPending: false,
      isSuccess: true,
      isError: false,
      data: {
        userOpHash: secondHash,
        txHash: `0x${'d'.repeat(64)}`,
        blockNumber: 100n,
        success: true,
        actualGasCost: 0n,
        provider: 'pimlico' as const,
      },
      error: null,
    } as Partial<ReturnType<typeof useBatchPayment>>);
    rerender(makeUi());

    // 新しい userOpHash で webhook が再発火する (ref が永久 lock していない)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    const secondPayload = JSON.parse(fetchSpy.mock.calls[1][1].body);
    expect(secondPayload.userOpHash).toBe(secondHash);
    vi.unstubAllGlobals();
  });

  it('[regression] 同一 userOpHash で再 render が起きても webhook は 1 回しか POST されない (gasQuote refetch 耐性)', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchSpy);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    // 初回 gasAmount = 100_000n
    setGasQuote('ready', 100_000n);
    const makeUi = () => (
      <CheckoutForm
        params={{
          ...USDC_PARAMS,
          webhook: 'https://shop.example.com/hook',
        }}
      />
    );
    const { rerender } = render(makeUi());
    // submit 時点の gas = 100_000n で snapshot を固定 → 成功描画で webhook 発火。
    await submitGaslessThenSucceed(user, rerender, makeUi);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    // gasQuote の refetchInterval を模擬: gasAmount を 200_000n に変えて再 render。
    // breakdown が変わるが webhook は再発火してはならない (同一 userOpHash)。
    setGasQuote('ready', 200_000n);
    rerender(makeUi());
    setGasQuote('ready', 300_000n);
    rerender(makeUi());

    // breakdown が 2 回変わっても webhook fetch は最初の 1 回のみ
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('[regression] webhook payload の amount/customerPays は submit 時点の値 (成功後の gas quote 変動を反映しない)', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchSpy);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    // submit 時点の gasAmount = 100_000n。gas=customer なので customerPays = 55 + 0.1 = 55.1 USDC。
    setGasQuote('ready', 100_000n);
    const makeUi = () => (
      <CheckoutForm
        params={{
          ...USDC_PARAMS,
          webhook: 'https://shop.example.com/hook',
        }}
      />
    );
    const { rerender } = render(makeUi());
    await submitGaslessThenSucceed(user, rerender, makeUi);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    // 成功描画後に gas quote が跳ねる (refetch)。live breakdown では customerPays が
    // 55.3 USDC に動くが、webhook は submit snapshot を報告するため変わってはならない。
    setGasQuote('ready', 300_000n);
    rerender(makeUi());

    const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
    // amount = 税込注文小計 (gas を含まない) = 55 USDC。
    expect(payload.amount).toBe('55');
    // customerPays = submit 時点の 55.1 USDC (= 55_100_000)。live の 55.3 ではない。
    expect(payload.customerPays).toBe('55100000');
    // merchant 着金は満額 55 USDC (customer モードなので gas は merchant 控除に乗らない)。
    expect(payload.merchantAmount).toBe('55000000');
    expect(payload.feeAmount).toBe('0');
    vi.unstubAllGlobals();
  });

  it('[regression] 同一 userOpHash で再 render が起きても redirect カウントダウンは再起動しない', async () => {
    vi.useFakeTimers();
    const assignSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, assign: assignSpy },
    });
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);
    const makeUi = () => (
      <CheckoutForm
        params={{
          ...USDC_PARAMS,
          successUrl: 'https://shop.example.com/thanks',
        }}
      />
    );
    const { rerender } = render(makeUi());
    // submit を経て成功 → カウントダウン start (snapshot 必須なので click が前提)。
    submitGaslessThenSucceedSync(rerender, makeUi);
    expect(screen.getByText(/3 秒後に確認ページへ移動します/)).toBeInTheDocument();
    // 1 秒進める → 2 秒 (act + 1 tick)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    // gasQuote refetch を模擬し再 render — 同一 userOpHash なのでカウントダウンは継続のはず
    setGasQuote('ready', 200_000n);
    rerender(makeUi());

    // 残り 2 秒進めて assign 発火を観測 (もしカウントダウンが 3 にリセットされていたら +1 秒不足で発火しない)
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }
    expect(assignSpy).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('webhook 失敗 (CORS 等) → UI には影響しない (logger.warn のみ)', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi
      .fn()
      .mockRejectedValue(new Error('CORS blocked'));
    vi.stubGlobal('fetch', fetchSpy);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);
    const makeUi = () => (
      <CheckoutForm
        params={{
          ...USDC_PARAMS,
          webhook: 'https://shop.example.com/hook',
        }}
      />
    );
    const { rerender } = render(makeUi());
    await submitGaslessThenSucceed(user, rerender, makeUi);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    // 成功 UI は影響を受けない
    expect(screen.getByText(/お支払いが完了しました/)).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('cancel_url 指定 → 「中止して戻る」リンクを描画', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);
    render(
      <CheckoutForm
        params={{
          ...USDC_PARAMS,
          cancelUrl: 'https://shop.example.com/cart',
        }}
      />,
    );
    const link = screen.getByRole('link', { name: /注文を中止して戻る/ });
    expect(link).toHaveAttribute('href', 'https://shop.example.com/cart');
  });

  it('cancel_url なし → リンクは描画しない', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);
    render(<CheckoutForm params={{ ...USDC_PARAMS, cancelUrl: undefined }} />);
    expect(screen.queryByText(/注文を中止して戻る/)).toBeNull();
  });

  it('customer_email 指定 → ヒント表示', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);
    render(
      <CheckoutForm
        params={{ ...USDC_PARAMS, customerEmail: 'alice@example.com' }}
      />,
    );
    expect(screen.getByText(/alice@example.com/)).toBeInTheDocument();
  });
});

describe('CheckoutForm — チェーン切替 状態 + isSwitching', () => {
  it('isSwitching=true の間は「チェーン切替中…」表示でボタン disabled', () => {
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(0n);
    setSmartAccount(false);
    mockHook(useSwitchChain, {
      switchChain: vi.fn(),
      isPending: true,
    });
    render(<CheckoutForm params={USDC_PARAMS} />);
    const btn = screen.getByRole('button', { name: /チェーン切替中…/ });
    expect(btn).toBeDisabled();
  });

  it('switch ボタン click で switchChain({ chainId: requiredChain.id }) が呼ばれる', async () => {
    const user = userEvent.setup();
    const switchChain = vi.fn();
    mockHook(useSwitchChain, { switchChain, isPending: false });
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(0n);
    setSmartAccount(false);
    render(<CheckoutForm params={USDC_PARAMS} />);
    await user.click(screen.getByRole('button', { name: /へ切り替え/ }));
    expect(switchChain).toHaveBeenCalledWith({ chainId: baseSepolia.id });
  });
});

describe('CheckoutForm — 自動 redirect カウントダウン (fake timers)', () => {
  let assignSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    assignSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, assign: assignSpy },
    });
  });

  it('成功 → 3 秒タイマーで countdown → 0 で window.location.assign 発火', async () => {
    vi.useFakeTimers();
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);
    const makeUi = () => (
      <CheckoutForm
        params={{
          ...USDC_PARAMS,
          successUrl: 'https://shop.example.com/thanks',
        }}
      />
    );
    const { rerender } = render(makeUi());
    // submit を経て成功 → カウントダウン start (snapshot 必須)。
    submitGaslessThenSucceedSync(rerender, makeUi);
    // 成功 panel が出ている (success_url 指定あり → カウントダウン start)
    expect(screen.getByText(/お支払いが完了しました/)).toBeInTheDocument();
    expect(screen.getByText(/3 秒後に確認ページへ移動します/)).toBeInTheDocument();

    // タイマーを 1 秒ずつ刻んで進める。各 tick で setRedirectIn が状態更新 →
    // 再 render → 次の setTimeout がスケジュールされる連鎖を実行する。
    // 一括で 4 秒進めると React の state 更新と timer の interleaving が
    // バンドラ依存になるため、明示的に 1 秒刻みで act + 進める。
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }

    expect(assignSpy).toHaveBeenCalledOnce();
    const url = new URL(assignSpy.mock.calls[0][0]);
    expect(url.searchParams.get('tx_hash')).toBe(`0x${'b'.repeat(64)}`);
    vi.useRealTimers();
  });

  it('success_url 未指定時はカウントダウン state が走らない (タイマーが空回りしない)', async () => {
    vi.useFakeTimers();
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setBatchPayment('success');
    setGasQuote('ready', 100_000n);
    render(
      <CheckoutForm params={{ ...USDC_PARAMS, successUrl: undefined }} />,
    );
    // カウントダウンメッセージは出ない
    expect(screen.queryByText(/秒後に確認ページへ移動します/)).toBeNull();
    // タイマー進めても assign は呼ばれない
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(assignSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('成功前 (gasless.data なし) はカウントダウン未起動', async () => {
    vi.useFakeTimers();
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setBatchPayment('idle'); // 未送信
    setGasQuote('ready', 100_000n);
    render(
      <CheckoutForm
        params={{
          ...USDC_PARAMS,
          successUrl: 'https://shop.example.com/thanks',
        }}
      />,
    );
    expect(screen.queryByText(/秒後に確認ページへ移動します/)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(assignSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('CheckoutForm — エラー表示', () => {
  it('GasCongestedError → i18n された案内文', async () => {
    const { GasCongestedError } = await import('@/lib/gasCeiling');
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);
    mockHook(useBatchPayment, {
      mutate: vi.fn(),
      isPending: false,
      isSuccess: false,
      isError: true,
      data: undefined,
      error: new GasCongestedError(baseSepolia.id, 1n, 5n),
    } as Partial<ReturnType<typeof useBatchPayment>>);
    render(<CheckoutForm params={USDC_PARAMS} />);
    expect(screen.getByText(/ネットワークが混雑/)).toBeInTheDocument();
    expect(screen.queryByText(/gas_congested/)).toBeNull();
  });

  it('gasQuote.error → friendly メッセージ + ボタン disabled', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('error');
    render(<CheckoutForm params={USDC_PARAMS} />);
    expect(
      screen.getByText(/ガス代見積の取得に失敗しました/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /ガス代見積取得中/ }),
    ).toBeDisabled();
  });

  it('useSmartAccount.error → メッセージそのまま (技術詳細だが UI 上にも出す)', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(false, new Error('SA init failed'));
    render(<CheckoutForm params={USDC_PARAMS} />);
    expect(screen.getByText('SA init failed')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 通常決済（ガス代は自分で負担） / mode=standard の統合テスト
// ---------------------------------------------------------------------------

const STANDARD_USDC_PARAMS: CheckoutParams = {
  ...USDC_PARAMS,
  mode: 'standard',
};

describe('CheckoutForm — mode=standard 統合', () => {
  it('明細: mode=standard では gas 見積行が「ウォレットで支払い」になり、SA 初期化は走らない', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    render(<CheckoutForm params={STANDARD_USDC_PARAMS} />);
    expect(screen.getByText(/ウォレットで支払い/)).toBeInTheDocument();
    // 「通常決済（ガス代は自分で負担）」バッジ + standardHint で複数箇所
    expect(
      screen.getAllByText(/通常決済（ガス代は自分で負担）/).length,
    ).toBeGreaterThanOrEqual(1);
    // useSmartAccount は enabled=false で呼ばれる
    expect(useSmartAccount).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'usdc' }),
      false,
    );
  });

  it('mode=standard で 「支払う」 クリック → standardMutate に正しい引数が渡る (fee=0)', async () => {
    const user = userEvent.setup();
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(false);
    render(<CheckoutForm params={STANDARD_USDC_PARAMS} />);
    // USDC_PARAMS の items は subtotal 55 USDC (25 + 15*2)
    await user.click(screen.getByRole('button', { name: /55 USDC を支払う/ }));
    expect(standardMutate).toHaveBeenCalledOnce();
    const call = standardMutate.mock.calls[0][0];
    // fee=0 → merchant = 55 満額
    expect(call.feeAmount).toBe(0n);
    expect(call.merchantAmount).toBe(55_000_000n);
    expect(call.chainId).toBe(baseSepolia.id);
  });

  it('mode=standard 成功時の webhook payload に mode/merchantTxHash/feeTxHash が含まれる (customerEmail は不在)', async () => {
    const user = userEvent.setup();
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    const makeUi = () => (
      <CheckoutForm
        params={{
          ...STANDARD_USDC_PARAMS,
          customerEmail: 'alice@example.com',
          webhook: 'https://shop.example.com/hook',
        }}
      />
    );
    const { rerender } = render(makeUi());
    // submit を経て snapshot を固定 → 成功描画で webhook 発火。
    await submitStandardThenSucceed(user, rerender, makeUi);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://shop.example.com/hook');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.type).toBe('openpay.checkout.success');
    expect(body.mode).toBe('standard');
    expect(body.merchantTxHash).toBe(`0x${'c'.repeat(64)}`);
    expect(body.feeTxHash).toBe(`0x${'d'.repeat(64)}`);
    // gasless の userOpHash は出ない (mode=standard の payload では別 schema)
    expect(body.userOpHash).toBeUndefined();
    expect(body.txHash).toBeUndefined();
    // amount = 税込注文小計 (55 USDC)・merchant 着金は満額 (fee=0)。submit snapshot 由来。
    expect(body.amount).toBe('55');
    expect(body.merchantAmount).toBe('55000000');
    expect(body.feeAmount).toBe('0');
    // customerEmail は payload に載らない (URL 仕様: prefill 専用)。
    expect('customerEmail' in body).toBe(false);
    fetchSpy.mockRestore();
  });

  it('mode=standard 成功時の webhook が同一 merchantTxHash で再 render しても 1 回しか発火しない (dedup)', async () => {
    const user = userEvent.setup();
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    const makeUi = () => (
      <CheckoutForm
        params={{
          ...STANDARD_USDC_PARAMS,
          webhook: 'https://shop.example.com/hook',
        }}
      />
    );
    const { rerender } = render(makeUi());
    await submitStandardThenSucceed(user, rerender, makeUi);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    // 連続 rerender しても dedup されて発火されない
    rerender(makeUi());
    rerender(makeUi());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it('mode=standard 成功 + success_url → 「今すぐ確認ページへ」 click で query に tx_hash/fee_tx_hash/mode=standard 付与', async () => {
    const user = userEvent.setup();
    const assignSpy = vi
      .spyOn(window.location, 'assign')
      .mockImplementation(() => {});
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setStandardPayment('success');
    render(
      <CheckoutForm
        params={{
          ...STANDARD_USDC_PARAMS,
          successUrl: 'https://shop.example.com/thanks',
        }}
      />,
    );
    await user.click(screen.getByRole('button', { name: /今すぐ確認ページへ/ }));
    expect(assignSpy).toHaveBeenCalledOnce();
    const url = new URL(assignSpy.mock.calls[0][0] as string);
    expect(url.searchParams.get('tx_hash')).toBe(`0x${'c'.repeat(64)}`);
    expect(url.searchParams.get('fee_tx_hash')).toBe(`0x${'d'.repeat(64)}`);
    expect(url.searchParams.get('mode')).toBe('standard');
    expect(url.searchParams.get('block')).toBe('123');
    expect(url.searchParams.get('order_id')).toBe('ord-42');
    // gasless の user_op_hash は付かない
    expect(url.searchParams.get('user_op_hash')).toBeNull();
    assignSpy.mockRestore();
  });

  it('mode=standard 成功 (fee=0): query に fee_tx_hash が含まれない', async () => {
    const user = userEvent.setup();
    const assignSpy = vi
      .spyOn(window.location, 'assign')
      .mockImplementation(() => {});
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setStandardPayment('success-no-fee');
    render(
      <CheckoutForm
        params={{
          ...STANDARD_USDC_PARAMS,
          successUrl: 'https://shop.example.com/thanks',
        }}
      />,
    );
    await user.click(screen.getByRole('button', { name: /今すぐ確認ページへ/ }));
    const url = new URL(assignSpy.mock.calls[0][0] as string);
    expect(url.searchParams.get('tx_hash')).toBe(`0x${'c'.repeat(64)}`);
    expect(url.searchParams.get('fee_tx_hash')).toBeNull();
    assignSpy.mockRestore();
  });

  it('mode=standard fee-error: 「OpenPay 利用手数料の送信に失敗」+ retry ボタン → retryFee 発火', async () => {
    const user = userEvent.setup();
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setStandardPayment('fee-error');
    render(<CheckoutForm params={STANDARD_USDC_PARAMS} />);
    expect(
      screen.getByText(/OpenPay 利用手数料の送信に失敗/),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: /手数料の送信を再試行/ }),
    );
    expect(standardRetryFee).toHaveBeenCalledOnce();
  });

  it.each([
    ['merchant-sending' as const, /店舗送金を承認してください/],
    ['merchant-mining' as const, /店舗送金を確定中/],
    ['fee-sending' as const, /手数料の送金を承認してください/],
    ['fee-mining' as const, /手数料の送金を確定中/],
  ])('checkoutPhaseLabel: phase=%s でボタン label が %s', (phase, expected) => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setStandardPayment(phase);
    render(<CheckoutForm params={STANDARD_USDC_PARAMS} />);
    expect(screen.getByRole('button', { name: expected })).toBeDisabled();
  });

  it('mode=standard success-no-fee: ResultPanel に fee Tx Hash 行が出ない', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setStandardPayment('success-no-fee');
    render(<CheckoutForm params={STANDARD_USDC_PARAMS} />);
    expect(screen.getAllByText(`0x${'c'.repeat(64)}`).length).toBeGreaterThan(0);
    expect(screen.queryByText(`0x${'d'.repeat(64)}`)).toBeNull();
    expect(screen.queryByText('手数料 Tx Hash')).toBeNull();
  });

  it('mode=standard SuccessOverlay: merchant tx hash (truncate 形式) を txHash として描画', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setStandardPayment('success');
    render(<CheckoutForm params={STANDARD_USDC_PARAMS} />);
    expect(screen.getAllByText(/決済完了/).length).toBeGreaterThan(0);
    // merchant tx の full hash が inline panel に 1 度出る
    expect(
      screen.getAllByText(`0x${'c'.repeat(64)}`).length,
    ).toBeGreaterThanOrEqual(1);
    // overlay の truncate (先頭 10 + … + 末尾 6) も検出
    expect(
      screen.getByText(/0xcccccccc…cccccc/),
    ).toBeInTheDocument();
  });
});

describe('CheckoutForm — 複数商品の履歴保存 (統合: usePaymentHistory→buildHistoryEntry→LocalStorage)', () => {
  // usePaymentHistory / buildHistoryEntry / appendHistory / loadHistory は実物。決済 hook と
  // wagmi のみ境界で mock し、gasless 成功で売上明細が LocalStorage に保存される実コードパスを検証。
  it('gasless 成功 → lineItems (per-item 税/通貨/管理番号) が履歴に保存される', async () => {
    window.localStorage.clear();
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setGasQuote('ready');
    setBatchPayment('success');
    const params: CheckoutParams = {
      to: MERCHANT,
      token: 'usdc',
      chain: 'base',
      gas: 'customer',
      items: [
        { name: 'Tシャツ', qty: 1, price: '25', taxRate: 10, taxCategory: 'taxable_10' },
        { name: '寄付', qty: 1, price: '5', taxRate: 0, taxCategory: 'out_of_scope' },
      ],
      receiptNo: 'R-1',
    };
    render(<CheckoutForm params={params} />);

    await waitFor(() => expect(loadHistory().length).toBeGreaterThan(0));
    const e = loadHistory().find((x) => x.txHash === `0x${'b'.repeat(64)}`);
    expect(e).toBeDefined();
    expect(e?.lineItems).toHaveLength(2);

    const shirt = e?.lineItems?.find((l) => l.name === 'Tシャツ');
    expect(shirt).toMatchObject({
      quantity: 1,
      unitPrice: '25',
      currency: 'usdc',
      taxRate: 10,
      taxCategory: 'taxable_10',
    });
    expect(shirt?.taxAmount).toBe('2.27'); // 25 税込@10% (USDC 2桁) 内税

    const donation = e?.lineItems?.find((l) => l.name === '寄付');
    expect(donation).toMatchObject({ taxRate: 0, taxCategory: 'out_of_scope', taxAmount: '0' });

    expect(e?.receiptNo).toBe('R-1');
    expect(e?.productName).toBe('Tシャツ, 寄付'); // 代表名 = 明細名の連結
  });
});

// ---------------------------------------------------------------------------
// JPYC EIP-3009 relay 経路 (/checkout・簡易レジ): resolveJpycGaslessProvider が
// 'eip3009-relay' を返すとき、useBatchPayment (Pimlico) ではなく useJpycEip3009Payment へ。
// ---------------------------------------------------------------------------
describe('CheckoutForm — JPYC EIP-3009 relay 経路', () => {
  const JPYC_TOTAL = 3000n * 10n ** 18n; // 3000 JPYC (18 decimals)

  function setupRelayReady() {
    vi.mocked(resolveJpycGaslessProvider).mockReturnValue('eip3009-relay');
    // test env では 'polygon' slug は Amoy に解決される (既存 JPYC テストと同じ)。
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(10_000n * 10n ** 18n); // 潤沢な JPYC 残高
  }

  it('flag ON + JPYC + Polygon: submit が relay.mutate を呼び gasless/standard は呼ばない (free)', async () => {
    const user = userEvent.setup();
    setupRelayReady();
    setSmartAccount(false); // SA 未構築でも relay は submit 可能
    render(<CheckoutForm params={JPYC_PARAMS} />);

    // relay 経路では Smart Account / gas quote を skip (enabled=false)。
    expect(useSmartAccount).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'jpyc' }),
      false,
    );
    // free モードの gas 行は「無料」表示。
    expect(screen.getByText('無料 (OpenPay が負担)')).toBeInTheDocument();

    const btn = screen.getByRole('button', { name: /3000 JPYC を支払う/ });
    expect(btn).toBeEnabled();
    await user.click(btn);

    expect(relayMutate).toHaveBeenCalledOnce();
    expect(relayMutate).toHaveBeenCalledWith({
      merchant: MERCHANT,
      value: JPYC_TOTAL,
      gasMode: 'customer',
    });
    expect(mutate).not.toHaveBeenCalled(); // useBatchPayment.mutate (Pimlico)
    expect(standardMutate).not.toHaveBeenCalled();
  });

  it('relay 成功: txHash パネル + 顧客向け控え埋込 (/checkout) + 履歴保存', () => {
    window.localStorage.clear();
    setupRelayReady();
    setRelayPayment('success', {
      txHash: `0x${'e'.repeat(64)}`,
      variables: { merchant: MERCHANT, value: JPYC_TOTAL, gasMode: 'customer' },
    });
    render(<CheckoutForm params={JPYC_PARAMS} />);

    expect(screen.getByText(/お支払いが完了しました/)).toBeInTheDocument();
    // txHash は成功パネル + 控え + overlay の複数箇所に出る。
    expect(screen.getAllByText(`0x${'e'.repeat(64)}`).length).toBeGreaterThan(0);

    // 控えが保存される (sourceRoute=/checkout・receiptId=txHash)。
    const receipts = loadPayerReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0].sourceRoute).toBe('/checkout');
    expect(receipts[0].receiptId).toBe(`0x${'e'.repeat(64)}`);
    // 完了画面に控え詳細が埋め込まれる。
    expect(screen.getByText('OpenPay 電子レシート')).toBeInTheDocument();

    // 履歴: relay は gasless variant・gross=saleAmount=3000・merchant=3000 (free/customer)。
    const e = loadHistory().find((x) => x.txHash === `0x${'e'.repeat(64)}`);
    expect(e).toBeDefined();
    expect(e?.payMode).toBe('gasless');
    // HistoryEntry は atomic 額を decimal 文字列で保持する。
    expect(e?.saleAmount).toBe(JPYC_TOTAL.toString());
    expect(e?.merchantAmount).toBe(JPYC_TOTAL.toString());
    expect(e?.userOpHash).toBeNull();
    expect(e?.blockNumber).toBeNull();
  });

  it('relay recover (forwarder 設定 + gas=merchant): gas 行に回収額 + 履歴 merchantAmount=value−fee', () => {
    window.localStorage.clear();
    vi.mocked(jpycForwarderFor).mockReturnValue(
      '0x1111111111111111111111111111111111111111',
    );
    setupRelayReady();
    setRelayPayment('success', {
      txHash: `0x${'e'.repeat(64)}`,
      variables: { merchant: MERCHANT, value: JPYC_TOTAL, gasMode: 'merchant' },
    });
    render(<CheckoutForm params={{ ...JPYC_PARAMS, gas: 'merchant' }} />);

    // recover は固定回収額 (2 JPYC) を gas 行に表示。
    expect(screen.getByText('2 JPYC')).toBeInTheDocument();

    const e = loadHistory().find((x) => x.txHash === `0x${'e'.repeat(64)}`);
    expect(e).toBeDefined();
    // recover + merchant 吸収: merchantAmount = value − fee(2 JPYC)、saleAmount = value。
    // (HistoryEntry は atomic 額を decimal 文字列で保持する。)
    expect(e?.merchantAmount).toBe(((3000n - 2n) * 10n ** 18n).toString());
    expect(e?.saleAmount).toBe(JPYC_TOTAL.toString());
    expect(e?.networkFeeEquivalent).toBe((2n * 10n ** 18n).toString());
  });

  it('relay error code (rate_limited) → friendly i18n 文言に変換 (生コード非表示)', () => {
    setupRelayReady();
    setRelayPayment('error', { errMsg: 'rate_limited' });
    render(<CheckoutForm params={JPYC_PARAMS} />);
    expect(screen.getByText(/短時間に決済が集中/)).toBeInTheDocument();
    expect(screen.queryByText('rate_limited')).toBeNull();
  });

  it('relay pending (broadcast 済・未確定): pending パネル + 再送ブロック (二重支払い防止)', async () => {
    const user = userEvent.setup();
    setupRelayReady();
    setRelayPayment('broadcast-pending', { txHash: `0x${'e'.repeat(64)}` });
    render(<CheckoutForm params={JPYC_PARAMS} />);

    // pending パネルが出る (success パネルは出さない)。
    expect(screen.getByText(/送信済み・確認待ち/)).toBeInTheDocument();
    expect(screen.queryByText(/お支払いが完了しました/)).toBeNull();
    // 再送ブロック: 支払いボタンは disabled (settledNoRetry)。broadcast 済 tx が確定すると
    // 再送分は 2 件目の on-chain 送金 = 二重支払いになるため。
    const payBtn = screen.getByRole('button', { name: /を支払う/ });
    expect(payBtn).toBeDisabled();
    // 再クリックしても relay.mutate は発火しない。
    await user.click(payBtn);
    expect(relayMutate).not.toHaveBeenCalled();
    // pending は error ではないので error パネルは出ない。
    expect(screen.queryByText(/エラー/)).toBeNull();
  });

  it('resolve=pimlico-7702 (relay 非選択): JPYC でも従来の Pimlico 経路 (gasless.mutate)', async () => {
    const user = userEvent.setup();
    // resolveJpycGaslessProvider は beforeEach で 'pimlico-7702'。
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(10_000n * 10n ** 18n);
    setSmartAccount(true);
    setGasQuote('ready', 0n);
    render(<CheckoutForm params={JPYC_PARAMS} />);

    await user.click(screen.getByRole('button', { name: /3000 JPYC を支払う/ }));
    expect(mutate).toHaveBeenCalledOnce(); // useBatchPayment (Pimlico)
    expect(relayMutate).not.toHaveBeenCalled();
  });

  it('relay 成功 + webhook: payload に txHash あり・blockNumber は省略 (null を直列化しない)', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchSpy);
    setupRelayReady();
    setRelayPayment('idle');
    const makeUi = () => (
      <CheckoutForm
        params={{ ...JPYC_PARAMS, webhook: 'https://shop.example.com/hook' }}
      />
    );
    const { rerender } = render(makeUi());
    // submit を経て snapshot を固定 → 成功描画で webhook 発火。
    await submitRelayThenSucceed(user, rerender, makeUi, {
      txHash: `0x${'e'.repeat(64)}`,
      variables: { merchant: MERCHANT, value: JPYC_TOTAL, gasMode: 'customer' },
    });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(payload.txHash).toBe(`0x${'e'.repeat(64)}`);
    expect(payload.mode).toBe('gasless');
    // amount = 注文小計 3000 JPYC・merchant 着金は満額 (free/customer)。submit snapshot 由来。
    expect(payload.amount).toBe('3000');
    expect(payload.merchantAmount).toBe(JPYC_TOTAL.toString());
    expect(payload.customerPays).toBe(JPYC_TOTAL.toString());
    // relay は block 不明 → payload から省略 (key 自体が無い・"null" 文字列にしない)。
    expect('blockNumber' in payload).toBe(false);
    expect(payload.userOpHash).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('relay 成功 + success_url: redirect query は tx_hash のみ (block / user_op_hash なし)', async () => {
    const user = userEvent.setup();
    const assignSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, assign: assignSpy },
    });
    setupRelayReady();
    setRelayPayment('success', {
      txHash: `0x${'e'.repeat(64)}`,
      variables: { merchant: MERCHANT, value: JPYC_TOTAL, gasMode: 'customer' },
    });
    render(
      <CheckoutForm
        params={{ ...JPYC_PARAMS, successUrl: 'https://shop.example.com/thanks' }}
      />,
    );
    await user.click(screen.getByRole('button', { name: /今すぐ確認ページへ/ }));
    expect(assignSpy).toHaveBeenCalledOnce();
    const url = new URL(assignSpy.mock.calls[0][0]);
    expect(url.searchParams.get('tx_hash')).toBe(`0x${'e'.repeat(64)}`);
    expect(url.searchParams.get('block')).toBeNull();
    expect(url.searchParams.get('user_op_hash')).toBeNull();
  });

  it('relay pending: webhook も redirect も発火しない (未確定 = completion なし)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchSpy);
    const assignSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, assign: assignSpy },
    });
    setupRelayReady();
    setRelayPayment('broadcast-pending', { txHash: `0x${'e'.repeat(64)}` });
    render(
      <CheckoutForm
        params={{
          ...JPYC_PARAMS,
          webhook: 'https://shop.example.com/hook',
          successUrl: 'https://shop.example.com/thanks',
        }}
      />,
    );
    expect(screen.getByText(/送信済み・確認待ち/)).toBeInTheDocument();
    await Promise.resolve(); // microtask flush
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(assignSpy).not.toHaveBeenCalled();
    expect(screen.queryByText(/確認ページへ移動します/)).toBeNull();
    vi.unstubAllGlobals();
  });

  it('relay in-flight (isPending): 送信中表示でボタン disabled (再送防止)', () => {
    setupRelayReady();
    setRelayPayment('pending-flow');
    render(<CheckoutForm params={JPYC_PARAMS} />);
    expect(screen.getByRole('button', { name: /送信中…/ })).toBeDisabled();
  });

  it('relay pending かつ txHash なし (authorizationState 既使用): tx 行なしの pending パネル + completion なし', () => {
    const assignSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, assign: assignSpy },
    });
    vi.mocked(resolveJpycGaslessProvider).mockReturnValue('eip3009-relay');
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(10_000n * 10n ** 18n);
    mockHook(useJpycEip3009Payment, {
      mutate: vi.fn(),
      isPending: false,
      data: { txHash: null, success: false, pending: true },
      error: null,
      variables: undefined,
    } as Partial<ReturnType<typeof useJpycEip3009Payment>>);
    render(
      <CheckoutForm
        params={{ ...JPYC_PARAMS, successUrl: 'https://shop.example.com/thanks' }}
      />,
    );
    // pending パネルは出るが txHash 行は無い (txHash=null)。
    expect(screen.getByText(/送信済み・確認待ち/)).toBeInTheDocument();
    expect(screen.queryByText(/Explorer で確認/)).toBeNull();
    // 成功扱いしない → 完了パネルも redirect も無い。
    expect(screen.queryByText(/お支払いが完了しました/)).toBeNull();
    expect(screen.queryByText(/確認ページへ移動します/)).toBeNull();
    expect(assignSpy).not.toHaveBeenCalled();
  });
});
