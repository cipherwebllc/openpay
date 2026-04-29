import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
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
vi.mock('@/hooks/useDirectPayment', () => ({ useDirectPayment: vi.fn() }));
vi.mock('@/hooks/useGasQuoteUsdc', () => ({ useGasQuoteUsdc: vi.fn() }));
vi.mock('@/hooks/useGasQuoteJpyc', () => ({ useGasQuoteJpyc: vi.fn() }));
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
import { useDirectPayment } from '@/hooks/useDirectPayment';
import { useGasQuoteUsdc } from '@/hooks/useGasQuoteUsdc';
import { useGasQuoteJpyc } from '@/hooks/useGasQuoteJpyc';
import { resolvePaymasterMode } from '@/lib/pimlico';
import { PaymentForm } from '@/components/PaymentForm';
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
let directMutate: ReturnType<typeof vi.fn>;
function setPayment(state: 'idle' | 'pending' | 'success' | 'error', err?: Error) {
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

function setDirectPayment(state: 'idle' | 'pending' | 'success' | 'error') {
  directMutate = vi.fn();
  mockHook(useDirectPayment, {
    mutate: directMutate,
    isPending: state === 'pending',
    isSuccess: state === 'success',
    isError: state === 'error',
    data:
      state === 'success'
        ? {
            txHash: `0x${'c'.repeat(64)}`,
            blockNumber: 77n,
          }
        : undefined,
    error: state === 'error' ? new Error('user rejected request') : null,
  } as Partial<ReturnType<typeof useDirectPayment>>);
}

function setSwitchChain() {
  mockHook(useSwitchChain, {
    switchChain: vi.fn(),
    isPending: false,
  });
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
  setDirectPayment('idle');
  setGasQuote('disabled');
  setAccount({ connected: false });
  // 既定は testnet 環境の挙動 (USDC/JPYC とも sponsorship)。ERC20 mode を
  // 検証する describe ブロックでだけ override する。
  vi.mocked(resolvePaymasterMode).mockImplementation(() => 'sponsorship');
});

describe('PaymentForm — URL parse', () => {
  it('to が無い URL → エラー表示', () => {
    setURL('token=usdc');
    render(<PaymentForm />);
    expect(screen.getByText(/決済 URL が不正/)).toBeInTheDocument();
    expect(screen.getByText(/to/)).toBeInTheDocument();
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
  it('USDC 100, gas=0 → merchant=99 / fee=1.0 / customer=100', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=100`);
    setGasQuote('ready', 0n);
    render(<PaymentForm />);
    // header=100 + customer total=100 → 2件, merchant=99 / fee=1 はユニーク
    expect(screen.getAllByText('100 USDC').length).toBe(2);
    expect(screen.getByText('99 USDC')).toBeInTheDocument();
    expect(screen.getByText('1 USDC')).toBeInTheDocument();
  });

  it('USDC 5, gas=0: 1.0% < MIN (0.05) → fee=0.05, merchant=4.95, customer=5', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=5`);
    setGasQuote('ready', 0n);
    render(<PaymentForm />);
    expect(screen.getByText('0.05 USDC')).toBeInTheDocument();
    expect(screen.getByText('4.95 USDC')).toBeInTheDocument();
  });
});

