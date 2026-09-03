import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
import userEvent from '@testing-library/user-event';
import { baseSepolia, polygonAmoy } from 'viem/chains';
import type { Address } from 'viem';

// 全ての外部依存を境界モック。テスト対象 (PaymentForm) のロジック
// (URL parse / breakdown 計算 / 状態遷移 / 送信ハンドラ) は実コードを実行する。
vi.mock('next/navigation', () => ({
  useSearchParams: vi.fn(),
}));
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
// useJpycEip3009Payment は real だと wagmi useWalletClient + react-query (useMutation) に依存する
// (#131c)。本 test の責務は PaymentForm 本体ロジックなので idle 状態で stub (relay 経路は
// jpycRelay/forwarderRecover の unit + e2e で検証)。useMutation 互換の最小 shape を返す。
vi.mock('@/hooks/useJpycEip3009Payment', () => ({
  useJpycEip3009Payment: vi.fn(() => ({
    data: undefined,
    error: null,
    isPending: false,
    mutate: vi.fn(),
    variables: undefined,
  })),
}));
// relay 経路の発火は env flag (module-load) ではなく resolveJpycGaslessProvider を直接
// 制御する。既定は 'pimlico-7702' (= 従来挙動) で、relay テストのみ 'eip3009-relay' に
// 切替える (CheckoutForm.test と同型)。
vi.mock('@/lib/jpycGaslessProvider', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/jpycGaslessProvider')
  >('@/lib/jpycGaslessProvider');
  return { ...actual, resolveJpycGaslessProvider: vi.fn(() => 'pimlico-7702') };
});
// forwarder 設定は env 依存なので test で決定論的に制御する。既定 null = free モード
// (OpenPay がガス負担・署名安心パネルを出す対象)。recover は jpycForwarderFor をアドレスに。
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
vi.mock('@/hooks/useGasQuoteUsdc', () => ({ useGasQuoteUsdc: vi.fn() }));
vi.mock('@/hooks/useGasQuoteJpyc', () => ({ useGasQuoteJpyc: vi.fn() }));
// B1 Layer B: relayer 事前健全性プローブ。既定 non-degraded (= 既存テストに影響しない)。
// preflight banner テストでのみ degraded:true に差し替える。
vi.mock('@/hooks/useRelayHealth', () => ({
  useRelayHealth: vi.fn(() => ({ degraded: false })),
}));
// Circle quote は flag OFF (resolveUsdcGaslessProvider→pimlico) で非 active。useQuery を
// 走らせないよう stub (QueryClientProvider 無しで render する既存 test を壊さない)。
// circle 経路 (usdc-permit 署名安心) テストでのみ setCircleQuote で data を持たせる。
vi.mock('@/hooks/useGasQuoteCircle', () => ({ useGasQuoteCircle: vi.fn() }));
// resolveUsdcGaslessProvider は既定 'pimlico' (= 従来 erc20)。circle テストでのみ
// 'circle' に切替える (TipForm.test と同型)。
vi.mock('@/lib/circlePaymaster', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/circlePaymaster')>(
      '@/lib/circlePaymaster',
    );
  return { ...actual, resolveUsdcGaslessProvider: vi.fn(() => 'pimlico') };
});
// CrossChainHint は wagmi の useWalletClient / usePublicClient + react-query
// に依存するが、本 test file の責務は PaymentForm 本体ロジックのため、Hint は
// 空 component で stub する (Hint 自体の動作は CrossChainHint.test.tsx で検証)。
// 但し、PaymentForm から Hint へ正しい props (token / enabled / requiredAtomic /
// targetChainId / recipient / tokenAddress) が渡るかは本 test で
// crossChainHintSpy 経由で props を capture して検証する (LARP audit C1)。
const crossChainHintSpy = vi.fn();
vi.mock('@/components/CrossChainHint', () => ({
  CrossChainHint: (props: Record<string, unknown>) => {
    crossChainHintSpy(props);
    return null;
  },
}));
// ConnectButton は実物だと jsdom で重い wagmi graph を render 評価し worker OOM (memory:
// paymentform-oom-rootcause)。軽量 stub に差し替え (本 test の対象は PaymentForm ロジック)。
vi.mock('@/components/ConnectButton', async () => ({
  ConnectButton: (await import('../_helpers/connectButtonStub')).ConnectButtonStub,
}));
// resolvePaymasterMode は env 依存なので、testnet/mainnet を切替えられるよう
// テスト個別に注入する。
vi.mock('@/lib/pimlico', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/pimlico')>('@/lib/pimlico');
  return {
    ...actual,
    resolvePaymasterMode: vi.fn(actual.resolvePaymasterMode),
  };
});

import { useSearchParams, type ReadonlyURLSearchParams } from 'next/navigation';
import { useAccount, useReadContract, useSwitchChain } from 'wagmi';
import { useSmartAccount } from '@/hooks/useSmartAccount';
import { useBatchPayment } from '@/hooks/useBatchPayment';
import { useStandardPayment } from '@/hooks/useStandardPayment';
import { useGasQuoteUsdc } from '@/hooks/useGasQuoteUsdc';
import { useGasQuoteJpyc } from '@/hooks/useGasQuoteJpyc';
import { useGasQuoteCircle } from '@/hooks/useGasQuoteCircle';
import { resolveUsdcGaslessProvider } from '@/lib/circlePaymaster';
import { useJpycEip3009Payment } from '@/hooks/useJpycEip3009Payment';
import { useRelayHealth } from '@/hooks/useRelayHealth';
import { resolvePaymasterMode } from '@/lib/pimlico';
import { resolveJpycGaslessProvider } from '@/lib/jpycGaslessProvider';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { PaymentForm } from '@/components/PaymentForm';
import { logger } from '@/lib/logger';
import { loadHistory } from '@/lib/history';
import { loadPayerReceipts } from '@/lib/payerReceipt';
import {
  RelayIpRateLimitedError,
  RelayResponseUnknownError,
} from '@/lib/relay/relayResponseError';
import { mockHook } from '../_helpers/wagmiMock';

const MERCHANT: Address = '0x1111111111111111111111111111111111111111';
const CUSTOMER: Address = '0x9999999999999999999999999999999999999999';

function setURL(query: string) {
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(query) as unknown as ReadonlyURLSearchParams,
  );
}

function setAccount(opts: {
  connected: boolean;
  chainId?: number;
}) {
  mockHook(useAccount, {
    address: opts.connected ? CUSTOMER : undefined,
    isConnected: opts.connected,
    chainId: opts.connected ? opts.chainId : undefined,
    chain: opts.connected
      ? opts.chainId === baseSepolia.id
        ? baseSepolia
        : polygonAmoy
      : undefined,
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
    data: ready
      ? { smartAccountClient: {}, pimlicoClient: {} }
      : undefined,
    isLoading: !ready && !error,
    error: error ?? null,
  } as Partial<ReturnType<typeof useSmartAccount>>);
}

let mutate: ReturnType<typeof vi.fn>;
let standardMutate: ReturnType<typeof vi.fn>;
let standardRetryFee: ReturnType<typeof vi.fn>;
let standardRetryReceipt: ReturnType<typeof vi.fn>;
let gaslessRetryReceipt: ReturnType<typeof vi.fn>;
function setPayment(
  state:
    | 'idle'
    | 'pending'
    | 'unknown'
    | 'store-unavailable'
    | 'success'
    | 'error',
  err?: Error,
) {
  mutate = vi.fn();
  gaslessRetryReceipt = vi.fn();
  mockHook(useBatchPayment, {
    mutate,
    isPending: state === 'pending',
    isUnknown: state === 'unknown',
    // pending record store が読めない fail-closed 状態 (isUnknown とは別 flag)。
    pendingStoreUnavailable: state === 'store-unavailable',
    pendingUserOpHash:
      state === 'unknown' ? `0x${'c'.repeat(64)}` : undefined,
    retryReceipt: gaslessRetryReceipt,
    isSuccess: state === 'success',
    isError: state === 'error',
    data:
      state === 'success'
        ? {
            userOpHash: `0x${'a'.repeat(64)}`,
            txHash: `0x${'b'.repeat(64)}`,
            blockNumber: 42n,
            success: true,
          }
        : undefined,
    error:
      state === 'error'
        ? (err ?? new Error('AA21 didn\'t pay prefund'))
        : null,
  } as Partial<ReturnType<typeof useBatchPayment>>);
}

// relay (useJpycEip3009Payment) の状態を制御する helper。CheckoutForm.test と同型。
let relayMutate: ReturnType<typeof vi.fn>;
let relayRetryRelay: ReturnType<typeof vi.fn>;
let relayRetrySamePayload: ReturnType<typeof vi.fn>;
function setRelay(
  state:
    | 'idle'
    | 'pending-flow'
    | 'success'
    | 'broadcast-pending'
    | 'response-unknown'
    | 'ip-rate-limited'
    | 'error',
  opts?: {
    txHash?: `0x${string}`;
    errMsg?: string;
    retryAfterSeconds?: number | null;
    recoveryState?: 'auto' | 'exhausted' | null;
    variables?: {
      merchant: Address;
      value: bigint;
      gasMode?: 'customer' | 'merchant';
      contextKey?: string;
    };
    restoredIntent?: NonNullable<
      ReturnType<typeof useJpycEip3009Payment>['restoredIntent']
    >;
    isRestoring?: boolean;
    hasActiveIntent?: boolean;
  },
) {
  relayMutate = vi.fn();
  relayRetryRelay = vi.fn();
  relayRetrySamePayload = vi.fn();
  const txHash = opts?.txHash ?? (`0x${'e'.repeat(64)}` as `0x${string}`);
  const data =
    state === 'success'
      ? { txHash, success: true }
      : state === 'broadcast-pending'
        ? { txHash, success: false, pending: true }
        : undefined;
  mockHook(useJpycEip3009Payment, {
    mutate: relayMutate,
    isPending: state === 'pending-flow',
    data,
    error:
      state === 'error'
        ? new Error(opts?.errMsg ?? 'rate_limited')
        : state === 'response-unknown'
          ? new RelayResponseUnknownError()
          : state === 'ip-rate-limited'
            ? new RelayIpRateLimitedError(opts?.retryAfterSeconds ?? 45)
            : null,
    retryRelay: relayRetryRelay,
    retrySamePayload: relayRetrySamePayload,
    recoveryState:
      opts?.recoveryState ??
      (state === 'response-unknown' ? 'exhausted' : null),
    variables: opts?.variables,
    restoredIntent: opts?.restoredIntent,
    isRestoring: opts?.isRestoring ?? false,
    hasActiveIntent: opts?.hasActiveIntent ?? false,
  } as Partial<ReturnType<typeof useJpycEip3009Payment>>);
}

// useStandardPayment は phase + 2-tx data shape を持つ。state は phase に直接 1:1
// 対応 (merchant-sending / merchant-mining / fee-sending / fee-mining / success /
// merchant-error / fee-error / idle)。"success-no-fee" は feeAmount=0 の極小額決済
// (feeTxHash=undefined になる) を表現する派生 state。
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
    | 'fee-error'
    | 'merchant-unknown'
    | 'fee-unknown',
  opts?: {
    lastSubmittedParams?: NonNullable<
      ReturnType<typeof useStandardPayment>['lastSubmittedParams']
    >;
    lastSubmittedFrom?: Address;
    hasAttempt?: boolean;
  },
) {
  standardMutate = vi.fn();
  standardRetryFee = vi.fn();
  standardRetryReceipt = vi.fn();
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
    retryReceipt: standardRetryReceipt,
    phase,
    isPending,
    isSuccess: state === 'success' || state === 'success-no-fee',
    isError: state === 'merchant-error' || state === 'fee-error',
    isFeeError: state === 'fee-error',
    isMerchantError: state === 'merchant-error',
    isUnknown: state === 'merchant-unknown' || state === 'fee-unknown',
    isMerchantUnknown: state === 'merchant-unknown',
    isFeeUnknown: state === 'fee-unknown',
    data:
      state === 'success'
        ? {
            merchantTxHash: `0x${'c'.repeat(64)}`,
            feeTxHash: `0x${'d'.repeat(64)}`,
            blockNumber: 77n,
          }
        : state === 'success-no-fee'
          ? {
              merchantTxHash: `0x${'c'.repeat(64)}`,
              feeTxHash: undefined,
              blockNumber: 77n,
            }
          : undefined,
    error:
      state === 'merchant-error'
        ? new Error('user rejected request')
        : state === 'fee-error'
          ? new Error('fee tx reverted')
          : state === 'merchant-unknown' || state === 'fee-unknown'
            ? new Error('receipt rpc failed')
          : null,
    merchantTxHash:
      state === 'fee-error' ||
      state === 'merchant-unknown' ||
      state === 'fee-unknown'
        ? `0x${'c'.repeat(64)}`
        : undefined,
    feeTxHash: state === 'fee-unknown' ? `0x${'d'.repeat(64)}` : undefined,
    merchantBlockNumber:
      state === 'fee-error' || state === 'fee-unknown' ? 77n : undefined,
    isRestoring: false,
    hasActiveIntent:
      state === 'merchant-unknown' ||
      state === 'fee-error' ||
      state === 'fee-unknown',
    hasAttempt: opts?.hasAttempt ?? state !== 'idle',
    lastSubmittedParams: opts?.lastSubmittedParams,
    lastSubmittedFrom: opts?.lastSubmittedFrom,
    restoredFromStorage: opts?.lastSubmittedParams !== undefined,
  } as Partial<ReturnType<typeof useStandardPayment>>);
}

