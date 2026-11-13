import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
import {
  CIRCLE_ERROR_CASES,
  CIRCLE_ERRORS_EN,
  CIRCLE_ERRORS_JA,
  RAW_ERROR_MESSAGE,
  codedError,
} from '../_helpers/circleErrorCases';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { arbitrumSepolia, baseSepolia, polygonAmoy } from 'viem/chains';
import type { Address } from 'viem';

vi.mock('wagmi', () => ({
  useWriteContract: vi.fn(() => ({ data: undefined, error: null, isPending: false, writeContract: vi.fn(), reset: vi.fn() })),
  useWaitForTransactionReceipt: vi.fn(() => ({ data: undefined, error: null, isSuccess: false, isError: false, refetch: vi.fn() })),
  useAccount: vi.fn(),
  useReadContract: vi.fn(),
  useSwitchChain: vi.fn(),
  useWalletClient: vi.fn(),
  usePublicClient: vi.fn(),
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
vi.mock('@/hooks/useGasQuoteUsdc', () => ({ useGasQuoteUsdc: vi.fn() }));
vi.mock('@/hooks/useGasQuoteJpyc', () => ({ useGasQuoteJpyc: vi.fn() }));
const loggerDebug = vi.hoisted(() => vi.fn());
const loggerInfo = vi.hoisted(() => vi.fn());
const loggerWarn = vi.hoisted(() => vi.fn());
const loggerError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logger', () => ({
  logger: {
    debug: loggerDebug,
    info: loggerInfo,
    warn: loggerWarn,
    error: loggerError,
  },
}));
// Circle quote は default flag OFF (resolveUsdcGaslessProvider→pimlico) で非 active。
// circle テスト block で 'circle' に override + permitAmount を返す。
vi.mock('@/hooks/useGasQuoteCircle', () => ({ useGasQuoteCircle: vi.fn() }));
vi.mock('@/lib/circlePaymaster', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/circlePaymaster')>(
      '@/lib/circlePaymaster',
    );
  return { ...actual, resolveUsdcGaslessProvider: vi.fn(() => 'pimlico') };
});
// CrossChainHint は wagmi の useWalletClient / usePublicClient + react-query
// に依存するが、本 test file の責務は TipForm 本体ロジックのため、Hint は空
// component で stub する (Hint 自体の動作は CrossChainHint.test.tsx で検証)。
// TipForm から Hint へ渡される props は crossChainHintSpy で capture して検証。
const crossChainHintSpy = vi.fn();
// A-1 のテストだけが false にし、「子がまだ報告していない」状態 (遅延ロード中・走査中) を固定する。
const crossChainHintReports = { onMount: true };
vi.mock('@/components/CrossChainHint', async () => {
  const React = await import('react');
  return {
    CrossChainHint: (props: Record<string, unknown>) => {
      crossChainHintSpy(props);
      // 実物は mount 時に onExecutingChange を必ず呼ぶ (Arc の回復 scan 完了を親に伝え、直接送信の
      // ロックを解く)。stub でも同じ契約を守らないと Arc standard の送信ボタンが永久に disabled になる。
      // 実物の effect は onExecutingChange の identity (= 親の scan scope: 金額変更で変わる) に追随する。
      const cb = props.onExecutingChange;
      React.useEffect(() => {
        if (crossChainHintReports.onMount && typeof cb === 'function') (cb as (executing: boolean) => void)(false);
      }, [cb]);
      return null;
    },
  };
});
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
// useJpycEip3009Payment は real だと wagmi useWalletClient + react-query (useMutation) に依存する。
// relay/Pimlico の分岐は resolveJpycGaslessProvider を直接制御して検証する (CheckoutForm.test と同型)。
vi.mock('@/hooks/useJpycEip3009Payment', () => ({
  useJpycEip3009Payment: vi.fn(),
}));
vi.mock('@/lib/relay/relayStoredReceipt', () => ({
  waitForStoredRelayReceipt: vi.fn(),
}));
vi.mock('@/lib/jpycGaslessProvider', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/jpycGaslessProvider')
  >('@/lib/jpycGaslessProvider');
  return { ...actual, resolveJpycGaslessProvider: vi.fn(() => 'pimlico-7702') };
});
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

import { useAccount, useReadContract, useSwitchChain, useWalletClient, usePublicClient } from 'wagmi';
import { useSmartAccount } from '@/hooks/useSmartAccount';
import { useBatchPayment } from '@/hooks/useBatchPayment';
import { useGasQuoteUsdc } from '@/hooks/useGasQuoteUsdc';
import { useGasQuoteJpyc } from '@/hooks/useGasQuoteJpyc';
import { useGasQuoteCircle } from '@/hooks/useGasQuoteCircle';
import { resolveUsdcGaslessProvider } from '@/lib/circlePaymaster';
import { resolvePaymasterMode } from '@/lib/pimlico';
import { useJpycEip3009Payment } from '@/hooks/useJpycEip3009Payment';
import { resolveJpycGaslessProvider } from '@/lib/jpycGaslessProvider';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { env } from '@/lib/env';
import { TipForm } from '@/components/TipForm';
import { ReceiveMethodPicker } from '@/components/ReceiveMethodPicker';
import type { HandleTipConfig } from '@/lib/handle';
import { loadPayerReceipts } from '@/lib/payerReceipt';
import { deploymentsForSymbol } from '@/lib/tokens';
import { saveResumeState } from '@/lib/crossChain/resumeStore';
import type { TipParams } from '@/lib/url';
import {
  RelayIpRateLimitedError,
  RelayResponseUnknownError,
} from '@/lib/relay/relayResponseError';
import { mockHook } from '../_helpers/wagmiMock';
import { waitForStoredRelayReceipt } from '@/lib/relay/relayStoredReceipt';
import { RELAY_INTENT_PROBE_KEY, RELAY_INTENT_STORAGE_KEY } from '@/lib/paymentIntentStorage';

const CREATOR: Address = '0x2222222222222222222222222222222222222222';
const FAN: Address = '0x9999999999999999999999999999999999999999';

function setAccount(opts: { connected: boolean; chainId?: number }) {
  mockHook(useAccount, {
    address: opts.connected ? FAN : undefined,
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
let batchRetryReceipt: ReturnType<typeof vi.fn>;
function setBatchPayment(
  state: 'idle' | 'pending' | 'success' | 'error' | 'unknown',
  errorOverride?: Error,
  extra?: Partial<ReturnType<typeof useBatchPayment>>,
) {
  mutate = vi.fn();
  batchRetryReceipt = vi.fn();
  mockHook(useBatchPayment, {
    ...extra,
    mutate,
    isPending: state === 'pending',
    isSuccess: state === 'success',
    isError: state === 'error' || state === 'unknown',
    isUnknown: state === 'unknown',
    pendingUserOpHash:
      state === 'unknown' ? `0x${'e'.repeat(64)}` : undefined,
    retryReceipt: batchRetryReceipt,
    data:
      state === 'success'
        ? {
            userOpHash: `0x${'a'.repeat(64)}`,
            txHash: `0x${'b'.repeat(64)}`,
            blockNumber: 99n,
            success: true,
          }
        : undefined,
    error:
      state === 'error'
        ? (errorOverride ?? new Error('AA21 fail'))
        : state === 'unknown'
          ? new Error('receipt RPC unavailable')
          : null,
  } as Partial<ReturnType<typeof useBatchPayment>>);
}

let relayMutate: ReturnType<typeof vi.fn>;
let relayRetryRelay: ReturnType<typeof vi.fn>;
let relayRetrySamePayload: ReturnType<typeof vi.fn>;
function setRelay(
  state:
    | 'idle'
    | 'pending'
    | 'auto'
    | 'success'
    | 'reverted'
    | 'error'
    | 'pendingResult'
    | 'response-unknown'
    | 'ip-rate-limited',
  opts?: {
    variables?: {
      merchant: Address;
      value: bigint;
      gasMode?: 'customer' | 'merchant';
      tipMessage?: string;
    };
    restoredIntent?: NonNullable<
      ReturnType<typeof useJpycEip3009Payment>['restoredIntent']
    >;
    isRestoring?: boolean;
    hasActiveIntent?: boolean;
    errMsg?: string;
  },
) {
  relayMutate = vi.fn();
  relayRetryRelay = vi.fn();
  relayRetrySamePayload = vi.fn();
  mockHook(useJpycEip3009Payment, {
    mutate: relayMutate,
    isPending: state === 'pending' || state === 'auto',
    data:
      state === 'success' || state === 'reverted'
        ? { txHash: `0x${'c'.repeat(64)}`, success: state === 'success' }
        : state === 'pendingResult'
          ? { txHash: `0x${'d'.repeat(64)}`, success: false, pending: true }
          : undefined,
    error:
      state === 'error'
        ? new Error(opts?.errMsg ?? 'rate_limited')
        : state === 'response-unknown'
          ? new RelayResponseUnknownError()
          : state === 'ip-rate-limited'
            ? new RelayIpRateLimitedError(45)
            : null,
    retryRelay: relayRetryRelay,
    retrySamePayload: relayRetrySamePayload,
    recoveryState:
      state === 'auto'
        ? 'auto'
        : state === 'response-unknown'
          ? 'exhausted'
          : null,
    variables: opts?.variables,
    restoredIntent: opts?.restoredIntent,
    isRestoring: opts?.isRestoring ?? false,
    hasActiveIntent: opts?.hasActiveIntent ?? false,
  } as Partial<ReturnType<typeof useJpycEip3009Payment>>);
}

function setSwitchChain() {
  mockHook(useSwitchChain, {
    switchChain: vi.fn(),
    isPending: false,
  });
}

function setGasQuote(state: 'disabled' | 'pending' | 'ready' | 'error', amount?: bigint) {
  // gas 見積は paymaster mode に応じて 1 つだけ使われる。両方同じ state で mock しておく。
  const mockState = {
    data: state === 'ready' ? { gasAmount: amount ?? 100_000n } : undefined,
    isLoading: state === 'pending',
    isError: state === 'error',
    error: state === 'error' ? new Error('quote failed') : null,
  };
  mockHook(useGasQuoteUsdc, mockState as Partial<ReturnType<typeof useGasQuoteUsdc>>);
  mockHook(useGasQuoteJpyc, mockState as Partial<ReturnType<typeof useGasQuoteJpyc>>);
}

// circle quote: state 'idle'(非active) / 'ready'(permitAmount + gasAmount を返す)。
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
  } as Partial<ReturnType<typeof useGasQuoteCircle>>);
}

function setTipMessageFlag(enabled: boolean): void {
  (env as { enableTipMessage: boolean }).enableTipMessage = enabled;
}

beforeEach(() => {
  vi.clearAllMocks();
  setTipMessageFlag(false);
  setSwitchChain();
  setBalance(undefined);
  setSmartAccount(false);
  setBatchPayment('idle');
  setRelay('idle');
  setGasQuote('disabled');
  setCircleQuote('idle');
  setAccount({ connected: false });
  // 既定: testnet 環境 → 全 token sponsorship。erc20 を test したい block で override
  vi.mocked(resolvePaymasterMode).mockImplementation(() => 'sponsorship');
  // 既定は従来 Pimlico 経路。relay を test したい block で 'eip3009-relay' へ override。
  vi.mocked(resolveJpycGaslessProvider).mockReturnValue('pimlico-7702');
  vi.mocked(jpycForwarderFor).mockReturnValue(null);
  // 既定 USDC は Pimlico erc20。circle テスト block で 'circle' へ override。
  vi.mocked(resolveUsdcGaslessProvider).mockReturnValue('pimlico');
});

const JPYC_PARAMS: TipParams = {
  mode: 'gasless',
  to: CREATOR,
  token: 'jpyc',
  name: '山田太郎',
  message: 'いつも応援ありがとう！',
  color: '#1e3a8a',
  presets: ['100', '500', '1000'],
};

const USDC_PARAMS: TipParams = {
  mode: 'gasless',
  to: CREATOR,
  token: 'usdc',
  presets: ['1', '5', '10'],
};

