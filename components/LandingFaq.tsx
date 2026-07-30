// FAQ アコーディオン。<details> ベースで JS 不要 (Server Component)。
//
// faqA4 は t.rich() で 2 つの inline link を埋め込む:
//   - <jpycEx>: JPYC EX (https://jpyc.co.jp/・サイト全体で統一表記)
//   - <create>: 受け取るページ (/[locale]/create)
// 「/create」path 直接表記は一般読み手に分かりにくいため、ラベル「受け取る」で
// 内部 Link に置き換える。

import type { ReactNode } from 'react';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { ChevronDown } from 'lucide-react';

type FaqKey = 'faqQ1' | 'faqQ7' | 'faqQ2' | 'faqQ3' | 'faqQ4' | 'faqQ5' | 'faqQ8';
type FaqAnswerKey = 'faqA1' | 'faqA7' | 'faqA2' | 'faqA3' | 'faqA4' | 'faqA5' | 'faqA8';

const QA: readonly { q: FaqKey; a: FaqAnswerKey }[] = [
  { q: 'faqQ1', a: 'faqA1' },
  // 「JPYC・USDC とは」= 基礎説明。「どちらを受け取るか (faqQ2)」の直前に置く。
  { q: 'faqQ7', a: 'faqA7' },
  { q: 'faqQ2', a: 'faqA2' },
  { q: 'faqQ3', a: 'faqA3' },
  { q: 'faqQ4', a: 'faqA4' },
  { q: 'faqQ5', a: 'faqA5' },
  // B2B 請求 (開発費/保守費) の利用例 — Mi&T の法人 JPYC 受付 (2026-07-27) を受けた
  // 訴求拡張 (user 承認 2026-07-30)。新機能の約束はせず既存の決済リンクの説明のみ。
  { q: 'faqQ8', a: 'faqA8' },
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
    <section className="mt-24 sm:mt-28">
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="text-[1.75rem] font-bold leading-tight tracking-tight text-slate-900 sm:text-4xl">
          {t('faqTitle')}
        </h2>
      </div>

      <ul className="mx-auto mt-8 max-w-3xl divide-y divide-slate-100 overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70">
        {QA.map(({ q, a }) => (
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
