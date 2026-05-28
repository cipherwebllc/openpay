'use client';

// AppShell の TopNav (md+) と BottomNav (mobile) で共有する nav 定義。
// labelKey は messages の Nav 名前空間を指す。

import type { LucideIcon } from 'lucide-react';
import { ScanLine, QrCode, History, Compass } from 'lucide-react';

export type NavItem = {
  key: 'scan' | 'create' | 'history' | 'explore';
  /** locale prefix を含まない path */
  href: string;
  icon: LucideIcon;
  /** locale prefix を取り除いた path に対する match 判定 */
  matches: (rest: string) => boolean;
};

// ホームへの戻りは AppHeader 左上のロゴクリックに集約 (Nav からは外す)。
// 1 slot 目は「スキャン (= 支払う動線)」、それ以外は受取/履歴/探す。
export const NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'scan',
    href: '/scan',
    icon: ScanLine,
    matches: (rest) => rest === '/scan' || rest.startsWith('/scan/'),
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
