import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import type { TokenChainBalance } from '@/lib/walletBalances';

// hook を境界 mock し、WalletBalances の描画ロジック (非ゼロ抽出 / トークン別
// グループ / 整形 / loading・empty・partial-error) を検証する。
const useWalletTokenBalances = vi.fn();
vi.mock('@/hooks/useWalletTokenBalances', () => ({
  useWalletTokenBalances: () => useWalletTokenBalances(),
}));

import { WalletBalances } from '@/components/WalletBalances';

// testnet chainId (supportedChains に存在 = chainNameForId が解決できる)。
const BASE_SEPOLIA = 84532;
const OP_SEPOLIA = 11155420;
const POLYGON_AMOY = 80002;

function bal(
  symbol: 'usdc' | 'jpyc',
  chainId: number,
  balance: bigint,
  status: 'ok' | 'error' = 'ok',
): TokenChainBalance {
  const decimals = symbol === 'usdc' ? 6 : 18;
  return {
    deployment: {
      symbol,
      displaySymbol: symbol.toUpperCase(),
      name: symbol,
      decimals,
      address: '0x0000000000000000000000000000000000000001',
      chainId,
      paymasterMode: symbol === 'usdc' ? 'erc20' : 'sponsorship',
    },
    status,
    balance,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('WalletBalances', () => {
  it('ローディング中は確認中メッセージ', () => {
    useWalletTokenBalances.mockReturnValue({ data: undefined, isLoading: true });
    renderWithIntl(<WalletBalances />);
    expect(screen.getByText('残高を確認中…')).toBeInTheDocument();
  });

  it('data 未取得 (非ローディング) は何も描画しない', () => {
    useWalletTokenBalances.mockReturnValue({ data: undefined, isLoading: false });
    const { container } = renderWithIntl(<WalletBalances />);
    expect(container).toBeEmptyDOMElement();
  });

  it('非ゼロ残高をフラット表示し、各行に金額 + トークン記号サフィックスを出す', () => {
    useWalletTokenBalances.mockReturnValue({
      isLoading: false,
      data: [
        bal('usdc', BASE_SEPOLIA, 12_500_000n), // 12.50
        bal('usdc', OP_SEPOLIA, 20_000_000n), // 20.00
        bal('jpyc', POLYGON_AMOY, 1000n * 10n ** 18n), // 1,000
      ],
    });
    renderWithIntl(<WalletBalances />);

    expect(screen.getByText('保有残高')).toBeInTheDocument();
    // グループ見出しは廃止。記号は各行のサフィックスとして出る (USDC×2 行 / JPYC×1 行)。
    expect(screen.getAllByText('USDC')).toHaveLength(2);
    expect(screen.getAllByText('JPYC')).toHaveLength(1);
    // 金額は記号と別 span (数字のみのノード)。USDC は小数 2 桁、JPYC は整数 + 桁区切り。
    expect(screen.getByText('12.50')).toBeInTheDocument();
    expect(screen.getByText('20.00')).toBeInTheDocument();
    expect(screen.getByText('1,000')).toBeInTheDocument();
    // 並び順: JPYC (日本のホームトークン) を先頭、USDC を後に。
    const items = screen.getAllByRole('listitem');
    expect(items[0].textContent).toContain('JPYC');
    expect(items[items.length - 1].textContent).toContain('USDC');
  });

  it('ゼロ残高は表示しない (非ゼロのみ)', () => {
    useWalletTokenBalances.mockReturnValue({
      isLoading: false,
      data: [
        bal('usdc', BASE_SEPOLIA, 0n),
        bal('usdc', OP_SEPOLIA, 7_000_000n), // 7.00
      ],
    });
    renderWithIntl(<WalletBalances />);
    expect(screen.getByText('7.00')).toBeInTheDocument();
    // 0 のチェーン分は出ない (USDC グループは 1 行のみ)
    expect(screen.queryByText('0.00')).not.toBeInTheDocument();
  });

  it('全ゼロは empty 文言', () => {
    useWalletTokenBalances.mockReturnValue({
      isLoading: false,
      data: [bal('usdc', BASE_SEPOLIA, 0n), bal('jpyc', POLYGON_AMOY, 0n)],
    });
    renderWithIntl(<WalletBalances />);
    expect(
      screen.getByText('対応トークン (JPYC / USDC) の残高がありません。'),
    ).toBeInTheDocument();
  });

  it('取得失敗 chain があれば partial-error 注記を出す', () => {
    useWalletTokenBalances.mockReturnValue({
      isLoading: false,
      data: [
        bal('usdc', BASE_SEPOLIA, 5_000_000n),
        bal('usdc', OP_SEPOLIA, 0n, 'error'),
      ],
    });
    renderWithIntl(<WalletBalances />);
    expect(screen.getByText('5.00')).toBeInTheDocument();
    expect(
      screen.getByText('一部のチェーンは残高を取得できませんでした。'),
    ).toBeInTheDocument();
  });
});
