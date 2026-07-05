'use client';

// AppShell の TopNav (md+) と BottomNav (mobile) で共有する nav 定義。
// item.key は messages の Nav 名前空間内の i18n key として使う。

import type { LucideIcon } from 'lucide-react';
import { ScanLine, QrCode, History, Compass, Bot } from 'lucide-react';

export type NavItem = {
  key: 'scan' | 'create' | 'history' | 'explore' | 'discovery';
  /** locale prefix を含まない path */
  href: string;
  icon: LucideIcon;
};

// ホームへの戻りは AppHeader 左上のロゴクリックに集約 (Nav からは外す)。
// 1 slot 目は「スキャン (= 支払う動線)」、それ以外は受取/履歴/探す。
export const NAV_ITEMS: readonly NavItem[] = [
  { key: 'scan', href: '/scan', icon: ScanLine },
  { key: 'create', href: '/create', icon: QrCode },
  { key: 'history', href: '/history', icon: History },
  { key: 'explore', href: '/explore', icon: Compass },
];

// PC (TopNav) 専用の拡張ナビ。モバイル BottomNav は 4 枠が操作性の上限のため NAV_ITEMS のまま
// (AIストア = /discovery は開発者/エージェント運用者向けで、店頭のモバイル主動線には出さない)。
export const DESKTOP_NAV_ITEMS: readonly NavItem[] = [
  ...NAV_ITEMS,
  { key: 'discovery', href: '/discovery', icon: Bot },
];

/** pathname (例 "/ja/create") から locale prefix を取り除き、rest ("/create") を返す。 */
export function pathRestForLocale(pathname: string, locale: string): string {
  const prefix = `/${locale}`;
  if (pathname === prefix) return '';
  if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);
  return pathname;
}

/** rest path が item の href にマッチするか (完全一致 or サブパス)。 */
export function pathMatches(rest: string, href: string): boolean {
  return rest === href || rest.startsWith(`${href}/`);
}