function setSwitchChain() {
  mockHook(useSwitchChain, {
    switchChain: vi.fn(),
    isPending: false,
  });
}

// Circle quote: 'idle' (非 active・既定) / 'ready' (permitAmount + gasAmount を返す)。
// circle 経路 (usdc-permit 署名安心) テストで data を持たせる (TipForm.test と同型)。
function setCircleQuote(
  state: 'idle' | 'ready',
  opts: { gasAmount?: bigint; permitAmount?: bigint } = {},
) {
  mockHook(useGasQuoteCircle, {
    data:
      state === 'ready'
        ? {
            gasAmount: opts.gasAmount ?? 0n,
            permitAmount: opts.permitAmount ?? 1_000_000n,
          }
        : undefined,
    error: null,
    fetchStatus: 'idle',
  } as Partial<ReturnType<typeof useGasQuoteCircle>>);
}

// useGasQuoteUsdc は ERC20 paymaster mode のみ動く。テストの大半は testnet 環境で
// USDC が sponsorship にフォールバックされるので enabled=false → data=undefined に
// なる。下記の状態を既定にし、ERC20 mode テストだけ data を持たせる。
function setGasQuote(state: 'disabled' | 'pending' | 'ready' | 'error', amount?: bigint) {
  // gas 見積は paymaster mode に応じて 1 つだけ使われる。両方同じ state で mock。
  const mockState = {
    data: state === 'ready' ? { gasAmount: amount ?? 100_000n } : undefined,
    isLoading: state === 'pending',
    isError: state === 'error',
    error: state === 'error' ? new Error('quote failed') : null,
  };
  mockHook(useGasQuoteUsdc, mockState as Partial<ReturnType<typeof useGasQuoteUsdc>>);
  mockHook(useGasQuoteJpyc, mockState as Partial<ReturnType<typeof useGasQuoteJpyc>>);
}

beforeEach(() => {
  vi.clearAllMocks();
  setSwitchChain();
  setBalance(undefined);
  setSmartAccount(false);
  setPayment('idle');
  setStandardPayment('idle');
  setRelay('idle');
  setGasQuote('disabled');
  setCircleQuote('idle');
  setAccount({ connected: false });
  // 既定は testnet 環境の挙動 (USDC/JPYC とも sponsorship)。ERC20 mode を
  // 検証する describe ブロックでだけ override する。
  vi.mocked(resolvePaymasterMode).mockImplementation(() => 'sponsorship');
  // 既定は従来の Pimlico 経路 + free 構成 (forwarder 無し)。relay テストでのみ切替える。
  vi.mocked(resolveJpycGaslessProvider).mockReturnValue('pimlico-7702');
  vi.mocked(jpycForwarderFor).mockReturnValue(null);
  // 既定 USDC は Pimlico erc20。circle テストでのみ 'circle' へ override。
  vi.mocked(resolveUsdcGaslessProvider).mockReturnValue('pimlico');
  // 既定 relayer 健全 (non-degraded)。preflight banner テストでのみ degraded へ override。
  vi.mocked(useRelayHealth).mockReturnValue({ degraded: false });
});

describe('PaymentForm — URL parse', () => {
  it('to が無い + 他 param あり → 赤エラー (URL 半壊なので merchant に通知)', () => {
    setURL('token=usdc');
    render(<PaymentForm />);
    expect(screen.getByText(/決済 URL が不正/)).toBeInTheDocument();
    expect(screen.getByText(/to/)).toBeInTheDocument();
  });

  it('bare /pay (query 完全空) → 赤エラーではなく friendly landing', () => {
    setURL('');
    render(<PaymentForm />);
    // 赤エラーは出さない
    expect(screen.queryByText(/決済 URL が不正/)).not.toBeInTheDocument();
    // landing の見出しが出る
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: 'ここは「顧客向け」決済ページです',
      }),
    ).toBeInTheDocument();
    // home / history 導線
    expect(
      screen.getByRole('link', { name: 'OpenPay (店舗向け) を開く' }),
    ).toHaveAttribute('href', '/');
    expect(
      screen.getByRole('link', { name: 'このブラウザの履歴を見る' }),
    ).toHaveAttribute('href', '/history');
  });

  it('token が不正 → エラー表示', () => {
    setURL(`to=${MERCHANT}&token=eth`);
    render(<PaymentForm />);
    expect(screen.getByText(/決済 URL が不正/)).toBeInTheDocument();
  });

  it('旧 fee パラメタは silently ignore (古い QR 互換)', () => {
    setURL(`to=${MERCHANT}&token=usdc&fee=tax-free&amount=10`);
    render(<PaymentForm />);
    // エラー表示が出ず、明細が描画される
    expect(screen.queryByText(/決済 URL が不正/)).not.toBeInTheDocument();
    expect(screen.getByText(/明細/)).toBeInTheDocument();
  });
});

