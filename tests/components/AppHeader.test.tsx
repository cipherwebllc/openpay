import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import { mockHook } from '../_helpers/wagmiMock';

// Server-side env のリテラル参照は実値で動かしたいので env.networkEnv の値は
// vitest env (`testnet` 既定) のまま使う。
vi.mock('wagmi', () => ({
  useAccount: vi.fn(),
  useConnect: vi.fn(),
  useDisconnect: vi.fn(),
}));
import { useAccount, useConnect, useDisconnect } from 'wagmi';

// usePathname (next/navigation) を mock — TopNav の active 判定で参照される。
vi.mock('next/navigation', () => ({
  usePathname: () => '/ja',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

// useVisibleConnectors はネイティブ実装で空配列を返すよう mock (WalletBadge 経由)
vi.mock('@/hooks/useVisibleConnectors', () => ({
  useVisibleConnectors: () => [],
}));

// SIWE セッション hook も boundary mock (WalletBadge 経由・未サインイン default)。
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({
    sessionAddress: null,
    isSignedIn: false,
    mismatch: false,
    isLoading: false,
    signIn: vi.fn().mockResolvedValue(undefined),
    isSigningIn: false,
    signInError: null,
    signOut: vi.fn().mockResolvedValue(undefined),
    isSigningOut: false,
  }),
}));

import { AppHeader } from '@/components/AppHeader';

beforeEach(() => {
  mockHook(useAccount, { isConnected: false, address: undefined });
  mockHook(useConnect, {
    connectors: [],
    connect: vi.fn(),
    isPending: false,
    error: null,
  });
  mockHook(useDisconnect, { disconnect: vi.fn() });
});

describe('AppHeader: ブランド / ナビ / 右側コントロール', () => {
  it('ロゴ image (alt="OpenPay") + href=/ja の <Link> でホーム戻り', () => {
    renderWithIntl(<AppHeader />);
    const logo = screen.getByAltText('OpenPay') as HTMLImageElement;
    expect(logo).toBeInTheDocument();
    // priority + width/height
    expect(logo.getAttribute('src')).toContain('/logo.svg');
    // h1 を構成する Link 要素
    const link = screen.getByRole('link', { name: 'OpenPay' });
    expect(link).toHaveAttribute('href', '/ja');
  });

  it('h1 として heading role が "OpenPay" で取れる (a11y: 単一 h1 / page)', () => {
    renderWithIntl(<AppHeader />);
    expect(
      screen.getByRole('heading', { level: 1, name: 'OpenPay' }),
    ).toBeInTheDocument();
  });

  it('TopNav (primary navigation) と Bottom nav と分かれた role を持つ', () => {
    renderWithIntl(<AppHeader />);
    // TopNav の aria-label
    expect(
      screen.getByRole('navigation', { name: 'primary navigation' }),
    ).toBeInTheDocument();
  });

  it('TopNav に 5 link (スキャン / 受け取る / 履歴 / 探す / AIストア) が出る', () => {
    renderWithIntl(<AppHeader />);
    const nav = screen.getByRole('navigation', { name: 'primary navigation' });
    expect(nav.querySelectorAll('a').length).toBe(5);
    // 各 link href が /ja prefix で正しい
    const hrefs = Array.from(nav.querySelectorAll('a')).map((a) =>
      a.getAttribute('href'),
    );
    expect(hrefs).toEqual([
      '/ja/scan',
      '/ja/create',
      '/ja/history',
      '/ja/explore',
      '/ja/discovery',
    ]);
  });

  it('右側に LocaleSwitcher (ja/en) + env pill (testnet) が出る', () => {
    renderWithIntl(<AppHeader />);
    // LocaleSwitcher の ja/en button
    expect(screen.getByRole('button', { name: /日本語/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /English/ })).toBeInTheDocument();
    // env pill
    expect(screen.getByText('testnet')).toBeInTheDocument();
  });

  it('WalletBadge (未接続) が右側に出る', () => {
    renderWithIntl(<AppHeader />);
    // 未接続時の WalletBadge は「接続」label を持つ
    expect(screen.getByText('接続')).toBeInTheDocument();
  });

  it('en locale: ロゴ alt "OpenPay" は不変 (ブランド名は locale-invariant)', () => {
    renderWithIntl(<AppHeader />, { locale: 'en' });
    expect(screen.getByAltText('OpenPay')).toBeInTheDocument();
  });

  it('en locale: ロゴ href が /en に変わる (locale prefix 連動)', () => {
    renderWithIntl(<AppHeader />, { locale: 'en' });
    const link = screen.getByRole('link', { name: 'OpenPay' });
    expect(link).toHaveAttribute('href', '/en');
  });

  it('sticky 配置: header に sticky / top-0 / z-30 / print:hidden class', () => {
    const { container } = renderWithIntl(<AppHeader />);
    const header = container.querySelector('header');
    const cls = header?.getAttribute('class') ?? '';
    expect(cls).toContain('sticky');
    expect(cls).toContain('top-0');
    expect(cls).toContain('z-30');
    expect(cls).toContain('print:hidden');
  });
});