describe('TipForm — レンダリング', () => {
  it('クリエイター名 / メッセージ / プリセットを表示', () => {
    render(<TipForm params={JPYC_PARAMS} />);
    expect(screen.getByText(/山田太郎 さんへ/)).toBeInTheDocument();
    expect(screen.getByText(/応援ありがとう/)).toBeInTheDocument();
    // preset ボタン
    expect(screen.getByRole('button', { name: '100 JPYC' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '500 JPYC' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1000 JPYC' })).toBeInTheDocument();
  });

  it('name が無いときは汎用文言', () => {
    render(<TipForm params={{ mode: 'gasless', to: CREATOR, token: 'usdc' }} />);
    expect(screen.getByText('クリエイターへチップを送る')).toBeInTheDocument();
  });

  it('preset 未指定 → DEFAULT_TIP_PRESETS が使われる (USDC)', () => {
    render(<TipForm params={{ mode: 'gasless', to: CREATOR, token: 'usdc' }} />);
    expect(screen.getByRole('button', { name: '5 USDC' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '20 USDC' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '50 USDC' })).toBeInTheDocument();
  });

  it('ラベル付き preset pill は上段ラベル + 下段金額の 2 行表示', () => {
    render(
      <TipForm
        params={{ ...JPYC_PARAMS, presets: ['300|☕ コーヒー1杯', '1000'] }}
      />,
    );
    const pill = screen.getByRole('button', {
      name: '☕ コーヒー1杯 300 JPYC',
    });
    expect(within(pill).getByText('☕ コーヒー1杯')).toHaveClass('text-xs');
    expect(within(pill).getByText('300 JPYC')).toHaveClass('leading-tight');
    expect(pill).toHaveClass('py-2');
  });

  it('ラベル無し preset pill は従来 class と子テキストを維持', () => {
    render(<TipForm params={JPYC_PARAMS} />);
    const pill = screen.getByRole('button', { name: '100 JPYC' });
    expect(pill.className).toBe(
      'rounded-xl border px-2 py-3 text-center text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 border-transparent text-white shadow-sm',
    );
    expect(pill.innerHTML).toBe('100 JPYC');
  });

  it('ラベル付き pill に night theme の active/inactive 配色を併用', () => {
    render(
      <TipForm
        params={{
          ...JPYC_PARAMS,
          theme: 'night',
          presets: ['300|☕ コーヒー1杯', '1000|🍰 ケーキ'],
        }}
      />,
    );
    const active = screen.getByRole('button', {
      name: '☕ コーヒー1杯 300 JPYC',
    });
    const inactive = screen.getByRole('button', {
      name: '🍰 ケーキ 1000 JPYC',
    });
    expect(active.style.backgroundColor).not.toBe('');
    expect(inactive.className).toContain('bg-slate-950');
    expect(inactive.className).toContain('text-slate-200');
  });

  it('color パラメータがヘッダの背景色に適用される', () => {
    render(<TipForm params={JPYC_PARAMS} />);
    const header = screen.getByText('OpenPay Tip').closest('header')!;
    expect(header.style.backgroundColor).toBe('rgb(30, 58, 138)'); // #1e3a8a
  });

  it('theme 未指定は導入前の class 出力を固定', () => {
    render(<TipForm params={JPYC_PARAMS} />);
    const header = screen.getByText('OpenPay Tip').closest('header')!;
    const root = header.parentElement!;
    const amountSection = screen.getByText('金額を選択').parentElement!;
    const submit = Array.from(document.querySelectorAll('button')).find((el) =>
      el.className.includes('text-base'),
    )!;

    expect(root.className).toBe('space-y-4');
    expect(header.className).toBe(
      'rounded-2xl p-5 text-white shadow-sm',
    );
    expect(amountSection.className).toBe(
      'rounded-2xl border border-slate-200 bg-white p-4',
    );
    expect(submit.className).toBe(
      'w-full rounded-xl px-4 py-3 text-base font-semibold text-white shadow-sm transition disabled:cursor-not-allowed disabled:opacity-50',
    );
  });

  it.each([
    ['clean', 'ring-1', 'ring-black/5'],
    ['gradient', 'ring-slate-200/70', 'ring-white/30'],
    ['bold', 'ring-4', 'shadow-[6px_6px_0_#0f172a]'],
    ['outline', 'p-3', 'shadow-none'],
    ['night', 'bg-slate-950', 'ring-white/15'],
    ['soft', 'rounded-[2rem]', 'rounded-[1.5rem]'],
  ] as const)('%s theme の class をフォームへ適用', (theme, rootClass, headerClass) => {
    render(<TipForm params={{ ...JPYC_PARAMS, theme }} />);
    const header = screen.getByText('OpenPay Tip').closest('header')!;
    const root = header.parentElement!;
    expect(root).toHaveAttribute('data-tip-theme', theme);
    expect(root.className).toContain(rootClass);
    expect(header.className).toContain(headerClass);
  });

  it('night はヘッダ/ボタンの文字コントラストを明示し、preview は送信不可', () => {
    render(<TipForm params={{ ...JPYC_PARAMS, theme: 'night' }} preview />);
    const header = screen.getByText('OpenPay Tip').closest('header')!;
    const submit = Array.from(document.querySelectorAll('button')).find((el) =>
      el.className.includes('text-base'),
    ) as HTMLButtonElement;
    expect(header.style.color).toBe('rgb(248, 250, 252)');
    expect(submit.disabled).toBe(true);
    expect(submit.style.color).not.toBe('');
  });

  it('night は明細/ウォレット節にもテーマ地色が波及する (白パッチワーク解消・P2)', () => {
    render(<TipForm params={{ ...JPYC_PARAMS, theme: 'night' }} />);
    const breakdown = screen.getByText('明細').parentElement!;
    expect(breakdown.style.backgroundColor).toBe('rgb(15, 23, 42)');
    const wallet = screen.getByText('ウォレット').parentElement!;
    expect(wallet.style.backgroundColor).toBe('rgb(15, 23, 42)');
  });
});

// 明細行は dt/dd ペア (label + value) 構造。同じ金額が preset ボタンにも出るので、
// dt の親 div にスコープして dd の中身を検証する。
function expectBreakdownRow(label: string | RegExp, value: string) {
  // 明細行の dt は <dl> の直下。ヒント段落 (<p>) と区別するため selector で絞る。
  const dts = Array.from(document.querySelectorAll('dl dt')) as HTMLElement[];
  const dt = dts.find((el) =>
    typeof label === 'string'
      ? el.textContent === label
      : label.test(el.textContent ?? ''),
  );
  if (!dt) throw new Error(`Breakdown row not found: ${label}`);
  const row = dt.parentElement!;
  expect(within(row).getByText(value)).toBeInTheDocument();
}

describe('TipForm — 金額選択 (sponsorship gas=0 で計算)', () => {
  beforeEach(() => {
    setGasQuote('ready', 0n); // gas 表示を 0 にして基本計算を確認
  });

  it('既定で最初の preset が選択され、明細に反映 (JPYC 100)', () => {
    render(<TipForm params={JPYC_PARAMS} />);
    // 100 JPYC preset, fee=0 (手数料撤廃→fee 行は描画されない), creator=100, gas=0, fan pays 100
    expectBreakdownRow('クリエイター受取', '100 JPYC');
    expectBreakdownRow('あなたの支払額', '100 JPYC');
  });

  it('別 preset をクリック → 明細が切替', async () => {
    const user = userEvent.setup();
    render(<TipForm params={JPYC_PARAMS} />);
    await user.click(screen.getByRole('button', { name: '1000 JPYC' }));
    // 1000 JPYC preset, fee=0 → creator=1000, fan pays 1000
    expectBreakdownRow('クリエイター受取', '1000 JPYC');
    expectBreakdownRow('あなたの支払額', '1000 JPYC');
  });

  it('カスタム入力 → preset が deselect され、明細に反映 (USDC 50)', async () => {
    const user = userEvent.setup();
    render(<TipForm params={USDC_PARAMS} />);
    const customInput = screen.getByPlaceholderText('例: 7.50');
    await user.type(customInput, '50');
    // 50 USDC, fee=0 → creator=50, fan pays 50
    expectBreakdownRow('クリエイター受取', '50 USDC');
    expectBreakdownRow('あなたの支払額', '50 USDC');
  });

  it('カスタム入力後に preset へ戻すと反映', async () => {
    const user = userEvent.setup();
    render(<TipForm params={USDC_PARAMS} />);
    await user.type(screen.getByPlaceholderText('例: 7.50'), '50');
    await user.click(screen.getByRole('button', { name: '5 USDC' }));
    // 5 USDC preset, fee=0 → creator=5, fan pays 5
    expectBreakdownRow('クリエイター受取', '5 USDC');
    expectBreakdownRow('あなたの支払額', '5 USDC');
  });
});

describe('TipForm — 接続状態', () => {
  it('未接続: 送信ボタンは押せて、ウォレット選択へスクロール誘導する', () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    render(<TipForm params={USDC_PARAMS} />);
    const btn = screen.getByRole('button', {
      name: /ウォレットを接続/,
    });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    expect(scrollSpy).toHaveBeenCalled();
  });

  it('違うチェーン → 切替ボタン表示 / 送信は disabled', () => {
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(0n);
    render(<TipForm params={USDC_PARAMS} />);
    expect(
      screen.getByRole('button', { name: /へ切り替え/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: /ネットワークを切替え/,
      }),
    ).toBeDisabled();
  });

  it('正しいチェーン + Smart Account ready + 残高あり → 送信ボタン活性', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n); // 20 USDC
    setSmartAccount(true);
    setGasQuote('ready', 0n);
    render(<TipForm params={USDC_PARAMS} />);
    // 既定 preset 1 USDC, gas=0 → fan pays 1 USDC
    expect(
      screen.getByRole('button', { name: /1 USDC を送る/ }),
    ).not.toBeDisabled();
  });

  it('A-1: CCTP の中断記録があれば、子 (CrossChainHint) の走査報告まで初回の描画から直接送信を閉じる', async () => {
    window.localStorage.clear();
    // 同じ宛先 (Base Sepolia)・受取人・account への CCTP 記録 (送金元・金額は問わない)。
    saveResumeState({ account: FAN, kind: 'cctp-v2', sourceChainId: polygonAmoy.id, destChainId: baseSepolia.id,
      recipient: CREATOR, valueAtomic: 1_000_000n, feeAtomic: 0n }, { burnTxHash: `0x${'bc'.repeat(32)}` });
    crossChainHintReports.onMount = false;
    try {
      setAccount({ connected: true, chainId: baseSepolia.id });
      setBalance(20_000_000n);
      setSmartAccount(true);
      setGasQuote('ready', 0n);
      crossChainHintSpy.mockClear();
      render(<TipForm params={USDC_PARAMS} />);
      // 初回の描画から、子が報告するまで直接送信は閉じている (子のロード前も後も)。
      expect(screen.queryByRole('button', { name: /1 USDC を送る/ })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /送信中/ })).toBeDisabled();
      await waitFor(() => expect(crossChainHintSpy).toHaveBeenCalled());
      expect(screen.getByRole('button', { name: /送信中/ })).toBeDisabled();
      const { onExecutingChange } = crossChainHintSpy.mock.calls.at(-1)![0] as { onExecutingChange: (v: boolean) => void };
      // 子が committed を報告 → 閉じたまま。この請求の記録ではなかったと報告 (false) → 開く。
      act(() => onExecutingChange(true));
      expect(screen.getByRole('button', { name: /送信中/ })).toBeDisabled();
      act(() => onExecutingChange(false));
      expect(screen.getByRole('button', { name: /1 USDC を送る/ })).not.toBeDisabled();
    } finally {
      crossChainHintReports.onMount = true;
      window.localStorage.clear();
    }
  });

  it('relay intent の sessionStorage 読込中は非 relay 表示でも新規送信を封鎖する', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 0n);
    setRelay('idle', { isRestoring: true });

    render(<TipForm params={USDC_PARAMS} />);

    expect(
      screen.getByRole('button', { name: /送信中/ }),
    ).toBeDisabled();
    expect(relayMutate).not.toHaveBeenCalled();
  });

  it('残高不足 → 警告 + 送信 disabled', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(500_000n); // 0.5 USDC < 1 needed
    setSmartAccount(true);
    setGasQuote('ready', 0n);
    render(<TipForm params={USDC_PARAMS} />);
    expect(screen.getByText(/残高が不足/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /1 USDC を送る/ }),
    ).toBeDisabled();
  });

  it('残高不足 (USDC) → onramp link が SBI VC トレード で正しい security 属性', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(500_000n);
    setSmartAccount(true);
    setGasQuote('ready', 0n);
    render(<TipForm params={USDC_PARAMS} />);
    const onramp = screen.getByRole('link', {
      name: /SBI VC トレード で USDC を購入/,
    });
    expect(onramp).toHaveAttribute('href', 'https://www.sbivc.co.jp/');
    expect(onramp).toHaveAttribute('target', '_blank');
    expect(onramp).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('残高不足 (JPYC) → onramp link が JPYC EX (token prop の wiring 確認)', () => {
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(0n);
    setSmartAccount(true);
    setGasQuote('ready', 0n);
    render(<TipForm params={JPYC_PARAMS} />);
    expect(screen.getByText(/残高が不足/)).toBeInTheDocument();
    const onramp = screen.getByRole('link', {
      name: /JPYC EX で JPYC を購入/,
    });
    expect(onramp).toHaveAttribute('href', 'https://jpyc.co.jp/');
  });

  it('決済の準備中 → 「初期化中…」', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(false);
    render(<TipForm params={USDC_PARAMS} />);
    expect(
      screen.getByRole('button', { name: /決済の準備中/ }),
    ).toBeDisabled();
  });
});

describe('TipForm — 送信', () => {
  it('クリックで mutate に正しい引数が渡る (preset 5 USDC, sponsorship gas=0)', async () => {
    const user = userEvent.setup();
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 0n);
    render(<TipForm params={USDC_PARAMS} />);

    await user.click(screen.getByRole('button', { name: '5 USDC' }));
    await user.click(screen.getByRole('button', { name: /5 USDC を送る/ }));

    expect(mutate).toHaveBeenCalledOnce();
    const call = mutate.mock.calls[0][0];
    expect(call.merchant.toLowerCase()).toBe(CREATOR.toLowerCase());
    // creator = preset = 5 (fee=0)、gas 0
    expect(call.merchantAmount).toBe(5_000_000n);
    expect(call.feeAmount).toBe(0n);
    expect(call.feeReceiver.toLowerCase()).toBe(
      '0xdead000000000000000000000000000000001234',
    );
    expect(call.tokenAddress.toLowerCase()).toBe(
      '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
    );
  });

  it('カスタム金額で mutate', async () => {
    const user = userEvent.setup();
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 0n);
    render(<TipForm params={USDC_PARAMS} />);

    await user.type(screen.getByPlaceholderText('例: 7.50'), '50');
    await user.click(screen.getByRole('button', { name: /50 USDC を送る/ }));

    const call = mutate.mock.calls[0][0];
    // creator = 50 (fee=0)
    expect(call.merchantAmount).toBe(50_000_000n);
    expect(call.feeAmount).toBe(0n);
  });

  it('送信中 → 「送信中…」 disabled', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setBatchPayment('pending');
    render(<TipForm params={USDC_PARAMS} />);
    expect(screen.getByRole('button', { name: /送信中/ })).toBeDisabled();
  });

  it('成功 → tx hash と block 表示', async () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setBatchPayment('success');
    render(<TipForm params={USDC_PARAMS} />);
    // SuccessOverlay (PayPay 風) + 既存 inline panel が両方 DOM に存在
    expect(
      (await screen.findAllByText(/チップを送信しました|決済完了/)).length,
    ).toBeGreaterThan(0);
    expect(
      (await screen.findAllByText(`0x${'a'.repeat(64)}`)).length,
    ).toBeGreaterThan(0);
    expect(
      (await screen.findAllByText(`0x${'b'.repeat(64)}`)).length,
    ).toBeGreaterThan(0);
    expect((await screen.findAllByText('99')).length).toBeGreaterThan(0);
  });

  it('gasless 送信成功後: 送信ボタンが disabled・再クリックで mutate が再呼出されない (二重支払い防止)', async () => {
    const user = userEvent.setup();
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 0n);
    setBatchPayment('success'); // data.success === true
    render(<TipForm params={USDC_PARAMS} />);

    // 成功後も送信ボタンは DOM に残るが settledNoRetry で disabled (既定 preset = 1 USDC)。
    const sendBtn = screen.getByRole('button', { name: /1 USDC を送る/ });
    expect(sendBtn).toBeDisabled();
    // 再クリックしても useBatchPayment.mutate は発火しない (2 件目の送金を阻止)。
    await user.click(sendBtn);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('失敗 → エラー表示', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setBatchPayment('error');
    render(<TipForm params={USDC_PARAMS} />);
    expect(screen.getByText(/エラー/)).toBeInTheDocument();
    expect(screen.getByText(/AA21 fail/)).toBeInTheDocument();
  });

  // 第 10 回レビュー PR-39c: Circle の経路 (USDC ガスレス) の error は、message (日本語の固定文) をそのまま出さず、
  // error の場面の符号 (circleCode) から locale の文 (messages の CircleErrors) を出す。
  describe('Circle の経路の error の案内 (CircleErrors)', () => {
    function renderWithGaslessError(error: Error, locale: 'ja' | 'en' = 'ja') {
      setAccount({ connected: true, chainId: baseSepolia.id });
      setBalance(20_000_000n);
      setSmartAccount(true);
      setBatchPayment('error', error);
      render(<TipForm params={USDC_PARAMS} />, { locale });
    }

    it.each(CIRCLE_ERROR_CASES)('符号 %s → その場面の文 (CircleErrors.%s) を出し、message は出さない', (code, key) => {
      renderWithGaslessError(codedError(code));
      expect(screen.getByText(CIRCLE_ERRORS_JA[key])).toBeInTheDocument();
      expect(screen.queryByText(new RegExp(RAW_ERROR_MESSAGE))).toBeNull();
    });

    it.each(CIRCLE_ERROR_CASES)('英語の画面・符号 %s: message が日本語でも、英語の文を出す', (code, key) => {
      renderWithGaslessError(codedError(code, CIRCLE_ERRORS_JA[key]), 'en');
      expect(screen.getByText(CIRCLE_ERRORS_EN[key])).toBeInTheDocument();
      expect(screen.queryByText(CIRCLE_ERRORS_JA[key])).toBeNull();
    });

    it('知らない符号・符号の無い error は、今までどおり message をそのまま出す', () => {
      renderWithGaslessError(codedError('something_else'));
      expect(screen.getByText(new RegExp(RAW_ERROR_MESSAGE))).toBeInTheDocument();
    });
  });

  it('GasCongestedError → 生メッセージではなく混雑の案内 (第 9 回レビュー A-5: 送信の中の fee の見積もりが止めた場合も同じ error が届く)', async () => {
    const { GasCongestedError } = await import('@/lib/gasCeiling');
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setBatchPayment('error', new GasCongestedError(baseSepolia.id, 1n, 5n));
    render(<TipForm params={USDC_PARAMS} />);
    expect(screen.getByText(/ネットワークが混雑しています/)).toBeInTheDocument();
    expect(screen.queryByText(/gas_congested/)).toBeNull();
  });

  it('Pimlico response-unknown → 再送封鎖・通常エラー抑止・同じ UserOp の receipt だけ再照会', async () => {
    const user = userEvent.setup();
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 0n);
    setBatchPayment('unknown');
    render(<TipForm params={USDC_PARAMS} />);

    expect(
      await screen.findByText(/送信済みかを判定できません/),
    ).toBeInTheDocument();
    expect(screen.getByText(`0x${'e'.repeat(64)}`)).toBeInTheDocument();
    expect(screen.queryByText('receipt RPC unavailable')).toBeNull();
    expect(screen.queryByText('エラー')).toBeNull();

    const payButton = screen.getByRole('button', { name: /送信中/ });
    expect(payButton).toBeDisabled();
    await user.click(payButton);
    expect(mutate).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole('button', { name: /同じ送信内容を再確認/ }),
    );
    expect(batchRetryReceipt).toHaveBeenCalledOnce();
    expect(mutate).not.toHaveBeenCalled();
  });

  // 確認中の支払いを送り直す前に端末へ保存できない (isUnknown と pendingStoreUnavailable が同時)。「保存できません」の
  // 欄は通常送信を案内せず、「送り直せません」と伝える。題・確認中の欄・再確認はそのまま。
  describe('確認中の支払いを送り直す前に保存できない (gaslessResendBlocked)', () => {
    const TITLE = 'この端末では記録を保存できません';
    const STANDARD_BODY =
      'この端末では支払い記録を保存できないため、ガスレス送信を止めています。ブラウザの設定 (サイトのデータの保存) を確かめるか、別のブラウザでお試しください。';
    const RESEND_BODY =
      'この端末では支払い記録を保存できないため、確認中の支払いを送り直せません。着金通知・受注画面でご確認ください。';

    function renderGasless(state: 'unknown' | 'idle', pendingStoreUnavailable: boolean) {
      setAccount({ connected: true, chainId: baseSepolia.id });
      setBalance(20_000_000n);
      setSmartAccount(true);
      setGasQuote('ready', 0n);
      setBatchPayment(state, undefined, { pendingStoreUnavailable });
      render(<TipForm params={USDC_PARAMS} />);
    }

    it('確認中 + 保存できない → 本文は「送り直せません」。通常送信を案内しない', async () => {
      const user = userEvent.setup();
      renderGasless('unknown', true);

      expect(await screen.findByText(RESEND_BODY)).toBeInTheDocument();
      expect(screen.getByText(TITLE)).toBeInTheDocument();
      expect(screen.queryByText(STANDARD_BODY)).not.toBeInTheDocument();
      expect(screen.queryByText(/ガスレス送信を止めています/)).not.toBeInTheDocument();
      // 確認中の欄と再確認のボタンはそのまま。
      expect(screen.getByText(/送信済みかを判定できません/)).toBeInTheDocument();
      expect(screen.getByText(`0x${'e'.repeat(64)}`)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /同じ送信内容を再確認/ }));
      expect(batchRetryReceipt).toHaveBeenCalledOnce();
      expect(mutate).not.toHaveBeenCalled();
    });

    it('保存できないだけ → 今までどおり通常送信を案内する', async () => {
      renderGasless('idle', true);

      expect(await screen.findByText(STANDARD_BODY)).toBeInTheDocument();
      expect(screen.getByText(TITLE)).toBeInTheDocument();
      expect(screen.queryByText(RESEND_BODY)).not.toBeInTheDocument();
      expect(screen.queryByText(/送信済みかを判定できません/)).not.toBeInTheDocument();
    });

    it('確認中だけ → 「保存できません」の欄は出ない', async () => {
      renderGasless('unknown', false);

      expect(await screen.findByText(/送信済みかを判定できません/)).toBeInTheDocument();
      expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
      expect(screen.queryByText(RESEND_BODY)).not.toBeInTheDocument();
      expect(screen.queryByText(STANDARD_BODY)).not.toBeInTheDocument();
    });
  });
});

