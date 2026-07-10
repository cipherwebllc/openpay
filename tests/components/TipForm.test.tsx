import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
import userEvent from '@testing-library/user-event';
import { arbitrumSepolia, baseSepolia, polygonAmoy } from 'viem/chains';
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
vi.mock('@/hooks/useGasQuoteUsdc', () => ({ useGasQuoteUsdc: vi.fn() }));
vi.mock('@/hooks/useGasQuoteJpyc', () => ({ useGasQuoteJpyc: vi.fn() }));
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
vi.mock('@/components/CrossChainHint', () => ({
  CrossChainHint: (props: Record<string, unknown>) => {
    crossChainHintSpy(props);
    return null;
  },
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
// useJpycEip3009Payment は real だと wagmi useWalletClient + react-query (useMutation) に依存する。
// relay/Pimlico の分岐は resolveJpycGaslessProvider を直接制御して検証する (CheckoutForm.test と同型)。
vi.mock('@/hooks/useJpycEip3009Payment', () => ({
  useJpycEip3009Payment: vi.fn(),
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

import { useAccount, useReadContract, useSwitchChain } from 'wagmi';
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
import { TipForm } from '@/components/TipForm';
import { ReceiveMethodPicker } from '@/components/ReceiveMethodPicker';
import type { HandleTipConfig } from '@/lib/handle';
import { loadPayerReceipts } from '@/lib/payerReceipt';
import type { TipParams } from '@/lib/url';
import { mockHook } from '../_helpers/wagmiMock';

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
function setBatchPayment(state: 'idle' | 'pending' | 'success' | 'error') {
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
    error: state === 'error' ? new Error('AA21 fail') : null,
  } as Partial<ReturnType<typeof useBatchPayment>>);
}

let relayMutate: ReturnType<typeof vi.fn>;
function setRelay(state: 'idle' | 'pending' | 'success' | 'error' | 'pendingResult') {
  relayMutate = vi.fn();
  mockHook(useJpycEip3009Payment, {
    mutate: relayMutate,
    isPending: state === 'pending',
    data:
      state === 'success'
        ? { txHash: `0x${'c'.repeat(64)}`, success: true }
        : state === 'pendingResult'
          ? { txHash: `0x${'d'.repeat(64)}`, success: false, pending: true }
          : undefined,
    error: state === 'error' ? new Error('rate_limited') : null,
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

beforeEach(() => {
  vi.clearAllMocks();
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
  to: CREATOR,
  token: 'jpyc',
  name: '山田太郎',
  message: 'いつも応援ありがとう！',
  color: '#1e3a8a',
  presets: ['100', '500', '1000'],
};

const USDC_PARAMS: TipParams = {
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
    render(<TipForm params={{ to: CREATOR, token: 'usdc' }} />);
    expect(screen.getByText('クリエイターへチップを送る')).toBeInTheDocument();
  });

  it('preset 未指定 → DEFAULT_TIP_PRESETS が使われる (USDC)', () => {
    render(<TipForm params={{ to: CREATOR, token: 'usdc' }} />);
    expect(screen.getByRole('button', { name: '5 USDC' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '20 USDC' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '50 USDC' })).toBeInTheDocument();
  });

  it('color パラメータがヘッダの背景色に適用される', () => {
    render(<TipForm params={JPYC_PARAMS} />);
    const header = screen.getByText('OpenPay Tip').parentElement!;
    expect(header.style.backgroundColor).toBe('rgb(30, 58, 138)'); // #1e3a8a
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
  it('未接続: 送信ボタンに接続を促すラベル / disabled', () => {
    render(<TipForm params={USDC_PARAMS} />);
    const btn = screen.getByRole('button', {
      name: /ウォレットを接続/,
    });
    expect(btn).toBeDisabled();
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

  it('成功 → tx hash と block 表示', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setBatchPayment('success');
    render(<TipForm params={USDC_PARAMS} />);
    // SuccessOverlay (PayPay 風) + 既存 inline panel が両方 DOM に存在
    expect(
      screen.getAllByText(/チップを送信しました|決済完了/).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(`0x${'a'.repeat(64)}`).length).toBeGreaterThan(0);
    expect(screen.getAllByText(`0x${'b'.repeat(64)}`).length).toBeGreaterThan(0);
    expect(screen.getAllByText('99').length).toBeGreaterThan(0);
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
});

describe('TipForm — thanks / webhook (B2 + B3)', () => {
  it('成功 + thanks あり → メッセージ表示', () => {
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
      screen.getByText('ありがとう！Discord 招待リンクをどうぞ'),
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

  it('成功 + webhook あり → fetch が POST される', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));

    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setBatchPayment('success');
    render(
      <TipForm
        params={{
          ...USDC_PARAMS,
          webhook: 'https://example.com/hook',
        }}
      />,
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://example.com/hook',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const body = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.type).toBe('openpay.tip.success');
    expect(body.creator.toLowerCase()).toBe(CREATOR.toLowerCase());
    expect(body.token).toBe('usdc');
    expect(body.txHash).toBe(`0x${'b'.repeat(64)}`);
    fetchSpy.mockRestore();
  });

  it('[regression] 同一 userOpHash で再 render が起きても webhook は 1 回 (gasQuote refetch 耐性)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));

    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setBatchPayment('success');
    // 初回 gasAmount = 100_000n
    setGasQuote('ready', 100_000n);
    const { rerender } = render(
      <TipForm
        params={{ ...USDC_PARAMS, webhook: 'https://example.com/hook' }}
      />,
    );
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    // gasQuote refetchInterval (30s) で gasAmount が変わったケースをシミュレート
    setGasQuote('ready', 200_000n);
    rerender(
      <TipForm
        params={{ ...USDC_PARAMS, webhook: 'https://example.com/hook' }}
      />,
    );
    setGasQuote('ready', 300_000n);
    rerender(
      <TipForm
        params={{ ...USDC_PARAMS, webhook: 'https://example.com/hook' }}
      />,
    );

    // 同一 userOpHash の間は webhook は再発火しない
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it('成功 + webhook が non-OK (500) → logger.warn 経路 (UI には影響なし)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('Server error', { status: 500, statusText: 'Internal' }),
      );

    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setBatchPayment('success');
    render(
      <TipForm
        params={{ ...USDC_PARAMS, webhook: 'https://example.com/hook' }}
      />,
    );

    // fetch は呼ばれた (引数を確認)
    expect(fetchSpy).toHaveBeenCalled();
    // 完了 UI は影響を受けず通常表示
    expect(screen.getAllByText(/UserOp/).length).toBeGreaterThan(0);
    fetchSpy.mockRestore();
  });

  it('成功 + webhook が CORS エラー (reject) → catch 経路、UI に影響なし', () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('CORS blocked by browser'));

    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setBatchPayment('success');
    render(
      <TipForm
        params={{ ...USDC_PARAMS, webhook: 'https://discord.com/api/webhooks/x' }}
      />,
    );

    expect(fetchSpy).toHaveBeenCalled();
    // 完了 UI は影響を受けない
    expect(screen.getAllByText(/UserOp/).length).toBeGreaterThan(0);
    fetchSpy.mockRestore();
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

  it('成功 + webhook なし → fetch は呼ばれない', () => {
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

  it('webhook payload: ERC20 mode でも customerPays は merchantAmount + feeAmount のみ (gas 含めない)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));

    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 300_000n);
    setBatchPayment('success');

    render(
      <TipForm
        params={{
          ...USDC_PARAMS,
          webhook: 'https://example.com/hook',
        }}
      />,
    );

    const body = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
    );
    // preset 1 USDC, gas 0.3 → customerPays = 1.3, merchant = 1 (fee=0), fee = 0
    expect(body.customerPays).toBe('1300000');
    expect(body.merchantAmount).toBe('1000000');
    expect(body.feeAmount).toBe('0');
    fetchSpy.mockRestore();
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

  // --- F1: recover モードの手数料開示 (共有 RecoverFeeNotice・tip は customer 固定) ---
  it('recover (forwarder 設定): 送信ボタン上に手数料開示 (顧客負担) を表示', () => {
    vi.mocked(jpycForwarderFor).mockReturnValue(
      '0x752B000000000000000000000000000000000000' as Address,
    );
    render(<TipForm params={JPYC_PARAMS} />);
    // bps=0 → ガス相当の固定手数料。tip は gas=customer 固定 → チップ内訳 + チッパー負担の文言。
    // L6: 数字の前後を境界で締める (`:\s*` 直後 + 後続 `（`) — 「12 JPYC（」等の部分一致を排除。
    expect(
      screen.getByText(/決済手数料:\s*2 JPYC（ガス相当）/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/決済手数料:\s*12 JPYC/)).toBeNull();
    // 確定モデル: チップ文脈の分担行 (チップ N + 手数料 M・お送りになるお客様のご負担)。
    expect(
      screen.getByText(/手数料はお送りになるお客様のご負担です/),
    ).toBeInTheDocument();
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

  it('relay error → friendly な i18n メッセージ (rate_limited)', () => {
    setRelay('error');
    render(<TipForm params={JPYC_PARAMS} />);
    expect(screen.getByText(/短時間に送金が集中/)).toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: /見積/ })).toBeDisabled();
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
  it('第三者 host の webhook/thanksUrl → 開示ノートに host を表示', () => {
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
        }}
      />,
    );
    const note = screen.getByText(/に通知・遷移します/);
    expect(note).toBeInTheDocument();
    expect(note.textContent).toContain('shop.example.com');
    expect(note.textContent).toContain('discord.gg');
  });

  it('callback が無ければ開示ノートは出さない', () => {
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(200_000_000_000_000_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 0n);
    render(<TipForm params={JPYC_PARAMS} />);
    expect(screen.queryByText(/に通知・遷移します/)).toBeNull();
  });
});
