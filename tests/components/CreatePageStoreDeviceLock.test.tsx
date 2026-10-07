import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
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
const flag = vi.hoisted(() => ({ on: true }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (target, key) => (key === 'enableStoreGasWallet' ? flag.on : Reflect.get(target, key)),
    }),
  };
});
const hold = vi.hoisted(() => ({
  busy: true,
  pending: false,
  leave: vi.fn(async () => true),
}));
vi.mock('@/components/StoreDeviceProvider', () => ({
  StoreDeviceProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useStoreDeviceMode: () => ({
    device: { busy: hold.busy, state: { phase: 'idle' }, hasPendingSale: () => hold.pending, leave: hold.leave },
  }),
}));

import CreatePage from '@/app/[locale]/create/page';

describe('作成ページ × お店の端末で送る', () => {
  beforeEach(() => {
    flag.on = true;
    hold.busy = false;
    hold.pending = false;
    hold.leave.mockReset().mockResolvedValue(true);
  });

  it('お店の端末が送っている・結果を待っている間は、タブを切り替えずに理由を出す', () => {
    hold.busy = true;
    renderWithIntl(<CreatePage />);
    expect(screen.getByText('qr-panel')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'レジ' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/結果が出るまでタブを切り替えられません/);
    expect(screen.getByText('qr-panel')).toBeTruthy(); // 決済QR タブのまま
  });

  it('送っていなければ、いつもどおり切り替わる (締め切る受け渡しが無ければ通信しない)', () => {
    renderWithIntl(<CreatePage />);
    fireEvent.click(screen.getByRole('button', { name: 'レジ' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('qr-panel')).toBeNull();
    expect(hold.leave).not.toHaveBeenCalled();
  });

  it('flag OFF ではお店の端末の状態を見ない (締め切りの通信もしない・今までどおり切り替わる)', () => {
    flag.on = false;
    hold.busy = true;
    hold.pending = true;
    renderWithIntl(<CreatePage />);
    fireEvent.click(screen.getByRole('button', { name: 'レジ' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('qr-panel')).toBeNull();
    expect(hold.leave).not.toHaveBeenCalled();
  });

  it('結果が出て送っていなくなったら「切り替えられません」を消す (次の会計で押していないのに出し直さない)', () => {
    hold.busy = true;
    const r = renderWithIntl(<CreatePage />);
    fireEvent.click(screen.getByRole('button', { name: 'レジ' }));
    expect(screen.getByRole('alert')).toBeTruthy();
    hold.busy = false;
    r.rerender(<CreatePage />);
    hold.busy = true; // 次の会計で送り始めた
    r.rerender(<CreatePage />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('締め切っていない受け渡しがあれば、締め切ってから移る', async () => {
    hold.pending = true;
    renderWithIntl(<CreatePage />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'レジ' }));
    });
    expect(hold.leave).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('qr-panel')).toBeNull();
  });

  it('締め切ったら署名が入っていた (端末が送る) → 移らずに理由を出す', async () => {
    hold.pending = true;
    hold.leave.mockImplementation(async () => {
      hold.busy = true; // 送り始めた
      return false;
    });
    renderWithIntl(<CreatePage />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'レジ' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/結果が出るまでタブを切り替えられません/);
    expect(screen.getByText('qr-panel')).toBeTruthy();
  });
});
