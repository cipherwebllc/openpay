// 全 page 共通の footer。app/[locale]/layout.tsx から 1 度だけ render される。
// 役割は (1) legal page (/terms /privacy /disclaimer) への導線、(2) 事業者表記
// + copyright、(3) 既存 "Powered by ..." の表示。
//
// QR ポスター印刷時は不要なので `print:hidden` で全体を非表示にする。

'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { LEGAL_ENTITY } from '@/lib/legal';

export function SiteFooter() {
  const t = useTranslations('Footer');
  const currentYear = new Date().getFullYear();
  // copyrightStartYear と一致したら単年表示、それ以外はレンジ表示。
  const yearLabel =
    currentYear === LEGAL_ENTITY.copyrightStartYear
      ? `${currentYear}`
      : `${LEGAL_ENTITY.copyrightStartYear}-${currentYear}`;

  return (
    <footer className="mx-auto mt-12 w-full max-w-5xl px-4 pb-10 text-center text-xs text-slate-500 print:hidden">
      <nav
        aria-label="Legal"
        className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2"
      >
        <Link
          href="/history"
          className="hover:text-slate-700 hover:underline"
          prefetch={false}
        >
          {t('links.history')}
        </Link>
        <Link href="/terms" className="hover:text-slate-700 hover:underline" prefetch={false}>
          {t('links.terms')}
        </Link>
        <Link href="/privacy" className="hover:text-slate-700 hover:underline" prefetch={false}>
          {t('links.privacy')}
        </Link>
        <Link
          href="/disclaimer"
          className="hover:text-slate-700 hover:underline"
          prefetch={false}
        >
          {t('links.disclaimer')}
        </Link>
        <Link
          href="/tokutei"
          className="hover:text-slate-700 hover:underline"
          prefetch={false}
        >
          {t('links.tokutei')}
        </Link>
      </nav>
      <p className="mt-3 text-slate-400">
        {t('copyright', {
          year: yearLabel,
          company: LEGAL_ENTITY.companyName,
        })}
      </p>
      <p className="mt-1 text-slate-400">{t('poweredBy')}</p>
      <p className="mt-1 text-slate-400">
        <a
          href="https://github.com/cipherwebllc/openpay"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-slate-700 hover:underline"
        >
          {t('sourceLink')}
        </a>
      </p>
    </footer>
  );
}
