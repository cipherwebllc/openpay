// FAQ アコーディオン。<details> ベースで JS 不要 (Server Component)。
//
// faqA4 は t.rich() で 2 つの inline link を埋め込む:
//   - <jpycEx>: JPYC EX (https://jpyc.co.jp/・サイト全体で統一表記)
//   - <create>: 受け取るページ (/[locale]/create)
// 「/create」path 直接表記は一般読み手に分かりにくいため、ラベル「受け取る」で
// 内部 Link に置き換える。

import { LANDING_PAYMENT_FEE_VALUES } from '@/lib/legal';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { ChevronDown } from 'lucide-react';
import { LandingSectionHeader } from '@/components/LandingSectionHeader';
import { LANDING_FAQ, type LandingFaqAnswerKey } from '@/lib/landingFaq';


export async function LandingFaq() {
  const locale = await getLocale();
  const t = await getTranslations('Landing');

  function renderAnswer(key: LandingFaqAnswerKey): ReactNode {
    if (key === 'faqA4') {
      return t.rich(key, {
        jpycEx: (chunks) => (
          <a
            href="https://jpyc.co.jp/"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-brand underline underline-offset-2 hover:text-brand-dark"
          >
            {chunks}
          </a>
        ),
        create: (chunks) => (
          <Link
            href={`/${locale}/create`}
            prefetch={false}
            className="font-medium text-brand underline underline-offset-2 hover:text-brand-dark"
          >
            {chunks}
          </Link>
        ),
      });
    }
    return t(key, LANDING_PAYMENT_FEE_VALUES);
  }

  return (
    <section className="mt-16 sm:mt-28">
      <LandingSectionHeader eyebrow={t('eyebrowFaq')} title={t('faqTitle')} />

      <ul className="mx-auto mt-8 max-w-3xl divide-y divide-slate-100 overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70">
        {LANDING_FAQ.map(({ q, a }) => (
          <li key={q}>
            <details className="group px-5 py-4 transition-colors open:bg-slate-50/60 sm:px-6 sm:py-5">
              <summary className="flex cursor-pointer list-none items-start gap-3 text-left text-sm font-semibold text-slate-800 sm:text-[15px]">
                <span className="flex-1">{t(q)}</span>
                <ChevronDown
                  className="mt-0.5 h-4 w-4 flex-shrink-0 text-slate-400 transition-transform duration-200 group-open:rotate-180 group-open:text-brand"
                  aria-hidden
                />
              </summary>
              <p className="mt-3 text-sm leading-relaxed text-slate-600">
                {renderAnswer(a)}
              </p>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
