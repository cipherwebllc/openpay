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
function setPayment(state: 'idle' | 'pending' | 'success' | 'error') {
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
      state === 'error' ? new Error('AA21 didn\'t pay prefund') : null,
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
  mockHook(useGasQuoteUsdc, {
    data: state === 'ready' ? { gasAmount: amount ?? 100_000n } : undefined,
    isLoading: state === 'pending',
    isError: state === 'error',
    error: state === 'error' ? new Error('quote failed') : null,
  } as Partial<ReturnType<typeof useGasQuoteUsdc>>);
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
  vi.mocked(resolvePaymasterMode).mockImplementation((token) =>
    token === 'jpyc' ? 'sponsorship' : 'sponsorship',
  );
});

describe('PaymentForm — URL parse', () => {
  it('to が無い URL → エラー表示', () => {
    setURL('token=usdc&fee=include');
    render(<PaymentForm />);
    expect(screen.getByText(/決済 URL が不正/)).toBeInTheDocument();
    expect(screen.getByText(/to/)).toBeInTheDocument();
  });

  it('token が不正 → エラー表示', () => {
    setURL(`to=${MERCHANT}&token=eth&fee=include`);
    render(<PaymentForm />);
    expect(screen.getByText(/決済 URL が不正/)).toBeInTheDocument();
  });

  it('fee が不正 → エラー表示', () => {
    setURL(`to=${MERCHANT}&token=usdc&fee=tax-free`);
    render(<PaymentForm />);
    expect(screen.getByText(/決済 URL が不正/)).toBeInTheDocument();
  });
});

describe('PaymentForm — 金額の表示モード', () => {
  it('amount 指定 URL → 固定金額表示 (ヘッダ + 顧客支払額の 2 箇所)', () => {
    setURL(`to=${MERCHANT}&token=usdc&fee=include&amount=10`);
    render(<PaymentForm />);
    // ヘッダの大きな表示 + 明細「顧客支払額」で 2 件マッチ
    expect(screen.getAllByText('10 USDC').length).toBeGreaterThanOrEqual(2);
  });

  it('amount 無し URL → 入力フォーム表示', () => {
    setURL(`to=${MERCHANT}&token=usdc&fee=include`);
    render(<PaymentForm />);
    expect(screen.getByPlaceholderText('10.00')).toBeInTheDocument();
  });

  it('JPYC URL → JPYC 用プレースホルダ', () => {
    setURL(`to=${MERCHANT}&token=jpyc&fee=include`);
    render(<PaymentForm />);
    expect(screen.getByPlaceholderText('1000')).toBeInTheDocument();
  });
});

describe('PaymentForm — 手数料明細', () => {
  it('内税 (USDC, 100): 1.2% → merchant=98.8 / fee=1.2 / customer=100', () => {
    setURL(`to=${MERCHANT}&token=usdc&fee=include&amount=100`);
    render(<PaymentForm />);
    // merchant=98.8 はユニーク, fee=1.2 はユニーク, customer=100 はヘッダと共通 → 2件
    expect(screen.getByText('98.8 USDC')).toBeInTheDocument();
    expect(screen.getByText('1.2 USDC')).toBeInTheDocument();
    expect(screen.getAllByText('100 USDC').length).toBe(2);
  });

  it('外税 (USDC, 100): 1.2% → merchant=100 / fee=1.2 / customer=101.2', () => {
    setURL(`to=${MERCHANT}&token=usdc&fee=exclude&amount=100`);
    render(<PaymentForm />);
    // header=100 + 明細merchant=100 → 2件, customer=101.2 はユニーク
    expect(screen.getAllByText('100 USDC').length).toBe(2);
    expect(screen.getByText('1.2 USDC')).toBeInTheDocument();
    expect(screen.getByText('101.2 USDC')).toBeInTheDocument();
  });

  it('内税 (USDC, 5): 1.2% < MIN なので fee=0.2, merchant=4.8', () => {
    setURL(`to=${MERCHANT}&token=usdc&fee=include&amount=5`);
    render(<PaymentForm />);
    expect(screen.getByText('4.8 USDC')).toBeInTheDocument();
    expect(screen.getByText('0.2 USDC')).toBeInTheDocument();
  });
});