describe('PaymentForm — 金額の表示モード', () => {
  it('amount 指定 URL → 固定金額表示 (ヘッダ + 顧客支払額の 2 箇所)', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10`);
    render(<PaymentForm />);
    // ヘッダの大きな表示 + 明細「顧客支払額」で 2 件マッチ
    expect(screen.getAllByText('10 USDC').length).toBeGreaterThanOrEqual(2);
  });

  it('amount 無し URL → 入力フォーム表示', () => {
    setURL(`to=${MERCHANT}&token=usdc`);
    render(<PaymentForm />);
    expect(screen.getByPlaceholderText('10.00')).toBeInTheDocument();
  });

  it('JPYC URL → JPYC 用プレースホルダ', () => {
    setURL(`to=${MERCHANT}&token=jpyc`);
    render(<PaymentForm />);
    expect(screen.getByPlaceholderText('1000')).toBeInTheDocument();
  });
});

describe('PaymentForm — 手数料明細 (default = gas=customer)', () => {
  it('USDC 100, gas=0 → merchant=100 / fee=0 / customer=100 (手数料 0%)', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=100`);
    setGasQuote('ready', 0n);
    render(<PaymentForm />);
    // 手数料 0% (FEE_BPS_GASLESS=0n): merchant 満額・customer=amount。
    // header + merchant受取 + customer支払で「100 USDC」が 3 箇所、旧 fee=1/控除 99 は出ない。
    expect(screen.getAllByText('100 USDC').length).toBe(3);
    expect(screen.queryByText('99 USDC')).not.toBeInTheDocument();
    expect(screen.queryByText('1 USDC')).not.toBeInTheDocument();
  });

  it('USDC 5, gas=0: 手数料 0% → merchant=5, customer=5', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=5`);
    setGasQuote('ready', 0n);
    render(<PaymentForm />);
    // fee=0: merchant 満額 5。旧 0.05/4.95 は出ない。
    expect(screen.queryByText('0.05 USDC')).not.toBeInTheDocument();
    expect(screen.queryByText('4.95 USDC')).not.toBeInTheDocument();
    expect(screen.getAllByText('5 USDC').length).toBeGreaterThanOrEqual(2);
  });
});

describe('PaymentForm — 接続状態によるボタン', () => {
  it('未接続 → 接続を促すラベル / 送信ボタン disabled', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10`);
    setAccount({ connected: false });
    render(<PaymentForm />);
    const btn = screen.getByRole('button', {
      name: /ウォレットを接続/,
    });
    // 押せない行動喚起を塞いだ (#266 同型): タップでウォレット選択へスクロール誘導。
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    expect(scrollSpy).toHaveBeenCalled();
    // 初回向け 3 ステップガイド + 「アプリ/登録不要」を表示
    expect(screen.getByText('署名で完了')).toBeInTheDocument();
    expect(screen.getByText(/アプリのDL・登録は不要/)).toBeInTheDocument();
  });

  it('接続済 + 違うチェーン → ネットワーク切替ボタン表示 / 送信ボタンに切替メッセージ', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10`);
    setAccount({ connected: true, chainId: polygonAmoy.id }); // USDC は Base なので不一致
    setBalance(0n);
    render(<PaymentForm />);
    expect(
      screen.getByRole('button', { name: /へ切り替え/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: /ネットワークを切替え/,
      }),
    ).toBeDisabled();
  });

  it('接続済 + 違うチェーン → 初回 mount で switchChain を 1 回自動呼出 (再 render しても再呼出しない)', () => {
    // JPYC URL (Polygon 必須) を Base 接続中に開く想定
    setURL(`to=${MERCHANT}&token=jpyc&amount=10`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(0n);
    const switchChain = vi.fn();
    mockHook(useSwitchChain, { switchChain, isPending: false });

    const { rerender } = render(<PaymentForm />);
    expect(switchChain).toHaveBeenCalledTimes(1);
    expect(switchChain).toHaveBeenCalledWith({ chainId: polygonAmoy.id });

    // 再 render しても同じ requiredChain.id では再呼出しない (popup ループ防止)
    rerender(<PaymentForm />);
    expect(switchChain).toHaveBeenCalledTimes(1);
  });

  it('接続済 + 正しいチェーン → switchChain は呼ばれない (auto-switch 不要)', () => {
    setURL(`to=${MERCHANT}&token=jpyc&amount=10`);
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(0n);
    const switchChain = vi.fn();
    mockHook(useSwitchChain, { switchChain, isPending: false });

    render(<PaymentForm />);
    expect(switchChain).not.toHaveBeenCalled();
  });

  it('接続済 + 正しいチェーン + Smart Account ready + 残高あり → 支払いボタンが活性', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n); // 20 USDC, 必要分 (10.1 USDC) 以上
    setSmartAccount(true);
    setGasQuote('ready', 0n); // sponsorship では quote 0 でも ready
    render(<PaymentForm />);
    const btn = screen.getByRole('button', {
      name: /10 USDC を支払う/,
    });
    expect(btn).not.toBeDisabled();
  });

  it('残高不足 → 警告表示 + 送信ボタン disabled', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(1_000_000n); // 1 USDC、必要 10.1 USDC
    setSmartAccount(true);
    setGasQuote('ready', 0n);
    render(<PaymentForm />);
    expect(screen.getByText(/残高が不足/)).toBeInTheDocument();
    // 不足額 (あと◯◯必要) を明示
    expect(screen.getByText(/あと.*必要/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /10 USDC を支払う/ }),
    ).toBeDisabled();
  });

  it('残高不足 (USDC) → onramp link が SBI VC トレード で正しい security 属性', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(1_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 0n);
    render(<PaymentForm />);
    const onramp = screen.getByRole('link', {
      name: /SBI VC トレード で USDC を購入/,
    });
    expect(onramp).toHaveAttribute('href', 'https://www.sbivc.co.jp/');
    expect(onramp).toHaveAttribute('target', '_blank');
    expect(onramp).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('残高不足 (JPYC) → onramp link が JPYC EX になる (token prop の wiring 確認)', () => {
    setURL(`to=${MERCHANT}&token=jpyc&amount=100`);
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(0n); // 0 JPYC、必要 100 JPYC
    setSmartAccount(true);
    setGasQuote('ready', 0n);
    render(<PaymentForm />);
    expect(screen.getByText(/残高が不足/)).toBeInTheDocument();
    const onramp = screen.getByRole('link', {
      name: /JPYC EX で JPYC を購入/,
    });
    expect(onramp).toHaveAttribute('href', 'https://jpyc.co.jp/');
  });

  it('残高十分 → onramp link は出ない (insufficientBalance branch のみで出る)', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n); // 20 USDC > 10.1 USDC
    setSmartAccount(true);
    setGasQuote('ready', 0n);
    render(<PaymentForm />);
    expect(screen.queryByRole('link', { name: /で USDC を購入/ })).toBeNull();
  });

  it('決済の準備中 → 「初期化中…」ラベル', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(false);
    render(<PaymentForm />);
    expect(
      screen.getByRole('button', { name: /決済の準備中/ }),
    ).toBeDisabled();
  });
});

describe('PaymentForm — 送信フロー', () => {
  it('クリックで mutate に正しい引数が渡る (USDC 100, sponsorship gas=0)', async () => {
    const user = userEvent.setup();
    setURL(`to=${MERCHANT}&token=usdc&amount=100`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setPayment('idle');
    setGasQuote('ready', 0n);
    render(<PaymentForm />);

    await user.click(screen.getByRole('button', { name: /100 USDC を支払う/ }));

    expect(mutate).toHaveBeenCalledOnce();
    const call = mutate.mock.calls[0][0];
    expect(call.merchant.toLowerCase()).toBe(MERCHANT.toLowerCase());
    // 手数料 0% (gas=customer): merchant = 100 満額、fee = 0
    expect(call.merchantAmount).toBe(100_000_000n);
    expect(call.feeAmount).toBe(0n);
    expect(call.feeReceiver.toLowerCase()).toBe(
      '0xdead000000000000000000000000000000001234',
    );
    expect(call.tokenAddress.toLowerCase()).toBe(
      '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
    );
  });

  it('据え置き QR (amount 無し) で顧客が金額入力 → mutate に反映', async () => {
    const user = userEvent.setup();
    setURL(`to=${MERCHANT}&token=usdc`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setPayment('idle');
    setGasQuote('ready', 0n);
    render(<PaymentForm />);

    await user.type(screen.getByPlaceholderText('10.00'), '50');
    await user.click(screen.getByRole('button', { name: /50 USDC を支払う/ }));

    const call = mutate.mock.calls[0][0];
    // fee=0: merchant = 50 満額
    expect(call.merchantAmount).toBe(50_000_000n);
    expect(call.feeAmount).toBe(0n);
  });

  it('可変額は送信時点で表示・履歴明細を固定し、成功後も live 入力へ追随しない', async () => {
    window.localStorage.clear();
    const user = userEvent.setup();
    setURL(`to=${MERCHANT}&token=usdc&pname=Coffee`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setPayment('idle');
    setGasQuote('ready', 0n);
    const { rerender } = render(<PaymentForm />);

    const input = screen.getByPlaceholderText('10.00');
    await user.type(input, '10');
    await user.click(screen.getByRole('button', { name: /10 USDC を支払う/ }));
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ saleAmount: 10_000_000n }),
    );

    // hook mock は idle のままなので、旧実装で起きた live drift を意図的に再現する。
    // 新実装は click 時の attempt snapshot を成功表示・明細の単一情報源にする。
    await user.clear(input);
    await user.type(input, '20');
    setPayment('success');
    rerender(<PaymentForm />);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('10 USDC')).toBeInTheDocument();
    expect(within(dialog).queryByText('20 USDC')).toBeNull();
    await waitFor(() => expect(loadPayerReceipts()).toHaveLength(1));
    const [receipt] = loadPayerReceipts();
    expect(receipt.amount).toBe('10');
    expect(receipt.lineItems?.[0]).toEqual(
      expect.objectContaining({
        name: 'Coffee',
        unitPrice: '10',
        amount: '10',
      }),
    );
    const [history] = loadHistory();
    expect(history.saleAmount).toBe('10000000');
    expect(history.lineItems?.[0]).toEqual(
      expect.objectContaining({
        name: 'Coffee',
        unitPrice: '10',
        amount: '10',
      }),
    );
  });

  it('可変額入力は決済 pending と settled-no-retry の間ロックする', () => {
    setURL(`to=${MERCHANT}&token=usdc`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 0n);
    setPayment('pending');
    const { rerender } = render(<PaymentForm />);

    expect(screen.getByPlaceholderText('10.00')).toBeDisabled();
    setPayment('success');
    rerender(<PaymentForm />);
    expect(screen.getByPlaceholderText('10.00')).toBeDisabled();
  });

  it('送信中 → ボタンが「送信中…」かつ disabled', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setPayment('pending');
    render(<PaymentForm />);
    expect(screen.getByRole('button', { name: /送信中/ })).toBeDisabled();
  });

  it('Pimlico receipt unknown → main Pay を封鎖し同じ userOpHash だけ再照会する', async () => {
    const user = userEvent.setup();
    setURL(`to=${MERCHANT}&token=usdc&amount=10`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setPayment('unknown');
    setGasQuote('ready', 0n);
    render(<PaymentForm />);

    expect(await screen.findByText('送信結果を確認中')).toBeInTheDocument();
    expect(screen.getByText(`0x${'c'.repeat(64)}`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /送信中/ })).toBeDisabled();

    await user.click(
      screen.getByRole('button', { name: '同じ送信内容を再確認' }),
    );
    expect(gaslessRetryReceipt).toHaveBeenCalledOnce();
    expect(mutate).not.toHaveBeenCalled();
  });

  // A3 rescope (2026-09-03): pending record store が読めない fail-closed 状態は
  // 「支払い確認中」と混ぜず専用文言にし、封鎖するのは gasless 経路だけにする。
  it('pending 記録を保存できない端末: gasless は封鎖し専用文言を出す', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setPayment('store-unavailable');
    setGasQuote('ready', 0n);
    render(<PaymentForm />);

    expect(
      screen.getByText('この端末では記録を保存できません'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'この端末では支払い記録を保存できないため、ガスレス送信を止めています。通常送信をご利用ください。',
      ),
    ).toBeInTheDocument();
    // 「支払い確認中」(broadcast 済かもしれない状態) とは別表示にする。
    expect(screen.queryByText('送信結果を確認中')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /10 USDC を支払う/ }),
    ).toBeDisabled();
  });

  it('pending 記録を保存できなくても standard (通常送信) は使える', async () => {
    const user = userEvent.setup();
    setURL(`to=${MERCHANT}&token=usdc&amount=10&mode=standard`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setPayment('store-unavailable');
    render(<PaymentForm />);

    const payButton = screen.getByRole('button', { name: /10 USDC を支払う/ });
    expect(payButton).not.toBeDisabled();
    // gasless 専用の案内は standard では出さない。
    expect(
      screen.queryByText('この端末では記録を保存できません'),
    ).not.toBeInTheDocument();
    await user.click(payButton);
    expect(standardMutate).toHaveBeenCalledOnce();
  });

  it('送信成功 → tx hash と block 番号が表示される', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setPayment('success');
    render(<PaymentForm />);
    // 成功時は SuccessOverlay (大型 PayPay 風) + 既存 inline ResultPanel が
    // 両方 DOM に存在するため、特定の値が複数箇所に現れる。
    expect(screen.getAllByText(/決済が完了しました|決済完了/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(`0x${'a'.repeat(64)}`).length).toBeGreaterThan(0);
    expect(screen.getAllByText(`0x${'b'.repeat(64)}`).length).toBeGreaterThan(0);
    expect(screen.getAllByText('42').length).toBeGreaterThan(0);
  });

  it('gasless 送信成功後: Pay ボタンが disabled・再クリックで mutate が再呼出されない (二重支払い防止)', async () => {
    const user = userEvent.setup();
    setURL(`to=${MERCHANT}&token=usdc&amount=10`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setPayment('success'); // data.success === true
    setGasQuote('ready', 0n);
    render(<PaymentForm />);

    // 成功後も main Pay ボタンは DOM に残るが settledNoRetry で disabled。
    const payBtn = screen.getByRole('button', { name: /10 USDC を支払う/ });
    expect(payBtn).toBeDisabled();
    // 再クリックしても useBatchPayment.mutate は発火しない (2 件目の on-chain 送金を阻止)。
    await user.click(payBtn);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('送信成功 → 顧客向け電子レシート控えを保存し完了画面に埋め込む (/pay)', async () => {
    window.localStorage.clear();
    setURL(`to=${MERCHANT}&token=usdc&amount=10`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setPayment('success');
    render(<PaymentForm />);
    // (a) 控えが LocalStorage に保存される (実 usePaymentHistory → appendPayerReceipt 経路)。
    const receipts = loadPayerReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0].sourceRoute).toBe('/pay');
    expect(receipts[0].direction).toBe('paid');
    expect(receipts[0].receiptId).toBe(`0x${'b'.repeat(64)}`); // = txHash
    // (b) 完了画面に控え詳細 (PayerReceiptDetail) が描画される。
    //     ctx → usePaymentHistory → appendPayerReceipt → CHANGED_EVENT →
    //     usePayerReceipts → PayerReceiptCompletion → PayerReceiptDetail の全鎖を実証。
    //     PayerReceiptCompletion は next/dynamic で遅延ロードのため findByText で待つ。
    expect(
      await screen.findByText('OpenPay 電子レシート'),
    ).toBeInTheDocument();
    // 完了画面の /scan 導線 (PayerReceiptCompletion 固有文言)。
    const scanLink = screen.getByText(/\/scan で支払い履歴/);
    expect(scanLink.closest('a')).toHaveAttribute('href', '/scan');
  });

  it('GasCongestedError → 生メッセージではなく i18n 案内 (sponsorship)', async () => {
    const { GasCongestedError } = await import('@/lib/gasCeiling');
    setURL(`to=${MERCHANT}&token=jpyc&amount=1000`);
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(2000n * 10n ** 18n);
    setSmartAccount(true);
    setPayment('error', new GasCongestedError(polygonAmoy.id, 1000n, 1500n));
    render(<PaymentForm />);

    expect(
      screen.getByText(/ネットワークが混雑しています/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/gas_congested/)).toBeNull();
  });

  it('送信失敗 → エラーメッセージ表示', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setPayment('error');
    render(<PaymentForm />);
    expect(screen.getByText(/エラー/)).toBeInTheDocument();
    expect(screen.getByText(/prefund/)).toBeInTheDocument();
  });
});

describe('PaymentForm — split (C1)', () => {
  const B = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const C = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  it('split あり → 受取人ごとの行 + バッチ説明文', () => {
    setURL(
      `to=${MERCHANT}&token=usdc&amount=100&split=${B}:30,${C}:20`,
    );
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    render(<PaymentForm />);

    expect(screen.getByText(/主受取人 \(50%\)/)).toBeInTheDocument();
    expect(
      screen.getAllByText(/受取人 \(\d+%\)/).length,
    ).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/3 件の transfer/)).toBeInTheDocument();
  });

  it('split あり → mutate の extraRecipients が正しい (USDC 100, sponsorship gas=0)', async () => {
    const user = userEvent.setup();
    setURL(
      `to=${MERCHANT}&token=usdc&amount=100&split=${B}:30,${C}:20`,
    );
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setPayment('idle');
    setGasQuote('ready', 0n);
    render(<PaymentForm />);

    await user.click(
      screen.getByRole('button', { name: /100 USDC を支払う/ }),
    );

    expect(mutate).toHaveBeenCalledOnce();
    const call = mutate.mock.calls[0][0];
    // distributable = amount - fee = 100 USDC (fee=0), primary (MERCHANT) 50% = 50
    expect(call.merchant.toLowerCase()).toBe(MERCHANT.toLowerCase());
    expect(call.merchantAmount).toBe(50_000_000n);
    expect(call.feeAmount).toBe(0n);
    expect(call.extraRecipients).toHaveLength(2);
    expect(call.extraRecipients[0].to.toLowerCase()).toBe(B.toLowerCase());
    // B = 100 * 30% = 30
    expect(call.extraRecipients[0].amount).toBe(30_000_000n);
    expect(call.extraRecipients[1].to.toLowerCase()).toBe(C.toLowerCase());
    // C = 100 * 20% = 20
    expect(call.extraRecipients[1].amount).toBe(20_000_000n);
  });
});

describe('PaymentForm — 通常決済（ガス代は自分で負担） / mode=standard', () => {
  it('バッジ「通常決済（ガス代は自分で負担）」が表示される', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10&mode=standard`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    render(<PaymentForm />);
    // 「通常決済（ガス代は自分で負担）」はタイトルバッジ + breakdown hint に出るので複数
    expect(
      screen.getAllByText(/通常決済（ガス代は自分で負担）/).length,
    ).toBeGreaterThanOrEqual(1);
    // ETH (USDC のネイティブガス) の案内が出る
    expect(
      screen.getAllByText((text) => /POL|ETH/.test(text)).length,
    ).toBeGreaterThan(0);
  });

  it('legacy alias: mode=direct は standard に正規化されて同じ UI を表示', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10&mode=direct`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    render(<PaymentForm />);
    expect(
      screen.getAllByText(/通常決済（ガス代は自分で負担）/).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('明細: 手数料 0%、ネットワーク手数料はウォレットで支払い、顧客支払額は amount のまま', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10&mode=standard`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    render(<PaymentForm />);
    // fee=0: 旧 0.05 fee / 9.95 控除は出ない。merchant は amount 満額。
    expect(screen.queryByText('0.05 USDC')).not.toBeInTheDocument();
    expect(screen.queryByText('9.95 USDC')).not.toBeInTheDocument();
    // ネットワーク手数料はウォレットで支払い (standard 固有・手数料とは独立)
    expect(screen.getByText(/ウォレットで支払い/)).toBeInTheDocument();
    // 顧客支払額・merchant 受取とも 10 USDC (header 含め複数箇所)
    expect(screen.getAllByText('10 USDC').length).toBeGreaterThanOrEqual(2);
  });

  it('Smart Account 待ち状態でもボタンは活性 (standard は SA 不要)', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10&mode=standard`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(false);
    render(<PaymentForm />);
    expect(
      screen.getByRole('button', { name: /10 USDC を支払う/ }),
    ).not.toBeDisabled();
  });

  it('クリックで standardMutate が merchant + fee + chainId で呼ばれる (fee=0)', async () => {
    const user = userEvent.setup();
    setURL(`to=${MERCHANT}&token=usdc&amount=10&mode=standard`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    render(<PaymentForm />);
    await user.click(screen.getByRole('button', { name: /10 USDC を支払う/ }));

    expect(standardMutate).toHaveBeenCalledOnce();
    const arg = standardMutate.mock.calls[0][0];
    // fee=0: merchant = amount = 10
    expect(arg.merchantAmount).toBe(10_000_000n);
    expect(arg.feeAmount).toBe(0n);
    expect(arg.saleAmount).toBe(10_000_000n);
    expect(arg.merchant.toLowerCase()).toBe(MERCHANT.toLowerCase());
    expect(arg.tokenAddress.toLowerCase()).toBe(
      '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
    );
    expect(arg.chainId).toBe(baseSepolia.id);
    expect(arg.feeReceiver.toLowerCase()).toBe(
      '0xdead000000000000000000000000000000001234',
    );
    expect(arg.contextKey).toBeUndefined();
  });

  it('可変額 standard でも URL 文脈を intent metadata に追加しない', async () => {
    const user = userEvent.setup();
    setURL(`to=${MERCHANT}&token=usdc&mode=standard`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    render(<PaymentForm />);

    await user.type(screen.getByPlaceholderText('10.00'), '7');
    await user.click(screen.getByRole('button', { name: /7 USDC を支払う/ }));

    expect(standardMutate.mock.calls[0][0].contextKey).toBeUndefined();
  });

  it('成功時: merchant Tx + fee Tx + ブロック が表示される (UserOp Hash は無い)', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10&mode=standard`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setStandardPayment('success');
    render(<PaymentForm />);
    expect(screen.getAllByText(/決済が完了しました|決済完了/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(`0x${'c'.repeat(64)}`).length).toBeGreaterThan(0);
    expect(screen.getAllByText(`0x${'d'.repeat(64)}`).length).toBeGreaterThan(0);
    expect(screen.getAllByText('77').length).toBeGreaterThan(0);
    expect(screen.queryByText('UserOp Hash')).toBeNull();
  });

  it('saError は standard モードでは UI に出ない', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10&mode=standard`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    mockHook(useSmartAccount, {
      data: undefined,
      isLoading: false,
      error: new Error('SA init noise'),
    } as Partial<ReturnType<typeof useSmartAccount>>);
    render(<PaymentForm />);
    expect(screen.queryByText(/SA init noise/)).toBeNull();
  });

  it('merchant-error → エラーメッセージ表示 (fee-error retry UI は出ない)', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10&mode=standard`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setStandardPayment('merchant-error');
    render(<PaymentForm />);
    expect(screen.getByText(/エラー/)).toBeInTheDocument();
    expect(screen.getByText(/user rejected/)).toBeInTheDocument();
    // 「手数料の送信を再試行」 button (= fee-error 状態専用 UI) は出ない。
    // standardBatchHint 本文には同じフレーズが含まれるため role=button で限定する。
    expect(
      screen.queryByRole('button', { name: /手数料の送信を再試行/ }),
    ).toBeNull();
  });

  it('fee-error → 「OpenPay 利用手数料の送信に失敗」+ retry ボタン (merchant は確定済)', async () => {
    const user = userEvent.setup();
    setURL(`to=${MERCHANT}&token=usdc&amount=10&mode=standard`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setStandardPayment('fee-error');
    render(<PaymentForm />);
    expect(
      screen.getByText(/OpenPay 利用手数料の送信に失敗/),
    ).toBeInTheDocument();
    const retryBtn = screen.getByRole('button', { name: /手数料の送信を再試行/ });
    expect(retryBtn).not.toBeDisabled();
    await user.click(retryBtn);
    expect(standardRetryFee).toHaveBeenCalledOnce();
  });

  it('standard 送信成功後: main Pay ボタンが disabled・再クリックで mutate が再呼出されない (二重支払い防止)', async () => {
    const user = userEvent.setup();
    setURL(`to=${MERCHANT}&token=usdc&amount=10&mode=standard`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setStandardPayment('success'); // standard.data 定義済 (phase=success)
    render(<PaymentForm />);

    // 成功後も main Pay ボタンは DOM に残るが settledNoRetry で disabled。
    const payBtn = screen.getByRole('button', { name: /10 USDC を支払う/ });
    expect(payBtn).toBeDisabled();
    // 再クリックしても merchant transfer (standard.mutate) は再発火しない。
    await user.click(payBtn);
    expect(standardMutate).not.toHaveBeenCalled();
  });

  it('fee-error (merchant 確定済 / fee 失敗): main Pay ボタンは disabled・retryFee ボタンは有効', async () => {
    const user = userEvent.setup();
    setURL(`to=${MERCHANT}&token=usdc&amount=10&mode=standard`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setStandardPayment('fee-error'); // merchant transfer 確定済・fee transfer だけ失敗
    render(<PaymentForm />);

    // main Pay ボタンは disabled = merchant transfer の再送 (重複) を阻止。
    const payBtn = screen.getByRole('button', { name: /10 USDC を支払う/ });
    expect(payBtn).toBeDisabled();
    await user.click(payBtn);
    expect(standardMutate).not.toHaveBeenCalled();

    // fee の再送は専用 retryFee ボタンのみで実行可 (merchant は再送しない)。
    const retryBtn = screen.getByRole('button', { name: /手数料の送信を再試行/ });
    expect(retryBtn).not.toBeDisabled();
    await user.click(retryBtn);
    expect(standardRetryFee).toHaveBeenCalledOnce();
  });

  it.each(['merchant-unknown', 'fee-unknown'] as const)(
    '%s: 送信結果の中間表示 + settledNoRetry で main Pay を封鎖し、receipt 再照会のみ許可',
    async (phase) => {
      const user = userEvent.setup();
      setURL(`to=${MERCHANT}&token=usdc&amount=10&mode=standard`);
      setAccount({ connected: true, chainId: baseSepolia.id });
      setBalance(20_000_000n);
      setStandardPayment(phase);
      render(<PaymentForm />);

      expect(screen.getByText('送信結果を確認中')).toBeInTheDocument();
      expect(screen.getByText(/receipt を取得できず/)).toBeInTheDocument();
      expect(screen.queryByText('receipt rpc failed')).toBeNull();
      const payBtn = screen.getByRole('button', { name: /10 USDC を支払う/ });
      expect(payBtn).toBeDisabled();
      await user.click(payBtn);
      expect(standardMutate).not.toHaveBeenCalled();

      // fee-unknown を含め、手数料の新規再送 UI は出さない。
      expect(
        screen.queryByRole('button', { name: /手数料の送信を再試行/ }),
      ).toBeNull();
      await user.click(screen.getByRole('button', { name: /receipt を再照会/ }));
      expect(standardRetryReceipt).toHaveBeenCalledOnce();
      expect(standardRetryFee).not.toHaveBeenCalled();
    },
  );

  it('reload で復元した standard intent は元 QR が gasless でも standard receipt 照会へ固定する', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setStandardPayment('merchant-unknown');

    render(<PaymentForm />);

    expect(screen.getByText('送信結果を確認中')).toBeInTheDocument();
    expect(useSmartAccount).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'usdc' }),
      false,
    );
    expect(
      screen.getByRole('button', { name: /10 USDC を支払う/ }),
    ).toBeDisabled();
  });

  it('reload 復元した standard 成功を同店同額の別商品履歴・控えへ帰属させない', async () => {
    window.localStorage.clear();
    const restoredCustomer =
      '0x8888888888888888888888888888888888888888' as Address;
    setURL(`to=${MERCHANT}&token=usdc&amount=10&pname=別商品`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setStandardPayment('success-no-fee', {
      lastSubmittedParams: {
        tokenAddress: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
        merchant: MERCHANT,
        merchantAmount: 10_000_000n,
        feeReceiver: '0xdead000000000000000000000000000000001234',
        feeAmount: 0n,
        chainId: baseSepolia.id,
        saleAmount: 10_000_000n,
      },
      lastSubmittedFrom: restoredCustomer,
    });

    render(<PaymentForm />);

    const txHash = `0x${'c'.repeat(64)}`;
    expect(screen.getAllByText(txHash).length).toBeGreaterThan(0);
    await waitFor(() => expect(loadHistory()).toHaveLength(0));
    expect(loadPayerReceipts()).toHaveLength(0);
  });

  it.each([
    ['merchant-sending' as const, /店舗送金を承認してください/],
    ['merchant-mining' as const, /店舗送金を確定中/],
    ['fee-sending' as const, /手数料の送金を承認してください/],
    ['fee-mining' as const, /手数料の送金を確定中/],
  ])('phaseLabel: phase=%s でボタン label が %s に切替', (phase, expected) => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10&mode=standard`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setStandardPayment(phase);
    render(<PaymentForm />);
    expect(screen.getByRole('button', { name: expected })).toBeDisabled();
  });

  it('success-no-fee (fee=0 極小額): ResultPanel に merchant Tx + block のみ表示、fee Tx 行は出ない', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10&mode=standard`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setStandardPayment('success-no-fee');
    render(<PaymentForm />);
    // merchant tx hash は表示される
    expect(screen.getAllByText(`0x${'c'.repeat(64)}`).length).toBeGreaterThan(0);
    // fee tx hash は data に undefined のため一切現れない
    expect(screen.queryByText(`0x${'d'.repeat(64)}`)).toBeNull();
    // 「手数料 Tx Hash」label も出ない
    expect(screen.queryByText('手数料 Tx Hash')).toBeNull();
    // SuccessOverlay も出る (block 77 で確認)
    expect(screen.getAllByText('77').length).toBeGreaterThan(0);
  });

  it('SuccessOverlay (standard): submit snapshot と merchant tx hash の truncate が overlay に出る', async () => {
    const user = userEvent.setup();
    setURL(`to=${MERCHANT}&token=usdc&amount=10&mode=standard`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setStandardPayment('idle');
    const { rerender } = render(<PaymentForm />);
    await user.click(screen.getByRole('button', { name: /10 USDC を支払う/ }));
    expect(standardMutate).toHaveBeenCalledOnce();
    setStandardPayment('success');
    rerender(<PaymentForm />);
    // SuccessOverlay は「決済完了」を表示
    expect((await screen.findAllByText(/決済完了/)).length).toBeGreaterThan(0);
    // merchant tx hash の full は inline panel に 1 度出る
    expect(screen.getAllByText(`0x${'c'.repeat(64)}`).length).toBeGreaterThanOrEqual(1);
    // overlay の truncate 表示 (先頭 10 + … + 末尾 6) も検出
    const c = 'c'.repeat(54);
    expect(
      screen.getByText(new RegExp(`0xcccccccc…${c.slice(0, 6)}`)),
    ).toBeInTheDocument();
  });
});

