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

import { useAccount, useReadContract, useSwitchChain } from 'wagmi';
import { useSmartAccount } from '@/hooks/useSmartAccount';
import { useBatchPayment } from '@/hooks/useBatchPayment';
import { useGasQuoteUsdc } from '@/hooks/useGasQuoteUsdc';
import { useGasQuoteJpyc } from '@/hooks/useGasQuoteJpyc';
import { resolvePaymasterMode } from '@/lib/pimlico';
import { TipForm } from '@/components/TipForm';
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

beforeEach(() => {
  vi.clearAllMocks();
  setSwitchChain();
  setBalance(undefined);
  setSmartAccount(false);
  setBatchPayment('idle');
  setGasQuote('disabled');
  setAccount({ connected: false });
  // 既定: testnet 環境 → 全 token sponsorship。erc20 を test したい block で override
  vi.mocked(resolvePaymasterMode).mockImplementation(() => 'sponsorship');
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
    // 100 JPYC preset, fee=1 (1% プロポーショナル), creator=99, gas=0, fan pays 100
    expectBreakdownRow('クリエイター受取', '99 JPYC');
    expectBreakdownRow(/OpenPay 利用手数料/, '1 JPYC');
    expectBreakdownRow('あなたの支払額', '100 JPYC');
  });

  it('別 preset をクリック → 明細が切替', async () => {
    const user = userEvent.setup();
    render(<TipForm params={JPYC_PARAMS} />);
    await user.click(screen.getByRole('button', { name: '1000 JPYC' }));
    // 1000 JPYC preset, fee=10 → creator=990, fan pays 1000
    expectBreakdownRow('クリエイター受取', '990 JPYC');
    expectBreakdownRow(/OpenPay 利用手数料/, '10 JPYC');
    expectBreakdownRow('あなたの支払額', '1000 JPYC');
  });

  it('カスタム入力 → preset が deselect され、明細に反映 (USDC 50)', async () => {
    const user = userEvent.setup();
    render(<TipForm params={USDC_PARAMS} />);
    const customInput = screen.getByPlaceholderText('例: 7.50');
    await user.type(customInput, '50');
    // 50 USDC, fee=0.5 → creator=49.5, fan pays 50
    expectBreakdownRow('クリエイター受取', '49.5 USDC');
    expectBreakdownRow(/OpenPay 利用手数料/, '0.5 USDC');
    expectBreakdownRow('あなたの支払額', '50 USDC');
  });

  it('カスタム入力後に preset へ戻すと反映', async () => {
    const user = userEvent.setup();
    render(<TipForm params={USDC_PARAMS} />);
    await user.type(screen.getByPlaceholderText('例: 7.50'), '50');
    await user.click(screen.getByRole('button', { name: '5 USDC' }));
    // 5 USDC preset, fee=0.05 (1% × 5 = 0.05) → creator=4.95, fan pays 5
    expectBreakdownRow('クリエイター受取', '4.95 USDC');
    expectBreakdownRow(/OpenPay 利用手数料/, '0.05 USDC');
    expectBreakdownRow('あなたの支払額', '5 USDC');
  });
});

