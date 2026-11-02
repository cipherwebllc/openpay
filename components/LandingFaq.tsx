// FAQ アコーディオン。<details> ベースで JS 不要 (Server Component)。
//
// 回答は t.rich() で inline link を埋め込む:
//   - <jpycEx>: JPYC EX (https://jpyc.co.jp/・サイト全体で統一表記)
//   - <create>: 受け取るページ (/[locale]/create)
//   - <pricing>: 料金ページ (/[locale]/pricing・faqA1 の詳細の行き先)
//   - <guide>: JPYC 払いの割引のガイド (/[locale]/guide/qr#jpyc-discount)
// 「/create」path 直接表記は一般読み手に分かりにくいため、ラベル「受け取る」で
// 内部 Link に置き換える。タグを足したら StructuredData の FAQ_PLAIN_TAGS にも足す。

import { LANDING_PAYMENT_FEE_VALUES } from '@/lib/legal';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { ChevronDown } from 'lucide-react';
import { LandingSectionHeader } from '@/components/LandingSectionHeader';
import { LANDING_FAQ, type LandingFaqAnswerKey } from '@/lib/landingFaq';

function FaqLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      prefetch={false}
      className="font-medium text-brand underline underline-offset-2 hover:text-brand-dark"
    >
      {children}
    </Link>
  );
}

export async function LandingFaq() {
  const locale = await getLocale();
  const t = await getTranslations('Landing');

  function renderAnswer(key: LandingFaqAnswerKey): ReactNode {
    return t.rich(key, {
      ...LANDING_PAYMENT_FEE_VALUES,
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
      create: (chunks) => <FaqLink href={`/${locale}/create`}>{chunks}</FaqLink>,
      pricing: (chunks) => <FaqLink href={`/${locale}/pricing`}>{chunks}</FaqLink>,
      guide: (chunks) => <FaqLink href={`/${locale}/guide/qr#jpyc-discount`}>{chunks}</FaqLink>,
    });
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
