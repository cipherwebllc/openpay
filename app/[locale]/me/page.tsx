// /me: マイページ (Store 統合 P4・plans/store-marketplace.md)。
//
// 「自分の情報を確認・管理する人」の入口。**新しいアカウント制度は作らない** —
// 既存機能 (端末ローカルの履歴 / 購入済みライブラリ / プロフィール・出品管理) への
// ハブに徹する。ウォレット接続や SIWE は各行き先ページが既存 UI で担う。
// 履歴は旧ナビの 1 タップ目から 2 タップ目になるため最上段に置く (裁定 M2)。
// 掟 3: このファイルは default / generateMetadata 以外を export しない。

import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import {
  ChevronRight,
  History,
  Library,
  Store,
  UserRound,
} from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { env } from '@/lib/env';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'MePage' });
  return { title: t('metaTitle'), description: t('metaDescription') };
}

export default async function MePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'MePage' });

  const cards = [
    {
      key: 'history',
      href: `/${locale}/history`,
      icon: History,
    },
    // ライブラリは client flag OFF (self-host 等) だと 404 のため項目ごと隠す
    ...(env.enableCreatorStoreUi
      ? [
          {
            key: 'library',
            href: `/${locale}/store/library`,
            icon: Library,
          },
        ]
      : []),
    {
      key: 'selling',
      href: `/${locale}/create?tab=profile`,
      icon: Store,
    },
  ] as const;

  return (
    <AppShell>
      <div className="mx-auto max-w-xl">
        <header className="flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-full bg-brand/10">
            <UserRound className="h-5 w-5 text-brand" aria-hidden />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">{t('title')}</h1>
            <p className="text-sm text-slate-600">{t('subtitle')}</p>
          </div>
        </header>

        <ul className="mt-6 space-y-3">
          {cards.map(({ key, href, icon: Icon }) => (
            <li key={key}>
              <Link
                href={href}
                prefetch={false}
                className="flex items-center gap-4 rounded-2xl border border-slate-200/80 bg-white px-5 py-4 shadow-[0_2px_8px_-2px_rgba(15,23,42,0.07)] transition-all hover:-translate-y-0.5 hover:border-brand/30 hover:shadow-[0_8px_20px_-10px_rgba(15,23,42,0.25)]"
              >
                <span className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-xl bg-slate-100">
                  <Icon className="h-5 w-5 text-slate-600" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-bold text-slate-900">
                    {t(`cards.${key}.title`)}
                  </span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-slate-500">
                    {t(`cards.${key}.desc`)}
                  </span>
                </span>
                <ChevronRight
                  className="h-4 w-4 flex-shrink-0 text-slate-400"
                  aria-hidden
                />
              </Link>
            </li>
          ))}
        </ul>

        <p className="mt-6 text-xs leading-relaxed text-slate-400">
          {t('note')}
        </p>
      </div>
    </AppShell>
  );
}
