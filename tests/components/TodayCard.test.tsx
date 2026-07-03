import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import {
  localDateKey,
  TODAY_SUMMARY_KEY,
  type TodaySummary,
} from '@/lib/history';

// useAccount を mutable hoisted で差し替え (接続状態 / address を test ごとに切替)。
const account = vi.hoisted(() => ({
  address: undefined as string | undefined,
  isConnected: false,
}));
vi.mock('wagmi', () => ({
  useAccount: () => account,
}));

import { TodayCard } from '@/components/TodayCard';

const SHOP = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';

function storeSummary(overrides?: Partial<TodaySummary>): void {
  const summary: TodaySummary = {
    date: localDateKey(Date.now()),
    byMerchant: {
      [SHOP.toLowerCase()]: {
        count: 3,
        jpycAtomic: '1234000000000000000000', // 1234 JPYC (18 decimals)
        usdcAtomic: '0',
        lastTs: Date.now(),
      },
    },
    ...overrides,
  };
  window.localStorage.setItem(TODAY_SUMMARY_KEY, JSON.stringify(summary));
}

beforeEach(() => {
  window.localStorage.clear();
  account.address = undefined;
  account.isConnected = false;
});

describe('TodayCard', () => {
  it('未接続なら null (何も描画しない)', () => {
    storeSummary();
    const { container } = renderWithIntl(<TodayCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it('接続済でも merchant 不一致なら null (他人の端末履歴を出さない)', () => {
    storeSummary();
    account.isConnected = true;
    account.address = '0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb';
    const { container } = renderWithIntl(<TodayCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it('接続 wallet と当日 summary が一致 → 売上/件数/最終着金を描画', () => {
    storeSummary();
    account.isConnected = true;
    account.address = SHOP;
    renderWithIntl(<TodayCard />);
    expect(screen.getByText('今日の売上')).toBeInTheDocument();
    expect(screen.getByText('¥1,234')).toBeInTheDocument();
    expect(screen.getByText('3 件')).toBeInTheDocument();
    expect(screen.getByText(/最終着金/)).toBeInTheDocument();
  });

  it('タップ先は /{locale}/history', () => {
    storeSummary();
    account.isConnected = true;
    account.address = SHOP;
    renderWithIntl(<TodayCard />);
    expect(screen.getByRole('link')).toHaveAttribute('href', '/ja/history');
  });

  it('USDC 合計があれば $x.xx USDC を併記', () => {
    storeSummary({
      byMerchant: {
        [SHOP.toLowerCase()]: {
          count: 1,
          jpycAtomic: '0',
          usdcAtomic: '12340000', // 12.34 USDC (6 decimals)
          lastTs: Date.now(),
        },
      },
    });
    account.isConnected = true;
    account.address = SHOP;
    renderWithIntl(<TodayCard />);
    expect(screen.getByText('$12.34 USDC')).toBeInTheDocument();
  });

  it('USDC がゼロなら USDC 行を出さない', () => {
    storeSummary();
    account.isConnected = true;
    account.address = SHOP;
    renderWithIntl(<TodayCard />);
    expect(screen.queryByText(/USDC/)).not.toBeInTheDocument();
  });

  it('summary が前日 (date≠今日) なら null', () => {
    storeSummary({ date: '2000-01-01' });
    account.isConnected = true;
    account.address = SHOP;
    const { container } = renderWithIntl(<TodayCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it('count===0 の merchant は描画しない', () => {
    storeSummary({
      byMerchant: {
        [SHOP.toLowerCase()]: {
          count: 0,
          jpycAtomic: '0',
          usdcAtomic: '0',
          lastTs: Date.now(),
        },
      },
    });
    account.isConnected = true;
    account.address = SHOP;
    const { container } = renderWithIntl(<TodayCard />);
    expect(container).toBeEmptyDOMElement();
  });
});
