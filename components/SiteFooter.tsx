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
      <p className="mt-1 flex items-center justify-center gap-3 text-slate-400">
        <a
          href="https://github.com/cipherwebllc/openpay"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-slate-700 hover:underline"
        >
          {t('sourceLink')}
        </a>
        <a
          href="https://x.com/openpay_jp"
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t('xLink')}
          title={t('xLink')}
          className="inline-flex items-center hover:text-slate-700"
        >
          <XIcon />
        </a>
      </p>
    </footer>
  );
}

// X (旧 Twitter) 公式ロゴ。2023 改名後の現行マーク。viewBox 0 0 24 24、
// fill=currentColor で親 <a> の color を継承し hover 時に slate-700 へ追従する。
function XIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}