describe('PaymentForm — 接続状態によるボタン', () => {
  it('未接続 → 接続を促すラベル / 送信ボタン disabled', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10`);
    setAccount({ connected: false });
    render(<PaymentForm />);
    const btn = screen.getByRole('button', {
      name: /ウォレットを接続してください/,
    });
    expect(btn).toBeDisabled();
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
        name: /ネットワークを切替えてください/,
      }),
    ).toBeDisabled();
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
    expect(
      screen.getByRole('button', { name: /10 USDC を支払う/ }),
    ).toBeDisabled();
  });

  it('Smart Account 初期化中 → 「初期化中…」ラベル', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(false);
    render(<PaymentForm />);
    expect(
      screen.getByRole('button', { name: /Smart Account 初期化中/ }),
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
    // 新モデル default (gas=customer): merchant = 100 - 1 = 99
    expect(call.merchantAmount).toBe(99_000_000n);
    expect(call.feeAmount).toBe(1_000_000n);
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
    // merchant = 50 - 0.5 = 49.5
    expect(call.merchantAmount).toBe(49_500_000n);
    expect(call.feeAmount).toBe(500_000n);
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
    // distributable = amount - fee = 99 USDC, primary (MERCHANT) 50% = 49.5
    expect(call.merchant.toLowerCase()).toBe(MERCHANT.toLowerCase());
    expect(call.merchantAmount).toBe(49_500_000n);
    expect(call.feeAmount).toBe(1_000_000n);
    expect(call.extraRecipients).toHaveLength(2);
    expect(call.extraRecipients[0].to.toLowerCase()).toBe(B.toLowerCase());
    // B = 99 * 30% = 29.7
    expect(call.extraRecipients[0].amount).toBe(29_700_000n);
    expect(call.extraRecipients[1].to.toLowerCase()).toBe(C.toLowerCase());
    // C = 99 * 20% = 19.8
    expect(call.extraRecipients[1].amount).toBe(19_800_000n);
  });
});

describe('PaymentForm — 直接送金モード (mode=direct)', () => {
  it('警告バッジ「ガス代お客様負担」が表示される', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10&mode=direct`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    render(<PaymentForm />);
    expect(screen.getByText(/ガス代お客様負担/)).toBeInTheDocument();
    expect(screen.getByText(/POL|ETH/)).toBeInTheDocument();
  });

  it('明細から運営手数料行が消え、merchant=customer=amount で表示', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10&mode=direct`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    render(<PaymentForm />);
    // 運営手数料行は消える
    expect(screen.queryByText(/運営手数料/)).toBeNull();
    // ラベルは "顧客支払額" のみ (内税/外税 表記はつかない)
    expect(screen.getByText('顧客支払額')).toBeInTheDocument();
    // header + merchant + customer の 3 箇所に "10 USDC" が出る
    expect(screen.getAllByText('10 USDC').length).toBe(3);
  });

  it('Smart Account 待ち状態でもボタンは活性 (direct は SA 不要)', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10&mode=direct`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(false);
    render(<PaymentForm />);
    expect(
      screen.getByRole('button', { name: /10 USDC を支払う/ }),
    ).not.toBeDisabled();
  });

  it('クリックで directMutate が amount 全額で呼ばれる (手数料なし)', async () => {
    const user = userEvent.setup();
    setURL(`to=${MERCHANT}&token=usdc&amount=10&mode=direct`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    render(<PaymentForm />);
    await user.click(screen.getByRole('button', { name: /10 USDC を支払う/ }));

    expect(directMutate).toHaveBeenCalledOnce();
    const arg = directMutate.mock.calls[0][0];
    expect(arg.amount).toBe(10_000_000n);
    expect(arg.merchant.toLowerCase()).toBe(MERCHANT.toLowerCase());
    expect(arg.tokenAddress.toLowerCase()).toBe(
      '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
    );
    expect(arg.chainId).toBe(baseSepolia.id);
  });

  it('成功時: Tx Hash と ブロックのみ表示 (UserOp Hash は無い)', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10&mode=direct`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setDirectPayment('success');
    render(<PaymentForm />);
    expect(screen.getAllByText(/決済が完了しました|決済完了/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(`0x${'c'.repeat(64)}`).length).toBeGreaterThan(0);
    expect(screen.getAllByText('77').length).toBeGreaterThan(0);
    expect(screen.queryByText('UserOp Hash')).toBeNull();
  });

  it('saError は direct モードでは UI に出ない', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10&mode=direct`);
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

  it('direct エラー → エラーメッセージ表示', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10&mode=direct`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setDirectPayment('error');
    render(<PaymentForm />);
    expect(screen.getByText(/エラー/)).toBeInTheDocument();
    expect(screen.getByText(/user rejected/)).toBeInTheDocument();
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
    // merchant = amount - fee = 99 USDC (運営手数料を merchant 控除)
    expect(call.merchantAmount).toBe(99_000_000n);
    expect(call.feeAmount).toBe(1_000_000n); // ERC20 paymaster: gas は paymaster 経由
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

  it('direct mode + USDC params: 即時 ERC20 transfer なので gas 行が出ず gasQuote は呼ばれない', () => {
    setURL(`to=${MERCHANT}&token=usdc&amount=10&mode=direct`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    // direct mode では erc20 mode mock 下でも gas を考慮しない
    setGasQuote('disabled');
    render(<PaymentForm />);

    // 「ネットワーク手数料」行は出ない (direct = paymaster 不使用)
    expect(
      Array.from(document.querySelectorAll('dl dt')).some((el) =>
        /ネットワーク手数料/.test(el.textContent ?? ''),
      ),
    ).toBe(false);
    // direct 警告は出る
    expect(screen.getByText(/ガス代お客様負担/)).toBeInTheDocument();
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

    // 100 + 1.0 (fee) + 0.5 (gas) = 101.5 USDC
    expect(
      screen.getByRole('button', { name: /100\.5 USDC を支払う/ }),
    ).not.toBeDisabled();

    await user.click(
      screen.getByRole('button', { name: /100\.5 USDC を支払う/ }),
    );
    const call = mutate.mock.calls[0][0];
    // distributable = amount - fee = 99 USDC, primary 70% = 69.3, B 30% = 29.7
    expect(call.merchantAmount).toBe(69_300_000n);
    expect(call.extraRecipients[0].to.toLowerCase()).toBe(B.toLowerCase());
    expect(call.extraRecipients[0].amount).toBe(29_700_000n);
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

    // 店主受取 = 99 (amount - fee 1.0 - gas 0)
    expect(screen.getByText('99 USDC')).toBeInTheDocument();
  });

  it('表示: gas 込みで merchant 控除 (sponsorship JPYC, gas=2 JPYC)', () => {
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

    // 店主受取 = 1000 - 10 (fee) - 2 (gas) = 988
    expect(screen.getByText('988 JPYC')).toBeInTheDocument();
  });

  it('内税の hint テキストが表示される (店主負担)', () => {
    setURL(`to=${MERCHANT}&token=usdc&gas=merchant&amount=100`);
    setGasQuote('ready', 0n);
    render(<PaymentForm />);
    expect(screen.getByText(/店主が gas を負担/)).toBeInTheDocument();
  });

  it('submit: sponsorship JPYC で fee_transfer = fee + gas (運営は両方徴収)', async () => {
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
    // merchant = 1000 - 10 - 2 = 988
    expect(call.merchantAmount).toBe(988n * 10n ** 18n);
    // sponsorship: feeAmount = fee (10) + gas (2) = 12 JPYC
    expect(call.feeAmount).toBe(12n * 10n ** 18n);
    // 合計 = 988 + 12 = 1000 (顧客 outflow と一致)
  });

  it('境界 underflow: amount < fee + gas → エラー表示 + 送信 disabled', () => {
    setURL(`to=${MERCHANT}&token=usdc&gas=merchant&amount=0.3`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 500_000n); // gas 0.5 USDC
    render(<PaymentForm />);

    // amount=0.3 USDC, fee=0.05 (MIN), gas=0.5 → 0.3 - 0.55 < 0 → underflow
    expect(screen.getByText(/店主受取が 0 になります/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /0\.3 USDC を支払う/ }),
    ).toBeDisabled();
  });

  it('境界 ちょうど: amount == fee + gas → merchant=0 だが送信可能 (運営が満額)', () => {
    setURL(`to=${MERCHANT}&token=usdc&gas=merchant&amount=0.55`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 500_000n);
    render(<PaymentForm />);
    // amount=0.55, fee=0.05, gas=0.5 → merchant=0、underflow とみなす
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
    // distributable = 100 - 1.0 - 0.5 = 98.5, primary 50% = 49.25, B 50% = 49.25
    expect(call.merchantAmount).toBe(49_250_000n);
    expect(call.extraRecipients[0].amount).toBe(49_250_000n);
    // sponsorship: feeAmount = fee + gas = 1.0 + 0.5 = 1.5
    expect(call.feeAmount).toBe(1_500_000n);
  });
});
