import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';

// useNewsRead を boundary mock し、hydrated / hasUnread / unreadCount を制御する。
vi.mock('@/hooks/useNewsRead', () => ({
  useNewsRead: vi.fn(),
}));
import { useNewsRead } from '@/hooks/useNewsRead';
import { NewsBell } from '@/components/NewsBell';

const mockUseNewsRead = vi.mocked(useNewsRead);

function setState(s: {
  unreadCount?: number;
  hasUnread?: boolean;
  hydrated?: boolean;
}) {
  mockUseNewsRead.mockReturnValue({
    unreadCount: s.unreadCount ?? 0,
    hasUnread: s.hasUnread ?? false,
    hydrated: s.hydrated ?? true,
    markAllSeen: vi.fn(),
  });
}

// 赤ドット = bg-rose-500 の span (aria-hidden)。link 内から検出する。
function hasRedDot(): boolean {
  const link = screen.getByRole('link');
  return link.querySelector('.bg-rose-500') !== null;
}

beforeEach(() => mockUseNewsRead.mockReset());

describe('NewsBell: 未読ドット / a11y / 遷移先', () => {
  it('hydrated && hasUnread: 赤ドットを出す + aria-label に未読件数', () => {
    setState({ hydrated: true, hasUnread: true, unreadCount: 2 });
    renderWithIntl(<NewsBell />);
    expect(hasRedDot()).toBe(true);
    // unreadAria: "お知らせ (2 件の未読)"
    expect(screen.getByRole('link').getAttribute('aria-label')).toContain('2');
  });

  it('未読なし: 赤ドットを出さない + aria-label は bellAria', () => {
    setState({ hydrated: true, hasUnread: false, unreadCount: 0 });
    renderWithIntl(<NewsBell />);
    expect(hasRedDot()).toBe(false);
    expect(screen.getByRole('link').getAttribute('aria-label')).toBe('お知らせを開く');
  });

  it('hydrate 前 (hydrated=false): 未読があってもドットを出さない (mismatch 防止)', () => {
    setState({ hydrated: false, hasUnread: true, unreadCount: 3 });
    renderWithIntl(<NewsBell />);
    expect(hasRedDot()).toBe(false);
    // hydrate 前は件数を出さず bellAria のみ。
    expect(screen.getByRole('link').getAttribute('aria-label')).toBe('お知らせを開く');
  });

  it('クリック先: /{locale}/news へのリンク (ja)', () => {
    setState({ hydrated: true, hasUnread: false });
    renderWithIntl(<NewsBell />);
    expect(screen.getByRole('link')).toHaveAttribute('href', '/ja/news');
  });

  it('en locale: /en/news + 英語 aria-label', () => {
    setState({ hydrated: true, hasUnread: true, unreadCount: 1 });
    renderWithIntl(<NewsBell />, { locale: 'en' });
    expect(screen.getByRole('link')).toHaveAttribute('href', '/en/news');
    expect(screen.getByRole('link').getAttribute('aria-label')).toContain('1');
  });

  it('print:hidden class を持つ (印刷時非表示)', () => {
    setState({ hydrated: true, hasUnread: false });
    renderWithIntl(<NewsBell />);
    expect(screen.getByRole('link').getAttribute('class') ?? '').toContain('print:hidden');
  });
});
