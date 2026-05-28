'use client';

// AppShell の TopNav (md+) と BottomNav (mobile) で共有する nav 定義。
// labelKey は messages の Nav 名前空間を指す。

import type { LucideIcon } from 'lucide-react';
import { ScanLine, QrCode, History, Compass } from 'lucide-react';

export type NavItem = {
  key: 'home' | 'create' | 'history' | 'explore';
  /** locale prefix を含まない path (空文字 = locale ルート) */
  href: string;
  icon: LucideIcon;
  /** locale prefix を取り除いた path に対する match 判定 */
  matches: (rest: string) => boolean;
};

export const NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'home',
    href: '',
    icon: ScanLine,
    matches: (rest) =>
      rest === '' || rest === '/' || rest === '/scan' || rest.startsWith('/scan/'),
  },
  {
    key: 'create',
    href: '/create',
    icon: QrCode,
    matches: (rest) => rest === '/create' || rest.startsWith('/create/'),
  },
  {
    key: 'history',
    href: '/history',
    icon: History,
    matches: (rest) => rest === '/history' || rest.startsWith('/history/'),
  },
  {
    key: 'explore',
    href: '/explore',
    icon: Compass,
    matches: (rest) => rest === '/explore' || rest.startsWith('/explore/'),
  },
];

/** pathname (例 "/ja/create") から locale prefix を取り除き、rest ("/create") を返す。 */
export function pathRestForLocale(
  pathname: string,
  locale: string,
): string {
  const prefix = `/${locale}`;
  if (pathname === prefix) return '';
  if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);
  return pathname;
}