// 第 10 回レビュー A-1: 確定した Pimlico の支払いが、この画面から最後に送った支払いと別の intent (reload の後に
// 「同じ送信内容を再確認」で確定した等・useBatchPayment の settledOtherIntent) なら、今のチップとして扱わない
// (控え・お礼・完了の overlay を出さない)。reload で復元した relay の成功と同じ扱い。
describe('TipForm — 別の intent の確定 (gasless)', () => {
  // 第 10 回レビュー A-1 (Codex 第 2 回 MUST 2): 確定した intent 自体の受取先・金額 (recoveredIntent) があれば、それだけで
  // 支払い者の控えを残す (今のチップの名前・メッセージ・お礼は付けない・/pay /checkout と同じ規則)。
  it('確定した intent の受取先・金額 (recoveredIntent) があれば、それだけで控えを残す。名前・メッセージ・お礼・overlay は出さず、題は「この画面の支払いではありません」(受取先が違う)', async () => {
    window.localStorage.clear();
    const thanks = '今のページだけのお礼';
    const intentA = {
      tokenAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const,
      merchant: '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1' as const,
      merchantAmount: 3_000_000n,
      feeReceiver: '0xfee0fee0fee0fee0fee0fee0fee0fee0fee0fee0' as const,
      feeAmount: 0n,
    };
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setBatchPayment('success', undefined, {
      settledOtherIntent: true,
      recoveredIntent: intentA,
      variables: intentA,
    });
    render(
      <TipForm params={{ ...USDC_PARAMS, thanks, name: 'Creator B', message: 'message B' }} />,
    );

    // 確定した intent の受取先 (0xa1a1…) は、この画面の受取先と違う = この画面のチップでない (第 10 回レビュー H-S)。
    expect(await screen.findByText('前に確認中だった支払いが完了しました。この画面の支払いではありません。')).toBeInTheDocument();
    expect(screen.queryByText('チップを送信しました')).toBeNull();
    expect(screen.getAllByText(`0x${'b'.repeat(64)}`).length).toBeGreaterThan(0);
    await waitFor(() => expect(loadPayerReceipts()).toHaveLength(1));
    const [receipt] = loadPayerReceipts();
    expect(receipt.merchantAddress).toBe(intentA.merchant);
    expect(receipt.amount).toBe('3');
    expect(receipt.merchantName).toBeUndefined();
    expect((receipt.lineItems ?? []).map((item) => item.memo)).not.toContain('message B');
    await expect(screen.findByRole('dialog', {}, { timeout: 300 })).rejects.toThrow();
    expect(screen.queryByText(thanks)).toBeNull();
  });

  it.each([
    { settledOtherIntent: false, attributed: true },
    { settledOtherIntent: true, attributed: false },
  ])(
    '確定した intent が画面の最後の送信と別 ($settledOtherIntent) なら、控え・お礼・完了の overlay を出さない',
    async ({ settledOtherIntent, attributed }) => {
      window.localStorage.clear();
      const thanks = '今のページだけのお礼';
      setAccount({ connected: true, chainId: baseSepolia.id });
      setBalance(20_000_000n);
      setSmartAccount(true);
      setBatchPayment('success', undefined, { settledOtherIntent });
      render(<TipForm params={{ ...USDC_PARAMS, thanks }} />);

      // 完了の欄 (hash) はどちらも出る。
      expect(await screen.findByText('チップを送信しました')).toBeInTheDocument();
      expect(screen.getAllByText(`0x${'b'.repeat(64)}`).length).toBeGreaterThan(0);
      if (attributed) {
        expect(await screen.findByText(thanks)).toBeInTheDocument();
        expect(await screen.findByRole('dialog')).toBeInTheDocument();
        expect(loadPayerReceipts()).toHaveLength(1);
      } else {
        // overlay は遅延ロードなので、出ない側も待ってから確かめる。
        await expect(screen.findByRole('dialog', {}, { timeout: 300 })).rejects.toThrow();
        expect(screen.queryByText(thanks)).toBeNull();
        expect(loadPayerReceipts()).toEqual([]);
      }
    },
  );
});

describe('TipForm — thanks / 第三者 webhook 退役 (B2 + R1)', () => {
  it('成功 + thanks あり → メッセージ表示', async () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setBatchPayment('success');
    render(
      <TipForm
        params={{
          ...USDC_PARAMS,
          thanks: 'ありがとう！Discord 招待リンクをどうぞ',
        }}
      />,
    );
    expect(
      await screen.findByText('ありがとう！Discord 招待リンクをどうぞ'),
    ).toBeInTheDocument();
  });

  it('成功 → 顧客向け電子レシート (支払い控え) を /tip で保存', async () => {
    window.localStorage.clear();
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(20_000_000_000_000_000_000_000n);
    setSmartAccount(true);
    setBatchPayment('success');
    render(<TipForm params={JPYC_PARAMS} />);
    const receipts = loadPayerReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0].direction).toBe('paid');
    expect(receipts[0].sourceRoute).toBe('/tip');
    expect(receipts[0].merchantAddress).toBe(CREATOR);
    expect(receipts[0].merchantName).toBe('山田太郎');
    expect(receipts[0].receiptId).toBe(`0x${'b'.repeat(64)}`);
    // 完了画面に控え詳細 (PayerReceiptDetail) + /scan 導線が描画される
    // (TipForm 成功 effect → appendPayerReceipt → PayerReceiptCompletion 全鎖)。
    // PayerReceiptCompletion は next/dynamic で遅延ロードのため findByText で待つ。
    expect(await screen.findByText('OpenPay 電子レシート')).toBeInTheDocument();
    expect(screen.getByText(/\/scan で支払い履歴/).closest('a')).toHaveAttribute(
      'href',
      '/scan',
    );
  });

  it('成功 + thanksUrl あり → リンクボタン表示', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setBatchPayment('success');
    render(
      <TipForm
        params={{
          ...USDC_PARAMS,
          thanksUrl: 'https://discord.gg/abc',
        }}
      />,
    );
    const link = screen.getByRole('link', { name: /リンクを開く/ });
    expect(link).toHaveAttribute('href', 'https://discord.gg/abc');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer noopener');
  });

  it('第三者 webhook は退役 (R1): 旧リンク由来の webhook が params に残っていても外部 URL へ fetch しない', async () => {
    // parseTipParams は `webhook=` を読まない (tests/lib/url.test.ts) が、型の外から値が紛れても
    // 成功時に外部 POST が復活しないことを TipForm 側でも固定する。
    window.localStorage.clear();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));

    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setBatchPayment('success');
    const legacyParams = {
      ...USDC_PARAMS,
      webhook: 'https://discord.com/api/webhooks/1/legacy',
    } as TipParams;
    render(<TipForm params={legacyParams} />);

    // 成功処理 (ログ・控え) は従来どおり走る。
    await waitFor(() =>
      expect(loggerInfo).toHaveBeenCalledWith('tip.success', expect.anything()),
    );
    expect(loadPayerReceipts()).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(
      loggerWarn.mock.calls.filter(([event]) => String(event).startsWith('tip.webhook')),
    ).toEqual([]);
    fetchSpy.mockRestore();
  });

  it('[regression] 同一 userOpHash で再 render が起きても成功処理 (tip.success・控え) は 1 回 (gasQuote refetch 耐性)', async () => {
    window.localStorage.clear();
    const successLogs = () =>
      loggerInfo.mock.calls.filter(([event]) => event === 'tip.success');

    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setBatchPayment('success');
    // 初回 gasAmount = 100_000n
    setGasQuote('ready', 100_000n);
    const { rerender } = render(<TipForm params={USDC_PARAMS} />);
    await waitFor(() => expect(successLogs()).toHaveLength(1));

    // gasQuote refetchInterval (30s) で gasAmount が変わったケースをシミュレート
    setGasQuote('ready', 200_000n);
    rerender(<TipForm params={USDC_PARAMS} />);
    setGasQuote('ready', 300_000n);
    rerender(<TipForm params={USDC_PARAMS} />);

    // 同一 userOpHash の間は成功処理を再実行しない
    expect(successLogs()).toHaveLength(1);
    expect(loadPayerReceipts()).toHaveLength(1);
  });

  it('isSwitching=true 時に「チェーン切替中…」表示でボタン disabled', () => {
    setAccount({ connected: true, chainId: polygonAmoy.id }); // wrong chain (USDC params)
    setBalance(0n);
    setSmartAccount(false);
    mockHook(useSwitchChain, { switchChain: vi.fn(), isPending: true });
    render(<TipForm params={USDC_PARAMS} />);
    expect(
      screen.getByRole('button', { name: /チェーン切替中…/ }),
    ).toBeDisabled();
  });

  it('成功 → fetch は呼ばれない (第三者への通知は無い)', () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));

    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setBatchPayment('success');
    render(<TipForm params={USDC_PARAMS} />);

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('TipForm — ERC20 Paymaster mode (USDC mainnet)', () => {
  beforeEach(() => {
    vi.mocked(resolvePaymasterMode).mockImplementation((dep) =>
      dep.symbol === 'usdc' ? 'erc20' : 'sponsorship',
    );
  });

  it('gas 見積取得前 → ボタン無効、明細の gas 行が「見積取得中…」', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('pending');
    render(<TipForm params={USDC_PARAMS} />);
    expect(
      screen.getByRole('button', { name: /ガス代見積取得中/ }),
    ).toBeDisabled();
    // 「見積取得中…」はボタン文言とも被るので、gas 行の dt にスコープして確認
    expectBreakdownRow(/ネットワーク手数料/, '見積取得中…');
  });

  it('gas 見積あり: 明細に gas 行 + customer に加算 (preset 1 USDC)', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 300_000n); // 0.3 USDC
    render(<TipForm params={USDC_PARAMS} />);

    // preset 1 USDC, fee=0 (fee 行は描画されない), creator=1, gas=0.3, customer = 1.3 (= preset + gas)
    expectBreakdownRow('クリエイター受取', '1 USDC');
    expectBreakdownRow(/ネットワーク手数料/, '最大 0.3 USDC');
    expectBreakdownRow('あなたの支払額', '1.3 USDC');
  });

  it('gas 込みで残高不足: 警告 + ボタン disabled', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    // 1.2 USDC: preset 1 + gas 0.3 = 1.3 > 1.2
    setBalance(1_200_000n);
    setSmartAccount(true);
    setGasQuote('ready', 300_000n);
    render(<TipForm params={USDC_PARAMS} />);
    expect(screen.getByText(/残高が不足/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /1\.3 USDC を送る/ }),
    ).toBeDisabled();
  });

  it('USDC 用の gaslessHint が表示される', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready');
    render(<TipForm params={USDC_PARAMS} />);
    expect(
      screen.getByText(/最大表示。実費はこれ以下に収まります/),
    ).toBeInTheDocument();
  });

  it('JPYC sponsorship mode でも gas 行が表示される', () => {
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(2000n * 10n ** 18n);
    setSmartAccount(true);
    setGasQuote('ready', 5n * 10n ** 17n); // 0.5 JPYC
    render(<TipForm params={JPYC_PARAMS} />);
    expect(
      Array.from(document.querySelectorAll('dl dt')).some((el) =>
        /ネットワーク手数料/.test(el.textContent ?? ''),
      ),
    ).toBe(true);
  });

  it('USDC ERC20 mode + 接続済 → 「ガス代承認の状況を確認」リンクが表示される', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setGasQuote('ready');
    render(<TipForm params={USDC_PARAMS} />);
    const link = screen.getByRole('link', { name: /ガス代承認の状況を確認/ });
    // testnet env では Base Sepolia の explorer (sepolia.basescan.org) を使う
    expect(link).toHaveAttribute(
      'href',
      `https://sepolia.basescan.org/tokenapprovalchecker?search=${FAN}`,
    );
  });

  it('JPYC sponsorship mode では approval リンクは表示されない', () => {
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(2000n * 10n ** 18n);
    setSmartAccount(true);
    render(<TipForm params={JPYC_PARAMS} />);
    expect(screen.queryByText(/ガス代承認の状況を確認/)).toBeNull();
  });

  it('USDC ERC20 mode の mutate には gas を含めない (paymaster が顧客から直接徴収)', async () => {
    const user = userEvent.setup();
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 300_000n);
    render(<TipForm params={USDC_PARAMS} />);

    await user.click(screen.getByRole('button', { name: '5 USDC' }));
    await user.click(
      screen.getByRole('button', { name: /5\.3 USDC を送る/ }),
    );

    const call = mutate.mock.calls[0][0];
    // creator = 5 (fee=0)、ERC20 なので feeAmount に gas 含めない
    expect(call.merchantAmount).toBe(5_000_000n);
    expect(call.feeAmount).toBe(0n);
    expect(call.extraRecipients).toBeUndefined();
  });

  it('gasQuote.error → エラー表示 + ボタン disabled', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('error');
    render(<TipForm params={USDC_PARAMS} />);
    expect(screen.getByText(/エラー/)).toBeInTheDocument();
    expect(screen.queryByText(/quote failed/)).toBeNull();
    expect(
      screen.getByText(/ガス代見積の取得に失敗しました/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /ガス代見積取得中/ }),
    ).toBeDisabled();
  });

  it('境界: 残高 = 必要額 ちょうど → 送信可能', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    // customer = preset + gas = 1 + 0.3 = 1.3
    setBalance(1_300_000n);
    setSmartAccount(true);
    setGasQuote('ready', 300_000n);
    render(<TipForm params={USDC_PARAMS} />);
    expect(screen.queryByText(/残高が不足/)).toBeNull();
    expect(
      screen.getByRole('button', { name: /1\.3 USDC を送る/ }),
    ).not.toBeDisabled();
  });

  it('境界: 残高 = 必要額 - 1 → 不足', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(1_300_000n - 1n);
    setSmartAccount(true);
    setGasQuote('ready', 300_000n);
    render(<TipForm params={USDC_PARAMS} />);
    expect(screen.getByText(/残高が不足/)).toBeInTheDocument();
  });
});

