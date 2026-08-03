// LP「OpenPayでできること」— ナビ 4 区分 (決済/販売/Store/マイページ) と同じ構造で
// 全体像を一望させるセクション (plans/lp-restructure-ruling.md P1・2026-08-04 user 承認)。
// 見出しはナビと同じ Nav namespace・icon も navItems と同一 (トップとメニューの
// 情報設計を一致させるのが目的)。Store カードは navItems と同条件
// (enableCreatorStoreUi) で出し分け、flag OFF 環境で 404 導線を出さない。

import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  ScanLine,
  QrCode,
  ShoppingBag,
  CircleUserRound,
  ArrowRight,
  type LucideIcon,
} from 'lucide-react';
import { env } from '@/lib/env';

type CapabilityCard = {
  key: 'pay' | 'sell' | 'store' | 'me';
  href: string;
  icon: LucideIcon;
  items: readonly string[];
};

export async function LandingCapabilities() {
  const t = await getTranslations('Landing');
  const tNav = await getTranslations('Nav');
  const locale = await getLocale();

  const cards: readonly CapabilityCard[] = [
    {
      key: 'pay',
      href: `/${locale}/scan`,
      icon: ScanLine,
      items: [t('capPayItem1'), t('capPayItem2')],
    },
    {
      key: 'sell',
      href: `/${locale}/create`,
      icon: QrCode,
      items: [
        t('capSellItem1'),
        t('capSellItem2'),
        t('capSellItem3'),
        t('capSellItem4'),
        t('capSellItem5'),
      ],
    },
    ...(env.enableCreatorStoreUi
      ? ([
          {
            key: 'store',
            href: `/${locale}/store`,
            icon: ShoppingBag,
            items: [t('capStoreItem1'), t('capStoreItem2')],
          },
        ] as const)
      : []),
    {
      key: 'me',
      href: `/${locale}/me`,
      icon: CircleUserRound,
      items: [t('capMeItem1'), t('capMeItem2'), t('capMeItem3')],
    },
  ];

  return (
    <section className="mt-24 sm:mt-28">
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="text-[1.75rem] font-bold leading-tight tracking-tight text-slate-900 sm:text-4xl">
          {t('capabilitiesTitle')}
        </h2>
        <p className="mt-3 text-sm text-slate-500 sm:text-base">
          {t('capabilitiesSubtitle')}
        </p>
      </div>
      <div className="mx-auto mt-8 grid max-w-4xl grid-cols-1 gap-4 sm:grid-cols-2">
        {cards.map(({ key, href, icon: Icon, items }) => (
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
                {tNav(key)}
              </span>
              <ArrowRight
                className="ml-auto h-4 w-4 text-slate-300 transition-transform group-hover:translate-x-0.5 group-hover:text-brand"
                aria-hidden
              />
            </span>
            <span className="mt-3 flex flex-wrap gap-x-3 gap-y-1.5">
              {items.map((item) => (
                <span key={item} className="text-sm leading-relaxed text-slate-600">
                  {item}
                </span>
              ))}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
