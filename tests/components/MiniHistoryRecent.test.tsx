import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import type { HistoryEntry } from '@/lib/history';

// useHistory を境界 mock。MiniHistoryRecent の rendering ロジック (slice(0,3) /
// 0 件 empty / 1+ 件 list + view-all link / hydrated guard) を verify する。
const useHistoryMock = vi.fn();
vi.mock('@/hooks/useHistory', () => ({
  useHistory: () => useHistoryMock(),
}));

import { MiniHistoryRecent } from '@/components/MiniHistoryRecent';

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    schemaVersion: 1,
    id: 'mini-' + Math.random(),
    ts: 1_700_000_000_000,
    flow: 'batch',
    status: 'success',
    chainId: 137,
    chainSlug: 'polygon',
    asset: 'jpyc',
    tokenAddress: '0xToken',
    payMode: 'gasless',
    gasMode: 'customer',
    merchant: '0xMerchant',
    merchantAmount: '1000000000000000000', // 1 JPYC (18 decimals)
    customer: '0xCustomer',
    feeReceiver: '0xFee',
    feeAmount: '10000000000000000',
    txHash: `0x${'a'.repeat(64)}`,
    userOpHash: null,
    blockNumber: '12345',
    errorMessage: null,
    storeName: '',
    note: '',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MiniHistoryRecent', () => {
  it('hydrated=false なら描画 skip (CLS placeholder のみ)', () => {
    useHistoryMock.mockReturnValue({ entries: [], hydrated: false });
    renderWithIntl(<MiniHistoryRecent />);
    expect(screen.queryByText('最近の取引 (最新 3 件)')).toBeNull();
  });

  it('0 件 → empty 文言が出て view-all link は出ない', () => {
    useHistoryMock.mockReturnValue({ entries: [], hydrated: true });
    renderWithIntl(<MiniHistoryRecent />);
    expect(screen.getByText('最近の取引 (最新 3 件)')).toBeInTheDocument();
    expect(
      screen.getByText(/このブラウザにはまだ取引履歴がありません/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /全件を見る/ })).toBeNull();
  });

  it('1 件 → 行が描画されて view-all link が出る', () => {
    useHistoryMock.mockReturnValue({
      entries: [entry({ id: 'e1' })],
      hydrated: true,
    });
    renderWithIntl(<MiniHistoryRecent />);
    expect(screen.getByText(/1 JPYC/)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /全件を見る/ });
    expect(link).toHaveAttribute('href', '/ja/history');
  });

  it('4 件 → 最初の 3 件のみ表示 (slice(0,3))', () => {
    const entries = [
      entry({ id: 'e1', merchantAmount: '1000000000000000000' }), // 1
      entry({ id: 'e2', merchantAmount: '2000000000000000000' }), // 2
      entry({ id: 'e3', merchantAmount: '3000000000000000000' }), // 3
      entry({ id: 'e4', merchantAmount: '4000000000000000000' }), // 4
    ];
    useHistoryMock.mockReturnValue({ entries, hydrated: true });
    renderWithIntl(<MiniHistoryRecent />);
    expect(screen.getByText(/1 JPYC/)).toBeInTheDocument();
    expect(screen.getByText(/2 JPYC/)).toBeInTheDocument();
    expect(screen.getByText(/3 JPYC/)).toBeInTheDocument();
    expect(screen.queryByText(/4 JPYC/)).toBeNull();
  });

  it('USDC entry: 6 decimals で整形される', () => {
    useHistoryMock.mockReturnValue({
      entries: [
        entry({
          id: 'usdc-1',
          asset: 'usdc',
          chainId: 8453,
          chainSlug: 'base',
          merchantAmount: '12500000', // 12.5 USDC (6 decimals)
        }),
      ],
      hydrated: true,
    });
    renderWithIntl(<MiniHistoryRecent />);
    expect(screen.getByText(/12\.5 USDC/)).toBeInTheDocument();
  });

  it('txHash 有り + 対応 chain → tx ↗ link が target=_blank で出る', () => {
    // vitest は NETWORK_ENV=testnet なので testnet chain (baseSepolia=84532) を使う
    useHistoryMock.mockReturnValue({
      entries: [
        entry({
          id: 'tx-1',
          txHash: `0x${'b'.repeat(64)}`,
          chainId: 84532,
          chainSlug: 'base',
          asset: 'usdc',
          merchantAmount: '5000000',
        }),
      ],
      hydrated: true,
    });
    renderWithIntl(<MiniHistoryRecent />);
    const tx = screen.getByRole('link', { name: /tx/ });
    expect(tx).toHaveAttribute('target', '_blank');
    expect(tx).toHaveAttribute('rel', 'noopener noreferrer');
    expect(tx.getAttribute('href')).toContain(`/tx/0x${'b'.repeat(64)}`);
  });

  it('txHash 無し → tx link は描画されない (view-all link だけ残る)', () => {
    useHistoryMock.mockReturnValue({
      entries: [entry({ id: 'no-tx', txHash: null, chainId: 84532 })],
      hydrated: true,
    });
    renderWithIntl(<MiniHistoryRecent />);
    // "tx" を含む link は 0 (view-all は "全件を見る")
    const txLinks = screen
      .queryAllByRole('link')
      .filter((el) => /\btx\b/.test(el.textContent ?? ''));
    expect(txLinks).toHaveLength(0);
  });

  it('en locale: view-all link href が /en/history、empty 文言が英語', () => {
    useHistoryMock.mockReturnValue({ entries: [], hydrated: true });
    renderWithIntl(<MiniHistoryRecent />, { locale: 'en' });
    expect(screen.getByText(/Recent transactions/)).toBeInTheDocument();
    expect(
      screen.getByText(/No transaction history in this browser yet/),
    ).toBeInTheDocument();
  });
});