describe('TipForm — CrossChainHint props 統合 (USDC cross-chain wiring)', () => {
  beforeEach(() => {
    crossChainHintSpy.mockClear();
  });

  // 注: 本 describe では CrossChainHint を spy stub で置換、props 渡しのみ verify。
  // 実 mount + balance fetch + SourceChooser render の統合確認は
  // tests/components/TipForm-crosschain.integration.test.tsx (LARP L3 fix) で実施。
  it('USDC + 接続済 → CrossChainHint module が render 呼出され正しい props を受け取る', async () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);
    render(<TipForm params={USDC_PARAMS} />);

    await waitFor(() => expect(crossChainHintSpy).toHaveBeenCalled());
    const props = crossChainHintSpy.mock.calls[0]![0] as {
      token: string;
      enabled: boolean;
      targetChainId: number;
      recipient: Address;
      requiredAtomic: bigint;
      displayDecimals: number;
      tokenAddress: Address;
    };
    expect(props.token).toBe('usdc');
    // crossChain 未指定 → default true (parseTipParams で true 解釈)
    expect(props.enabled).toBe(true);
    expect(props.targetChainId).toBe(baseSepolia.id);
    expect(props.recipient).toBe(CREATOR);
    // requiredAtomic = amountWei = 決済額のみ (preset[0]=1 USDC = 1_000_000 atomic)。
    // cross-chain は決済額を bridge する想定で、gas/fee は requiredAtomic に含めない。
    expect(props.requiredAtomic).toBe(1_000_000n);
    expect(props.displayDecimals).toBe(6);
  });

  it('JPYC + 接続済 → CrossChainHint module は呼出されない (USDC 専用機能 = token guard)', async () => {
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);
    render(<TipForm params={JPYC_PARAMS} />);

    // 描画完了を待つため preset ボタンの存在で待機 (fee=0 で「100 JPYC」が明細にも出て
    // getByText が複数 match するため、preset ボタンに限定して待つ)。
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: '100 JPYC' }),
      ).toBeInTheDocument();
    });
    expect(crossChainHintSpy).not.toHaveBeenCalled();
  });

  it('USDC + 未接続 → CrossChainHint module は呼出されない (address gate)', async () => {
    setAccount({ connected: false });
    render(<TipForm params={USDC_PARAMS} />);
    // 接続ボタン表示で render 完了を確認 (未接続時の不変表示)
    await waitFor(() => {
      expect(
        screen.getByText(/ウォレットを接続/),
      ).toBeInTheDocument();
    });
    expect(crossChainHintSpy).not.toHaveBeenCalled();
  });

  it('USDC + crossChain=false → enabled prop が false', async () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);
    render(<TipForm params={{ ...USDC_PARAMS, crossChain: false }} />);

    await waitFor(() => expect(crossChainHintSpy).toHaveBeenCalled());
    const props = crossChainHintSpy.mock.calls[0]![0] as { enabled: boolean };
    expect(props.enabled).toBe(false);
  });

  it.each(['pending', 'success'] as const)(
    '親の通常決済が %s の間は cross-chain execute を無効化',
    async (state) => {
      setAccount({ connected: true, chainId: baseSepolia.id });
      setBalance(20_000_000n);
      setSmartAccount(true);
      setGasQuote('ready', 0n);
      setBatchPayment(state);

      render(<TipForm params={USDC_PARAMS} />);

      await waitFor(() => expect(crossChainHintSpy).toHaveBeenCalled());
      const props = crossChainHintSpy.mock.lastCall![0] as {
        executionDisabled: boolean;
      };
      expect(props.executionDisabled).toBe(true);
    },
  );

  it('cross-chain 実行中は親 Send を止める', async () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 0n);
    render(<TipForm params={USDC_PARAMS} />);

    await waitFor(() => expect(crossChainHintSpy).toHaveBeenCalled());
    const props = crossChainHintSpy.mock.lastCall![0] as {
      onAttemptStart: (amount: bigint) => void;
      onExecutingChange: (executing: boolean) => void;
    };
    const sendBtn = screen.getByRole('button', { name: /1 USDC を送る/ });
    expect(sendBtn).toBeEnabled();

    act(() => {
      props.onAttemptStart(1_000_000n);
      props.onExecutingChange(true);
    });
    expect(sendBtn).toBeDisabled();

    act(() => props.onExecutingChange(false));
    expect(sendBtn).toBeEnabled();
  });

  it('cross-chain 成功を親 overlay/控えへ1回だけ流し、開始時金額を固定する', async () => {
    window.localStorage.clear();
    const user = userEvent.setup();
    const mintTxHash = `0x${'e'.repeat(64)}` as const;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    const successLogs = () =>
      loggerInfo.mock.calls.filter(([event]) => event === 'tip.success');
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);

    render(<TipForm params={USDC_PARAMS} />);

    await waitFor(() => expect(crossChainHintSpy).toHaveBeenCalled());
    const props = crossChainHintSpy.mock.lastCall![0] as {
      onAttemptStart: (amount: bigint) => void;
      onSuccess: (result: {
        path: 'cctp-v2';
        approveTxHash: `0x${string}`;
        burnTxHash: `0x${string}`;
        mintTxHash: `0x${string}`;
        destChainId: number;
      }) => void;
    };
    act(() => {
      props.onAttemptStart(1_000_000n);
      props.onSuccess({
        path: 'cctp-v2',
        approveTxHash: '0xapprove',
        burnTxHash: '0xburn',
        mintTxHash,
        destChainId: baseSepolia.id,
      });
    });

    await waitFor(() => expect(successLogs()).toHaveLength(1));
    expect(
      screen.getAllByText(/チップを送信しました|決済完了/).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(mintTxHash).length).toBeGreaterThan(0);

    // 成功後に preset を変えて effect deps が再評価されても、成功処理/控えは再発火せず
    // onAttemptStart 時点の 1 USDC が維持される。
    await user.click(screen.getByRole('button', { name: '5 USDC' }));
    await waitFor(() => {
      expect(successLogs()).toHaveLength(1);
      expect(loadPayerReceipts()).toHaveLength(1);
    });
    expect(successLogs()[0][1]).toMatchObject({ amount: '1', txHash: mintTxHash });
    expect(loadPayerReceipts()[0]?.amount).toBe('1');
    // 第三者 webhook (R1) は退役: 外部への通知は無い。
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('preset 切替で requiredAtomic prop が再計算される', async () => {
    const user = userEvent.setup();
    setAccount({ connected: true, chainId: baseSepolia.id });
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);
    render(<TipForm params={USDC_PARAMS} />);

    // 初期 preset[0] = 1 USDC → requiredAtomic = amountWei = 1.0 USDC (1_000_000 atomic)
    await waitFor(() => expect(crossChainHintSpy).toHaveBeenCalled());
    const initial = crossChainHintSpy.mock.lastCall![0] as {
      requiredAtomic: bigint;
    };
    expect(initial.requiredAtomic).toBe(1_000_000n);

    // preset[1] = 5 USDC をクリック → requiredAtomic = 5.0 USDC (5_000_000 atomic)
    // requiredAtomic は決済額のみ (gas/fee は含まない)
    await user.click(screen.getByRole('button', { name: '5 USDC' }));
    await waitFor(() => {
      const latest = crossChainHintSpy.mock.lastCall![0] as {
        requiredAtomic: bigint;
      };
      expect(latest.requiredAtomic).toBe(5_000_000n);
    });
  });

  it('custom amount 入力 → requiredAtomic prop が入力値で再計算される', async () => {
    const user = userEvent.setup();
    setAccount({ connected: true, chainId: baseSepolia.id });
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);
    render(<TipForm params={USDC_PARAMS} />);

    await waitFor(() => expect(crossChainHintSpy).toHaveBeenCalled());

    // custom amount は onChange で setSelectedPreset(null) → 自動で custom mode に
    // 切替。"例: 7.50" placeholder の input に 10 を入力。
    const input = screen.getByPlaceholderText('例: 7.50');
    await user.type(input, '10');
    await waitFor(() => {
      const latest = crossChainHintSpy.mock.lastCall![0] as {
        requiredAtomic: bigint;
      };
      // requiredAtomic = amountWei = 10 USDC = 10_000_000 atomic (gas/fee は含まない)
      expect(latest.requiredAtomic).toBe(10_000_000n);
    });
  });

  it('カスタム選択 + 未入力 → requiredAtomic = 0 (amountWei のみ・gas は含まない)', async () => {
    const user = userEvent.setup();
    setAccount({ connected: true, chainId: baseSepolia.id });
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);
    render(<TipForm params={USDC_PARAMS} />);

    await waitFor(() => expect(crossChainHintSpy).toHaveBeenCalled());
    // input focus で selectCustom が selectedPreset=null に切替、amountWei=0n になる
    const input = screen.getByPlaceholderText('例: 7.50');
    await user.click(input);

    await waitFor(() => {
      const latest = crossChainHintSpy.mock.lastCall![0] as {
        requiredAtomic: bigint;
      };
      // requiredAtomic = amountWei = 0 (未入力)。gas は requiredAtomic に含めない仕様。
      expect(latest.requiredAtomic).toBe(0n);
    });
  });

  it('USDC + Arbitrum chain → targetChainId が arbitrumSepolia (testnet env)', async () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);
    render(
      <TipForm params={{ ...USDC_PARAMS, chain: 'arbitrum' }} />,
    );

    await waitFor(() => expect(crossChainHintSpy).toHaveBeenCalled());
    const props = crossChainHintSpy.mock.lastCall![0] as {
      targetChainId: number;
      tokenAddress: Address;
    };
    // testnet env なので arbitrum slug は arbitrumSepolia chain に解決される。
    // magic number を避けるため viem chain const から id を引く。
    expect(props.targetChainId).toBe(arbitrumSepolia.id);
    // tokenAddress は arbitrum USDC のもの (per-chain deployment)
    expect(props.tokenAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it('複数 props 変動を 1 render で観測 (preset 切替 + crossChain default)', async () => {
    const user = userEvent.setup();
    setAccount({ connected: true, chainId: baseSepolia.id });
    setSmartAccount(true);
    setGasQuote('ready', 50_000n);
    render(<TipForm params={USDC_PARAMS} />);

    await waitFor(() => expect(crossChainHintSpy).toHaveBeenCalled());
    // 全 call の中で enabled は常に true (crossChain 未指定 → default true)
    const allCalls = crossChainHintSpy.mock.calls.map(
      (c) => c[0] as { enabled: boolean; targetChainId: number },
    );
    expect(allCalls.every((p) => p.enabled === true)).toBe(true);
    expect(allCalls.every((p) => p.targetChainId === baseSepolia.id)).toBe(true);

    // preset 切替後も same chain
    await user.click(screen.getByRole('button', { name: '10 USDC' }));
    await waitFor(() => {
      const latest = crossChainHintSpy.mock.lastCall![0] as {
        targetChainId: number;
        enabled: boolean;
      };
      expect(latest.enabled).toBe(true);
      expect(latest.targetChainId).toBe(baseSepolia.id);
    });
  });
});

