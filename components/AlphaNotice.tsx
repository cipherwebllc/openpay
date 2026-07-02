// ベータ版ステータスの通知バナー。layout 直下で全 page (legal page 含む) の最上部に出す。
// (コンポーネント/i18n namespace 名は AlphaNotice のまま維持 = 表示文言のみ Beta 化し改名 churn を回避。)
// 視覚は控えめな 1 ストリップ (薄い amber + アイコン + 小さめ本文) にし、ファーストビューを
// 製品が主役のまま保つ。本文 (ベータ版である旨 / 送金は原則取消不可) と /disclaimer への
// "詳細" リンクは保持する = 開示の本体は不変。任意で閉じられる (localStorage・初回は必ず表示)。
//
// 削除手順: layout.tsx から <AlphaNotice /> を外す + 本ファイル削除
//   + messages/*.json の AlphaNotice namespace を削除 + tests も削除。

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { TriangleAlert, X } from 'lucide-react';
import { isHandlePagePath } from '@/lib/handlePath';

const DISMISS_KEY = 'openpay:alphaNoticeDismissed:v1';

export function AlphaNotice() {
  const t = useTranslations('AlphaNotice');
  const locale = useLocale();
  // @handle (クリエイターの link-in-bio / 店舗) は本人が主役の入口ページ。共通の amber バナーは
  // 世界観を削ぐので出さず、取消不可の開示はページ側フッターに簡潔に再掲する (開示自体は不変)。
  // pathname=null (router provider 無し=テスト等) は通常ページ扱いで従来どおり表示。
  const pathname = usePathname();
  const onHandlePage = isHandlePagePath(pathname);
  // 既定は表示 (SSR / 初回ペイント / テストで開示が必ず出る)。過去に閉じた利用者のみ mount 後に隠す。
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem(DISMISS_KEY) === '1') setDismissed(true);
    } catch {
      /* localStorage 不可環境では常に表示 */
    }
  }, []);

  if (onHandlePage || dismissed) return null;

  return (
    <div
      role="status"
      aria-label={t('label')}
      className="border-b border-amber-100 bg-amber-50/80 print:hidden"
    >
      <div className="mx-auto flex max-w-5xl items-start gap-2 px-4 py-1.5">
        <TriangleAlert
          className="mt-px h-3.5 w-3.5 flex-shrink-0 text-amber-500"
          aria-hidden
        />
        <p className="min-w-0 flex-1 text-[11px] leading-snug text-amber-800 sm:text-xs">
          <span className="mr-1.5 inline-block rounded bg-amber-200/70 px-1.5 py-0.5 text-[9px] font-bold uppercase leading-none tracking-wider text-amber-900">
            {t('badge')}
          </span>
          {/* モバイルは 1 行に収まる簡潔版 (取消不可の要点を保持)、sm+ は従来の全文。
              全文開示は moreLink → /disclaimer に不変で残る。 */}
          <span className="sm:hidden">{t('bodyShort')}</span>
          <span className="hidden sm:inline">{t('body')}</span>{' '}
          <Link
            href="/disclaimer"
            prefetch={false}
            className="whitespace-nowrap font-medium underline underline-offset-2 hover:text-amber-950"
          >
            {t('moreLink')}
          </Link>
        </p>
        <button
          type="button"
          onClick={() => {
            try {
              localStorage.setItem(DISMISS_KEY, '1');
            } catch {
              /* noop */
            }
            setDismissed(true);
          }}
          aria-label={locale === 'ja' ? '閉じる' : 'Dismiss'}
          className="-mr-1 mt-px flex-shrink-0 rounded p-0.5 text-amber-500 transition-colors hover:bg-amber-100 hover:text-amber-700"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
    </div>
  );
}
