// FAQ アコーディオン。<details> ベースで JS 不要 (Server Component)。
//
// faqA4 は t.rich() で 2 つの inline link を埋め込む:
//   - <jpycEx>: JPYC 公式 (https://jpyc.co.jp/) — JPYC EX label
//   - <create>: 受け取るページ (/[locale]/create)
// 「/create」path 直接表記は一般読み手に分かりにくいため、ラベル「受け取る」で
// 内部 Link に置き換える。

import type { ReactNode } from 'react';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { ChevronDown } from 'lucide-react';

type FaqKey = 'faqQ1' | 'faqQ2' | 'faqQ3' | 'faqQ4' | 'faqQ5';
type FaqAnswerKey = 'faqA1' | 'faqA2' | 'faqA3' | 'faqA4' | 'faqA5';

const QA: readonly { q: FaqKey; a: FaqAnswerKey }[] = [
  { q: 'faqQ1', a: 'faqA1' },
  { q: 'faqQ2', a: 'faqA2' },
  { q: 'faqQ3', a: 'faqA3' },
  { q: 'faqQ4', a: 'faqA4' },
  { q: 'faqQ5', a: 'faqA5' },
];

export async function LandingFaq() {
  const locale = await getLocale();
  const t = await getTranslations('Landing');

  function renderAnswer(key: FaqAnswerKey): ReactNode {
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
    return t(key);
  }

  return (
    <section className="mt-14">
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl">
          {t('faqTitle')}
        </h2>
      </div>

      <ul className="mx-auto mt-6 max-w-3xl space-y-2">
        {QA.map(({ q, a }) => (
          <li key={q}>
            <details className="group rounded-2xl border border-slate-200 bg-white px-5 py-4 open:shadow-sm">
              <summary className="flex cursor-pointer list-none items-start gap-2 text-left text-sm font-semibold text-slate-800">
                <span className="flex-1">{t(q)}</span>
                <ChevronDown
                  className="mt-0.5 h-4 w-4 flex-shrink-0 text-slate-400 transition-transform group-open:rotate-180"
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