// JPYC EIP-3009 relay 経路 (/tip): resolveJpycGaslessProvider が 'eip3009-relay' を返すとき、
// useBatchPayment (Pimlico) ではなく useJpycEip3009Payment へ。tip は gasless/customer 固定。
describe('TipForm — EIP-3009 relay (JPYC)', () => {
  beforeEach(() => {
    vi.mocked(resolveJpycGaslessProvider).mockReturnValue('eip3009-relay');
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(1000n * 10n ** 18n); // 1000 JPYC (十分)
  });

  it('送信で relay.mutate({merchant,value,gasMode:customer}) を呼び、Pimlico mutate は呼ばない', async () => {
    const user = userEvent.setup();
    render(<TipForm params={JPYC_PARAMS} />);
    // preset 100 が初期選択 → free relay は gas 0 で 100 JPYC を送る
    await user.click(screen.getByRole('button', { name: /100 JPYC を送る/ }));
    expect(relayMutate).toHaveBeenCalledOnce();
    expect(relayMutate).toHaveBeenCalledWith({
      merchant: CREATOR,
      value: 100n * 10n ** 18n,
      gasMode: 'customer',
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it('flag ON + relay のときだけ composer を表示し、preview でも表示する', () => {
    setTipMessageFlag(true);
    const rendered = render(<TipForm params={JPYC_PARAMS} preview />);

    const composer = screen.getByRole('textbox', {
      name: '応援メッセージ (任意)',
    });
    expect(composer).toHaveAttribute('maxlength', '300');
    // placeholder は記入例 (ラベル/プライバシー行との三重復唱を解消・2026-08-02)。
    expect(composer).toHaveAttribute('placeholder', '例: いつも応援しています！');
    expect(
      screen.getByText(
        '公開されません。受取ウォレットでサインインした画面にのみ表示されます。',
      ),
    ).toBeInTheDocument();

    rendered.unmount();
    setTipMessageFlag(false);
    render(<TipForm params={JPYC_PARAMS} />);
    expect(
      screen.queryByRole('textbox', {
        name: '応援メッセージ (任意)',
      }),
    ).toBeNull();
  });

  it('flag ON でも非 relay JPYC / USDC 経路には composer を表示しない', () => {
    setTipMessageFlag(true);
    vi.mocked(resolveJpycGaslessProvider).mockReturnValue('pimlico-7702');
    const rendered = render(<TipForm params={JPYC_PARAMS} />);
    expect(
      screen.queryByRole('textbox', {
        name: '応援メッセージ (任意)',
      }),
    ).toBeNull();

    rendered.rerender(<TipForm params={USDC_PARAMS} />);
    expect(
      screen.queryByRole('textbox', {
        name: '応援メッセージ (任意)',
      }),
    ).toBeNull();
  });

  it('1 JPYC 未満では composer を無効化して最低額を案内する', () => {
    setTipMessageFlag(true);
    render(
      <TipForm
        params={{ ...JPYC_PARAMS, presets: ['0.5'] }}
      />,
    );

    expect(
      screen.getByRole('textbox', {
        name: '応援メッセージ (任意)',
      }),
    ).toBeDisabled();
    expect(
      screen.getByText('1 JPYC 以上のチップに応援メッセージを添えられます'),
    ).toBeInTheDocument();
  });

  it('privateTipMessage は snapshot として relay だけへ渡し、logger/控え/URL へ混入しない (外部通知も無い)', async () => {
    setTipMessageFlag(true);
    window.localStorage.clear();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));
    const privateMessage = 'private-only-recipient-質問';
    const publicCreatorMessage = '公開クリエイターメッセージ';
    const params = {
      ...JPYC_PARAMS,
      message: publicCreatorMessage,
    };
    const user = userEvent.setup();
    const rendered = render(<TipForm params={params} />);

    await user.type(
      screen.getByRole('textbox', {
        name: '応援メッセージ (任意)',
      }),
      privateMessage,
    );
    await user.click(
      screen.getByRole('button', { name: /100 JPYC を送る/ }),
    );
    expect(relayMutate).toHaveBeenCalledWith({
      merchant: CREATOR,
      value: 100n * 10n ** 18n,
      gasMode: 'customer',
      tipMessage: privateMessage,
    });

    setRelay('success', {
      variables: {
        merchant: CREATOR,
        value: 100n * 10n ** 18n,
        gasMode: 'customer',
        tipMessage: privateMessage,
      },
    });
    rendered.rerender(<TipForm params={params} />);
    await waitFor(() =>
      expect(loggerInfo).toHaveBeenCalledWith('tip.success', expect.anything()),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    const receipts = loadPayerReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0].memo).toBe(publicCreatorMessage);
    expect(JSON.stringify(receipts)).not.toContain(privateMessage);
    const localStorageValues = Array.from(
      { length: window.localStorage.length },
      (_, index) =>
        window.localStorage.getItem(window.localStorage.key(index) ?? '') ?? '',
    ).join('\n');
    expect(localStorageValues).not.toContain(privateMessage);
    expect(window.location.href).not.toContain(privateMessage);
    expect(
      JSON.stringify({
        debug: loggerDebug.mock.calls,
        info: loggerInfo.mock.calls,
        warn: loggerWarn.mock.calls,
        error: loggerError.mock.calls,
      }),
    ).not.toContain(privateMessage);
    fetchSpy.mockRestore();
  });

  it('relay recover (forwarder 設定) → gas 相当が customer 上乗せ (value は tip 額のまま)', async () => {
    const user = userEvent.setup();
    vi.mocked(jpycForwarderFor).mockReturnValue(
      '0x752B000000000000000000000000000000000000' as Address,
    );
    render(<TipForm params={JPYC_PARAMS} />);
    // customerPays = 100 + relayGasFee(2 JPYC) = 102 JPYC。value は tip 額 (gas は forwarder 回収)。
    await user.click(screen.getByRole('button', { name: /102 JPYC を送る/ }));
    expect(relayMutate).toHaveBeenCalledWith({
      merchant: CREATOR,
      value: 100n * 10n ** 18n,
      gasMode: 'customer',
    });
  });

  // --- F1 改 (UI 引き算 2026-08-02): recover の手数料開示は明細 (breakdown) に一本化し、
  // 送信ボタン上の重複箱 (旧 RecoverFeeNotice) は出さない。開示自体は明細の
  // ガス相当行 + 顧客負担ヒントが担う (表示の単一ソース化・金額計算は不変)。---
  it('recover (forwarder 設定): 手数料は明細に表示し、重複開示箱は出さない', () => {
    vi.mocked(jpycForwarderFor).mockReturnValue(
      '0x752B000000000000000000000000000000000000' as Address,
    );
    render(<TipForm params={JPYC_PARAMS} />);
    // 明細側の開示: ガス相当行 + チッパー負担ヒント (gaslessHintJpycRecover)。
    expect(
      screen.getByText(/チップをお送りになるお客様のご負担です/),
    ).toBeInTheDocument();
    // 旧 RecoverFeeNotice の重複箱は撤去済み。
    expect(screen.queryByText(/決済手数料:/)).toBeNull();
  });

  it('FREE モード (forwarder null): 手数料開示は出さない', () => {
    // beforeEach は forwarder を mock しない → free モード。relay 経路だが開示は非表示。
    render(<TipForm params={JPYC_PARAMS} />);
    expect(screen.queryByText(/決済手数料/)).toBeNull();
  });

  it('relay 成功 → txHash 表示 (userOpHash / block 行は無い)', () => {
    setRelay('success');
    render(<TipForm params={JPYC_PARAMS} />);
    expect(screen.getAllByText(`0x${'c'.repeat(64)}`).length).toBeGreaterThan(0);
    // relay は userOpHash / blockNumber を持たない (gasless mock の 99 は出ない)。
    expect(screen.queryByText('99')).toBeNull();
  });

  it('auto recovery→成功で同一 mount の thanks/overlay/控えを各 1 回だけ確定する', async () => {
    window.localStorage.clear();
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchSpy);
    const value = 100n * 10n ** 18n;
    const variables = { merchant: CREATOR, value, gasMode: 'customer' as const };
    const params = {
      ...JPYC_PARAMS,
      thanks: '同一 mount のお礼',
      thanksUrl: 'https://creator.example/thanks',
    };
    const successLogs = () =>
      loggerInfo.mock.calls.filter(([event]) => event === 'tip.success');
    const user = userEvent.setup();
    const rendered = render(<TipForm params={params} />);

    await user.click(screen.getByRole('button', { name: /100 JPYC を送る/ }));
    setRelay('auto', { variables });
    rendered.rerender(<TipForm params={params} />);
    expect(screen.getByText(/支払い結果を確認しています/)).toBeInTheDocument();

    setRelay('success', { variables });
    rendered.rerender(<TipForm params={params} />);
    await waitFor(() => expect(successLogs()).toHaveLength(1));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('同一 mount のお礼')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /リンクを開く/ })).toHaveAttribute(
      'href',
      'https://creator.example/thanks',
    );
    expect(screen.getAllByText(`0x${'c'.repeat(64)}`).length).toBeGreaterThan(0);
    rendered.rerender(<TipForm params={params} />);

    const txHash = `0x${'c'.repeat(64)}`;
    expect(successLogs()).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(loadPayerReceipts().filter((r) => r.receiptId === txHash)).toHaveLength(1);
  });

  it('reload 復元した別の受取先への relay 成功は「この画面の支払いではありません」と tx hash だけに留め、現在ページへ帰属させない', async () => {
    window.localStorage.clear();
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchSpy);
    const restoredCreator =
      '0x3333333333333333333333333333333333333333' as Address;
    const restoredFan =
      '0x8888888888888888888888888888888888888888' as Address;
    const currentCreator =
      '0x4444444444444444444444444444444444444444' as Address;
    const value = 250n * 10n ** 18n;
    setRelay('success', {
      variables: {
        merchant: restoredCreator,
        value,
      },
      restoredIntent: {
        chainId: polygonAmoy.id,
        from: restoredFan,
        merchant: restoredCreator,
        merchantValue: value.toString(),
        feeValue: '0',
        nonce: `0x${'4'.repeat(64)}`,
        validBefore: '9999999999',
        routeKind: 'free',
        issuedAt: 1,
      },
    });
    const currentName = '現在ページのクリエイター';
    const currentMessage = '現在ページだけの案内';
    const currentThanks = '現在ページだけのお礼';
    render(
      <TipForm
        params={{
          ...JPYC_PARAMS,
          to: currentCreator,
          name: currentName,
          message: currentMessage,
          thanks: currentThanks,
          thanksUrl: 'https://current.example/thanks',
        }}
      />,
    );

    expect(screen.getByText(`${currentName} さんへチップを送る`)).toBeInTheDocument();
    expect(screen.getByText(currentMessage)).toBeInTheDocument();
    // 復元した支払いの受取先 (0x3333…) は、この画面の受取先 (0x4444…) と違う = この画面のチップでない (第 10 回レビュー H-S)。
    const successTitle = await screen.findByText('前に確認中だった支払いが完了しました。この画面の支払いではありません。');
    expect(screen.queryByText('チップを送信しました')).toBeNull();
    const successPanel = successTitle.parentElement;
    expect(successPanel).not.toBeNull();
    expect(
      within(successPanel!).getAllByText(`0x${'c'.repeat(64)}`).length,
    ).toBeGreaterThan(0);
    expect(within(successPanel!).queryByText(currentName)).toBeNull();
    expect(within(successPanel!).queryByText(currentMessage)).toBeNull();
    expect(within(successPanel!).queryByText('250 JPYC')).toBeNull();
    expect(screen.queryByText(currentThanks)).toBeNull();
    expect(screen.queryByRole('link', { name: /リンクを開く/ })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(loadPayerReceipts()).toEqual([]);
  });

  it('reload 復元結果の表示中に creator/name/message が変わっても副作用を発火しない', async () => {
    window.localStorage.clear();
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchSpy);
    const restoredCreator =
      '0x3333333333333333333333333333333333333333' as Address;
    const changedCreator =
      '0x5555555555555555555555555555555555555555' as Address;
    const value = 250n * 10n ** 18n;
    setRelay('success', {
      variables: {
        merchant: restoredCreator,
        value,
      },
      restoredIntent: {
        chainId: polygonAmoy.id,
        from: FAN,
        merchant: restoredCreator,
        merchantValue: value.toString(),
        feeValue: '0',
        nonce: `0x${'5'.repeat(64)}`,
        validBefore: '9999999999',
        routeKind: 'free',
        issuedAt: 1,
      },
    });
    const initialParams = {
      ...JPYC_PARAMS,
      thanks: '復元時ページのお礼',
      thanksUrl: 'https://restored-page.example/thanks',
    };
    const rendered = render(<TipForm params={initialParams} />);

    // 復元した支払いの受取先 (0x3333…) は、この画面の受取先と違う = この画面のチップでない (第 10 回レビュー H-S)。
    expect(await screen.findByText('前に確認中だった支払いが完了しました。この画面の支払いではありません。')).toBeInTheDocument();
    expect(screen.queryByText('チップを送信しました')).toBeNull();
    rendered.rerender(
      <TipForm
        params={{
          ...JPYC_PARAMS,
          to: changedCreator,
          name: '変更後のクリエイター',
          message: '変更後の案内',
          thanks: '変更後のお礼',
          thanksUrl: 'https://changed.example/thanks',
        }}
      />,
    );

    expect(
      screen.getByText('変更後のクリエイター さんへチップを送る'),
    ).toBeInTheDocument();
    expect(screen.getByText('変更後の案内')).toBeInTheDocument();
    expect(screen.getByText('前に確認中だった支払いが完了しました。この画面の支払いではありません。')).toBeInTheDocument();
    expect(screen.getAllByText(`0x${'c'.repeat(64)}`).length).toBeGreaterThan(0);
    expect(screen.queryByText('復元時ページのお礼')).toBeNull();
    expect(screen.queryByText('変更後のお礼')).toBeNull();
    expect(screen.queryByRole('link', { name: /リンクを開く/ })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(loadPayerReceipts()).toEqual([]);
  });

  it('relay error → friendly な i18n メッセージ (rate_limited)', () => {
    setRelay('error');
    render(<TipForm params={JPYC_PARAMS} />);
    expect(screen.getByText(/短時間に送金が集中/)).toBeInTheDocument();
  });

  // 第 10 回レビュー H-R: 復旧の枠を書けない端末で hook が送らずに止めた (intent_storage_unavailable)。通常決済へは案内しない
  // (user 裁定 Q7-1・チップには JPYC の通常決済へ切り替える入口も無い)。赤いエラー枠に出す。
  it('relay error (intent_storage_unavailable) → 専用の文言を赤いエラー枠に出す (通常決済への切り替えは案内しない)', () => {
    setRelay('error', { errMsg: 'intent_storage_unavailable' });
    render(<TipForm params={JPYC_PARAMS} />);
    const message = screen.getByText('この端末では支払い記録を保存できないため、ガスレス送金は使えません (JPYC は動いていません)。ブラウザの設定 (サイトのデータの保存) を確かめるか、別のブラウザでお試しください。');
    expect(message.closest('.bg-red-50')).not.toBeNull();
    expect(message.textContent).not.toMatch(/通常/);
    expect(screen.queryByText('intent_storage_unavailable')).toBeNull();
    expect(screen.queryByText(/完了できませんでした/)).toBeNull();
    expect(screen.queryByRole('button', { name: /通常支払い/ })).toBeNull();
  });

  // 第 10 回レビュー H-R・user 裁定 Q7-2: 確かめをしないのは埋め込み (iframe) の中のチップだけ。TipForm が開いた window で決めて
  // hook の option で渡す (hook は window を見ない)。
  describe('埋め込み (iframe) の中かどうかを hook に渡す (H-R・Q7-2)', () => {
    const topDescriptor = Object.getOwnPropertyDescriptor(window, 'top');
    afterEach(() => {
      if (topDescriptor) Object.defineProperty(window, 'top', topDescriptor);
    });
    const lastOptions = () => vi.mocked(useJpycEip3009Payment).mock.lastCall?.[1];

    it('直接開いたページ (window.top が自分) → 確かめる', () => {
      render(<TipForm params={JPYC_PARAMS} />);
      expect(lastOptions()).toEqual({ skipIntentStorageCheck: false });
    });

    it('別のページの iframe の中 (window.top が親) → 確かめをしない', () => {
      const parentWindow = {};
      Object.defineProperty(window, 'top', { configurable: true, get: () => parentWindow });
      render(<TipForm params={JPYC_PARAMS} />);
      expect(lastOptions()).toEqual({ skipIntentStorageCheck: true });
    });

    it('cross-origin の親の参照を拒むブラウザ (window.top の参照が throw) → 画面は描け、埋め込みとして確かめをしない', () => {
      Object.defineProperty(window, 'top', {
        configurable: true,
        get: () => {
          throw new DOMException('Blocked a frame from accessing a cross-origin frame.', 'SecurityError');
        },
      });
      render(<TipForm params={JPYC_PARAMS} />);
      expect(screen.getByRole('button', { name: /100 JPYC を送る/ })).toBeInTheDocument();
      expect(lastOptions()).toEqual({ skipIntentStorageCheck: true });
    });
  });

  // 第 10 回レビュー H-R・user 裁定 Q7-2: 実物の relay hook で、枠を保存できない端末の 2 つの開き方を通す。hook と
  // lib/paymentIntentStorage は実物で、差し替えるのは wagmi の署名・fetch・Storage の書き込み・window.top (境界) だけ。
  describe('実物の relay hook: 枠を保存できない端末で、直接開いたページは止め、埋め込みの中は今までどおり送る (H-R・Q7-2)', () => {
    const realSetItem = Storage.prototype.setItem;
    const topDescriptor = Object.getOwnPropertyDescriptor(window, 'top');
    const restores: (() => void)[] = [];
    let signTypedData: ReturnType<typeof vi.fn>;
    const relayPosts = () => vi.mocked(fetch).mock.calls.filter(([url]) => url === '/api/relay/jpyc');

    beforeEach(async () => {
      const real = await vi.importActual<typeof import('@/hooks/useJpycEip3009Payment')>('@/hooks/useJpycEip3009Payment');
      vi.mocked(useJpycEip3009Payment).mockImplementation(real.useJpycEip3009Payment);
      signTypedData = vi.fn(async () => `0x${'a'.repeat(130)}`);
      mockHook(useWalletClient, { data: { signTypedData } } as never);
      mockHook(usePublicClient, { waitForTransactionReceipt: vi.fn() } as never);
      window.sessionStorage.clear();
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        new Response(JSON.stringify({ ok: true, txHash: `0x${'b'.repeat(64)}` }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }));
      // 枠のキーも、署名の前の確かめのキーも書けない端末 (サイトのデータの保存をブロック・third-party の storage を拒む iframe)。
      const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
        if (key === RELAY_INTENT_STORAGE_KEY || key === RELAY_INTENT_PROBE_KEY) {
          throw new DOMException('The operation is insecure.', 'SecurityError');
        }
        realSetItem.call(this, key, value);
      });
      restores.push(() => fetchSpy.mockRestore(), () => setItemSpy.mockRestore());
    });
    afterEach(() => {
      for (const restore of restores.splice(0)) restore();
      if (topDescriptor) Object.defineProperty(window, 'top', topDescriptor);
      window.sessionStorage.clear();
    });

    async function renderAndSend() {
      const user = userEvent.setup();
      const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
      const view = render(<QueryClientProvider client={client}><TipForm params={JPYC_PARAMS} /></QueryClientProvider>);
      // 実物の hook は storage の chunk を読み込むまで「復元中」(送るボタンの名前が変わる)。
      await waitFor(() => expect(screen.getByRole('button', { name: /100 JPYC を送る/ })).toBeEnabled());
      await user.click(screen.getByRole('button', { name: /100 JPYC を送る/ }));
      return view;
    }

    it('直接開いたページ → 署名を求めずに止め、専用の文言を赤いエラー枠に出す (POST 0 回)', async () => {
      await renderAndSend();
      const message = await screen.findByText('この端末では支払い記録を保存できないため、ガスレス送金は使えません (JPYC は動いていません)。ブラウザの設定 (サイトのデータの保存) を確かめるか、別のブラウザでお試しください。');
      expect(message.closest('.bg-red-50')).not.toBeNull();
      expect(signTypedData).not.toHaveBeenCalled();
      expect(relayPosts()).toHaveLength(0);
      expect(loggerInfo).toHaveBeenCalledWith('payment.intent_storage_unavailable', expect.objectContaining({ stage: 'probe' }));
    });

    it('埋め込み (iframe) の中 → 確かめをせず、今までどおり署名 1 回・POST 1 回で送る', async () => {
      const parentWindow = {};
      Object.defineProperty(window, 'top', { configurable: true, get: () => parentWindow });
      await renderAndSend();
      await waitFor(() => expect(relayPosts()).toHaveLength(1));
      expect(signTypedData).toHaveBeenCalledTimes(1);
      expect(loggerInfo).not.toHaveBeenCalledWith('payment.intent_storage_unavailable', expect.anything());
      expect(screen.queryByText(/この端末では支払い記録を保存できないため/)).toBeNull();
      // 枠は書けていない (今までどおり・受容台帳)。
      expect(window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY)).toBeNull();
    });
  });

  // 2026-10-13 本番: ウォレットで署名を拒否しただけで tip.relay.failed が Sentry に上がり、画面にも
  // 「ガスレス送金を完了できませんでした」が出ていた。取り消しは失敗ではない。
  it('relay で署名を拒否 → 失敗表示も Sentry 送信もせず、送信前の画面に戻る', () => {
    setRelay('error', { errMsg: 'User rejected the request.\n\nDetails: User rejected the request.\nVersion: viem@2.56.3' });
    render(<TipForm params={JPYC_PARAMS} />);
    expect(screen.queryByText(/完了できませんでした/)).toBeNull();
    expect(screen.queryByText(/User rejected/)).toBeNull();
    expect(screen.getByRole('button', { name: /100 JPYC を送る/ })).toBeEnabled();
    expect(loggerError).not.toHaveBeenCalledWith('tip.relay.failed', expect.anything());
  });

  it('relay の拒否以外の失敗は従来どおり tip.relay.failed を記録する', () => {
    setRelay('error', { errMsg: 'boom' });
    render(<TipForm params={JPYC_PARAMS} />);
    expect(screen.getByText(/完了できませんでした/)).toBeInTheDocument();
    expect(loggerError).toHaveBeenCalledWith('tip.relay.failed', { error: expect.any(Error) });
  });

  it('relay は smart account 不要 — saData 無しでも送信ボタンが活性', () => {
    setSmartAccount(false);
    render(<TipForm params={JPYC_PARAMS} />);
    expect(
      screen.getByRole('button', { name: /100 JPYC を送る/ }),
    ).toBeEnabled();
  });

  it('relay pending → pendingTitle パネルが表示され Explorer リンクが /tx/ href を持つ', () => {
    setRelay('pendingResult');
    render(<TipForm params={JPYC_PARAMS} />);
    expect(screen.getByText(/送信済み・確認待ち/)).toBeInTheDocument();
    const explorerLink = screen.getByRole('link', { name: /Explorer で確認/ });
    expect(explorerLink).toHaveAttribute('href', expect.stringContaining(`/tx/0x${'d'.repeat(64)}`));
  });

  it('relay pending → 送信ボタンは disabled かつ「送信中」表示', () => {
    setRelay('pendingResult');
    render(<TipForm params={JPYC_PARAMS} />);
    const btn = screen.getByRole('button', { name: /送信中/ });
    expect(btn).toBeDisabled();
  });

  it('relay pending → successTitle も errorTitle も描画されない', () => {
    setRelay('pendingResult');
    render(<TipForm params={JPYC_PARAMS} />);
    expect(screen.queryByText('チップを送信しました')).toBeNull();
    expect(screen.queryByText('エラー')).toBeNull();
  });

  it('relay pending (txHash 無し) → パネル本体は出るが txHash 行が無い', () => {
    relayMutate = vi.fn();
    mockHook(useJpycEip3009Payment, {
      mutate: relayMutate,
      isPending: false,
      data: { txHash: null, success: false, pending: true },
      error: null,
    } as Partial<ReturnType<typeof useJpycEip3009Payment>>);
    render(<TipForm params={JPYC_PARAMS} />);
    expect(screen.getByText(/送信済み・確認待ち/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Explorer で確認/ })).toBeNull();
  });

  it('response-unknown → Pay 封鎖・中間表示・通常エラー非表示', async () => {
    const user = userEvent.setup();
    setRelay('response-unknown');
    render(<TipForm params={JPYC_PARAMS} />);

    expect(screen.getByText(/送信済みかを判定できません/)).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: /同じ送信内容を再確認/ }),
    );
    expect(relayRetrySamePayload).toHaveBeenCalledOnce();
    const payButton = screen.getByRole('button', { name: /送信中/ });
    expect(payButton).toBeDisabled();
    await user.click(payButton);
    expect(relayMutate).not.toHaveBeenCalled();
    expect(screen.queryByText('エラー')).toBeNull();
  });

  it('ip_rate_limited → Pay 封鎖・同一 payload 再試行のみ・通常エラー非表示', async () => {
    const user = userEvent.setup();
    setRelay('ip-rate-limited');
    render(<TipForm params={JPYC_PARAMS} />);

    expect(
      screen.getByText(/45秒ほど待ってから、同じ内容でもう一度/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /100 JPYC を送る/ }),
    ).toBeDisabled();

    await user.click(
      screen.getByRole('button', { name: /同じ内容で再試行/ }),
    );
    expect(relayRetryRelay).toHaveBeenCalledOnce();
    expect(relayMutate).not.toHaveBeenCalled();
    expect(screen.queryByText('エラー')).toBeNull();
  });
});

