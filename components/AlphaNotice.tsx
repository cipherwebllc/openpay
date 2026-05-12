// アルファ版ステータスの persistent banner。layout 直下で全 page (legal page 含む)
// の最上部に出す。本番運用が安定したら本 component ごと削除する想定。
//
// 削除手順: layout.tsx から <AlphaNotice /> を外す + 本ファイル削除
//   + messages/*.json の AlphaNotice namespace を削除 + tests も削除。

'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

export function AlphaNotice() {
  const t = useTranslations('AlphaNotice');

  return (
    <div
      role="status"
      aria-label={t('label')}
      className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-xs leading-relaxed text-amber-900 print:hidden sm:text-sm"
    >
      <span className="mr-2 inline-block rounded-full bg-amber-200 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-900">
        {t('badge')}
      </span>
      <span>{t('body')}</span>{' '}
      <Link
        href="/disclaimer"
        prefetch={false}
        className="underline hover:text-amber-700"
      >
        {t('moreLink')}
      </Link>
    </div>
  );
}
