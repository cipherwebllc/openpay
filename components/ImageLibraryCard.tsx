'use client';

// マイページ (/me) の「アップロードした画像」のカード (/me/images へ)。サインイン済みの本人が画像のアップロードを使える
// (/api/auth/siwe/me の imageUpload・ヘッダが既に読む GET) ときだけ出す。段階 off・運営者でない (admin の段階)・
// サインインの前は出さない (今のマイページのまま)。一覧は開いたときに読む (このカードは読まない)。

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { ChevronRight, Images } from 'lucide-react';
import { useSiweSession } from '@/hooks/useSiweSession';

export function ImageLibraryCard() {
  const t = useTranslations('MePage');
  const locale = useLocale();
  const { imageUpload } = useSiweSession();
  if (!imageUpload) return null;
  return (
    <li>
      <Link
        href={`/${locale}/me/images`}
        prefetch={false}
        className="flex items-center gap-4 rounded-2xl border border-slate-200/80 bg-white px-5 py-4 shadow-[0_2px_8px_-2px_rgba(15,23,42,0.07)] transition-all hover:-translate-y-0.5 hover:border-brand/30 hover:shadow-[0_8px_20px_-10px_rgba(15,23,42,0.25)]"
      >
        <span className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-xl bg-slate-100">
          <Images className="h-5 w-5 text-slate-600" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-bold text-slate-900">{t('cards.images.title')}</span>
          <span className="mt-0.5 block text-xs leading-relaxed text-slate-500">{t('cards.images.desc')}</span>
        </span>
        <ChevronRight className="h-4 w-4 flex-shrink-0 text-slate-400" aria-hidden />
      </Link>
    </li>
  );
}
