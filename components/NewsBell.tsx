'use client';

// AppHeader 右側 (WalletBadge と LocaleSwitcher の間) に置く通知ベル。
// /{locale}/news へのリンク。未読あり (hydrated && hasUnread) のとき赤ドットを出す
// (WalletBadge の接続ドット様式を流用)。aria-label は未読件数を i18n で読み上げる。
//
// モバイルでも表示する (icon のみで幅を取らない)。BottomNav には入れない (4 枠維持)。
// print:hidden は env pill / header と同様。

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Bell } from 'lucide-react';
import type { Locale } from '@/i18n';
import { useNewsRead } from '@/hooks/useNewsRead';

export function NewsBell() {
  const locale = useLocale() as Locale;
  const t = useTranslations('News');
  const { unreadCount, hasUnread, hydrated } = useNewsRead();

  // hydrate 後に未読がある時だけドットを出す (SSR では未読を出さない)。
  const showDot = hydrated && hasUnread;
  const ariaLabel = showDot ? t('unreadAria', { count: unreadCount }) : t('bellAria');

  return (
    <Link
      href={`/${locale}/news`}
      prefetch={false}
      aria-label={ariaLabel}
      className="relative inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-700 print:hidden"
    >
      <Bell className="h-4 w-4" aria-hidden />
      {showDot && (
        <span
          className="absolute right-1.5 top-1.5 inline-block h-2 w-2 rounded-full bg-rose-500 ring-2 ring-white"
          aria-hidden
        />
      )}
    </Link>
  );
}
