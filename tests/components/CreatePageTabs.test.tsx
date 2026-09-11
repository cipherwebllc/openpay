import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';

vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
vi.mock('@/components/BillingDueBanner', () => ({ BillingDueBanner: () => null }));
vi.mock('@/components/MarketRates', () => ({ MarketRates: () => null }));
vi.mock('@/components/MiniHistoryRecent', () => ({ MiniHistoryRecent: () => null }));
vi.mock('@/components/QrGenerator', () => ({ QrGenerator: () => null }));
vi.mock('@/components/OrdersTabBadge', () => ({ OrdersTabBadge: () => null }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, enableHandles: true, enableMobileOrder: true, enableOrderRelay: true } };
});

import CreatePage from '@/app/[locale]/create/page';

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(240);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const isButton = this.tagName === 'BUTTON';
    const position = this.textContent === 'プロフ' ? 500 : 0;
    const left = 100 + (isButton ? position - this.parentElement!.scrollLeft : 0);
    const width = isButton ? 80 : 240;
    return { left, right: left + width, top: 200, bottom: 240, width, height: 40, x: left, y: 200, toJSON: () => ({}) };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('CreatePage tab visibility', () => {
  it('profile deep-link はアクティブタブを横スクロールで可視化し、縦位置を動かさない', () => {
    window.history.replaceState(null, '', '/ja/create?tab=profile');
    const scrollTo = vi.spyOn(window, 'scrollTo');
    renderWithIntl(<CreatePage />);
    const profile = screen.getByRole('button', { name: 'プロフ' });
    const bar = profile.parentElement!;
    expect(profile).toHaveClass('bg-white');
    expect(bar.scrollLeft).toBe(420);
    expect(bar.scrollTop).toBe(0);
    expect(scrollTo).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '決済QR' }));
    expect(bar.scrollLeft).toBeLessThan(420);
    expect(bar.scrollTop).toBe(0);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('初期タブが見えている場合はスクロールしない', () => {
    window.history.replaceState(null, '', '/ja/create');
    renderWithIntl(<CreatePage />);
    expect(screen.getByRole('button', { name: '決済QR' }).parentElement!.scrollLeft).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'プロフ' }));
    expect(screen.getByRole('button', { name: 'プロフ' }).parentElement!.scrollLeft).toBe(420);
  });
});
