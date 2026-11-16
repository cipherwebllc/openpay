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
import { LANDING_CARD } from '@/components/LandingControls';
import { phrased } from '@/components/Phrased';

// 行の左右の余白 (スマホ 20px・sm 以上 24px)。質問 (summary) と答えで同じ値を使い、答えの左を質問の左にそろえる。
const ROW_X = 'px-5 sm:px-6';
// 質問 (summary) = 行の押せる範囲。上下の余白 (スマホ 16px・sm 以上 20px) も summary が持つので、行のどこを押しても開閉する。
// 開いたときだけ下の余白を 12px にする (質問と答えの間)。
// キーボードの focus の輪は行の内側に 2px の紺で描く (節のボタンと同じ太さと色)。行は外枠の端まであるので、外側に描くと外枠の
// overflow-hidden と角の丸みで切れる。輪の角は外枠と同じ丸み (1 行目と最後の行でも外枠の角に切られない)。丸みは focus のとき
// だけ付ける: いつも付けると、行の四隅 (丸みの外) が押せる範囲から外れる。
const SUMMARY = `flex cursor-pointer list-none items-start gap-3 ${ROW_X} py-4 text-left text-sm font-semibold text-slate-800 focus-visible:rounded-2xl focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand group-open:pb-3 sm:py-5 sm:text-[15px]`;
// 答え。下の余白は行の下の余白 (閉じた行の下の余白と同じ 16 / 20px)。
const ANSWER = `${ROW_X} pb-4 text-sm leading-relaxed text-slate-600 [word-break:auto-phrase] supports-[word-break:auto-phrase]:text-pretty sm:pb-5`;

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
      {/* 補足の節 (読みたい人が開く質問): 見出しを 1 段小さくし、見出しから中身までも狭くして、ふつうの節より一段弱く見せる。 */}
      <LandingSectionHeader eyebrow={t('eyebrowFaq')} title={phrased(t('faqTitle'), locale)} size="sm" />

      <ul className={`mx-auto mt-6 max-w-3xl divide-y divide-slate-100 overflow-hidden ${LANDING_CARD}`}>
        {LANDING_FAQ.map(({ q, a }) => (
          <li key={q}>
            {/* 行の余白は summary が持つ (details に付けると、押せるのは質問の文字の高さ 20px だけで、行の余白を押しても開かない)。
                開いたときは summary の下の余白を 12px にして (group-open:pb-3)、答えの下に行の下の余白を置く。閉じた姿も開いた姿も、
                余白を details に付けていたときと同じ位置になる (質問と答えの間 12px・答えの下 16 / 20px)。 */}
            <details className="group transition-colors open:bg-slate-50/60">
              <summary className={SUMMARY}>
                {/* 質問の折り返し: 文節で折れるブラウザ (Chromium 系) は、文節で折って最後の行を短くしすぎない (text-pretty)。
                    文節が分からないブラウザ (WebKit = iPhone の Safari) は、行の長さをそろえる (text-balance)。そろえないと
                    「…換金するに / は?」のように最後の行が 1〜2 字になる。 */}
                <span className="flex-1 text-balance [word-break:auto-phrase] supports-[word-break:auto-phrase]:text-pretty">{phrased(t(q), locale)}</span>
                {/* 開いた印の回転は、動きを減らす設定 (prefers-reduced-motion: reduce) でないときだけ。そのときも開いた印は
                    矢印の色 (紺) と開いた答えで分かる。 */}
                <ChevronDown
                  className="mt-0.5 h-4 w-4 flex-shrink-0 text-slate-400 transition-transform duration-200 motion-safe:group-open:rotate-180 group-open:text-brand"
                  aria-hidden
                />
              </summary>
              <p className={ANSWER}>
                {renderAnswer(a)}
              </p>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