describe('PaymentForm — ERC20 Paymaster mode (USDC mainnet)', () => {
  beforeEach(() => {
    // mainnet 相当: USDC は erc20 mode、JPYC は sponsorship
    vi.mocked(resolvePaymasterMode).mockImplementation((dep) =>
      dep.symbol === 'usdc' ? 'erc20' : 'sponsorship',
    );
  });

  it('gas 見積取得前: ボタンが「ガス代見積取得中…」で disabled', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=100`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('pending');
    render(<PaymentForm />);
    expect(
      screen.getByRole('button', { name: /ガス代見積取得中/ }),
    ).toBeDisabled();
  });

  it('gas 見積あり: 明細に「ネットワーク手数料 (見積)」行が出て、上限値が customer に加算される', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=100`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 500_000n); // 0.5 USDC
    render(<PaymentForm />);

    expect(
      Array.from(document.querySelectorAll('dl dt')).some((el) =>
        /ネットワーク手数料/.test(el.textContent ?? ''),
      ),
    ).toBe(true);
    expect(screen.getByText(/最大 0\.5 USDC/)).toBeInTheDocument();
    // customer = amount + gas = 100 + 0.5 = 100.5 (運営手数料は merchant 控除で隠れる)
    expect(screen.getByText('100.5 USDC')).toBeInTheDocument();
  });

  it('gas を含めた残高チェック: gas 込みで足りなければ「残高不足」', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=100`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    // 残高 100 USDC、必要 100.5 USDC (= 100 + gas 0.5) → 不足
    setBalance(100_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 500_000n);
    render(<PaymentForm />);
    expect(screen.getByText(/残高が不足/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /100\.5 USDC を支払う/ }),
    ).toBeDisabled();
  });

  it('JPYC sponsorship mode でも gas 行が表示される', () => {
    setURL(`to=${MERCHANT}&token=jpyc&amount=1000`);
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(2000n * 10n ** 18n);
    setSmartAccount(true);
    setGasQuote('ready', 5n * 10n ** 17n); // 0.5 JPYC gas quote
    render(<PaymentForm />);
    expect(
      Array.from(document.querySelectorAll('dl dt')).some((el) =>
        /ネットワーク手数料/.test(el.textContent ?? ''),
      ),
    ).toBe(true);
  });

  it('gaslessBatchHintUsdc が表示される (USDC paymaster の説明文)', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=100`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready');
    render(<PaymentForm />);
    expect(
      screen.getByText(/最大表示。実費はこれ以下に収まります \(USDC でお支払い\)/),
    ).toBeInTheDocument();
  });

  it('USDC ERC20 mode の mutate には gas を含めない (paymaster が顧客から直接徴収するため二重徴収を避ける)', async () => {
    const user = userEvent.setup();
    setURL(`to=${MERCHANT}&token=usdc&amount=100`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 500_000n);
    setPayment('idle');
    render(<PaymentForm />);

    await user.click(
      screen.getByRole('button', { name: /100\.5 USDC を支払う/ }),
    );

    expect(mutate).toHaveBeenCalledOnce();
    const call = mutate.mock.calls[0][0];
    // fee=0: merchant = amount = 100 (ERC20 paymaster は gas を顧客から直接徴収・二重徴収なし)
    expect(call.merchantAmount).toBe(100_000_000n);
    expect(call.feeAmount).toBe(0n); // ERC20 paymaster: gas は paymaster 経由
    expect(call.extraRecipients).toBeUndefined();
  });

  it('gasQuote.error → エラーメッセージ表示 + ボタン disabled', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=100`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('error');
    render(<PaymentForm />);

    expect(screen.getByText(/エラー/)).toBeInTheDocument();
    // 生 RPC メッセージではなく i18n 化された friendly エラーが出る
    expect(screen.queryByText(/quote failed/)).toBeNull();
    expect(
      screen.getByText(/ガス代見積の取得に失敗しました/),
    ).toBeInTheDocument();
    // gas quote が ready していないので button は loading 表示で disabled
    expect(
      screen.getByRole('button', { name: /ガス代見積取得中/ }),
    ).toBeDisabled();
  });

  it('境界: 残高 = 必要額 ちょうど → 支払い可能 (insufficient ではない)', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=100`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    // customer = 100 + 0.5 = 100.5 USDC ぴったり
    setBalance(100_500_000n);
    setSmartAccount(true);
    setGasQuote('ready', 500_000n);
    render(<PaymentForm />);
    expect(screen.queryByText(/残高が不足/)).toBeNull();
    expect(
      screen.getByRole('button', { name: /100\.5 USDC を支払う/ }),
    ).not.toBeDisabled();
  });

  it('境界: 残高 = 必要額 - 1 wei → insufficient', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=100`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(100_500_000n - 1n);
    setSmartAccount(true);
    setGasQuote('ready', 500_000n);
    render(<PaymentForm />);
    expect(screen.getByText(/残高が不足/)).toBeInTheDocument();
  });

  it('standard mode + USDC params: ガス代見積は呼ばれない (paymaster 不使用)、ネットワーク手数料行は「ウォレットで支払い」表示', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10&mode=standard`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    // standard mode では erc20 mode mock 下でも gas を考慮しない
    setGasQuote('disabled');
    render(<PaymentForm />);

    // ネットワーク手数料行は「ウォレットで支払い」表示で出る (見積額は出さない)
    expect(screen.getByText(/ウォレットで支払い/)).toBeInTheDocument();
    // standard モードバッジは出る (タイトル + hint で複数箇所)
    expect(
      screen.getAllByText(/通常決済（ガス代は自分で負担）/).length,
    ).toBeGreaterThanOrEqual(1);
    // useGasQuoteUsdc は enabled=false で呼ばれる (no fetch)。第 1 引数は USDC deployment。
    expect(useGasQuoteUsdc).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'usdc' }),
      false,
    );
  });

  it('ERC20 mode で GasCongestedError → 生メッセージではなく i18n 案内が表示される', async () => {
    const { GasCongestedError } = await import('@/lib/gasCeiling');
    setURL(`to=${MERCHANT}&token=usdc&amount=10`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);
    setPayment('error', new GasCongestedError(baseSepolia.id, 1n, 5n));
    render(<PaymentForm />);

    expect(
      screen.getByText(/ネットワークが混雑しています/),
    ).toBeInTheDocument();
    // 生 message ("gas_congested: chainId=84532...") は出さない
    expect(screen.queryByText(/gas_congested/)).toBeNull();
  });

  it('USDC ERC20 mode + 接続済 → 「ガス代承認の状況を確認」リンクが BaseScan の approvals 画面を指す', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setGasQuote('ready');
    render(<PaymentForm />);

    const link = screen.getByRole('link', { name: /ガス代承認の状況を確認/ });
    expect(link).toHaveAttribute(
      'href',
      `https://sepolia.basescan.org/tokenapprovalchecker?search=${CUSTOMER}`,
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer noopener');
  });

  it('JPYC sponsorship mode では approval リンクは表示されない (paymaster approve が無いため)', () => {
    setURL(`to=${MERCHANT}&token=jpyc&amount=1000`);
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(2000n * 10n ** 18n);
    setSmartAccount(true);
    render(<PaymentForm />);
    expect(screen.queryByText(/ガス代承認の状況を確認/)).toBeNull();
  });

  it('未接続では approval リンクは表示されない (アドレス不明)', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10`);
    setAccount({ connected: false });
    setGasQuote('ready');
    render(<PaymentForm />);
    expect(screen.queryByText(/ガス代承認の状況を確認/)).toBeNull();
  });

  it('split + ERC20 mode: gas を含めた customer total と extraRecipients が両立', async () => {
    const user = userEvent.setup();
    const B = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    setURL(
      `to=${MERCHANT}&token=usdc&amount=100&split=${B}:30`,
    );
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 500_000n); // 0.5 USDC
    setPayment('idle');
    render(<PaymentForm />);

    // customer = amount + gas = 100 + 0.5 = 100.5 USDC (fee=0)
    expect(
      screen.getByRole('button', { name: /100\.5 USDC を支払う/ }),
    ).not.toBeDisabled();

    await user.click(
      screen.getByRole('button', { name: /100\.5 USDC を支払う/ }),
    );
    const call = mutate.mock.calls[0][0];
    // distributable = amount - fee = 100 USDC (fee=0), primary 70% = 70, B 30% = 30
    expect(call.merchantAmount).toBe(70_000_000n);
    expect(call.extraRecipients[0].to.toLowerCase()).toBe(B.toLowerCase());
    expect(call.extraRecipients[0].amount).toBe(30_000_000n);
    expect(call.extraRecipients).toHaveLength(1);
  });
});

describe('PaymentForm — gas=merchant モード (店主が gas を負担)', () => {
  it('表示: customer pays exactly amount, merchant 控除済表示 (sponsorship gas=0)', () => {
    setURL(`to=${MERCHANT}&token=usdc&gas=merchant&amount=100`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 0n); // sponsorship: gas 0
    render(<PaymentForm />);

    // 顧客支払額 = 100 (amount のまま)
    const dts = Array.from(document.querySelectorAll('dl dt')) as HTMLElement[];
    const customerDt = dts.find((d) =>
      /顧客支払額/.test(d.textContent ?? ''),
    )!;
    expect(customerDt.parentElement).toHaveTextContent('100 USDC');

    // 店主受取 = 100 (fee=0・gas=0 → 控除なし)。旧 99 (fee 1.0 控除) は出ない。
    expect(screen.queryByText('99 USDC')).not.toBeInTheDocument();
    expect(screen.getAllByText('100 USDC').length).toBeGreaterThanOrEqual(2);
  });

  it('JPYC ガス無料化: gas=merchant でも gas 控除なし (sponsorship JPYC・店主満額)', () => {
    setURL(`to=${MERCHANT}&token=jpyc&gas=merchant&amount=1000`);
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(2000n * 10n ** 18n);
    setSmartAccount(true);
    setGasQuote('ready', 2n * 10n ** 18n);
    render(<PaymentForm />);

    // customer pays 1000 (内税)
    const dts = Array.from(document.querySelectorAll('dl dt')) as HTMLElement[];
    const customerDt = dts.find((d) =>
      /顧客支払額/.test(d.textContent ?? ''),
    )!;
    expect(customerDt.parentElement).toHaveTextContent('1000 JPYC');

    // JPYC 無料化: OpenPay が gas を全額負担 → 店主受取 = 1000 (満額・gas 控除なし)。
    // 旧モデルの 998 (gas 2 JPYC 控除) は出ない。
    expect(screen.queryByText('998 JPYC')).not.toBeInTheDocument();
    // 顧客支払額・店主受取がともに 1000 JPYC
    expect(screen.getAllByText('1000 JPYC').length).toBeGreaterThanOrEqual(2);
  });

  it('内税の hint テキストが表示される (店主負担)', () => {
    setURL(`to=${MERCHANT}&token=usdc&gas=merchant&amount=100`);
    setGasQuote('ready', 0n);
    render(<PaymentForm />);
    // i18n updated: "店主がネットワーク手数料を負担"
    expect(
      screen.getByText(/店主が(?: gas|ネットワーク手数料)を負担/),
    ).toBeInTheDocument();
  });

  it('submit: JPYC 無料化で gas=merchant でも徴収なし (merchant 満額・各額 0)', async () => {
    const user = userEvent.setup();
    setURL(`to=${MERCHANT}&token=jpyc&gas=merchant&amount=1000`);
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(2000n * 10n ** 18n);
    setSmartAccount(true);
    setGasQuote('ready', 2n * 10n ** 18n);
    setPayment('idle');
    render(<PaymentForm />);

    await user.click(screen.getByRole('button', { name: /1000 JPYC を支払う/ }));

    const call = mutate.mock.calls[0][0];
    // JPYC 無料化: OpenPay が gas を全額負担し一切徴収しない → merchant 満額 1000、
    // fee / networkFeeEquivalent / gasReimbursement はすべて 0 (feeReceiver 送金なし)。
    expect(call.merchantAmount).toBe(1000n * 10n ** 18n);
    expect(call.feeAmount).toBe(0n);
    expect(call.networkFeeEquivalent).toBe(0n);
    expect(call.gasReimbursement).toBe(0n);
  });

  it('境界 underflow: amount < fee + gas → エラー表示 + 送信 disabled', () => {
    setURL(`to=${MERCHANT}&token=usdc&gas=merchant&amount=0.3`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 500_000n); // gas 0.5 USDC
    render(<PaymentForm />);

    // fee=0: amount=0.3 USDC, gas=0.5 → 0.3 - 0 - 0.5 < 0 → underflow
    expect(screen.getByText(/店主受取が 0 になります/)).toBeInTheDocument();
    // underflow (merchantReceives===0) ではボタンが btnEnterAmount に切替 + disabled
    expect(
      screen.getByRole('button', { name: /金額を入力/ }),
    ).toBeDisabled();
  });

  it('境界 ちょうど: gas == amount → merchant=0、underflow とみなす', () => {
    setURL(`to=${MERCHANT}&token=usdc&gas=merchant&amount=0.1`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);
    render(<PaymentForm />);
    // fee=0: amount=0.1, gas=0.1 → merchant = 0.1 - 0 - 0.1 = 0 → underflow
    expect(screen.getByText(/店主受取が 0 になります/)).toBeInTheDocument();
  });

  it('default (gas 省略 = customer mode) の挙動: customer = amount + gas', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=100`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 0n);
    render(<PaymentForm />);
    // customer = amount + gas = 100 + 0 = 100 (運営手数料は merchant 控除で隠れる)
    expect(
      screen.getByRole('button', { name: /100 USDC を支払う/ }),
    ).not.toBeDisabled();
  });

  it('split + 内税: distributable = amount - fee - gas が % で按分', async () => {
    const user = userEvent.setup();
    const B = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    setURL(
      `to=${MERCHANT}&token=usdc&gas=merchant&amount=100&split=${B}:50`,
    );
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 500_000n); // gas 0.5
    setPayment('idle');
    render(<PaymentForm />);

    await user.click(screen.getByRole('button', { name: /100 USDC を支払う/ }));
    const call = mutate.mock.calls[0][0];
    // distributable = 100 - 0 (fee) - 0.5 (gas) = 99.5, primary 50% = 49.75, B 50% = 49.75
    expect(call.merchantAmount).toBe(49_750_000n);
    expect(call.extraRecipients[0].amount).toBe(49_750_000n);
    // fee=0。gas (0.5) を回収: networkFeeEquivalent=会計記録 / gasReimbursement=実 on-chain 送金額。
    expect(call.feeAmount).toBe(0n);
    expect(call.networkFeeEquivalent).toBe(500_000n);
    expect(call.gasReimbursement).toBe(500_000n);
  });

  it('JPYC ガス無料化: split でも gas 控除なし (受取人満額按分・徴収 0)', async () => {
    // JPYC split (非 relay sponsorship) も無徴収。受取人は gas 控除なしで満額按分され、
    // gasReimbursement / networkFeeEquivalent はともに 0 (feeReceiver 送金なし)。gas quote が
    // 出ても split 按分・徴収には反映されない (effectiveGasAmount=0)。
    const user = userEvent.setup();
    const B = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    setURL(`to=${MERCHANT}&token=jpyc&gas=merchant&amount=1000&split=${B}:50`);
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(2000n * 10n ** 18n);
    setSmartAccount(true);
    setGasQuote('ready', 2n * 10n ** 18n); // gas quote は出るが無視される
    setPayment('idle');
    render(<PaymentForm />);

    await user.click(screen.getByRole('button', { name: /1000 JPYC を支払う/ }));
    const call = mutate.mock.calls[0][0];
    // distributable = 1000 - 0 (fee) - 0 (gas) = 1000, primary 50% = 500, B 50% = 500
    expect(call.merchantAmount).toBe(500n * 10n ** 18n);
    expect(call.extraRecipients[0].amount).toBe(500n * 10n ** 18n);
    expect(call.feeAmount).toBe(0n);
    expect(call.networkFeeEquivalent).toBe(0n);
    expect(call.gasReimbursement).toBe(0n);
  });
});