// USDC Circle Paymaster 経路 (/tip): resolveUsdcGaslessProvider が 'circle' を返すとき、
// useBatchPayment(Pimlico) ではなく circle 経路 (permitAmount を mutate へ) に乗る。
// /pay・/checkout と統一。flag OFF (既定 'pimlico') は従来 Pimlico erc20 で不変。
describe('TipForm — USDC Circle Paymaster', () => {
  beforeEach(() => {
    vi.mocked(resolvePaymasterMode).mockReturnValue('erc20'); // USDC = erc20 paymaster
    vi.mocked(resolveUsdcGaslessProvider).mockReturnValue('circle');
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n); // 200 USDC
    setSmartAccount(true);
    setCircleQuote('ready', { gasAmount: 0n, permitAmount: 5_000_000n });
  });

  it('送信で gasless.mutate に circlePermitAmount を渡す (relay は呼ばない)', async () => {
    const user = userEvent.setup();
    render(<TipForm params={USDC_PARAMS} />);
    // preset 1 USDC が初期選択 → gas=0 なので 1 USDC を送る
    await user.click(screen.getByRole('button', { name: /1 USDC を送る/ }));
    expect(mutate).toHaveBeenCalledOnce();
    expect(mutate.mock.calls[0][0].circlePermitAmount).toBe(5_000_000n);
    expect(relayMutate).not.toHaveBeenCalled();
  });

  it('circleQuote 未解決 (permitAmount 未算定) は送信不可 (見積取得中)', () => {
    setCircleQuote('idle');
    render(<TipForm params={USDC_PARAMS} />);
    // 内訳の (?) ボタンも「ネットワーク手数料見積 の詳細」の名前を持つ (全レビュー第 8 回 D-2) ので、送信ボタンの文言で引く。
    expect(screen.getByRole('button', { name: /見積取得中/ })).toBeDisabled();
  });

  it('flag OFF (pimlico) では circlePermitAmount を渡さない (従来 erc20 経路)', async () => {
    const user = userEvent.setup();
    vi.mocked(resolveUsdcGaslessProvider).mockReturnValue('pimlico');
    setGasQuote('ready', 0n); // Pimlico quote
    render(<TipForm params={USDC_PARAMS} />);
    await user.click(screen.getByRole('button', { name: /1 USDC を送る/ }));
    expect(mutate.mock.calls[0][0].circlePermitAmount).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ReceiveMethodPicker × 実 TipForm — @handle 公開ページの受取方法切替。
// TipForm は preset/金額 state を mount 時の params から初期化するため、picker は
// `key={token:chain}` で再マウントして金額を隔離する (Codex R2: JPYC 500 のまま
// USDC 500 として送られる誤金額の防止)。ここではスタブでなく**実 TipForm** で
// 「切替後に前方法の金額が持ち越されない」ことを実証する。
// ─────────────────────────────────────────────────────────────────────────────
describe('ReceiveMethodPicker × 実 TipForm — 切替で金額がリセットされる', () => {
  beforeEach(() => {
    setGasQuote('ready', 0n);
  });

  const HANDLE_CONFIG: HandleTipConfig = {
    to: CREATOR,
    name: '山田太郎',
    methods: [
      { token: 'jpyc', chain: 'polygon' },
      { token: 'usdc', chain: 'base', crossChain: true },
    ],
    presets: { jpyc: ['100', '500', '1000'], usdc: ['1', '5', '10'] },
  };

  it('JPYC で 500 を選択 → USDC へ切替 → USDC 既定 preset (1) に戻る', async () => {
    const user = userEvent.setup();
    render(<ReceiveMethodPicker config={HANDLE_CONFIG} />);
    // アコーディオン化により初期は全折りたたみ → まず JPYC の方法ボタンで展開する
    await user.click(screen.getByRole('button', { name: 'JPYC · Polygon' }));
    await user.click(screen.getByRole('button', { name: '500 JPYC' }));
    expectBreakdownRow('クリエイター受取', '500 JPYC');
    // USDC へ切替 → 再マウントで USDC の最初の preset (1 USDC) が選択される。
    // 500 が USDC として持ち越されないことが本題。
    await user.click(screen.getByRole('button', { name: 'USDC · cross-chain' }));
    expectBreakdownRow('クリエイター受取', '1 USDC');
    expect(screen.queryByText('500 USDC')).not.toBeInTheDocument();
    // JPYC へ戻しても 500 ではなく JPYC の最初の preset (100) から
    await user.click(screen.getByRole('button', { name: 'JPYC · Polygon' }));
    expectBreakdownRow('クリエイター受取', '100 JPYC');
  });

  it('カスタム入力も方法切替で持ち越されない', async () => {
    const user = userEvent.setup();
    render(<ReceiveMethodPicker config={HANDLE_CONFIG} />);
    // アコーディオン化により初期は全折りたたみ → まず JPYC の方法ボタンで展開する
    await user.click(screen.getByRole('button', { name: 'JPYC · Polygon' }));
    await user.type(screen.getByPlaceholderText('例: 2500'), '7777');
    expectBreakdownRow('クリエイター受取', '7777 JPYC');
    await user.click(screen.getByRole('button', { name: 'USDC · cross-chain' }));
    expectBreakdownRow('クリエイター受取', '1 USDC');
    // USDC 側のカスタム入力欄は空 (JPYC の 7777 が残らない)
    expect(screen.getByPlaceholderText('例: 7.50')).toHaveValue('');
  });
});

// 「署名安心 UX」P2: relay free でフルパネル・Circle で usdc-permit (tip は standard 経路なし)。
describe('TipForm — 署名安心パネル (SignReassurance・P2)', () => {
  it('relay free + JPYC: jpyc-relay-free フルパネル (preview は amountWei と同一ソース)', () => {
    vi.mocked(resolveJpycGaslessProvider).mockReturnValue('eip3009-relay');
    vi.mocked(jpycForwarderFor).mockReturnValue(null); // free
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(10_000n * 10n ** 18n);
    render(<TipForm params={JPYC_PARAMS} />);

    // フルパネルの見出し + バッジ。preset[0]=100 JPYC が初期選択。
    expect(
      screen.getByText(/求められるのは「署名」1回だけ/),
    ).toBeInTheDocument();
    expect(screen.getByText(/動かせるのは 100 JPYC ちょうど/)).toBeInTheDocument();
    // 照合表に署名する生の数字 (100 * 10^18) が出る。
    expect(screen.getByText('100000000000000000000')).toBeInTheDocument();
  });

  it('relay recover (forwarder 設定): jpyc-relay-recover フルパネル (P4・合計 = チップ + 手数料)', () => {
    // P4: recover でも安心パネルを出す。tip は gas=customer 固定なのでウォレットは
    // チップ + 手数料 (100 + 2 = 102 JPYC) を出す。その内訳を照合表が説明する。
    vi.mocked(resolveJpycGaslessProvider).mockReturnValue('eip3009-relay');
    vi.mocked(jpycForwarderFor).mockReturnValue(
      '0x1111111111111111111111111111111111111111',
    );
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(10_000n * 10n ** 18n);
    render(<TipForm params={JPYC_PARAMS} />);
    // 見出しは free と共通。preset[0]=100 JPYC・fee=2 JPYC (relayGasFeeValue mock) → 合計 102。
    expect(
      screen.getByText(/求められるのは「署名」1回だけ/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /動かせるのは 102 JPYC ちょうど（お支払い 100 \+ 手数料 2）/,
      ),
    ).toBeInTheDocument();
    // 照合表に署名する生の数字 (signedTotal = 102 * 10^18) が出る。
    expect(screen.getByText('102000000000000000000')).toBeInTheDocument();
  });

  it('Circle (USDC gasless): usdc-permit パネル + permitCap (上限) を formatUnits で表示', () => {
    vi.mocked(resolvePaymasterMode).mockReturnValue('erc20');
    vi.mocked(resolveUsdcGaslessProvider).mockReturnValue('circle');
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    // permitAmount=1.5 USDC (= 1_500_000 atomic・6 桁)。preset[0]=1 USDC。
    setCircleQuote('ready', { gasAmount: 0n, permitAmount: 1_500_000n });
    render(<TipForm params={USDC_PARAMS} />);

    expect(
      screen.getByText(/利用許可 \(Spending cap\).+署名/),
    ).toBeInTheDocument();
    expect(screen.getByText(/上限 1\.5 USDC まで/)).toBeInTheDocument();
    expect(
      screen.getByText(/この許可はこの決済 \(1 USDC\) にのみ使われます/),
    ).toBeInTheDocument();
    // 有界 permit のため「Approve は求めません」は書かない (誠実性)。
    expect(screen.queryByText(/Approve \(利用許可\) は求めません/)).toBeNull();
  });

  it('USDC Pimlico erc20 (非 circle): どのパネルも出さない (スコープ外)', () => {
    vi.mocked(resolvePaymasterMode).mockReturnValue('erc20');
    // resolveUsdcGaslessProvider 既定 'pimlico'。
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 0n);
    render(<TipForm params={USDC_PARAMS} />);
    expect(screen.queryByText(/利用許可 \(Spending cap\)/)).toBeNull();
    expect(screen.queryByText(/求められるのは「署名」1回だけ/)).toBeNull();
  });
});

describe('TipForm — F7 off-origin callback 開示', () => {
  it('第三者 host の thanksUrl → 開示ノートに host を表示 (退役した webhook の host は出さない)', () => {
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(200_000_000_000_000_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 0n);
    render(
      <TipForm
        params={{
          ...JPYC_PARAMS,
          webhook: 'https://shop.example.com/hook',
          thanksUrl: 'https://discord.gg/xyz',
        } as TipParams}
      />,
    );
    const note = screen.getByText(/へのリンクが表示されます/);
    expect(note).toBeInTheDocument();
    expect(note.textContent).not.toContain('shop.example.com');
    expect(note.textContent).toContain('discord.gg');
  });

  it('callback が無ければ開示ノートは出さない', () => {
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(200_000_000_000_000_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 0n);
    render(<TipForm params={JPYC_PARAMS} />);
    expect(screen.queryByText(/へのリンクが表示されます/)).toBeNull();
  });

  it('退役した webhook だけが第三者 host でも開示ノートは出さない (送らないので開示対象外)', () => {
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(200_000_000_000_000_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 0n);
    render(
      <TipForm
        params={{ ...JPYC_PARAMS, webhook: 'https://shop.example.com/hook' } as TipParams}
      />,
    );
    expect(screen.queryByText(/へのリンクが表示されます/)).toBeNull();
  });
});

// Real useStandardPayment + persisted intent; only wallet/RPC boundaries are mocked.
describe('Arc standard tip attribution', () => {
  const tx = `0x${'e'.repeat(64)}` as const;
  const arcParams: TipParams = { ...USDC_PARAMS, mode: 'standard', chain: 'arc', presets: ['0.5', '1'], thanks: 'Arc thanks' };
  let walletWrite: ReturnType<typeof vi.fn>;
  let receiptRetry: ReturnType<typeof vi.fn>;
  let writeState: { data: typeof tx | undefined; error: Error | null; isPending: boolean };
  // 実際の viem receipt の形 (送った tx の receipt は transactionHash = 送信 hash)。
  let receiptState: { data: { status: 'success' | 'reverted'; blockNumber: bigint; transactionHash: typeof tx; from: string; logs: [] } | undefined; error: Error | null; isSuccess: boolean; isError: boolean };

  beforeEach(async () => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    setAccount({ connected: true, chainId: 5042002 });
    setBalance(10000000n);
    setGasQuote('error'); // Standard must ignore quote and SA gates.
    walletWrite = vi.fn((_request, callbacks) => callbacks?.onSuccess(tx));
    receiptRetry = vi.fn();
    writeState = { data: undefined, error: null, isPending: false };
    receiptState = { data: undefined, error: null, isSuccess: false, isError: false };
    // 既定: receipt query error 時の生 receipt も取れない (RPC 障害)。revert を確かめる test だけ上書き。
    mockHook(usePublicClient, { getTransactionReceipt: vi.fn().mockRejectedValue(new Error('rpc down')) } as never);
    const wagmi = await import('wagmi');
    vi.mocked(wagmi.useWriteContract).mockImplementation(() => ({ ...writeState, writeContract: walletWrite, reset: vi.fn() }) as never);
    vi.mocked(wagmi.useWaitForTransactionReceipt).mockImplementation(({ query, hash } = {}) => ({
      ...(query?.enabled && hash ? receiptState : { data: undefined, error: null, isSuccess: false, isError: false }),
      refetch: receiptRetry,
    }) as never);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  });

  function seed(chainId = 84532) {
    window.sessionStorage.setItem('openpay:standard-intent:v1', JSON.stringify({
      version: 1, chainId, from: FAN, tokenAddress: '0x3600000000000000000000000000000000000000',
      merchant: CREATOR, merchantValue: '500000', feeReceiver: env.feeReceiver, feeValue: '0',
      stage: 'merchant', merchantTxHash: tx, issuedAt: Date.now(),
    }));
  }
  async function submit() {
    const button = await screen.findByRole('button', { name: /0.5 USDC.*送る/ });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
  }
  // 成功処理 (控え・ログ) の発火回数。第三者 webhook (R1) の退役前はその POST 回数で数えていた。
  const successLogs = () => loggerInfo.mock.calls.filter(([event]) => event === 'tip.success');

  describe.each([
    { locale: 'ja' as const, send: '0.5 USDC を送る', checking: '送信結果を確認中', sending: '送信中…' },
    { locale: 'en' as const, send: 'Send 0.5 USDC', checking: 'Checking submission status', sending: 'Sending…' },
  ])('F8 review: $locale Arc button wording', ({ locale, send, checking, sending }) => {
    it.each(['auto', 'response-unknown'] as const)('describes %s relay recovery without claiming an Arc submission', async (state) => {
      const view = render(<TipForm params={arcParams} />, { locale });
      await waitFor(() => expect(screen.getByRole('button', { name: send })).toBeEnabled());
      setRelay(state, { hasActiveIntent: true });
      view.rerender(<TipForm params={arcParams} />);

      const button = screen.getByRole('button', { name: checking });
      expect(button).toBeDisabled();
      expect(screen.queryByRole('button', { name: sending })).not.toBeInTheDocument();
      fireEvent.click(button);
      expect(walletWrite).not.toHaveBeenCalled();
      expect(relayMutate).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['storage restoring', 'idle', { isRestoring: true }],
    ['active intent', 'idle', { hasActiveIntent: true }],
    ['auto recovery', 'auto', { hasActiveIntent: true }],
    ['unknown response', 'response-unknown', {}],
    ['broadcast pending', 'pendingResult', { hasActiveIntent: true }],
  ] as const)('F8: %s blocks Arc direct and cross-chain payments', async (_name, state, options) => {
    const view = render(<TipForm params={arcParams} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /0.5 USDC.*送る/ })).toBeEnabled());
    setRelay(state, options);
    view.rerender(<TipForm params={arcParams} />);

    expect(crossChainHintSpy.mock.lastCall?.[0].executionDisabled).toBe(true);
    const send = screen.getByRole('button', { name: /送る|送信中|送信結果を確認中/ });
    expect(send).toBeDisabled();
    fireEvent.click(send);
    expect(walletWrite).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    expect(relayMutate).not.toHaveBeenCalled();
    if (state === 'auto' || state === 'response-unknown') {
      expect(await screen.findByText('送信結果を確認中', { selector: 'p' })).toBeInTheDocument();
    }
  });

  it.each(['settled', 'reverted', 'expired-unused'] as const)('F8: existing relay recovery releases Arc after %s without attributing the old tip', async (outcome) => {
    const view = render(<TipForm params={arcParams} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /0.5 USDC.*送る/ })).toBeEnabled());
    setRelay('response-unknown', { hasActiveIntent: true });
    view.rerender(<TipForm params={arcParams} />);
    expect(crossChainHintSpy.mock.lastCall?.[0].executionDisabled).toBe(true);
    expect(screen.getByRole('button', { name: '送信結果を確認中' })).toBeDisabled();
    fireEvent.click(await screen.findByRole('button', { name: /再確認/ }));
    expect(relayRetrySamePayload).toHaveBeenCalledOnce();
    expect(relayMutate).not.toHaveBeenCalled();

    // These are the existing hook's terminal states: settled clears the active
    // intent while retaining its result; expired + confirmed unused clears both.
    setRelay(outcome === 'settled' ? 'success' : outcome === 'reverted' ? 'reverted' : 'idle');
    view.rerender(<TipForm params={arcParams} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /0.5 USDC.*送る/ })).toBeEnabled());
    expect(crossChainHintSpy.mock.lastCall?.[0].executionDisabled).toBe(false);
    expect(screen.queryByText('送信結果を確認中')).not.toBeInTheDocument();
    expect(successLogs()).toHaveLength(0);
    expect(loadPayerReceipts()).toHaveLength(0);
    expect(walletWrite).not.toHaveBeenCalled();
    await submit();
    expect(walletWrite).toHaveBeenCalledOnce();
  });

  it.each(['settled', 'expired-unused'] as const)('F8: real same-tab relay recovery unlocks Arc after %s', async (outcome) => {
    const realRelay = await vi.importActual<typeof import('@/hooks/useJpycEip3009Payment')>('@/hooks/useJpycEip3009Payment');
    vi.mocked(useJpycEip3009Payment).mockImplementation(realRelay.useJpycEip3009Payment);
    const signTypedData = vi.fn();
    mockHook(useWalletClient, { data: { signTypedData } } as never);
    mockHook(usePublicClient, { waitForTransactionReceipt: vi.fn() } as never);
    vi.mocked(waitForStoredRelayReceipt).mockResolvedValue({ status: 'success' } as never);
    window.sessionStorage.setItem(RELAY_INTENT_STORAGE_KEY, JSON.stringify({
      version: 1, chainId: polygonAmoy.id, from: FAN, merchant: CREATOR,
      merchantValue: '100000000000000000000', feeValue: '0',
      nonce: `0x${'7'.repeat(64)}`, routeKind: 'free', issuedAt: Date.now(),
      validBefore: String(Math.floor(Date.now() / 1000) + 10),
    }));
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ ok: true, state: 'indeterminate' })));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.useFakeTimers();
    const view = render(<QueryClientProvider client={queryClient}><TipForm params={arcParams} /></QueryClientProvider>);
    try {
      // Start the recovery clock only after lazy storage/engine/recovery imports
      // settle, so an isolated run has the same deadline as a warm full suite.
      await act(async () => { await vi.dynamicImportSettled(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(90_001); });
      expect(screen.getByText('送信結果を確認中', { selector: 'p' })).toBeInTheDocument();
      expect(crossChainHintSpy.mock.lastCall?.[0].executionDisabled).toBe(true);
      expect(screen.getByRole('button', { name: '送信結果を確認中' })).toBeDisabled();
      expect(window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY)).not.toBeNull();

      vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify(
        // 期限切れはチェーンの finalized による証明 (expiry: 'expired') だけが解除する (第 7 回レビュー A6・#767)。
        outcome === 'settled' ? { ok: true, state: 'settled', txHash: tx } : { ok: true, state: 'unused', expiry: 'expired' },
      )));
      fireEvent.click(screen.getByRole('button', { name: /同じ送信内容を再確認/ }));
      await act(async () => { await vi.advanceTimersByTimeAsync(9_001); });
      expect(window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY)).toBeNull();
      expect(screen.queryByText('送信結果を確認中')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /0.5 USDC.*送る/ })).toBeEnabled();
      expect(crossChainHintSpy.mock.lastCall?.[0].executionDisabled).toBe(false);
      if (outcome === 'settled') {
        expect(waitForStoredRelayReceipt).toHaveBeenCalledWith(polygonAmoy.id, tx, expect.any(Number));
      }
      expect(signTypedData).not.toHaveBeenCalled();
      expect(walletWrite).not.toHaveBeenCalled();
      expect(successLogs()).toHaveLength(0);
      expect(loadPayerReceipts()).toHaveLength(0);
      expect(vi.mocked(fetch).mock.calls.every(([url]) => url === '/api/relay/jpyc/status')).toBe(true);
    } finally {
      view.unmount();
      queryClient.clear();
      vi.useRealTimers();
    }
  });

  it('success sends the principal once, records standard receipt and notifies exactly once with snapshotted payer', async () => {
    const view = render(<TipForm params={arcParams} />);
    expect(screen.getByText('ウォレットで支払い')).toBeInTheDocument();
    await submit();
    expect(walletWrite).toHaveBeenCalledTimes(1);
    expect(walletWrite.mock.calls[0][0]).toMatchObject({ chainId: 5042002, functionName: 'transfer', args: [CREATOR, 500000n] });
    expect(useSmartAccount).toHaveBeenLastCalledWith(expect.anything(), false);
    expect(useBatchPayment).toHaveBeenLastCalledWith(expect.anything(), false);
    mockHook(useAccount, { address: '0x8888888888888888888888888888888888888888', isConnected: true, chainId: 5042002 });
    receiptState = { data: { status: 'success', blockNumber: 123n, transactionHash: tx, from: FAN, logs: [] }, error: null, isSuccess: true, isError: false };
    view.rerender(<TipForm params={arcParams} />);
    await screen.findByText('Arc thanks');
    expect(successLogs()).toHaveLength(1);
    expect(successLogs()[0][1]).toMatchObject({ mode: 'standard', amount: '0.5', txHash: tx });
    // 同一 origin の決済ログ (/api/log/payment) だけ。外部 URL への通知 (退役した webhook) は無い。
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url)).filter((url) => !url.startsWith('/'))).toEqual([]);
    const receipts = loadPayerReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ paymentMode: 'standard', payerAddress: FAN, amount: '0.5' });
    expect(receipts[0]).not.toHaveProperty('networkFeeEquivalent');
    view.rerender(<TipForm params={arcParams} />);
    expect(successLogs()).toHaveLength(1);
  });

  it.each(['reject', 'revert'] as const)('%s produces no success side effects and permits retry', async (kind) => {
    if (kind === 'reject') walletWrite.mockImplementation(() => {});
    const view = render(<TipForm params={arcParams} />);
    await submit();
    if (kind === 'reject') writeState.error = new Error('User rejected request');
    else {
      // 実際の wagmi は reverted receipt を data で返さず throw する。useStandardPayment は生の
      // receipt で reverted を確かめてから確定失敗にする (第 7 回レビュー A4)。
      mockHook(usePublicClient, { getTransactionReceipt: vi.fn().mockResolvedValue({ status: 'reverted', blockNumber: 123n, transactionHash: tx }) } as never);
      receiptState = { data: undefined, error: new Error('execution reverted'), isSuccess: false, isError: true };
    }
    view.rerender(<TipForm params={arcParams} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /0.5 USDC.*送る/ })).toBeEnabled());
    expect(successLogs()).toHaveLength(0);
    expect(loadPayerReceipts()).toHaveLength(0);
    expect(screen.queryByText('Arc thanks')).not.toBeInTheDocument();
  });

  it('unknown latches transfer, retries receipt only and recovers once', async () => {
    const view = render(<TipForm params={arcParams} />);
    await submit();
    receiptState.error = new Error('RPC timeout');
    receiptState.isError = true;
    view.rerender(<TipForm params={arcParams} />);
    const retry = await screen.findByRole('button', { name: /再確認/ });
    fireEvent.click(retry);
    expect(receiptRetry).toHaveBeenCalledTimes(1);
    expect(walletWrite).toHaveBeenCalledTimes(1);
    receiptState = { data: { status: 'success', blockNumber: 123n, transactionHash: tx, from: FAN, logs: [] }, error: null, isSuccess: true, isError: false };
    view.rerender(<TipForm params={arcParams} />);
    await screen.findByText('Arc thanks');
    expect(successLogs()).toHaveLength(1);
    expect(loadPayerReceipts()).toHaveLength(1);
    expect(walletWrite).toHaveBeenCalledTimes(1);
  });

  it.each([84532, 5042002])('restored chain %s is never a tip, including identical tuples; only a new mutate owns a changed amount', async (chainId) => {
    seed(chainId);
    const view = render(<TipForm params={arcParams} />);
    const previous = await screen.findByText('以前の送信の確認');
    expect(previous).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Explorer で確認/ }).getAttribute('href')).toContain(chainId === 84532 ? 'sepolia.basescan.org' : 'explorer.testnet.arc.io');
    receiptState = { data: { status: 'success', blockNumber: 123n, transactionHash: tx, from: FAN, logs: [] }, error: null, isSuccess: true, isError: false };
    view.rerender(<TipForm params={arcParams} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /0.5 USDC.*送る/ })).toBeEnabled());
    expect(successLogs()).toHaveLength(0);
    expect(loadPayerReceipts()).toHaveLength(0);
    expect(screen.queryByText('Arc thanks')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '1 USDC' }));
    receiptState = { data: undefined, error: null, isSuccess: false, isError: false };
    fireEvent.click(screen.getByRole('button', { name: /1 USDC.*送る/ }));
    expect(walletWrite).toHaveBeenCalledTimes(1);
    expect(walletWrite.mock.calls[0][0].args).toEqual([CREATOR, 1000000n]);
    receiptState = { data: { status: 'success', blockNumber: 124n, transactionHash: tx, from: FAN, logs: [] }, error: null, isSuccess: true, isError: false };
    view.rerender(<TipForm params={arcParams} />);
    await screen.findByText('Arc thanks');
    expect(successLogs()).toHaveLength(1);
    expect(loadPayerReceipts()[0]).toMatchObject({ amount: '1', paymentMode: 'standard' });
  });

  it('preview with a populated intent has zero restore, RPC, write, receipt, notification and log effects', async () => {
    seed(5042002);
    const stored = window.sessionStorage.getItem('openpay:standard-intent:v1');
    render(<TipForm params={arcParams} preview />);
    await act(async () => { await Promise.resolve(); });
    const wagmi = await import('wagmi');
    for (const [options] of vi.mocked(wagmi.useWaitForTransactionReceipt).mock.calls) expect(options?.query?.enabled).toBe(false);
    expect(window.sessionStorage.getItem('openpay:standard-intent:v1')).toBe(stored);
    expect(walletWrite).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(loadPayerReceipts()).toHaveLength(0);
    expect(screen.queryByText('以前の送信の確認')).not.toBeInTheDocument();
  });
});

