// LP「用途から選ぶ」— 用途別 LP への 3 入口 (plans/site-ia-guides-ruling.md N1③)。
// リンク先は用途別 LP が揃うまで暫定で機能ページ直行:
//   決済QR → /create (P4 で /guide/qr へ差し替え)
//   レジ・モバイルオーダー → /create?tab=mobileOrder (P3 で /guide/shop へ差し替え)
//   クリエイター → /guide/store (P2 の LP 化後もこのまま)

import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { QrCode, Store, Palette, type LucideIcon } from 'lucide-react';

type EntryCard = {
  key: 'Qr' | 'Shop' | 'Creator';
  href: string;
  icon: LucideIcon;
};

export async function LandingEntryPoints() {
  const t = await getTranslations('Landing');
  const locale = await getLocale();

  const cards: readonly EntryCard[] = [
    { key: 'Qr', href: `/${locale}/create`, icon: QrCode },
    { key: 'Shop', href: `/${locale}/create?tab=mobileOrder`, icon: Store },
    { key: 'Creator', href: `/${locale}/guide/store`, icon: Palette },
  ];

  return (
    <section className="mt-24 sm:mt-28">
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="text-[1.75rem] font-bold leading-tight tracking-tight text-slate-900 sm:text-4xl">
          {t('entryTitle')}
        </h2>
        <p className="mt-3 text-sm text-slate-500 sm:text-base">
          {t('entrySubtitle')}
        </p>
      </div>
      <div className="mx-auto mt-8 grid max-w-4xl grid-cols-1 gap-4 sm:grid-cols-3">
        {cards.map(({ key, href, icon: Icon }) => (
          <Link
            key={key}
            href={href}
            prefetch={false}
            className="group flex flex-col rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[0_2px_8px_-2px_rgba(15,23,42,0.07)] transition-all hover:-translate-y-0.5 hover:border-brand/30 hover:shadow-[0_8px_20px_-10px_rgba(15,23,42,0.25)]"
          >
            <span className="flex items-center gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand/10">
                <Icon className="h-5 w-5 text-brand" aria-hidden />
              </span>
              <span className="text-lg font-bold text-slate-900">
                {t(`entry${key}Title`)}
              </span>
            </span>
            <p className="mt-3 text-sm leading-relaxed text-slate-600">
              {t(`entry${key}Body`)}
            </p>
            <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-brand">
              {t(`entry${key}Cta`)}
              <span
                aria-hidden
                className="transition-transform duration-200 group-hover:translate-x-0.5"
              >
                →
              </span>
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
