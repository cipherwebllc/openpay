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
    // R: search param (例: /pay?to=0xABC&token=jpyc) を維持する。Next 標準の
    //    usePathname は pathname のみ返し、router.replace に検索文字列を含めない
    //    限り query が失われる。決済 (pay/checkout) では URL の query が金額・宛先
    //    そのものなので、欠落させると別ページに飛ばすに等しい regression になる。
    //    `useSearchParams` を使うと static page で Suspense boundary を要求され、
    //    build が落ちる (CSR bailout)。click は必ず browser 上で起きるため、
    //    `window.location.search` を click 時に読めば subscribe 不要で SSG も維持できる。
    const segments = pathname.split('/');
    let nextPath: string;
    if (segments.length >= 2 && (LOCALES as readonly string[]).includes(segments[1])) {
      segments[1] = next;
      nextPath = segments.join('/');
    } else {
      nextPath = `/${next}${pathname}`;
    }
    const search = window.location.search;
    router.replace(search ? `${nextPath}${search}` : nextPath);
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