it('Gateway hashless success keeps Tip paid and records a receipt without a transaction link or external notification', async () => {
  window.localStorage.clear();
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
  setAccount({ connected: true, chainId: baseSepolia.id });
  setBalance(20_000_000n); setSmartAccount(true); setGasQuote('ready', 100_000n);
  render(<TipForm params={USDC_PARAMS} />);
  await waitFor(() => expect(crossChainHintSpy).toHaveBeenCalled());
  const props = crossChainHintSpy.mock.lastCall![0] as { onAttemptStart: (amount: bigint) => void; onSuccess: (result: import('@/hooks/useCrossChainPayment').ExecuteResult) => void };
  const { gatewayAttestation, encodedSpec } = await import('../fixtures/gateway');
  const { keccak256 } = await import('viem');
  const att = gatewayAttestation(); const transferSpecHash = keccak256(encodedSpec());
  act(() => {
    props.onAttemptStart(1_000_000n);
    props.onSuccess({ path: 'gateway', settlement: 'hashless', transferSpecHash, attestation: att.attestation, attestationSignature: att.signature, destChainId: baseSepolia.id });
  });
  await waitFor(() => expect(loadPayerReceipts()).toHaveLength(1));
  expect(loadPayerReceipts()[0]).toMatchObject({ receiptId: `gateway:${baseSepolia.id}:${transferSpecHash}`, status: 'confirmed' });
  expect(loadPayerReceipts()[0].txHash).toBeUndefined();
  expect(loadPayerReceipts()[0].explorerUrl).toBeUndefined();
  expect(screen.getAllByText(/チップを送信しました/).length).toBeGreaterThan(0);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it.each(['notify-pending', 'terminal', 'prepared'] as const)('A2c %s order from an earlier checkout cannot hijack a new TipForm mount', async (state) => {
  const { bindingFixture } = await import('../_helpers/orderBinding');
  const { defaultDeploymentForSymbol } = await import('@/lib/tokens');
  const { ORDER_DELIVERY_KEY, resolveOrderDelivery, saveOrderDelivery, terminateOrderDelivery } = await import('@/lib/orderDelivery');
  const { useJpycEip3009Payment: actualHook } = await vi.importActual<typeof import('@/hooks/useJpycEip3009Payment')>('@/hooks/useJpycEip3009Payment');
  sessionStorage.clear();
  const dep = defaultDeploymentForSymbol('jpyc');
  const record = resolveOrderDelivery(bindingFixture('free', { chainId: dep.chainId, tokenAddress: dep.address, merchant: CREATOR, handle: 'alice', orderId: 'old', items: [{ name: 'Tea', qty: 1, price: '300' }] }).record, `0x${'ab'.repeat(32)}`);
  saveOrderDelivery(record);
  if (state === 'terminal') expect(terminateOrderDelivery(record)).toBe(true);
  if (state === 'prepared') sessionStorage.setItem(ORDER_DELIVERY_KEY, JSON.stringify({ ...record, state: 'prepared', txHash: undefined, notifyBody: undefined }));
  vi.mocked(useJpycEip3009Payment).mockImplementation(actualHook);
  vi.mocked(resolveJpycGaslessProvider).mockReturnValue('eip3009-relay');
  setAccount({ connected: true, chainId: dep.chainId });
  setBalance(10_000n * 10n ** 18n);
  mockHook(useWalletClient, { data: undefined });
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><TipForm params={JPYC_PARAMS} /></QueryClientProvider>);
  await waitFor(() => expect(screen.getByRole('button', { name: /JPYC.*送る/ })).toBeEnabled());
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(vi.mocked(useJpycEip3009Payment).mock.calls.every((args) => args[1]?.restoreOrderDelivery !== true)).toBe(true);
  view.unmount(); client.clear(); fetchSpy.mockRestore(); sessionStorage.clear();
});

// R14 (Phase 6): 内訳行の描画 fixture。行の抽出前に移動前のコードで捕捉し、ja/en × gas 提供者 ×
// Arc standard × テーマの section outerHTML を固定する (PaymentForm.test と同型・開いた
// InfoTooltip の id は乱数なので正規化)。
// 2026-10-30 再採取 (全レビュー第 8 回 D-2): InfoTooltip のボタンの aria-label を「{行のラベル} の詳細」/
// 「{label} details」の固定に、class に押せる範囲 (relative・after:absolute・after:-inset-[5px]) を足したので撮り直した。
// 旧 snapshot と新 snapshot をこの 2 属性だけ正規化して比べると全件一致し (他の DOM は不変)、各ボタンの名前は
// 直前の dt のラベル + 接尾辞と一致することを確かめた。
describe('TipForm — R14 内訳行 fixture (ja/en)', () => {
  function usdcReady() {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(500_000_000n);
    setSmartAccount(true);
  }
  function jpycReady() {
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(1000n * 10n ** 18n);
  }
  async function arcReady() {
    setAccount({ connected: true, chainId: 5042002 });
    setBalance(10_000_000n);
    const wagmi = await import('wagmi');
    vi.mocked(wagmi.useWriteContract).mockImplementation(() => ({ data: undefined, error: null, isPending: false, writeContract: vi.fn(), reset: vi.fn() }) as never);
    vi.mocked(wagmi.useWaitForTransactionReceipt).mockImplementation(() => ({ data: undefined, error: null, isSuccess: false, isError: false, refetch: vi.fn() }) as never);
  }
  const cases: Array<[string, () => Promise<TipParams> | TipParams]> = [
    ['usdc sponsorship', () => { usdcReady(); setGasQuote('ready', 50_000n); return USDC_PARAMS; }],
    ['usdc erc20', () => { vi.mocked(resolvePaymasterMode).mockReturnValue('erc20'); usdcReady(); setGasQuote('ready', 100_000n); return USDC_PARAMS; }],
    ['usdc circle', () => { vi.mocked(resolvePaymasterMode).mockReturnValue('erc20'); vi.mocked(resolveUsdcGaslessProvider).mockReturnValue('circle'); usdcReady(); setCircleQuote('ready', { gasAmount: 60_000n, permitAmount: 1_060_000n }); return USDC_PARAMS; }],
    ['usdc gas quote pending', () => { vi.mocked(resolvePaymasterMode).mockReturnValue('erc20'); usdcReady(); setGasQuote('pending'); return USDC_PARAMS; }],
    ['jpyc sponsorship (non relay)', () => { jpycReady(); setGasQuote('ready', 0n); return JPYC_PARAMS; }],
    ['jpyc relay free', () => { vi.mocked(resolveJpycGaslessProvider).mockReturnValue('eip3009-relay'); jpycReady(); return JPYC_PARAMS; }],
    ['jpyc relay recover', () => { vi.mocked(resolveJpycGaslessProvider).mockReturnValue('eip3009-relay'); vi.mocked(jpycForwarderFor).mockReturnValue('0x1111111111111111111111111111111111111111'); jpycReady(); return JPYC_PARAMS; }],
    ['jpyc relay free / night theme', () => { vi.mocked(resolveJpycGaslessProvider).mockReturnValue('eip3009-relay'); jpycReady(); return { ...JPYC_PARAMS, theme: 'night' }; }],
    ['usdc Arc standard', async () => { await arcReady(); return { ...USDC_PARAMS, mode: 'standard', chain: 'arc', presets: ['0.5', '1'] }; }],
  ];
  const titles = { ja: '明細', en: 'Breakdown' } as const;
  describe.each(['ja', 'en'] as const)('%s', (locale) => {
    it.each(cases)('%s', async (_name, setup) => {
      const params = await setup();
      render(<TipForm params={params} />, { locale });
      const section = screen.getByText(titles[locale]).closest('section')!;
      expect(section.outerHTML).toMatchSnapshot('closed');
      for (const button of Array.from(section.querySelectorAll('dl button'))) fireEvent.click(button);
      expect(section.outerHTML.replace(/tip-[a-z0-9]+/g, 'tip-ID')).toMatchSnapshot('tooltips open');
      // dynamic な standard engine の読込が test 後に state を更新しないよう待つ。
      await act(async () => {});
    });
  });
});

// R14 (Phase 6): click 時の二重送信。policy の抽出前に移動前のコードで捕捉。1 回目の click を
// hook が受け取った (in-flight に遷移した) 後の再描画で、同じボタンの 2 回目は mutate しない。
describe('TipForm — R14 二重送信 (in-flight 後の再 click)', () => {
  it('gasless: 2 回目の click は mutate しない', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 0n);
    const view = render(<TipForm params={USDC_PARAMS} />);
    const button = screen.getByRole('button', { name: /1 USDC を送る/ });
    fireEvent.click(button);
    const first = mutate;
    expect(first).toHaveBeenCalledOnce();
    setBatchPayment('pending');
    view.rerender(<TipForm params={USDC_PARAMS} />);
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(first).toHaveBeenCalledOnce();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('relay: 署名待ちの 2 回目の click は mutate しない', () => {
    vi.mocked(resolveJpycGaslessProvider).mockReturnValue('eip3009-relay');
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(1000n * 10n ** 18n);
    const view = render(<TipForm params={JPYC_PARAMS} />);
    const button = screen.getByRole('button', { name: /100 JPYC を送る/ });
    fireEvent.click(button);
    const first = relayMutate;
    expect(first).toHaveBeenCalledOnce();
    setRelay('pending');
    view.rerender(<TipForm params={JPYC_PARAMS} />);
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(first).toHaveBeenCalledOnce();
    expect(relayMutate).not.toHaveBeenCalled();
  });
});

// 第 9 回レビュー A-4: 控えの支払者は、確定時に接続しているアドレスでなく送信した時点のアドレス。確定を待つ間に
// 拡張機能で別のウォレット (B) へ切り替えても、控えに B を残さない (控えは pending → confirmed の昇格しか受けず、
// A に戻しても保存済みの支払者は直らない)。送信時のスナップショットを今の address に戻すと各 it が落ちる。
describe('TipForm — 控えの支払者は送信した時点のアドレス (第 9 回レビュー A-4)', () => {
  const OTHER: Address = '0x8888888888888888888888888888888888888888';
  type HintProps = {
    onAttemptStart: (amount: bigint) => void;
    onSuccess: (result: import('@/hooks/useCrossChainPayment').ExecuteResult) => void;
  };
  const latestHintProps = () => crossChainHintSpy.mock.lastCall![0] as HintProps;
  function switchToOther(chainId: number) {
    mockHook(useAccount, { address: OTHER, isConnected: true, chainId });
  }

  beforeEach(() => {
    window.localStorage.clear();
  });

  it('relay: 送信 → B に切り替え → 成功が届く でも、控えの支払者は送った A', () => {
    vi.mocked(resolveJpycGaslessProvider).mockReturnValue('eip3009-relay');
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(1000n * 10n ** 18n);
    const view = render(<TipForm params={JPYC_PARAMS} />);
    fireEvent.click(screen.getByRole('button', { name: /100 JPYC を送る/ }));
    expect(relayMutate).toHaveBeenCalledOnce();
    switchToOther(polygonAmoy.id);
    view.rerender(<TipForm params={JPYC_PARAMS} />);
    setRelay('success', { variables: { merchant: CREATOR, value: 100n * 10n ** 18n, gasMode: 'customer' } });
    view.rerender(<TipForm params={JPYC_PARAMS} />);
    const receipts = loadPayerReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ receiptId: `0x${'c'.repeat(64)}`, payerAddress: FAN });
  });

  it('gasless: 送信 → B に切り替え → 成功が届く でも、控えの支払者は送った A', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 0n);
    const view = render(<TipForm params={USDC_PARAMS} />);
    fireEvent.click(screen.getByRole('button', { name: /1 USDC を送る/ }));
    expect(mutate).toHaveBeenCalledOnce();
    switchToOther(baseSepolia.id);
    view.rerender(<TipForm params={USDC_PARAMS} />);
    setBatchPayment('success');
    view.rerender(<TipForm params={USDC_PARAMS} />);
    const receipts = loadPayerReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ receiptId: `0x${'b'.repeat(64)}`, payerAddress: FAN });
  });

  it('cross-chain (CCTP): 試みる → B に切り替え → 成功が届く でも、控えの支払者は試みた A', async () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);
    const view = render(<TipForm params={USDC_PARAMS} />);
    await waitFor(() => expect(crossChainHintSpy).toHaveBeenCalled());
    act(() => latestHintProps().onAttemptStart(1_000_000n));
    switchToOther(baseSepolia.id);
    view.rerender(<TipForm params={USDC_PARAMS} />);
    const mintTxHash = `0x${'e'.repeat(64)}` as const;
    act(() => latestHintProps().onSuccess({
      path: 'cctp-v2',
      burnTxHash: `0x${'f'.repeat(64)}`,
      mintTxHash,
      destChainId: baseSepolia.id,
    }));
    await waitFor(() => expect(loadPayerReceipts()).toHaveLength(1));
    expect(loadPayerReceipts()[0]).toMatchObject({ receiptId: mintTxHash, paymentMode: 'cross-chain', payerAddress: FAN });
  });

  it('cross-chain (Gateway の hash の無い控え): 試みる → B に切り替え → 成功が届く でも、控えの支払者は試みた A', async () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);
    const view = render(<TipForm params={USDC_PARAMS} />);
    await waitFor(() => expect(crossChainHintSpy).toHaveBeenCalled());
    const { gatewayAttestation, encodedSpec } = await import('../fixtures/gateway');
    const { keccak256 } = await import('viem');
    const att = gatewayAttestation();
    const transferSpecHash = keccak256(encodedSpec());
    act(() => latestHintProps().onAttemptStart(1_000_000n));
    switchToOther(baseSepolia.id);
    view.rerender(<TipForm params={USDC_PARAMS} />);
    act(() => latestHintProps().onSuccess({
      path: 'gateway',
      settlement: 'hashless',
      transferSpecHash,
      attestation: att.attestation,
      attestationSignature: att.signature,
      destChainId: baseSepolia.id,
    }));
    await waitFor(() => expect(loadPayerReceipts()).toHaveLength(1));
    expect(loadPayerReceipts()[0]).toMatchObject({
      receiptId: `gateway:${baseSepolia.id}:${transferSpecHash}`,
      payerAddress: FAN,
    });
    expect(loadPayerReceipts()[0].txHash).toBeUndefined();
  });
});

