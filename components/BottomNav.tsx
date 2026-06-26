'use client';

// モバイル用 fixed bottom nav。md 以上では非表示 (TopNav が代替)。
// 各 item は icon + 短ラベル、active state は pathMatches(rest, item.href) で判定。

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import type { Locale } from '@/i18n';
import { NAV_ITEMS, pathMatches, pathRestForLocale } from './navItems';

export function BottomNav() {
  const pathname = usePathname();
  const locale = useLocale() as Locale;
  const t = useTranslations('Nav');
  const rest = pathRestForLocale(pathname, locale);

  return (
    <nav
      aria-label="bottom navigation"
      className="fixed bottom-0 left-0 right-0 z-20 border-t border-slate-200/70 bg-white/85 backdrop-blur-md supports-[backdrop-filter]:bg-white/75 md:hidden print:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <ul className="mx-auto flex max-w-5xl items-stretch justify-around">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = pathMatches(rest, item.href);
          return (
            <li key={item.key} className="flex-1">
              <Link
                href={`/${locale}${item.href}`}
                prefetch={false}
                aria-current={active ? 'page' : undefined}
                className={`group flex min-h-[3.25rem] flex-col items-center justify-center gap-1 pb-1 pt-1.5 text-[10px] font-medium transition-colors ${
                  active ? 'text-brand' : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                {/* アクティブは icon 背後にブランド色の pill (Material 3 風)。押下時は微縮小でネイティブ感。 */}
                <span
                  className={`flex h-7 w-12 items-center justify-center rounded-full transition-colors duration-200 ${
                    active ? 'bg-brand/10' : 'group-active:bg-slate-100'
                  }`}
                >
                  <Icon
                    className={`h-5 w-5 transition-transform duration-200 ${
                      active ? 'scale-110' : 'group-active:scale-95'
                    }`}
                    aria-hidden
                  />
                </span>
                <span>{t(item.key)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
