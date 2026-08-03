'use client';

// AppShell の TopNav (md+) と BottomNav (mobile) で共有する nav 定義。
// item.key は messages の Nav 名前空間内の i18n key として使う。
//
// 2026-08-02 Store 統合 P4 (plans/store-marketplace.md・user 承認済み):
// 旧 5 区分 (スキャン/受取る/履歴/探す/AIストア) → 目的別 4 区分へ。
//   決済 (pay)     = /scan   … 支払う人の入口 (旧スキャン)
//   販売 (sell)    = /create … 売る/受け取る人の入口 (旧 受取る。タブ群がハブを兼ねる)
//   Store          = /store  … 商品を探して買う人の入口 (P3)
//   マイページ (me) = /me    … 履歴/購入/出品管理のハブ (P4)
// 旧 URL は全て維持: /history /explore /discovery は直接アクセス可のまま、
// 導線は /me (履歴)・/store 下部 (explore/discovery) が受け持つ (裁定 M1/M2)。

import type { LucideIcon } from 'lucide-react';
import { ScanLine, QrCode, ShoppingBag, CircleUserRound } from 'lucide-react';
import { env } from '@/lib/env';

export type NavItem = {
  key: 'pay' | 'sell' | 'store' | 'me';
  /** locale prefix を含まない path */
  href: string;
  icon: LucideIcon;
};

// ホームへの戻りは AppHeader 左上のロゴクリックに集約 (Nav からは外す)。
// Store は client flag OFF (self-host 等) だと /store が 404 のため項目ごと隠す。
export const NAV_ITEMS: readonly NavItem[] = [
  { key: 'pay', href: '/scan', icon: ScanLine },
  { key: 'sell', href: '/create', icon: QrCode },
  ...(env.enableCreatorStoreUi
    ? ([{ key: 'store', href: '/store', icon: ShoppingBag }] as const)
    : []),
  { key: 'me', href: '/me', icon: CircleUserRound },
];

// PC (TopNav) も同じ 4 区分 (AIストア単独項目は廃止 — Store の AI カテゴリー経由)。
export const DESKTOP_NAV_ITEMS: readonly NavItem[] = NAV_ITEMS;

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
