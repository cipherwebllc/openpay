import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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

import { useAccount, useReadContract, useSwitchChain } from 'wagmi';
import { useSmartAccount } from '@/hooks/useSmartAccount';
import { useBatchPayment } from '@/hooks/useBatchPayment';
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

beforeEach(() => {
  vi.clearAllMocks();
  setSwitchChain();
  setBalance(undefined);
  setSmartAccount(false);
  setBatchPayment('idle');
  setAccount({ connected: false });
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
    expect(screen.getByRole('button', { name: '1 USDC' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '5 USDC' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '10 USDC' })).toBeInTheDocument();
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
  const dt = screen.getByText(label);
  const row = dt.parentElement!;
  expect(within(row).getByText(value)).toBeInTheDocument();
}

describe('TipForm — 金額選択', () => {
  it('既定で最初の preset が選択され、明細に反映 (JPYC 100)', () => {
    render(<TipForm params={JPYC_PARAMS} />);
    // 100 JPYC tip / 外税 / MIN_FEE 15 → fan pays 115, creator gets 100, fee 15
    expectBreakdownRow('クリエイター受取', '100 JPYC');
    expectBreakdownRow(/運営手数料/, '15 JPYC');
    expectBreakdownRow('あなたの支払額', '115 JPYC');
  });

  it('別 preset をクリック → 明細が切替', async () => {
    const user = userEvent.setup();
    render(<TipForm params={JPYC_PARAMS} />);
    await user.click(screen.getByRole('button', { name: '1000 JPYC' }));
    // 1000 JPYC tip / 外税 / 1% = 10, MIN 15 → fee = 15, fan pays 1015
    expectBreakdownRow('クリエイター受取', '1000 JPYC');
    expectBreakdownRow(/運営手数料/, '15 JPYC');
    expectBreakdownRow('あなたの支払額', '1015 JPYC');
  });

  it('カスタム入力 → preset が deselect され、明細に反映 (USDC 50)', async () => {
    const user = userEvent.setup();
    render(<TipForm params={USDC_PARAMS} />);
    const customInput = screen.getByPlaceholderText('例: 7.50');
    await user.type(customInput, '50');
    // 50 USDC / 外税 / 1% = 0.5 USDC > MIN 0.1 → fee 0.5, fan pays 50.5
    expectBreakdownRow('クリエイター受取', '50 USDC');
    expectBreakdownRow(/運営手数料/, '0.5 USDC');
    expectBreakdownRow('あなたの支払額', '50.5 USDC');
  });

  it('カスタム入力後に preset へ戻すと反映', async () => {
    const user = userEvent.setup();
    render(<TipForm params={USDC_PARAMS} />);
    await user.type(screen.getByPlaceholderText('例: 7.50'), '50');
    await user.click(screen.getByRole('button', { name: '5 USDC' }));
    // 5 USDC / 外税 / 1% = 0.05 < MIN 0.1 → fee 0.1, fan pays 5.1
    expectBreakdownRow('クリエイター受取', '5 USDC');
    expectBreakdownRow(/運営手数料/, '0.1 USDC');
    expectBreakdownRow('あなたの支払額', '5.1 USDC');
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
    render(<TipForm params={USDC_PARAMS} />);
    // 既定 preset = 1 USDC, customer pays 1.1 USDC (fee 0.1)
    expect(
      screen.getByRole('button', { name: /1.1 USDC を送る/ }),
    ).not.toBeDisabled();
  });

  it('残高不足 → 警告 + 送信 disabled', () => {
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(500_000n); // 0.5 USDC < 1.1 needed
    setSmartAccount(true);
    render(<TipForm params={USDC_PARAMS} />);
    expect(screen.getByText(/残高が不足/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /1.1 USDC を送る/ }),
    ).toBeDisabled();
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
  it('クリックで mutate に正しい引数が渡る (preset 5 USDC)', async () => {
    const user = userEvent.setup();
    setAccount({ connected: true, chainId: baseSepolia.id });
    setBalance(20_000_000n);
    setSmartAccount(true);
    render(<TipForm params={USDC_PARAMS} />);

    await user.click(screen.getByRole('button', { name: '5 USDC' }));
    await user.click(screen.getByRole('button', { name: /5.1 USDC を送る/ }));

    expect(mutate).toHaveBeenCalledOnce();
    const call = mutate.mock.calls[0][0];
    expect(call.merchant.toLowerCase()).toBe(CREATOR.toLowerCase());
    // 外税: creator gets full preset (5 USDC), fee = MIN 0.1 USDC
    expect(call.merchantAmount).toBe(5_000_000n);
    expect(call.feeAmount).toBe(100_000n);
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
    render(<TipForm params={USDC_PARAMS} />);

    await user.type(screen.getByPlaceholderText('例: 7.50'), '50');
    await user.click(screen.getByRole('button', { name: /50.5 USDC を送る/ }));

    const call = mutate.mock.calls[0][0];
    expect(call.merchantAmount).toBe(50_000_000n);
    expect(call.feeAmount).toBe(500_000n); // 1% of 50 USDC
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
    expect(screen.getByText(/チップを送信しました/)).toBeInTheDocument();
    expect(screen.getByText(`0x${'a'.repeat(64)}`)).toBeInTheDocument();
    expect(screen.getByText(`0x${'b'.repeat(64)}`)).toBeInTheDocument();
    expect(screen.getByText('99')).toBeInTheDocument();
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
