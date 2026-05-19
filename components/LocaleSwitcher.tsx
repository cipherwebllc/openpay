'use client';

import { useRouter, usePathname } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { LOCALES, type Locale } from '@/i18n';

export function LocaleSwitcher() {
  const router = useRouter();
  const pathname = usePathname();
  const current = useLocale();
  const t = useTranslations('LocaleSwitcher');

  function switchTo(next: Locale) {
    if (next === current) return;
    // 決済ページの query は金額・宛先そのもの (PayParams) なので、locale 切替で
    // 落とすと別ページ送りに等しい regression。useSearchParams は SSG ページで
    // CSR bailout を起こすため、click 時に window.location.search を直接読む。
    const segments = pathname.split('/');
    const hasLocalePrefix = (LOCALES as readonly string[]).includes(segments[1] ?? '');
    const nextPath = hasLocalePrefix
      ? [segments[0], next, ...segments.slice(2)].join('/')
      : `/${next}${pathname}`;
    router.replace(`${nextPath}${window.location.search}`);
  }

  return (
    <div className="inline-flex rounded-full border border-slate-200 bg-white p-0.5 text-xs">
      {LOCALES.map((l) => {
        const active = l === current;
        return (
          <button
            key={l}
            type="button"
            onClick={() => switchTo(l)}
            aria-label={`${t('label')}: ${t(l)}`}
            aria-pressed={active}
            className={`rounded-full px-3 py-1 font-medium transition ${
              active
                ? 'bg-slate-900 text-white'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            {t(l)}
          </button>
        );
      })}
    </div>
  );
}