describe('PaymentForm → CrossChainHint props 統合 (LARP audit C1)', () => {
  beforeEach(() => {
    crossChainHintSpy.mockClear();
  });

  it('USDC + amount 確定 + 接続済 → Hint が render され props が flow', async () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=100`);
    setAccount({ connected: true, chainId: 84532 });
    mockHook(useSmartAccount, {
      data: { smartAccountClient: {}, pimlicoClient: {} },
    });
    mockHook(useGasQuoteUsdc, { data: { gasAmount: 0n } });
    mockHook(useGasQuoteJpyc, { data: { gasAmount: 0n } });
    mockHook(useBatchPayment, { isPending: false, error: null });
    mockHook(useStandardPayment, { isPending: false, error: null });
    vi.mocked(useReadContract).mockReturnValue({
      data: 1_000_000_000n, // 1000 USDC 残高
    } as never);

    render(<PaymentForm />);

    await waitFor(() => expect(crossChainHintSpy).toHaveBeenCalled());
    const props = crossChainHintSpy.mock.lastCall?.[0] as Record<string, unknown>;
    expect(props.token).toBe('usdc');
    expect(props.enabled).toBe(true);
    expect(props.targetChainId).toBe(84532); // Base Sepolia (testnet env)
    expect(props.recipient).toBe(MERCHANT);
    expect(props.displayDecimals).toBe(6);
    // requiredAtomic は totalCustomerOutflow。OpenPay 手数料は常に店主負担
    // (顧客不可視、memory project_fee_model) なので、customer outflow は
    // amount + gas (gas=customer 時) = 100 + 0 = 100 USDC = 100_000_000n
    expect(props.requiredAtomic).toBe(100_000_000n);
    // tokenAddress は USDC Base Sepolia
    expect(props.tokenAddress).toBe(
      '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    );
  });

  it('JPYC では Hint render されない (token guard)', async () => {
    setURL(`to=${MERCHANT}&token=jpyc&amount=1000`);
    setAccount({ connected: true, chainId: 80002 });
    mockHook(useSmartAccount, {
      data: { smartAccountClient: {}, pimlicoClient: {} },
    });
    mockHook(useGasQuoteJpyc, { data: { gasAmount: 0n } });
    mockHook(useBatchPayment, { isPending: false, error: null });
    mockHook(useStandardPayment, { isPending: false, error: null });
    vi.mocked(useReadContract).mockReturnValue({
      data: 100_000_000_000_000_000_000_000n, // 100K JPYC
    } as never);

    render(<PaymentForm />);

    // PaymentForm の guard で {params.token === 'usdc' && address && ...} は false
    // → CrossChainHint コンポーネント自体が mount されない
    await waitFor(() => {
      // payment button が render されたことを wait (PaymentForm 自体は描画完了)
      expect(document.querySelectorAll('button').length).toBeGreaterThan(0);
    });
    expect(crossChainHintSpy).not.toHaveBeenCalled();
  });

  it('未接続 (address 無し) で USDC → Hint render されない (address guard)', async () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10`);
    setAccount({ connected: false });
    mockHook(useSmartAccount, { data: undefined });
    mockHook(useGasQuoteUsdc, { data: { gasAmount: 0n } });
    mockHook(useGasQuoteJpyc, { data: { gasAmount: 0n } });
    mockHook(useBatchPayment, { isPending: false, error: null });
    mockHook(useStandardPayment, { isPending: false, error: null });
    vi.mocked(useReadContract).mockReturnValue({ data: undefined } as never);

    render(<PaymentForm />);

    await waitFor(() => {
      expect(document.querySelectorAll('button').length).toBeGreaterThan(0);
    });
    expect(crossChainHintSpy).not.toHaveBeenCalled();
  });

  it('URL に crossChain=false → Hint の enabled=false で render', async () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10&crossChain=false`);
    setAccount({ connected: true, chainId: 84532 });
    mockHook(useSmartAccount, {
      data: { smartAccountClient: {}, pimlicoClient: {} },
    });
    mockHook(useGasQuoteUsdc, { data: { gasAmount: 0n } });
    mockHook(useGasQuoteJpyc, { data: { gasAmount: 0n } });
    mockHook(useBatchPayment, { isPending: false, error: null });
    mockHook(useStandardPayment, { isPending: false, error: null });
    vi.mocked(useReadContract).mockReturnValue({
      data: 100_000_000n,
    } as never);

    render(<PaymentForm />);

    await waitFor(() => expect(crossChainHintSpy).toHaveBeenCalled());
    const props = crossChainHintSpy.mock.lastCall?.[0] as Record<string, unknown>;
    // store が opt-out した状態は enabled=false で hint へ伝播
    expect(props.enabled).toBe(false);
  });

  it.each(['pending', 'success'] as const)(
    '親の通常決済が %s の間は cross-chain execute を無効化',
    async (state) => {
      setURL(`to=${MERCHANT}&token=usdc&amount=10`);
      setAccount({ connected: true, chainId: baseSepolia.id });
      setBalance(20_000_000n);
      setSmartAccount(true);
      setGasQuote('ready', 0n);
      setPayment(state);

      render(<PaymentForm />);

      await waitFor(() => expect(crossChainHintSpy).toHaveBeenCalled());
      const props = crossChainHintSpy.mock.lastCall?.[0] as {
        executionDisabled: boolean;
      };
      expect(props.executionDisabled).toBe(true);
    },
  );

  it('cross-chain 実行中は親 Pay を止め、成功を親 panel/overlay に表示する', async () => {
    window.localStorage.clear();
    const mintTxHash = `0x${'f'.repeat(64)}` as const;
    setURL(`to=${MERCHANT}&token=usdc&amount=10`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 0n);
    setPayment('idle');

    render(<PaymentForm />);

    await waitFor(() => expect(crossChainHintSpy).toHaveBeenCalled());
    const props = crossChainHintSpy.mock.lastCall?.[0] as {
      onAttemptStart: (amount: bigint) => void;
      onExecutingChange: (executing: boolean) => void;
      onSuccess: (result: {
        path: 'gateway';
        attestation: `0x${string}`;
        attestationSignature: `0x${string}`;
        mintTxHash: `0x${string}`;
        destChainId: number;
      }) => void;
    };
    const payBtn = screen.getByRole('button', { name: /10 USDC を支払う/ });
    expect(payBtn).toBeEnabled();

    act(() => {
      props.onAttemptStart(10_000_000n);
      props.onExecutingChange(true);
    });
    expect(payBtn).toBeDisabled();

    act(() => props.onExecutingChange(false));
    expect(payBtn).toBeEnabled();

    act(() => {
      props.onAttemptStart(10_000_000n);
      props.onSuccess({
        path: 'gateway',
        attestation: '0xattestation',
        attestationSignature: '0xsignature',
        mintTxHash,
        destChainId: baseSepolia.id,
      });
    });
    expect(payBtn).toBeDisabled();
    expect(
      screen.getAllByText(/決済が完了しました|決済完了/).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(mintTxHash).length).toBeGreaterThan(0);
    await waitFor(() => expect(loadPayerReceipts()).toHaveLength(1));
    expect(loadPayerReceipts()[0]).toEqual(
      expect.objectContaining({
        receiptId: mintTxHash,
        amount: '10',
        chainId: baseSepolia.id,
        merchantAddress: MERCHANT,
        payerAddress: CUSTOMER,
        paymentMode: 'cross-chain',
        sourceRoute: '/pay',
      }),
    );
    expect(
      await screen.findByText('OpenPay 電子レシート'),
    ).toBeInTheDocument();
  });
});

describe('PaymentForm — 動的 QR (FX 換算・有効期限)', () => {
  it('exp 過去: UI 目安超過とサーバ非強制を開示 + 支払いボタンが無効', async () => {
    setURL(
      `to=${MERCHANT}&token=usdc&chain=polygon&amount=6.4&refAmt=1000&fxRate=150&exp=1000`,
    );
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setSmartAccount(true);
    setGasQuote('ready');
    render(<PaymentForm />);

    // UI 上の目安期限超過バナー (effect で now 取得後に確定)
    expect(
      await screen.findByText(/OpenPay 画面上の目安期限を過ぎています/),
    ).toBeInTheDocument();
    expect(screen.getByText(/期限はサーバ強制ではありません/)).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: /画面上の目安期限を超過/ });
    expect(btn).toBeDisabled();
  });

  it('exp 過去: CrossChainHint も enabled=false (代替 cross-chain 経路も封じる)', async () => {
    setURL(
      `to=${MERCHANT}&token=usdc&chain=polygon&amount=6.4&refAmt=1000&fxRate=150&exp=1000`,
    );
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setSmartAccount(true);
    setGasQuote('ready');
    render(<PaymentForm />);

    // 期限切れ確定後 (effect で now 計測) を待ってから props を検査
    await screen.findByText(/OpenPay 画面上の目安期限を過ぎています/);
    await waitFor(() => expect(crossChainHintSpy).toHaveBeenCalled());
    const props = crossChainHintSpy.mock.lastCall?.[0] as Record<string, unknown>;
    expect(props.enabled).toBe(false);
  });

  it('exp 未来: 文脈行 (1000 JPYC ≈ 6.4 USDC) + レート + 残り時間、btnExpired は出ない', async () => {
    const future = Math.floor(Date.now() / 1000) + 600;
    setURL(
      `to=${MERCHANT}&token=usdc&chain=polygon&amount=6.4&refAmt=1000&fxRate=150&exp=${future}`,
    );
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setSmartAccount(true);
    setGasQuote('ready');
    setBalance(100_000_000n); // 100 USDC ≫ 6.5 USDC
    render(<PaymentForm />);

    // anchor 文脈行 (元の円価格 ≈ 請求 USDC 額)
    expect(screen.getByText(/1000 JPYC ≈ 6\.4 USDC/)).toBeInTheDocument();
    // 生成時レート
    expect(screen.getByText(/1 USDC = 150 円/)).toBeInTheDocument();
    // 残り時間カウントダウン (effect 後)
    expect(await screen.findByText(/残り \d+:\d{2}/)).toBeInTheDocument();
    // 期限切れ表示は出ない
    expect(
      screen.queryByText(/OpenPay 画面上の目安期限を過ぎています/),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: /画面上の目安期限を超過/ }),
    ).toBeNull();
  });

  it('exp 未来→経過: UI の期限目安を適用し submit が無効化される (fake timers)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      const t0 = new Date(2026, 5, 3, 12, 0, 0).getTime();
      vi.setSystemTime(t0);
      const exp = Math.floor(t0 / 1000) + 5; // 5 秒後に失効
      setURL(
        `to=${MERCHANT}&token=usdc&chain=polygon&amount=6.4&refAmt=1000&fxRate=150&exp=${exp}`,
      );
      setAccount({ connected: true, chainId: polygonAmoy.id });
      setSmartAccount(true);
      setGasQuote('ready');
      setBalance(100_000_000n);
      render(<PaymentForm />);

      // 初期: 期限内 (バナー無し)
      expect(
        screen.queryByText(/OpenPay 画面上の目安期限を過ぎています/),
      ).toBeNull();

      // 6 秒経過 → interval が expired を flip
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });

      expect(
        screen.getByText(/OpenPay 画面上の目安期限を過ぎています/),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /画面上の目安期限を超過/ }),
      ).toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('exp 過去: 期限切れ QR 遭遇を logger.warn(pay.qr_expired) で観測 (Sentry alertable)', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    setURL(
      `to=${MERCHANT}&token=usdc&chain=polygon&amount=6.4&refAmt=1000&fxRate=150&exp=1000`,
    );
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setSmartAccount(true);
    setGasQuote('ready');
    render(<PaymentForm />);
    await screen.findByText(/OpenPay 画面上の目安期限を過ぎています/);
    await waitFor(() =>
      expect(warnSpy).toHaveBeenCalledWith(
        'pay.qr_expired',
        expect.objectContaining({ asset: 'usdc' }),
      ),
    );
    warnSpy.mockRestore();
  });

  it('exp 無し (通常 QR): 期限切れバナーも文脈行も出ない (従来挙動)', async () => {
    setURL(`to=${MERCHANT}&token=usdc&chain=polygon&amount=6.4`);
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setSmartAccount(true);
    setGasQuote('ready');
    setBalance(100_000_000n);
    render(<PaymentForm />);

    expect(
      screen.queryByText(/OpenPay 画面上の目安期限を過ぎています/),
    ).toBeNull();
    expect(screen.queryByText(/≈/)).toBeNull();
    // 通常の支払いボタンが出る (期限切れラベルではない)
    expect(
      screen.queryByRole('button', { name: /画面上の目安期限を超過/ }),
    ).toBeNull();
  });
});

// 「署名安心 UX」(plans/sign-reassurance-ux.md・P1)。relay free mode (forwarder 未設定)
// でのみ Pay ボタン直上に SignReassurance パネルを出す。
describe('PaymentForm — 署名安心パネル (SignReassurance・relay free)', () => {
  // test env では 'polygon' slug は Amoy に解決される (既存 JPYC テストと同じ)。
  function setupRelayFree() {
    vi.mocked(resolveJpycGaslessProvider).mockReturnValue('eip3009-relay');
    vi.mocked(jpycForwarderFor).mockReturnValue(null); // free
    setURL(`to=${MERCHANT}&token=jpyc&amount=300`);
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(10_000n * 10n ** 18n);
  }

  it('relay free + 金額あり → パネル表示 + 金額一致 (照合表に生の数字)', () => {
    setupRelayFree();
    render(<PaymentForm />);

    // 安心パネルの見出し + バッジ。
    expect(
      screen.getByText(/求められるのは「署名」1回だけ/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Approve \(利用許可\) は求めません/)).toBeInTheDocument();
    // バッジの金額が請求額 (300 JPYC) と一致。
    expect(
      screen.getByText(/動かせるのは 300 JPYC ちょうど/),
    ).toBeInTheDocument();
    // 折りたたみ照合表に署名する生の数字 (300 * 10^18) が出る = mutate に渡す value と同一。
    expect(screen.getByText('300000000000000000000')).toBeInTheDocument();
  });

  it('relay.isPending → 署名待ち文言に切替 (通常バッジは消える)', () => {
    setupRelayFree();
    setRelay('pending-flow');
    render(<PaymentForm />);

    expect(
      screen.getByText(/ウォレットの署名画面をご確認ください/),
    ).toBeInTheDocument();
    // 通常パネルのバッジは置換されて出ない。
    expect(screen.queryByText(/Approve \(利用許可\) は求めません/)).toBeNull();
  });

  it('standard 経路では非表示 (relay でないため)', () => {
    setURL(`to=${MERCHANT}&token=jpyc&amount=300&mode=standard`);
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(10_000n * 10n ** 18n);
    render(<PaymentForm />);
    expect(screen.queryByText(/求められるのは「署名」1回だけ/)).toBeNull();
  });

  it('USDC (非 relay) では非表示', () => {
    // resolveJpycGaslessProvider は USDC でも 'pimlico-7702' (beforeEach 既定)。
    setURL(`to=${MERCHANT}&token=usdc&amount=100`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 0n);
    render(<PaymentForm />);
    expect(screen.queryByText(/求められるのは「署名」1回だけ/)).toBeNull();
  });

  it('forwarder 構成 (recover) → jpyc-relay-recover パネル (確定モデル: merchant 固定・ウォレット表示=表示額)', () => {
    vi.mocked(resolveJpycGaslessProvider).mockReturnValue('eip3009-relay');
    // forwarder をアドレスに差し替える = recover 構成。fee=2 JPYC (relayGasFeeValue mock)。
    vi.mocked(jpycForwarderFor).mockReturnValue(
      '0x1111111111111111111111111111111111111111',
    );
    // URL は gas 既定 customer だが、確定モデル (2026-06-13) で /pay recover は merchant 固定。
    setURL(`to=${MERCHANT}&token=jpyc&amount=300`);
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(10_000n * 10n ** 18n);
    render(<PaymentForm />);
    // 見出しは free と共通。merchant モードはウォレット表示 = 表示額 300 JPYC ちょうど
    // (手数料は受取から内枠吸収・上乗せ表記は出ない)。
    expect(
      screen.getByText(/求められるのは「署名」1回だけ/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/動かせるのは 300 JPYC ちょうど/),
    ).toBeInTheDocument();
    // customer 内訳 (お支払い + 手数料) は merchant では出ない。
    expect(screen.queryByText(/お支払い 300 \+ 手数料 2/)).toBeNull();
    // 照合表に signedTotal (= merchantValue 298 + feeValue 2 = 300 * 10^18) の生の数字が出る。
    expect(screen.getByText('300000000000000000000')).toBeInTheDocument();
  });

  it('金額未入力 (据え置き QR) では非表示 (amountWei=0)', () => {
    vi.mocked(resolveJpycGaslessProvider).mockReturnValue('eip3009-relay');
    vi.mocked(jpycForwarderFor).mockReturnValue(null);
    setURL(`to=${MERCHANT}&token=jpyc`); // amount 無し
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(10_000n * 10n ** 18n);
    render(<PaymentForm />);
    expect(screen.queryByText(/求められるのは「署名」1回だけ/)).toBeNull();
  });
});

// B1 graceful degradation: relay が API レベルで失敗したとき、ガス代自己負担の「通常決済」へ
// 1 タップ切替する banner を Pay ボタン直上に出す。on-chain revert (data.success===false) は
// 別経路 (revertedNoFeedback) で扱うため、ここでは relay.error (= API 失敗) のみ対象。
describe('PaymentForm — relay 失敗時の通常決済フォールバック (B1)', () => {
  function setupRelayError(errMsg = 'rate_limited') {
    vi.mocked(resolveJpycGaslessProvider).mockReturnValue('eip3009-relay');
    vi.mocked(jpycForwarderFor).mockReturnValue(null); // free
    setURL(`to=${MERCHANT}&token=jpyc&amount=300`);
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(10_000n * 10n ** 18n);
    setRelay('error', { errMsg });
  }

  it('auto recovery→成功で成功描画/控え/履歴を各 1 回だけ確定する', async () => {
    window.localStorage.clear();
    vi.mocked(resolveJpycGaslessProvider).mockReturnValue('eip3009-relay');
    vi.mocked(jpycForwarderFor).mockReturnValue(null);
    setURL(`to=${MERCHANT}&token=jpyc&amount=300`);
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(10_000n * 10n ** 18n);
    const value = 300n * 10n ** 18n;
    const variables = { merchant: MERCHANT, value, gasMode: 'merchant' as const };
    const user = userEvent.setup();
    const rendered = render(<PaymentForm />);

    await user.click(screen.getByRole('button', { name: /300 JPYC を支払う/ }));
    setRelay('pending-flow', { recoveryState: 'auto', variables });
    rendered.rerender(<PaymentForm />);
    expect(screen.getByText(/支払い結果を確認しています/)).toBeInTheDocument();

    const txHash = `0x${'e'.repeat(64)}` as `0x${string}`;
    setRelay('success', { txHash, variables });
    rendered.rerender(<PaymentForm />);
    expect(screen.getAllByText(/決済が完了しました|決済完了/).length).toBeGreaterThan(0);
    rendered.rerender(<PaymentForm />);

    expect(loadPayerReceipts().filter((r) => r.receiptId === txHash)).toHaveLength(1);
    expect(loadHistory().filter((e) => e.txHash === txHash)).toHaveLength(1);
  });

  it('reload 復元した relay 成功は保存済み金額・送受信者で履歴と控えを作る', async () => {
    window.localStorage.clear();
    vi.mocked(resolveJpycGaslessProvider).mockReturnValue('eip3009-relay');
    vi.mocked(jpycForwarderFor).mockReturnValue(null);
    const restoredMerchant =
      '0x3333333333333333333333333333333333333333' as Address;
    const restoredCustomer =
      '0x8888888888888888888888888888888888888888' as Address;
    const value = 777n * 10n ** 18n;
    const txHash = `0x${'7'.repeat(64)}` as `0x${string}`;
    setURL(`to=${MERCHANT}&token=jpyc&amount=300`);
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(10_000n * 10n ** 18n);
    setRelay('success', {
      txHash,
      variables: {
        merchant: restoredMerchant,
        value,
        gasMode: 'customer',
      },
      restoredIntent: {
        chainId: polygonAmoy.id,
        from: restoredCustomer,
        merchant: restoredMerchant,
        merchantValue: value.toString(),
        feeValue: '0',
        nonce: `0x${'6'.repeat(64)}`,
        validBefore: '9999999999',
        routeKind: 'free',
        issuedAt: 1,
      },
    });

    render(<PaymentForm />);

    expect(screen.getAllByText(txHash).length).toBeGreaterThan(0);
    await waitFor(() => expect(loadHistory()).toHaveLength(0));
    expect(loadPayerReceipts()).toHaveLength(0);
  });

  it('relay error (rate_limited): friendly 文言 + 通常決済へ切替 banner (生コードは非表示)', () => {
    setupRelayError('rate_limited');
    render(<PaymentForm />);
    // friendly 文言は banner 内に 1 度だけ出る (生コードは出さない)。
    expect(screen.getByText(/短時間に決済が集中/)).toBeInTheDocument();
    expect(screen.queryByText('rate_limited')).toBeNull();
    // banner の title + 切替ボタン。
    expect(
      screen.getByText(/ガスレス決済が一時的に利用できません/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: /通常支払い（自分でガスを払う）に切り替える/,
      }),
    ).toBeInTheDocument();
  });

  it('friendly 文言は 1 度だけ表示 (赤エラーボックスとの重複なし)', () => {
    setupRelayError('rate_limited');
    render(<PaymentForm />);
    // 文言は banner 内のみ (旧 errorTitle 付き赤ボックスでは重複表示しない)。
    expect(screen.getAllByText(/短時間に決済が集中/)).toHaveLength(1);
    // 汎用エラー見出し (errorTitle) は relay fallback では出さない。
    expect(screen.queryByText('エラー')).toBeNull();
  });

  it('切替ボタンを押すと standard モードへ (banner 消滅 + 通常決済バッジ表示)', async () => {
    const user = userEvent.setup();
    setupRelayError('rate_limited');
    render(<PaymentForm />);

    await user.click(
      screen.getByRole('button', {
        name: /通常支払い（自分でガスを払う）に切り替える/,
      }),
    );

    // modeOverride='standard' → isStandard。relay banner は消え通常決済 UI に変わる。
    expect(
      screen.queryByText(/ガスレス決済が一時的に利用できません/),
    ).toBeNull();
    // 通常決済バッジ (standardModeTitle) が出る。
    expect(
      screen.getAllByText(/通常決済（ガス代は自分で負担）/).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ['relay_not_configured', /リレー\) は現在ご利用いただけません/],
    ['insufficient_balance', /JPYC の残高が不足/],
    ['fee_required', /現在停止しています/],
    ['boom', /完了できませんでした/],
  ])(
    'relay error (%s) でも切替 banner を出す (API レベル失敗は通常決済が次手)',
    (errMsg, bodyPattern) => {
      setupRelayError(errMsg);
      render(<PaymentForm />);
      expect(screen.getByText(bodyPattern)).toBeInTheDocument();
      expect(
        screen.getByRole('button', {
          name: /通常支払い（自分でガスを払う）に切り替える/,
        }),
      ).toBeInTheDocument();
    },
  );

  it('response-unknown → standard fallback 非表示・再署名封鎖・中間表示', async () => {
    const user = userEvent.setup();
    setupRelayError();
    setRelay('response-unknown');
    render(<PaymentForm />);

    expect(screen.getByText(/送信済みかを判定できません/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /同じ送信内容を再確認/ }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: /同じ送信内容を再確認/ }),
    );
    expect(relayRetrySamePayload).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole('button', {
        name: /通常支払い（自分でガスを払う）に切り替える/,
      }),
    ).toBeNull();
    const payButton = screen.getByRole('button', { name: /送信中/ });
    expect(payButton).toBeDisabled();
    await user.click(payButton);
    expect(relayMutate).not.toHaveBeenCalled();
    expect(screen.queryByText('エラー')).toBeNull();
  });

  it('unknown 後の 400 系 error でも fallback banner を出さず exhausted を維持', () => {
    setupRelayError();
    setRelay('error', {
      errMsg: 'insufficient_balance',
      recoveryState: 'exhausted',
    });
    render(<PaymentForm />);

    expect(screen.getByText(/送信済みかを判定できません/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: /通常支払い（自分でガスを払う）に切り替える/,
      }),
    ).toBeNull();
    expect(screen.queryByText('エラー')).toBeNull();
  });

  it('ip_rate_limited → fallback 非表示・Pay 封鎖・同一 payload 再試行のみ', async () => {
    const user = userEvent.setup();
    setupRelayError();
    setRelay('ip-rate-limited', { retryAfterSeconds: 45 });
    render(<PaymentForm />);

    expect(
      screen.getByText(/45秒ほど待ってから、同じ内容でもう一度/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: /通常支払い（自分でガスを払う）に切り替える/,
      }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: /300 JPYC を支払う/ }),
    ).toBeDisabled();

    await user.click(
      screen.getByRole('button', { name: /同じ内容で再試行/ }),
    );
    expect(relayRetryRelay).toHaveBeenCalledOnce();
    expect(relayMutate).not.toHaveBeenCalled();
    expect(screen.queryByText('エラー')).toBeNull();
  });

  it('relay の on-chain revert (data.success=false・error なし) は banner を出さない (別経路)', () => {
    vi.mocked(resolveJpycGaslessProvider).mockReturnValue('eip3009-relay');
    vi.mocked(jpycForwarderFor).mockReturnValue(null);
    setURL(`to=${MERCHANT}&token=jpyc&amount=300`);
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(10_000n * 10n ** 18n);
    // revert は data.success=false かつ error=null。setRelay には reverted 状態が無いため直接 mock。
    mockHook(useJpycEip3009Payment, {
      mutate: vi.fn(),
      isPending: false,
      data: { txHash: `0x${'e'.repeat(64)}`, success: false },
      error: null,
      variables: undefined,
    } as Partial<ReturnType<typeof useJpycEip3009Payment>>);
    render(<PaymentForm />);
    // revert は通常決済フォールバック banner ではなく従来の errorReverted 文言 (再試行が安全)。
    expect(
      screen.queryByText(/ガスレス決済が一時的に利用できません/),
    ).toBeNull();
  });
});

// B1 Layer B (preflight): relayer 健全性プローブ (useRelayHealth) が degraded を返したとき、
// 署名 *前* に同じ「通常決済へ切替」banner を出す。Layer A (relay.error) との優先順位を検証する。
describe('PaymentForm — relayer preflight degraded (B1 Layer B)', () => {
  function setupRelayFree() {
    vi.mocked(resolveJpycGaslessProvider).mockReturnValue('eip3009-relay');
    vi.mocked(jpycForwarderFor).mockReturnValue(null); // free
    setURL(`to=${MERCHANT}&token=jpyc&amount=300`);
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(10_000n * 10n ** 18n);
  }

  it('degraded + error なし + 未 submit → preflight 文言 + 通常決済へ切替 banner', () => {
    setupRelayFree();
    vi.mocked(useRelayHealth).mockReturnValue({
      degraded: true,
      reason: 'low_balance',
    });
    render(<PaymentForm />);
    // preflight 文言 (新 i18n key) が出る。
    expect(
      screen.getByText(/ガスレス決済が現在混雑\/一時的に利用しづらい可能性があります/),
    ).toBeInTheDocument();
    // banner の title + 切替ボタン。
    expect(
      screen.getByText(/ガスレス決済が一時的に利用できません/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: /通常支払い（自分でガスを払う）に切り替える/,
      }),
    ).toBeInTheDocument();
  });

  it('切替ボタンで standard モードへ (banner 消滅)', async () => {
    const user = userEvent.setup();
    setupRelayFree();
    vi.mocked(useRelayHealth).mockReturnValue({ degraded: true });
    render(<PaymentForm />);
    await user.click(
      screen.getByRole('button', {
        name: /通常支払い（自分でガスを払う）に切り替える/,
      }),
    );
    expect(
      screen.queryByText(/ガスレス決済が一時的に利用できません/),
    ).toBeNull();
    expect(
      screen.getAllByText(/通常決済（ガス代は自分で負担）/).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('Layer A 優先: relay.error があれば preflight 文言ではなく per-error 文言を出す (二重表示なし)', () => {
    setupRelayFree();
    vi.mocked(useRelayHealth).mockReturnValue({ degraded: true });
    setRelay('error', { errMsg: 'rate_limited' });
    render(<PaymentForm />);
    // Layer A の per-error 文言が出る。
    expect(screen.getByText(/短時間に決済が集中/)).toBeInTheDocument();
    // preflight 文言は出さない (両方は出さない)。
    expect(
      screen.queryByText(/ガスレス決済が現在混雑\/一時的に利用しづらい可能性があります/),
    ).toBeNull();
    // banner (title + 切替) は 1 つだけ。
    expect(
      screen.getAllByText(/ガスレス決済が一時的に利用できません/),
    ).toHaveLength(1);
  });

  it('degraded でも submit 済 (relay.data あり) なら preflight banner を出さない', () => {
    setupRelayFree();
    vi.mocked(useRelayHealth).mockReturnValue({ degraded: true });
    // 成功 data がある = 既に決済が進んだ状態。preflight は出さない。
    setRelay('success');
    render(<PaymentForm />);
    expect(
      screen.queryByText(/ガスレス決済が一時的に利用できません/),
    ).toBeNull();
  });

  it('relay.isPending 中は degraded でも standard 切替を表示しない', () => {
    setupRelayFree();
    vi.mocked(useRelayHealth).mockReturnValue({ degraded: true });
    setRelay('pending-flow');
    render(<PaymentForm />);

    expect(
      screen.queryByRole('button', {
        name: /通常支払い（自分でガスを払う）に切り替える/,
      }),
    ).toBeNull();
  });

  it('standard 経路では degraded でも banner を出さない (relay 経路のみ)', () => {
    vi.mocked(useRelayHealth).mockReturnValue({ degraded: true });
    setURL(`to=${MERCHANT}&token=jpyc&amount=300&mode=standard`);
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(10_000n * 10n ** 18n);
    render(<PaymentForm />);
    expect(
      screen.queryByText(/ガスレス決済が一時的に利用できません/),
    ).toBeNull();
  });

  it('preflight degraded + 金額精度エラー: preflight banner と検証エラーを両方出す (Codex P1: additive・抑止しない)', () => {
    setupRelayFree();
    vi.mocked(useRelayHealth).mockReturnValue({ degraded: true });
    // JPYC(18 桁) を超える 19 桁小数 → amountPrecisionError (pre-submit 検証エラー)。
    setURL(`to=${MERCHANT}&token=jpyc&amount=1.1234567890123456789`);
    render(<PaymentForm />);
    // additive preflight banner が出る。
    expect(
      screen.getByText(/ガスレス決済が現在混雑\/一時的に利用しづらい可能性があります/),
    ).toBeInTheDocument();
    // かつ精度エラーが抑止されず両方見える (旧 relayBannerActive 置換では隠れていた回帰)。
    expect(screen.getByText(/金額の小数点以下は最大/)).toBeInTheDocument();
  });
});

// 「署名安心 UX」P2: standard 経路は 1 行ヒント・Circle (USDC gasless) は usdc-permit。
describe('PaymentForm — 署名安心 P2 (standard ヒント / Circle usdc-permit)', () => {
  it('standard 経路: 通常送金の 1 行ヒント (フルパネル/usdc-permit は出さない)', () => {
    setURL(`to=${MERCHANT}&token=jpyc&amount=300&mode=standard`);
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(10_000n * 10n ** 18n);
    render(<PaymentForm />);
    expect(screen.getByText(/通常の送金確認が表示されます/)).toBeInTheDocument();
    // relay-free フルパネルは出さない。
    expect(screen.queryByText(/求められるのは「署名」1回だけ/)).toBeNull();
  });

  it('Circle (USDC gasless): usdc-permit パネル + permitCap (上限) を formatUnits で表示', () => {
    vi.mocked(resolvePaymasterMode).mockReturnValue('erc20');
    vi.mocked(resolveUsdcGaslessProvider).mockReturnValue('circle');
    setURL(`to=${MERCHANT}&token=usdc&amount=100`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    // permitAmount=100.5 USDC (= 100_500_000 atomic・6 桁)。cap 表示を formatUnits で検証。
    setCircleQuote('ready', { gasAmount: 0n, permitAmount: 100_500_000n });
    render(<PaymentForm />);

    // 有界 permit 見出し + cap バッジ + この決済にのみ。
    expect(
      screen.getByText(/利用許可 \(Spending cap\).+署名/),
    ).toBeInTheDocument();
    expect(screen.getByText(/上限 100\.5 USDC まで/)).toBeInTheDocument();
    expect(
      screen.getByText(/この許可はこの決済 \(100 USDC\) にのみ使われます/),
    ).toBeInTheDocument();
    // relay-free の「Approve は求めません」は出さない (有界 permit のため・誠実性)。
    expect(screen.queryByText(/Approve \(利用許可\) は求めません/)).toBeNull();
  });

  it('Circle で split QR: transferCount で「N 件の送金 (分割受取)」を表示', () => {
    vi.mocked(resolvePaymasterMode).mockReturnValue('erc20');
    vi.mocked(resolveUsdcGaslessProvider).mockReturnValue('circle');
    // split=addr:30 → primary + 1 extra = 2 件。
    const SPLIT: Address = '0x3333333333333333333333333333333333333333';
    setURL(`to=${MERCHANT}&token=usdc&amount=100&split=${SPLIT}:30`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setCircleQuote('ready', { gasAmount: 0n, permitAmount: 100_000_000n });
    render(<PaymentForm />);
    expect(
      screen.getByText(/2 件の送金 \(分割受取\) を 1 回の確認で行います/),
    ).toBeInTheDocument();
  });

  it('Circle 経路で permitAmount 未取得: cap なし文言 (上限なし版バッジ)', () => {
    vi.mocked(resolvePaymasterMode).mockReturnValue('erc20');
    vi.mocked(resolveUsdcGaslessProvider).mockReturnValue('circle');
    setURL(`to=${MERCHANT}&token=usdc&amount=100`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    // permit 未算定 (idle) でもパネルは出る (cap 省略)。
    setCircleQuote('idle');
    render(<PaymentForm />);
    expect(
      screen.getByText(/この決済額\+ガス代上限のみ/),
    ).toBeInTheDocument();
    // cap 文言 (上限 … まで) は出ない。
    expect(screen.queryByText(/上限 .+ まで/)).toBeNull();
  });

  it('USDC Pimlico erc20 (非 circle・非 standard): どのパネルも出さない (スコープ外)', () => {
    vi.mocked(resolvePaymasterMode).mockReturnValue('erc20');
    // resolveUsdcGaslessProvider 既定 'pimlico'。
    setURL(`to=${MERCHANT}&token=usdc&amount=100`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 0n);
    render(<PaymentForm />);
    expect(screen.queryByText(/利用許可 \(Spending cap\)/)).toBeNull();
    expect(screen.queryByText(/通常の送金確認が表示されます/)).toBeNull();
    expect(screen.queryByText(/求められるのは「署名」1回だけ/)).toBeNull();
  });
});
