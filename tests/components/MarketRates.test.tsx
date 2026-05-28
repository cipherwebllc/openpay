import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';

// useMarketRates を境界 mock。MarketRates の rendering 4 分岐 (loading / data /
// error / unavailable but JPYC peg だけ残る) を検証する。
const useMarketRatesMock = vi.fn();
vi.mock('@/hooks/useMarketRates', () => ({
  useMarketRates: () => useMarketRatesMock(),
}));

import { MarketRates } from '@/components/MarketRates';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MarketRates', () => {
  it('isLoading=true → ローディング文言', () => {
    useMarketRatesMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    });
    renderWithIntl(<MarketRates />);
    expect(screen.getByText(/市場レート/)).toBeInTheDocument();
    expect(screen.getByText('レート取得中…')).toBeInTheDocument();
  });

  it('data 取得済 → 1 USDC = ¥X.XX + JPYC peg + 参考注記が出る', () => {
    useMarketRatesMock.mockReturnValue({
      data: { usdcJpy: 154.5, updatedAt: '2026-05-28T12:00:00Z' },
      isLoading: false,
      isError: false,
    });
    renderWithIntl(<MarketRates />);
    expect(screen.getByText(/1 USDC = ¥154\.50/)).toBeInTheDocument();
    expect(screen.getByText(/1 JPYC = ¥1\.00 \(peg 1:1\)/)).toBeInTheDocument();
    expect(screen.getByText(/CoinGecko/)).toBeInTheDocument();
  });

  it('大きな USDC レートで桁区切り (1543.21 → 1,543.21)', () => {
    useMarketRatesMock.mockReturnValue({
      data: { usdcJpy: 1543.21, updatedAt: '2026-05-28T12:00:00Z' },
      isLoading: false,
      isError: false,
    });
    renderWithIntl(<MarketRates />);
    expect(screen.getByText(/1 USDC = ¥1,543\.21/)).toBeInTheDocument();
  });

  it('isError=true → unavailable 文言 + JPYC peg は残る', () => {
    useMarketRatesMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });
    renderWithIntl(<MarketRates />);
    expect(
      screen.getByText('USDC のレートを取得できませんでした'),
    ).toBeInTheDocument();
    // JPYC peg は client-side fixed なのでエラーでも表示される
    expect(screen.getByText(/1 JPYC = ¥1\.00 \(peg 1:1\)/)).toBeInTheDocument();
    // USDC レート表記は出ない
    expect(screen.queryByText(/1 USDC = ¥/)).toBeNull();
  });

  it('en locale: usdcRate / referenceNote / unavailable が英語', () => {
    useMarketRatesMock.mockReturnValue({
      data: { usdcJpy: 154.5, updatedAt: '2026-05-28T12:00:00Z' },
      isLoading: false,
      isError: false,
    });
    renderWithIntl(<MarketRates />, { locale: 'en' });
    expect(screen.getByText(/Market rate \(reference\)/)).toBeInTheDocument();
    expect(screen.getByText(/1 USDC = ¥154\.50/)).toBeInTheDocument();
    expect(screen.getByText(/via CoinGecko/)).toBeInTheDocument();
  });
});
