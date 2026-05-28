'use client';

// デスクトップ用 horizontal nav (md+)。AppHeader 内に置く。
// active state は BottomNav と同じ判定。

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import type { Locale } from '@/i18n';
import { NAV_ITEMS, pathRestForLocale } from './navItems';

export function TopNav() {
  const pathname = usePathname();
  const locale = useLocale() as Locale;
  const t = useTranslations('Nav');
  const rest = pathRestForLocale(pathname, locale);

  return (
    <nav
      aria-label="primary navigation"
      className="hidden items-center gap-1 text-sm font-medium md:flex"
    >
      {NAV_ITEMS.map((item) => {
        const active = item.matches(rest);
        return (
          <Link
            key={item.key}
            href={`/${locale}${item.href}`}
            prefetch={false}
            aria-current={active ? 'page' : undefined}
            className={`rounded-lg px-3 py-1.5 transition ${
              active
                ? 'bg-slate-100 text-brand'
                : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
            }`}
          >
            {t(item.key)}
          </Link>
        );
      })}
    </nav>
  );
}
