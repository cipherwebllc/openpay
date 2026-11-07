// /create の「受け取った通貨を換金」の折りたたみに置く「売上をほかのウォレットへ移す」(plans/store-sales-move.md §2.3)。
// flag OFF では page が部品を描かない (遅延読み込みの chunk も読まない = 完全 inert)。ON ではガス代の案内の直後に置く。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import ja from '@/messages/ja.json';

const loaded = vi.hoisted(() => ({ salesMove: 0 }));

// 遅延読み込みの部品は loader の中身 (import 先) で見分け、SalesMoveForm だけを印に置き換える。
vi.mock('next/dynamic', () => ({
  default: (loader: () => Promise<unknown>) => {
    if (!String(loader).includes('SalesMoveForm')) return () => null;
    return function SalesMoveFormMarker() {
      loaded.salesMove += 1;
      return <div data-testid="sales-move-form" />;
    };
  },
}));
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
vi.mock('@/components/BillingDueBanner', () => ({ BillingDueBanner: () => null }));
vi.mock('@/components/MiniHistoryRecent', () => ({ MiniHistoryRecent: () => null }));
vi.mock('@/components/QrGenerator', () => ({ QrGenerator: () => null }));
vi.mock('@/components/OrdersTabBadge', () => ({ OrdersTabBadge: () => null }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, enableSalesMove: false } };
});

import CreatePage from '@/app/[locale]/create/page';
import { env } from '@/lib/env';

beforeEach(() => {
  loaded.salesMove = 0;
  window.history.replaceState(null, '', '/ja/create');
});

describe('CreatePage: 売上をほかのウォレットへ移す', () => {
  it('flag OFF では描かない', () => {
    (env as { enableSalesMove: boolean }).enableSalesMove = false;
    renderWithIntl(<CreatePage />);
    // 換金の折りたたみ (gasHint) はいつもどおりある。
    expect(screen.getByText(ja.Create.offramp.gasHint.title)).toBeInTheDocument();
    expect(screen.queryByTestId('sales-move-form')).toBeNull();
    expect(loaded.salesMove).toBe(0);
  });

  it('flag ON では換金の折りたたみの中、ガス代の案内の直後に置く', () => {
    (env as { enableSalesMove: boolean }).enableSalesMove = true;
    renderWithIntl(<CreatePage />);
    const form = screen.getByTestId('sales-move-form');
    const gasHint = screen.getByText(ja.Create.offramp.gasHint.title).closest('details')!;
    expect(gasHint.nextElementSibling).toBe(form);
    // 換金の折りたたみ (外側の details) の中。
    expect(gasHint.parentElement!.closest('details')).toContainElement(form);
  });
});
