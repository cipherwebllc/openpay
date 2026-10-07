import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';

vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
vi.mock('@/components/BillingDueBanner', () => ({ BillingDueBanner: () => null }));
vi.mock('@/components/MarketRates', () => ({ MarketRates: () => null }));
vi.mock('@/components/MiniHistoryRecent', () => ({ MiniHistoryRecent: () => null }));
vi.mock('@/components/QrGenerator', () => ({ QrGenerator: () => <p>qr-panel</p> }));
vi.mock('@/components/OrdersTabBadge', () => ({ OrdersTabBadge: () => null }));
const hold = vi.hoisted(() => ({ busy: true }));
vi.mock('@/components/StoreDeviceProvider', () => ({
  StoreDeviceProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useStoreDeviceMode: () => ({ device: { busy: hold.busy } }),
}));

import CreatePage from '@/app/[locale]/create/page';

describe('作成ページ × お店の端末で送る', () => {
  it('お店の端末が送っている・結果を待っている間は、タブを切り替えずに理由を出す', () => {
    hold.busy = true;
    renderWithIntl(<CreatePage />);
    expect(screen.getByText('qr-panel')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'レジ' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/結果が出るまでタブを切り替えられません/);
    expect(screen.getByText('qr-panel')).toBeTruthy(); // 決済QR タブのまま
  });

  it('送っていなければ、いつもどおり切り替わる', () => {
    hold.busy = false;
    renderWithIntl(<CreatePage />);
    fireEvent.click(screen.getByRole('button', { name: 'レジ' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('qr-panel')).toBeNull();
  });
});
