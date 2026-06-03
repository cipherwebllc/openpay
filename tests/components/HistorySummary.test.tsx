import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
import { HistorySummary } from '@/components/HistorySummary';
import type { HistorySummary as Summary } from '@/lib/historyFilters';

function summary(o: Partial<Summary> = {}): Summary {
  return {
    counts: { success: 2, reverted: 1, error: 0, pending: 0, total: 3 },
    tokenTotals: { jpyc: '1000000000000000000000', usdc: '6400000' },
    gmvYen: 2500,
    gmvHasApprox: false,
    gmvUnavailableCount: 0,
    ...o,
  };
}

describe('HistorySummary', () => {
  it('件数行・トークン別合計・円換算 GMV を表示', () => {
    render(<HistorySummary summary={summary()} />);
    expect(screen.getByText(/総数 3 件/)).toBeInTheDocument();
    expect(screen.getByText('1000 JPYC')).toBeInTheDocument(); // jpyc 合計
    expect(screen.getByText('6.4 USDC')).toBeInTheDocument(); // usdc 合計
    expect(screen.getByText(/¥2,500/)).toBeInTheDocument(); // GMV
    expect(screen.queryByText('概算含む')).toBeNull();
  });

  it('approx 含む → 「概算含む」chip', () => {
    render(<HistorySummary summary={summary({ gmvHasApprox: true })} />);
    expect(screen.getByText('概算含む')).toBeInTheDocument();
  });

  it('GMV null (レート取得不可) → — 表示・¥ は出ない', () => {
    render(
      <HistorySummary
        summary={summary({ gmvYen: null, gmvUnavailableCount: 1 })}
      />,
    );
    expect(screen.getByText(/為替レート取得不可/)).toBeInTheDocument();
    expect(screen.queryByText(/¥2,500/)).toBeNull();
  });
});
