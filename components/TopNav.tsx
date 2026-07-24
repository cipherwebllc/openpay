'use client';

// デスクトップ用 horizontal nav (md+)。AppHeader 内に置く。
// active state は BottomNav と同じ判定。

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import type { Locale } from '@/i18n';
import { env } from '@/lib/env';
import { DESKTOP_NAV_ITEMS, pathMatches, pathRestForLocale } from './navItems';

export function TopNav() {
  const pathname = usePathname();
  const locale = useLocale() as Locale;
  const t = useTranslations('Nav');
  const rest = pathRestForLocale(pathname, locale);
  // /discovery は flag OFF で notFound になるため、OFF 環境では 404 導線を出さない。
  const items = DESKTOP_NAV_ITEMS.filter(
    (item) => item.key !== 'discovery' || env.enableX402Facilitator,
  );

  return (
    <nav
      aria-label="primary navigation"
      className="hidden items-center gap-1 text-sm font-medium md:flex"
    >
      {items.map((item) => {
        const active = pathMatches(rest, item.href);
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
