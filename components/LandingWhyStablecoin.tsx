// LP「なぜ今、ステーブルコインなのか + JPYCとは」— トップ総合案内化 P1
// (plans/site-ia-guides-ruling.md N1・2026-08-04 user 承認)。初訪問者向けの前提知識を
// 1 セクションに統合する (2 分割は LP の縦長化に対して冗長という裁定)。
// 投資・価格上昇の訴求はしない。1 JPYC = 1 円は言い切らず、JPYC EX で 1 円として払い戻せる事実で書く (2026-10-25 user 裁定・規約の免責はペッグを保証しない)。

import { getTranslations } from 'next-intl/server';
import {
  JapaneseYen,
  Coins,
  ExternalLink,
  type LucideIcon,
} from 'lucide-react';
import { LandingSectionHeader } from '@/components/LandingSectionHeader';
import { GuideCallout } from '@/components/guide/GuideCallout';

// JPYC 入門+運用・ウォレット選びの note 記事 (2026-08-05 user 指示で追加)。
const JPYC_NOTE_ARTICLE_URL = 'https://note.com/masia02/n/ned04a4cdb00a';

// 「ウォレットから直接」(導入メリットの即時着金と重なる) と「広がる使いみち」(ヒーローの入口と重なる) は外した
// (2026-10-25 引き算)。円の感覚と小額・オンラインの 2 つだけを残す。
const ITEMS: readonly { key: 1 | 3; icon: LucideIcon }[] = [
  { key: 1, icon: JapaneseYen },
  { key: 3, icon: Coins },
];

export async function LandingWhyStablecoin() {
  const t = await getTranslations('Landing');

  return (
    <section className="mt-16 sm:mt-28">
      <LandingSectionHeader eyebrow={t('eyebrowWhy')} title={t('whyStablecoinTitle')} lead={t('whyStablecoinSubtitle')} />
      {/* スマホも PC も 2 枚を横に並べる小さなタイル。
          狭いタイルで語の途中 (「強 / い」) で折れないよう、文節の切れ目で改行する (Safari は通常の改行のまま)。 */}
      <div className="mx-auto mt-8 grid max-w-4xl grid-cols-2 gap-3 sm:gap-4">
        {ITEMS.map(({ key, icon: Icon }) => (
          <div
            key={key}
            className="flex flex-col rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[0_2px_8px_-2px_rgba(15,23,42,0.07)] [word-break:auto-phrase] sm:p-5"
          >
            <span className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand/10 sm:h-10 sm:w-10">
                <Icon className="h-5 w-5 text-brand" aria-hidden />
              </span>
              <span className="text-sm font-bold text-slate-900 sm:text-lg">
                {t(`whyItem${key}Title`)}
              </span>
            </span>
            <p className="mt-2 text-[13px] leading-relaxed text-slate-600 sm:mt-3 sm:text-sm">
              {t(`whyItem${key}Body`)}
            </p>
          </div>
        ))}
      </div>
      {/* JPYC の一言説明 — 独立の大きなカードにせず、見出しと本文を 1 段落に詰めた注記として添える。
          囲みの型はガイドの注記 (GuideCallout) と同じ (plans/lp-polish-2026-10.md P2)。 */}
      <GuideCallout kind="info" className="mx-auto mt-3 max-w-4xl sm:mt-4">
        <p>
          <span className="font-bold text-slate-900">{t('jpycNoteTitle')}</span>
          {'　'}
          {/* JPYC EX はテキストリンク (新規タブ)。href/描画は LandingFaq の <jpycEx> と同一パターン
              (円に戻せることは、外した現金比較の 1:1 の帯からここへ移した・plans/lp-polish-2026-10.md P1-5)。 */}
          {t.rich('jpycNoteBody', {
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
          })}
        </p>
        <a
          href={JPYC_NOTE_ARTICLE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1.5 inline-flex items-center gap-1.5 font-semibold text-brand underline-offset-2 hover:underline"
        >
          {t('jpycNoteLink')}
          <ExternalLink className="h-4 w-4" aria-hidden />
        </a>
      </GuideCallout>
    </section>
  );
}