describe('PaymentForm — 接続状態によるボタン', () => {
  it('未接続 → 接続を促すラベル / 送信ボタン disabled', () => {
    setURL(`to=${MERCHANT}&token=usdc&fee=include&amount=10`);
    setAccount({ connected: false });
    render(<PaymentForm />);
    const btn = screen.getByRole('button', {
      name: /ウォレットを接続してください/,
    });
    expect(btn).toBeDisabled();
  });

  it('接続済 + 違うチェーン → ネットワーク切替ボタン表示 / 送信ボタンに切替メッセージ', () => {
    setURL(`to=${MERCHANT}&token=usdc&fee=include&amount=10`);
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
    setURL(`to=${MERCHANT}&token=usdc&fee=include&amount=10`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n); // 20 USDC, 必要分 (10 USDC) 以上
    setSmartAccount(true);
    render(<PaymentForm />);
    const btn = screen.getByRole('button', {
      name: /10 USDC を支払う/,
    });
    expect(btn).not.toBeDisabled();
  });

  it('残高不足 → 警告表示 + 送信ボタン disabled', () => {
    setURL(`to=${MERCHANT}&token=usdc&fee=include&amount=10`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(1_000_000n); // 1 USDC、必要 10 USDC
    setSmartAccount(true);
    render(<PaymentForm />);
    expect(screen.getByText(/残高が不足/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /10 USDC を支払う/ }),
    ).toBeDisabled();
  });

  it('Smart Account 初期化中 → 「初期化中…」ラベル', () => {
    setURL(`to=${MERCHANT}&token=usdc&fee=include&amount=10`);
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
  it('クリックで mutate に正しい引数が渡る (内税)', async () => {
    const user = userEvent.setup();
    setURL(`to=${MERCHANT}&token=usdc&fee=include&amount=100`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setPayment('idle');
    render(<PaymentForm />);

    await user.click(screen.getByRole('button', { name: /100 USDC を支払う/ }));

    expect(mutate).toHaveBeenCalledOnce();
    const call = mutate.mock.calls[0][0];
    expect(call.merchant.toLowerCase()).toBe(MERCHANT.toLowerCase());
    expect(call.merchantAmount).toBe(98_800_000n); // 100 - 1.2 USDC
    expect(call.feeAmount).toBe(1_200_000n);
    // FEE_RECEIVER は env 経由
    expect(call.feeReceiver.toLowerCase()).toBe(
      '0xdead000000000000000000000000000000001234',
    );
    // tokenAddress は USDC Base Sepolia
    expect(call.tokenAddress.toLowerCase()).toBe(
      '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
    );
  });

  it('外税: customer pays = amount + fee で mutate される', async () => {
    const user = userEvent.setup();
    setURL(`to=${MERCHANT}&token=usdc&fee=exclude&amount=100`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setPayment('idle');
    render(<PaymentForm />);

    await user.click(screen.getByRole('button', { name: /101.2 USDC を支払う/ }));
    const call = mutate.mock.calls[0][0];
    expect(call.merchantAmount).toBe(100_000_000n);
    expect(call.feeAmount).toBe(1_200_000n);
  });

  it('据え置き QR (amount 無し) で顧客が金額入力 → mutate に反映', async () => {
    const user = userEvent.setup();
    setURL(`to=${MERCHANT}&token=usdc&fee=include`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setPayment('idle');
    render(<PaymentForm />);

    await user.type(screen.getByPlaceholderText('10.00'), '50');
    await user.click(screen.getByRole('button', { name: /50 USDC を支払う/ }));

    const call = mutate.mock.calls[0][0];
    expect(call.merchantAmount).toBe(49_400_000n); // 50 - 0.6 USDC (1.2%)
    expect(call.feeAmount).toBe(600_000n);
  });

  it('送信中 → ボタンが「送信中…」かつ disabled', () => {
    setURL(`to=${MERCHANT}&token=usdc&fee=include&amount=10`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setPayment('pending');
    render(<PaymentForm />);
    expect(screen.getByRole('button', { name: /送信中/ })).toBeDisabled();
  });

  it('送信成功 → tx hash と block 番号が表示される', () => {
    setURL(`to=${MERCHANT}&token=usdc&fee=include&amount=10`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    setPayment('success');
    render(<PaymentForm />);
    expect(screen.getByText(/決済が完了しました/)).toBeInTheDocument();
    expect(screen.getByText(`0x${'a'.repeat(64)}`)).toBeInTheDocument();
    expect(screen.getByText(`0x${'b'.repeat(64)}`)).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('送信失敗 → エラーメッセージ表示', () => {
    setURL(`to=${MERCHANT}&token=usdc&fee=include&amount=10`);
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
      `to=${MERCHANT}&token=usdc&fee=include&amount=100&split=${B}:30,${C}:20`,
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

  it('split あり → mutate の extraRecipients が正しい (内税 100 USDC)', async () => {
    const user = userEvent.setup();
    setURL(
      `to=${MERCHANT}&token=usdc&fee=include&amount=100&split=${B}:30,${C}:20`,
    );
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setPayment('idle');
    render(<PaymentForm />);

    await user.click(
      screen.getByRole('button', { name: /100 USDC を支払う/ }),
    );

    expect(mutate).toHaveBeenCalledOnce();
    const call = mutate.mock.calls[0][0];
    // primary (MERCHANT) gets remainder (50%) of distributable 98.8 USDC = 49.4
    expect(call.merchant.toLowerCase()).toBe(MERCHANT.toLowerCase());
    expect(call.merchantAmount).toBe(49_400_000n);
    expect(call.feeAmount).toBe(1_200_000n);
    expect(call.extraRecipients).toHaveLength(2);
    expect(call.extraRecipients[0].to.toLowerCase()).toBe(B.toLowerCase());
    expect(call.extraRecipients[0].amount).toBe(29_640_000n);
    expect(call.extraRecipients[1].to.toLowerCase()).toBe(C.toLowerCase());
    expect(call.extraRecipients[1].amount).toBe(19_760_000n);
  });
});

describe('PaymentForm — 直接送金モード (mode=direct)', () => {
  it('警告バッジ「ガス代お客様負担」が表示される', () => {
    setURL(`to=${MERCHANT}&token=usdc&fee=include&amount=10&mode=direct`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    render(<PaymentForm />);
    expect(screen.getByText(/ガス代お客様負担/)).toBeInTheDocument();
    expect(screen.getByText(/POL|ETH/)).toBeInTheDocument();
  });

  it('明細から運営手数料行が消え、merchant=customer=amount で表示', () => {
    setURL(`to=${MERCHANT}&token=usdc&fee=include&amount=10&mode=direct`);
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
    setURL(`to=${MERCHANT}&token=usdc&fee=include&amount=10&mode=direct`);
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
    setURL(`to=${MERCHANT}&token=usdc&fee=include&amount=10&mode=direct`);
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
    setURL(`to=${MERCHANT}&token=usdc&fee=include&amount=10&mode=direct`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setDirectPayment('success');
    render(<PaymentForm />);
    expect(screen.getByText(/決済が完了しました/)).toBeInTheDocument();
    expect(screen.getByText(`0x${'c'.repeat(64)}`)).toBeInTheDocument();
    expect(screen.getByText('77')).toBeInTheDocument();
    expect(screen.queryByText('UserOp Hash')).toBeNull();
  });

  it('saError は direct モードでは UI に出ない', () => {
    setURL(`to=${MERCHANT}&token=usdc&fee=include&amount=10&mode=direct`);
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
    setURL(`to=${MERCHANT}&token=usdc&fee=include&amount=10&mode=direct`);
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
    vi.mocked(resolvePaymasterMode).mockImplementation((token) =>
      token === 'usdc' ? 'erc20' : 'sponsorship',
    );
  });

  it('gas 見積取得前: ボタンが「ガス代見積取得中…」で disabled', () => {
    setURL(`to=${MERCHANT}&token=usdc&fee=include&amount=100`);
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
    setURL(`to=${MERCHANT}&token=usdc&fee=exclude&amount=100`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 500_000n); // 0.5 USDC
    render(<PaymentForm />);

    expect(screen.getByText(/ネットワーク手数料/)).toBeInTheDocument();
    // gas 行の値: "最大 0.5 USDC"
    expect(screen.getByText(/最大 0\.5 USDC/)).toBeInTheDocument();
    // 顧客支払額 = 100 (merchant) + 1.2 (fee) + 0.5 (gas) = 101.7 USDC
    expect(screen.getByText('101.7 USDC')).toBeInTheDocument();
  });

  it('gas を含めた残高チェック: gas 込みで足りなければ「残高不足」', () => {
    setURL(`to=${MERCHANT}&token=usdc&fee=exclude&amount=100`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    // 残高 101 USDC、必要 101.7 USDC (100 + 1.2 fee + 0.5 gas) → 不足
    setBalance(101_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 500_000n);
    render(<PaymentForm />);
    expect(screen.getByText(/残高が不足/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /101.7 USDC を支払う/ }),
    ).toBeDisabled();
  });

  it('JPYC + erc20 mock 設定下でも JPYC 側は sponsorship 経路で gas 行が出ない', () => {
    setURL(`to=${MERCHANT}&token=jpyc&fee=include&amount=1000`);
    setAccount({ connected: true, chainId: polygonAmoy.id });
    setBalance(2000n * 10n ** 18n);
    setSmartAccount(true);
    setGasQuote('disabled');
    render(<PaymentForm />);
    expect(screen.queryByText(/ネットワーク手数料/)).toBeNull();
  });

  it('gaslessBatchHintUsdc が表示される (USDC paymaster の説明文)', () => {
    setURL(`to=${MERCHANT}&token=usdc&fee=include&amount=100`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready');
    render(<PaymentForm />);
    expect(
      screen.getByText(/USDC でお支払いいただきます/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/POL を保有する必要はありません/)).toBeNull();
  });

  it('mutate には gas を含めない (merchant + fee のみ — gas は paymaster 経由で別途引き落とされる)', async () => {
    const user = userEvent.setup();
    setURL(`to=${MERCHANT}&token=usdc&fee=exclude&amount=100`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 500_000n);
    setPayment('idle');
    render(<PaymentForm />);

    await user.click(
      screen.getByRole('button', { name: /101.7 USDC を支払う/ }),
    );

    expect(mutate).toHaveBeenCalledOnce();
    const call = mutate.mock.calls[0][0];
    // mutate には fee と merchant のみ。gas は paymaster が postOp で引くので
    // 明示的な transfer は組まない。
    expect(call.merchantAmount).toBe(100_000_000n);
    expect(call.feeAmount).toBe(1_200_000n);
    expect(call.extraRecipients).toBeUndefined();
  });

  it('gasQuote.error → エラーメッセージ表示 + ボタン disabled', () => {
    setURL(`to=${MERCHANT}&token=usdc&fee=include&amount=100`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('error');
    render(<PaymentForm />);

    expect(screen.getByText(/エラー/)).toBeInTheDocument();
    expect(screen.getByText(/quote failed/)).toBeInTheDocument();
    // gas quote が ready していないので button は loading 表示で disabled
    expect(
      screen.getByRole('button', { name: /ガス代見積取得中/ }),
    ).toBeDisabled();
  });

  it('境界: 残高 = 必要額 ちょうど → 支払い可能 (insufficient ではない)', () => {
    setURL(`to=${MERCHANT}&token=usdc&fee=exclude&amount=100`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    // 必要 101.7 USDC ぴったり
    setBalance(101_700_000n);
    setSmartAccount(true);
    setGasQuote('ready', 500_000n);
    render(<PaymentForm />);
    expect(screen.queryByText(/残高が不足/)).toBeNull();
    expect(
      screen.getByRole('button', { name: /101.7 USDC を支払う/ }),
    ).not.toBeDisabled();
  });

  it('境界: 残高 = 必要額 - 1 wei → insufficient', () => {
    setURL(`to=${MERCHANT}&token=usdc&fee=exclude&amount=100`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(101_700_000n - 1n);
    setSmartAccount(true);
    setGasQuote('ready', 500_000n);
    render(<PaymentForm />);
    expect(screen.getByText(/残高が不足/)).toBeInTheDocument();
  });

  it('direct mode + USDC params: 即時 ERC20 transfer なので gas 行が出ず gasQuote は呼ばれない', () => {
    setURL(`to=${MERCHANT}&token=usdc&fee=include&amount=10&mode=direct`);
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    // direct mode では erc20 mode mock 下でも gas を考慮しない
    setGasQuote('disabled');
    render(<PaymentForm />);

    // 「ネットワーク手数料」行は出ない (direct = paymaster 不使用)
    expect(screen.queryByText(/ネットワーク手数料/)).toBeNull();
    // direct 警告は出る
    expect(screen.getByText(/ガス代お客様負担/)).toBeInTheDocument();
    // useGasQuoteUsdc は enabled=false で呼ばれる (no fetch)
    expect(useGasQuoteUsdc).toHaveBeenCalledWith('usdc', false);
  });

  it('split + ERC20 mode: gas を含めた customer total と extraRecipients が両立', async () => {
    const user = userEvent.setup();
    const B = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    setURL(
      `to=${MERCHANT}&token=usdc&fee=exclude&amount=100&split=${B}:30`,
    );
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(200_000_000n);
    setSmartAccount(true);
    setGasQuote('ready', 500_000n); // 0.5 USDC
    setPayment('idle');
    render(<PaymentForm />);

    // 100 + 1.2 (fee) + 0.5 (gas) = 101.7 USDC
    expect(
      screen.getByRole('button', { name: /101.7 USDC を支払う/ }),
    ).not.toBeDisabled();

    await user.click(
      screen.getByRole('button', { name: /101.7 USDC を支払う/ }),
    );
    const call = mutate.mock.calls[0][0];
    // primary (MERCHANT) は 70%、B は 30% を 100 USDC から取る
    expect(call.merchantAmount).toBe(70_000_000n);
    expect(call.extraRecipients[0].to.toLowerCase()).toBe(B.toLowerCase());
    expect(call.extraRecipients[0].amount).toBe(30_000_000n);
    // gas は extraRecipients に含めない
    expect(call.extraRecipients).toHaveLength(1);
  });
});