describe('TipForm — 接続状態', () => {
  it('未接続: 送信ボタンに接続を促すラベル / disabled', () => {
    render(<TipForm params={USDC_PARAMS} />);
    const btn = screen.getByRole('button', {
      name: /ウォレットを接続してください/,
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
        name: /ネットワークを切替えてください/,
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

  it('残高不足 (JPYC) → onramp link が JPYC 公式 (token prop の wiring 確認)', () => {
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(0n);
    setSmartAccount(true);
    setGasQuote('ready', 0n);
    render(<TipForm params={JPYC_PARAMS} />);
    expect(screen.getByText(/残高が不足/)).toBeInTheDocument();
    const onramp = screen.getByRole('link', {
      name: /JPYC 公式 で JPYC を購入/,
    });
    expect(onramp).toHaveAttribute('href', 'https://jpyc.co.jp/');
  });

  it('Smart Account 初期化中 → 「初期化中…」', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(false);
    render(<TipForm params={USDC_PARAMS} />);
    expect(
      screen.getByRole('button', { name: /Smart Account 初期化中/ }),
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
    // creator = preset - fee = 5 - 0.05 = 4.95、fee 0.05 (MIN)、gas 0
    expect(call.merchantAmount).toBe(4_950_000n);
    expect(call.feeAmount).toBe(50_000n);
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
    // creator = 50 - 0.5 = 49.5
    expect(call.merchantAmount).toBe(49_500_000n);
    expect(call.feeAmount).toBe(500_000n);
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

    // preset 1 USDC, fee=0.01 (1% プロポーショナル), creator=0.99, gas=0.3, customer = 1.3 (= preset + gas)
    expectBreakdownRow('クリエイター受取', '0.99 USDC');
    expectBreakdownRow(/OpenPay 利用手数料/, '0.01 USDC');
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
    // creator = 5 - 0.05 = 4.95、fee 0.05、ERC20 なので feeAmount に gas 含めない
    expect(call.merchantAmount).toBe(4_950_000n);
    expect(call.feeAmount).toBe(50_000n);
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
    // preset 1 USDC, gas 0.3 → customerPays = 1.3, merchant = 0.99, fee = 0.01 (1%)
    expect(body.customerPays).toBe('1300000');
    expect(body.merchantAmount).toBe('990000');
    expect(body.feeAmount).toBe('10000');
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
    // preset[0]=1 USDC + fee 0.01 (1%) + gas 0.1 (gas=customer mode で顧客負担)
    // = customerPays = 1.10 USDC = 1_100_000 atomic
    expect(props.requiredAtomic).toBe(1_100_000n);
    expect(props.displayDecimals).toBe(6);
  });

  it('JPYC + 接続済 → CrossChainHint module は呼出されない (USDC 専用機能 = token guard)', async () => {
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setSmartAccount(true);
    setGasQuote('ready', 100_000n);
    render(<TipForm params={JPYC_PARAMS} />);

    // 描画完了を待つため presets ボタンの存在で待機
    await waitFor(() => {
      expect(screen.getByText('100 JPYC')).toBeInTheDocument();
    });
    expect(crossChainHintSpy).not.toHaveBeenCalled();
  });

  it('USDC + 未接続 → CrossChainHint module は呼出されない (address gate)', async () => {
    setAccount({ connected: false });
    render(<TipForm params={USDC_PARAMS} />);
    // 接続ボタン表示で render 完了を確認 (未接続時の不変表示)
    await waitFor(() => {
      expect(
        screen.getByText(/ウォレットを接続してください/),
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

    // 初期 preset[0] = 1 USDC → requiredAtomic = 1.10 USDC (1_100_000 atomic)
    await waitFor(() => expect(crossChainHintSpy).toHaveBeenCalled());
    const initial = crossChainHintSpy.mock.lastCall![0] as {
      requiredAtomic: bigint;
    };
    expect(initial.requiredAtomic).toBe(1_100_000n);

    // preset[1] = 5 USDC をクリック → requiredAtomic = 5.10 USDC (5_100_000 atomic)
    // gas 0.1 のみ顧客上乗せ (fee は merchant 控除側、customerPays には含まれない)
    await user.click(screen.getByRole('button', { name: '5 USDC' }));
    await waitFor(() => {
      const latest = crossChainHintSpy.mock.lastCall![0] as {
        requiredAtomic: bigint;
      };
      expect(latest.requiredAtomic).toBe(5_100_000n);
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
      // 10 USDC + 0.10 gas (gas=customer mode) = 10.10 = 10_100_000 atomic
      // (fee 1% は merchant 控除側で customerPays には乗らない、calcBreakdown 仕様)
      expect(latest.requiredAtomic).toBe(10_100_000n);
    });
  });

  it('カスタム選択 + 未入力 → requiredAtomic = gas のみ (amount=0 でも gas は載る仕様)', async () => {
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
      // calcBreakdown 仕様: customerPays = amount + gasAmount = 0 + 100_000 = 100_000n
      // (gas は条件無しで顧客上乗せ、submit ボタンは別経路で no-amount を弾く UX 想定)
      expect(latest.requiredAtomic).toBe(100_000n);
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
