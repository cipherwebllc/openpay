// 用途別の 3 入口 (plans/site-ia-guides-ruling.md N1③)。
//   決済QR → /guide/qr / レジ・モバイルオーダー → /guide/shop / クリエイター → /guide/store
// 独立した節にせず「使い方」の末尾に短い行として置く (入口を 1 か所に・plans/lp-polish-2026-09.md P1)。
// 3 タイルの下に全ガイドのハブ (/guide) へのテキストリンク (plans/guide-hub-sidebar.md PR-B)。

import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { ArrowRight, QrCode, Store, Palette, type LucideIcon } from 'lucide-react';

type EntryCard = {
  key: 'Qr' | 'Shop' | 'Creator';
  href: string;
  icon: LucideIcon;
};

export async function LandingEntryPoints() {
  const t = await getTranslations('Landing');
  const locale = await getLocale();

  const cards: readonly EntryCard[] = [
    { key: 'Qr', href: `/${locale}/guide/qr`, icon: QrCode },
    { key: 'Shop', href: `/${locale}/guide/shop`, icon: Store },
    { key: 'Creator', href: `/${locale}/guide/store`, icon: Palette },
  ];

  return (
    <div className="mt-10">
      <h3 className="text-center text-base font-bold text-slate-900 sm:text-lg">{t('entryTitle')}</h3>
      <p className="mt-1 text-center text-xs text-slate-500 sm:text-sm">{t('entrySubtitle')}</p>
      {/* スマホは 3 列の小さなタイル (見出しだけ)。説明は sm 以上 (3 行の大きな行 ≒ 半画面を 1 段に)。 */}
      <ul className="mt-4 grid grid-cols-3 gap-2 sm:gap-3">
        {cards.map(({ key, href, icon: Icon }) => (
          <li key={key}>
            {/* リンク名 = 見出し + 説明 (可視テキストだけ・掟 8)。 */}
            <Link
              href={href}
              prefetch={false}
              className="group flex h-full flex-col items-center gap-2 rounded-2xl bg-white p-3 text-center ring-1 ring-slate-200/80 transition hover:-translate-y-0.5 hover:ring-brand/40 sm:flex-row sm:items-start sm:gap-3 sm:p-4 sm:text-left"
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand/10">
                <Icon className="h-5 w-5 text-brand" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-center gap-1 text-xs font-bold leading-snug text-slate-900 sm:justify-start sm:text-sm">
                  {t(`entry${key}Title`)}
                  <ArrowRight aria-hidden className="hidden h-4 w-4 shrink-0 text-brand transition-transform group-hover:translate-x-0.5 sm:block" />
                </span>
                <span className="mt-1 hidden text-xs leading-relaxed text-slate-600 sm:block">{t(`entry${key}Body`)}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {/* 3 入口に無い用途 (お客様向け・AI・API 販売など) は全ガイドのハブ (/guide) から。
          リンク名は可視テキストだけ (矢印は aria-hidden・掟 8)。min-h で tap target 24px 以上。 */}
      <p className="mt-3 text-center">
        <Link
          href={`/${locale}/guide`}
          prefetch={false}
          className="group inline-flex min-h-[24px] items-center gap-1 text-sm font-semibold text-brand underline-offset-2 hover:underline"
        >
          {t('entryAllGuides')}
          <ArrowRight aria-hidden className="h-4 w-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </p>
    </div>
  );
}
