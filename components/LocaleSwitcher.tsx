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
    // /ja/foo/bar → /en/foo/bar に置き換え。先頭の /<locale> セグメントを差替。
    const segments = pathname.split('/');
    if (segments.length >= 2 && (LOCALES as readonly string[]).includes(segments[1])) {
      segments[1] = next;
      router.replace(segments.join('/'));
    } else {
      router.replace(`/${next}${pathname}`);
    }
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
