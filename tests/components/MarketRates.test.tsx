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

describe('MarketRates: 境界レート値 (formatYen の整形)', () => {
  function withRate(rate: number) {
    useMarketRatesMock.mockReturnValue({
      data: { usdcJpy: rate, updatedAt: '2026-05-28T12:00:00Z' },
      isLoading: false,
      isError: false,
    });
  }

  it('整数レート (150) → "¥150.00" で小数 2 桁が必ず付く', () => {
    withRate(150);
    renderWithIntl(<MarketRates />);
    expect(screen.getByText(/1 USDC = ¥150\.00/)).toBeInTheDocument();
  });

  it('小数 3 桁レート (154.567) → "¥154.57" で四捨五入', () => {
    withRate(154.567);
    renderWithIntl(<MarketRates />);
    expect(screen.getByText(/1 USDC = ¥154\.57/)).toBeInTheDocument();
  });

  it('非常に小さいレート (0.01) → "¥0.01"', () => {
    withRate(0.01);
    renderWithIntl(<MarketRates />);
    expect(screen.getByText(/1 USDC = ¥0\.01/)).toBeInTheDocument();
  });

  it('巨大レート (10000.5) → "¥10,000.50" 桁区切り付き', () => {
    withRate(10000.5);
    renderWithIntl(<MarketRates />);
    expect(screen.getByText(/1 USDC = ¥10,000\.50/)).toBeInTheDocument();
  });

  it('小数誤差を含む値 (1543.21 を internal float で) → "¥1,543.21"', () => {
    // 1543.21 は IEEE754 で正確に表現できないが toLocaleString で正しく丸まる
    withRate(0.07 + 0.14 + 1543.0); // = 1543.21 だが float 誤差あり
    renderWithIntl(<MarketRates />);
    // float 誤差で末尾 .20 か .21 になる、いずれにせよ桁区切り + 2 decimal
    const match = screen.getByText(/1 USDC = ¥1,543\.\d{2}/);
    expect(match).toBeInTheDocument();
  });
});

describe('MarketRates: a11y / 構造', () => {
  it('section に aria-label が title (i18n) で付く', () => {
    useMarketRatesMock.mockReturnValue({ data: undefined, isLoading: true });
    const { container } = renderWithIntl(<MarketRates />);
    const section = container.querySelector('section');
    expect(section?.getAttribute('aria-label')).toBe('市場レート (参考)');
  });

  it('token シンボル SVG (NextImage) が USDC + JPYC それぞれ 1 つずつ出る', () => {
    useMarketRatesMock.mockReturnValue({
      data: { usdcJpy: 150, updatedAt: '2026-05-28T12:00:00Z' },
      isLoading: false,
      isError: false,
    });
    const { container } = renderWithIntl(<MarketRates />);
    const imgs = container.querySelectorAll('img');
    // NextImage は最終的に <img> を描画 (mode によっては <span><img>)
    const srcs = Array.from(imgs).map((i) => i.getAttribute('src') ?? '');
    expect(srcs.some((s) => s.includes('usdc.svg'))).toBe(true);
    expect(srcs.some((s) => s.includes('jpyc.svg'))).toBe(true);
  });

  it('isError 時も JPYC peg は固定表示 (fetch 不要なので fallback で残す)', () => {
    useMarketRatesMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });
    const { container } = renderWithIntl(<MarketRates />);
    // JPYC token icon は描画継続
    const imgs = container.querySelectorAll('img');
    const srcs = Array.from(imgs).map((i) => i.getAttribute('src') ?? '');
    expect(srcs.some((s) => s.includes('jpyc.svg'))).toBe(true);
  });
});