// 第 10 回レビュー H-S (チップの分・/tip/[address] と @handle は同じ TipForm): ブラウザに残る未解決の支払いの記録 (束縛しない
// relay の枠・Pimlico の記録) は、どのチップの画面の mount でも復元される。前の支払い A の確定を、今の画面のチップの完了
// (「チップを送信しました」) として出さない: この画面のチップでないと証明できたときだけ、完了の欄の題を差し替えて、読み込み
// 直しの案内と「読み込み直す」を出す。比べられない欄は一致 (同じチップを読み直しただけの人に「この画面の支払いでは
// ありません」と出すと、二重払いを誘う)。チップの額は選んだ・打った額で、読み込み直すと既定に戻るので比べない。
// hook は境界として差し替え、判定 (lib/paymentFlowGuards/restoredSettlement)・画面の形 (settlementScreen)・控えは実物。
// 通常決済 (Arc) は ownsStandardAttempt と「以前の送信の確認」の欄で分けてあり、対象外 (上の Arc standard tip attribution)。
describe('TipForm — 復元した前の支払いの確定を、この画面のチップの完了として出さない (第 10 回レビュー H-S)', () => {
  const DONE_TITLE = 'チップを送信しました';
  const FOREIGN_TITLE = '前に確認中だった支払いが完了しました。この画面の支払いではありません。';
  const FOREIGN_BODY = 'この画面の支払いを続けるには、読み込み直してください。';
  const OTHER_CREATOR: Address = '0x3333333333333333333333333333333333333333';
  const OTHER_FAN: Address = '0x8888888888888888888888888888888888888888';
  const USDC_BASE_SEPOLIA: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
  const ANY_KEY = `0x${'7'.repeat(64)}` as const;
  const E18 = 10n ** 18n;
  const THANKS = 'この画面だけのお礼';
  const realLocation = window.location;
  const topDescriptor = Object.getOwnPropertyDescriptor(window, 'top');
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.localStorage.clear();
    reload = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, reload } });
  });
  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
    if (topDescriptor) Object.defineProperty(window, 'top', topDescriptor);
  });

  // 大きな完了画面 (遅延ロード) が出ないことは、待ってから確かめる。
  const expectNoOverlay = () => expect(screen.findByRole('dialog', {}, { timeout: 300 })).rejects.toThrow();

  /** 今までどおりの完了の欄 (題・hash)。読み込み直しの案内と「読み込み直す」は無い。 */
  async function expectOwnResult(txHash: string) {
    expect((await screen.findAllByText(DONE_TITLE)).length).toBeGreaterThan(0);
    expect(screen.queryByText(FOREIGN_TITLE)).toBeNull();
    expect(screen.queryByText(FOREIGN_BODY)).toBeNull();
    expect(screen.queryByRole('button', { name: '読み込み直す' })).toBeNull();
    expect(screen.getAllByText(txHash).length).toBeGreaterThan(0);
  }
  /** この画面のチップでない確定: 題が替わり、案内と「読み込み直す」が出る。hash は出る。押すと読み込み直す。 */
  async function expectForeignResult(txHash: string) {
    expect(await screen.findByText(FOREIGN_TITLE)).toBeInTheDocument();
    expect(screen.getByText(FOREIGN_BODY)).toBeInTheDocument();
    expect(screen.queryByText(DONE_TITLE)).toBeNull();
    expect(screen.getAllByText(txHash).length).toBeGreaterThan(0);
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '読み込み直す' }));
    expect(reload).toHaveBeenCalledTimes(1);
  }

  // ---- relay (束縛しない枠) ----
  type RelayIntent = NonNullable<ReturnType<typeof useJpycEip3009Payment>['restoredIntent']>;
  const RELAY_TX = `0x${'c'.repeat(64)}`;
  // CREATOR へ 250 JPYC (プリセットに無い額) を free で送った intent。画面の既定の額は 100 JPYC。
  function relayIntent(overrides: Partial<RelayIntent> = {}): RelayIntent {
    return {
      chainId: polygonAmoy.id,
      from: FAN,
      merchant: CREATOR,
      merchantValue: (250n * E18).toString(),
      feeValue: '0',
      nonce: `0x${'4'.repeat(64)}`,
      validBefore: '9999999999',
      routeKind: 'free',
      issuedAt: 1,
      ...overrides,
    };
  }
  function readyRelay() {
    vi.mocked(resolveJpycGaslessProvider).mockReturnValue('eip3009-relay');
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(1000n * E18);
  }
  // 読み直した画面で、保存された relay の nonce が settled と分かった状態 (hook は restoredIntent を持ったまま成功)。
  function setRestoredRelay(intent: RelayIntent) {
    setRelay('success', {
      restoredIntent: intent,
      variables: { merchant: intent.merchant, value: BigInt(intent.merchantValue) },
    });
  }
  const tipParams: TipParams = { ...JPYC_PARAMS, thanks: THANKS, thanksUrl: 'https://current.example/thanks' };

  it.each<[string, Partial<RelayIntent>]>([
    ['同じ受取先 (額は画面の既定の 100 と違う 250)', {}],
    ['recover (チップはお客様が利用料を上乗せ: 受取 250・利用料 2)', { routeKind: 'recover', feeValue: (2n * E18).toString() }],
    ['支払い者 (from) が今つないでいるウォレットと違う', { from: OTHER_FAN }],
    ['chain が違う', { chainId: baseSepolia.id }],
  ])('relay: %s 復元の確定は、今までどおりの題 (お礼・overlay・控えは今までどおり出さない)', async (_label, overrides) => {
    readyRelay();
    setRestoredRelay(relayIntent(overrides));
    render(<TipForm params={tipParams} />);

    await expectOwnResult(RELAY_TX);
    await expectNoOverlay();
    expect(screen.queryByText(THANKS)).toBeNull();
    expect(screen.queryByRole('link', { name: /リンクを開く/ })).toBeNull();
    expect(loadPayerReceipts()).toEqual([]);
  });

  it.each<[string, Partial<RelayIntent>]>([
    ['受取先が違う', { merchant: OTHER_CREATOR }],
    ['注文リンクの鍵を持つ (付けるのは /checkout だけ・受取先は同じ)', { orderLinkKey: ANY_KEY }],
  ])('relay: %s 復元の確定は「この画面の支払いではありません」と「読み込み直す」(お礼・overlay・控えなし)', async (_label, overrides) => {
    readyRelay();
    setRestoredRelay(relayIntent(overrides));
    render(<TipForm params={tipParams} />);

    await expectForeignResult(RELAY_TX);
    await expectNoOverlay();
    expect(screen.queryByText(THANKS)).toBeNull();
    expect(screen.queryByRole('link', { name: /リンクを開く/ })).toBeNull();
    expect(loadPayerReceipts()).toEqual([]);
  });

  it('relay: この mount で送ったチップの成功は、今までどおりの題・お礼・大きな完了画面 (判定しない)', async () => {
    const user = userEvent.setup();
    readyRelay();
    const { rerender } = render(<TipForm params={tipParams} />);
    await user.click(screen.getByRole('button', { name: /100 JPYC を送る/ }));
    expect(relayMutate).toHaveBeenCalledOnce();
    setRelay('success', { variables: { merchant: CREATOR, value: 100n * E18, gasMode: 'customer' } });
    rerender(<TipForm params={tipParams} />);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await expectOwnResult(RELAY_TX);
    expect(screen.getAllByText(THANKS).length).toBeGreaterThan(0);
  });

  it('preview (/create の見本) は払う画面でないので、別の受取先への復元の確定でも題を差し替えない', async () => {
    readyRelay();
    setRestoredRelay(relayIntent({ merchant: OTHER_CREATOR }));
    render(<TipForm params={tipParams} preview />);
    await expectOwnResult(RELAY_TX);
  });

  // 埋め込み (iframe) の中でも同じ表示。読み込み直すのは枠の中の window (親のページはそのまま)。
  it('埋め込み (iframe) の中: 別の受取先への復元の確定は同じ表示で、「読み込み直す」は枠の window を読み込み直す', async () => {
    const parentWindow = {};
    Object.defineProperty(window, 'top', { configurable: true, get: () => parentWindow });
    readyRelay();
    setRestoredRelay(relayIntent({ merchant: OTHER_CREATOR }));
    render(<TipForm params={tipParams} />);

    expect(vi.mocked(useJpycEip3009Payment).mock.lastCall?.[1]).toEqual({ skipIntentStorageCheck: true });
    await expectForeignResult(RELAY_TX);
  });

  // ---- ガスレス (Pimlico): 確定したのが、この画面から最後に送った支払いと別の intent ----
  type GaslessRecord = NonNullable<ReturnType<typeof useBatchPayment>['variables']>;
  const GASLESS_TX = `0x${'b'.repeat(64)}`;
  // CREATOR へ 3 USDC (プリセットに無い額) をガスレスで送った intent の保存した params。画面の既定の額は 1 USDC。
  function gaslessRecord(overrides: Partial<GaslessRecord> = {}): GaslessRecord {
    return {
      tokenAddress: USDC_BASE_SEPOLIA,
      merchant: CREATOR,
      merchantAmount: 3_000_000n,
      feeReceiver: '0xfee0fee0fee0fee0fee0fee0fee0fee0fee0fee0',
      feeAmount: 0n,
      saleAmount: 3_000_000n,
      ...overrides,
    };
  }
  function readyGasless() {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
  }
  const setSettledOther = (variables: GaslessRecord | undefined) =>
    setBatchPayment('success', undefined, { settledOtherIntent: true, recoveredIntent: null, variables });
  const usdcParams: TipParams = { ...USDC_PARAMS, thanks: THANKS };
  const jpycAddress = deploymentsForSymbol('jpyc')[0].address;

  it.each<[string, GaslessRecord | undefined]>([
    ['同じ受取先・token (額は画面の既定の 1 と違う 3)', gaslessRecord()],
    ['保存した params (variables) が無い = 比べられない', undefined],
  ])('ガスレス: 別の intent の確定で、%s なら今までどおりの題', async (_label, variables) => {
    readyGasless();
    setSettledOther(variables);
    render(<TipForm params={usdcParams} />);

    await expectOwnResult(GASLESS_TX);
    await expectNoOverlay();
    expect(screen.queryByText(THANKS)).toBeNull();
  });

  it.each<[string, Partial<GaslessRecord>]>([
    ['受取先が違う', { merchant: OTHER_CREATOR }],
    ['別の token (JPYC の address)', { tokenAddress: jpycAddress }],
  ])('ガスレス: 別の intent の確定で、%s なら「この画面の支払いではありません」と「読み込み直す」', async (_label, overrides) => {
    readyGasless();
    setSettledOther(gaslessRecord(overrides));
    render(<TipForm params={usdcParams} />);

    await expectForeignResult(GASLESS_TX);
    await expectNoOverlay();
    expect(screen.queryByText(THANKS)).toBeNull();
  });

  // 完了の欄の hash が、この mount で送った cross-chain の送金のものに替わったら、題も今までどおりに戻す。
  it('別の受取先への intent が確定した後に、この mount の cross-chain の送金が成功すると、欄は cross-chain の hash と今までどおりの題', async () => {
    readyGasless();
    setGasQuote('ready', 100_000n);
    setSettledOther(gaslessRecord({ merchant: OTHER_CREATOR }));
    render(<TipForm params={usdcParams} />);
    expect(await screen.findByText(FOREIGN_TITLE)).toBeInTheDocument();

    await waitFor(() => expect(crossChainHintSpy).toHaveBeenCalled());
    const hint = () => crossChainHintSpy.mock.lastCall![0] as {
      onAttemptStart: (amount: bigint) => void;
      onSuccess: (result: import('@/hooks/useCrossChainPayment').ExecuteResult) => void;
    };
    const mintTxHash = `0x${'f'.repeat(64)}` as const;
    act(() => hint().onAttemptStart(1_000_000n));
    act(() => hint().onSuccess({
      path: 'cctp-v2',
      burnTxHash: `0x${'a'.repeat(64)}`,
      mintTxHash,
      destChainId: baseSepolia.id,
    }));

    await waitFor(() => expect(screen.queryByText(FOREIGN_TITLE)).toBeNull());
    expect(screen.getAllByText(DONE_TITLE).length).toBeGreaterThan(0);
    expect(screen.getAllByText(mintTxHash).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: '読み込み直す' })).toBeNull();
  });

  // ---- @handle のページのチップ ----
  // ここまでのテストは TipForm を直接描く = /tip/[address] の形 (受取先が URL にある → 受取先を比べる)。@handle のページは
  // 受取先が handle の設定で決まり、払った後にクリエイターが変えられる。記録の受取先が今の設定と違っても、同じクリエイターへの
  // チップでありうるので、別の支払いの証明にしない (もう一度送らせない)。token と鍵の証明は今までどおり立つ。
  describe('@handle のページ (受取先は handle の設定で決まる = recipientFromHandleConfig): 受取先を比べない', () => {
    it('relay: 記録の受取先が今の設定と違っても (クリエイターが受取先を変えた後の読み直し)、今までどおりの題', async () => {
      readyRelay();
      setRestoredRelay(relayIntent({ merchant: OTHER_CREATOR }));
      render(<TipForm params={tipParams} recipientFromHandleConfig />);

      await expectOwnResult(RELAY_TX);
      await expectNoOverlay();
      expect(screen.queryByText(THANKS)).toBeNull();
      expect(loadPayerReceipts()).toEqual([]);
    });

    it('relay: 注文リンクの鍵を持つ記録 (付けるのは /checkout だけ) は、受取先を比べなくても「この画面の支払いではありません」', async () => {
      readyRelay();
      setRestoredRelay(relayIntent({ merchant: OTHER_CREATOR, orderLinkKey: ANY_KEY }));
      render(<TipForm params={tipParams} recipientFromHandleConfig />);
      await expectForeignResult(RELAY_TX);
    });

    it('ガスレス: 記録の受取先が今の設定と違っても、今までどおりの題', async () => {
      readyGasless();
      setSettledOther(gaslessRecord({ merchant: OTHER_CREATOR }));
      render(<TipForm params={usdcParams} recipientFromHandleConfig />);

      await expectOwnResult(GASLESS_TX);
      await expectNoOverlay();
      expect(screen.queryByText(THANKS)).toBeNull();
    });

    it('ガスレス: 別の token (JPYC の address) の記録は、受取先を比べなくても「この画面の支払いではありません」', async () => {
      readyGasless();
      setSettledOther(gaslessRecord({ merchant: OTHER_CREATOR, tokenAddress: jpycAddress }));
      render(<TipForm params={usdcParams} recipientFromHandleConfig />);
      await expectForeignResult(GASLESS_TX);
    });

    // @handle のページが実際に描く形 (ReceiveMethodPicker → TipForm)。picker が印を渡していることを固定する。
    const HANDLE_CONFIG: HandleTipConfig = {
      to: CREATOR,
      name: '山田太郎',
      methods: [
        { token: 'jpyc', chain: 'polygon' },
        { token: 'usdc', chain: 'base', crossChain: true },
      ],
      presets: { jpyc: ['100', '500', '1000'], usdc: ['1', '5', '10'] },
    };
    // 受取方法は初めは畳んである。JPYC を開くと、その方法の TipForm が mount される。
    function openJpycMethod() {
      render(<ReceiveMethodPicker config={HANDLE_CONFIG} />);
      fireEvent.click(screen.getByRole('button', { name: 'JPYC · Polygon' }));
    }

    it('ReceiveMethodPicker 経由: 受取先だけが違う relay の復元の確定は、今までどおりの題', async () => {
      readyRelay();
      setRestoredRelay(relayIntent({ merchant: OTHER_CREATOR }));
      openJpycMethod();
      await expectOwnResult(RELAY_TX);
    });

    it('ReceiveMethodPicker 経由: 注文リンクの鍵を持つ relay の記録は「この画面の支払いではありません」と「読み込み直す」', async () => {
      readyRelay();
      setRestoredRelay(relayIntent({ orderLinkKey: ANY_KEY }));
      openJpycMethod();
      await expectForeignResult(RELAY_TX);
    });
  });

  // 判定するのは復元した確定だけ。別の intent でない確定 (この mount で送った) は、hook が持つ記録が画面と違っても題を差し替えない。
  it('ガスレス: 別の intent でない成功は、variables の受取先が画面と違っても判定しない (今までどおりの題とお礼)', async () => {
    readyGasless();
    setBatchPayment('success', undefined, { settledOtherIntent: false, variables: gaslessRecord({ merchant: OTHER_CREATOR }) });
    render(<TipForm params={usdcParams} />);

    await expectOwnResult(GASLESS_TX);
    expect((await screen.findAllByText(THANKS)).length).toBeGreaterThan(0);
  });

  it('en: 題・案内・ボタンは承認済みの英語の文', async () => {
    readyRelay();
    setRestoredRelay(relayIntent({ merchant: OTHER_CREATOR }));
    render(<TipForm params={tipParams} />, { locale: 'en' });

    expect(await screen.findByText('A previous pending payment has completed. This is not the payment on this screen.')).toBeInTheDocument();
    expect(screen.getByText('To continue with the payment on this screen, reload the page.')).toBeInTheDocument();
    expect(screen.queryByText('Tip sent!')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
