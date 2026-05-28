'use client';

// モバイル用 fixed bottom nav。md 以上では非表示 (TopNav が代替)。
// 各 item は icon + 短ラベル、active state は usePathname + NAV_ITEMS.matches で判定。

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import type { Locale } from '@/i18n';
import { NAV_ITEMS, pathRestForLocale } from './navItems';

export function BottomNav() {
  const pathname = usePathname();
  const locale = useLocale() as Locale;
  const t = useTranslations('Nav');
  const rest = pathRestForLocale(pathname, locale);

  return (
    <nav
      aria-label="bottom navigation"
      className="fixed bottom-0 left-0 right-0 z-20 border-t border-slate-200 bg-white/95 backdrop-blur md:hidden print:hidden"
    >
      <ul className="mx-auto flex max-w-5xl items-stretch justify-around">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = item.matches(rest);
          return (
            <li key={item.key} className="flex-1">
              <Link
                href={`/${locale}${item.href}`}
                prefetch={false}
                aria-current={active ? 'page' : undefined}
                className={`flex flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium transition ${
                  active ? 'text-brand' : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                <Icon
                  className={`h-5 w-5 ${active ? 'stroke-brand' : ''}`}
                  aria-hidden
                />
                <span>{t(item.key)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
