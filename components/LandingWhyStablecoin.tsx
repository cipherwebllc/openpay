// LP「なぜ今、ステーブルコインなのか + JPYCとは」— トップ総合案内化 P1
// (plans/site-ia-guides-ruling.md N1・2026-08-04 user 承認)。初訪問者向けの前提知識を
// 1 セクションに統合する (2 分割は LP の縦長化に対して冗長という裁定)。
// 投資・価格上昇の訴求はしない。1 JPYC = 1 円は言い切る (2026-08-05 user 裁定)。

import { getTranslations } from 'next-intl/server';
import {
  JapaneseYen,
  Wallet,
  Coins,
  Users,
  ExternalLink,
  type LucideIcon,
} from 'lucide-react';
import { LandingSectionHeader } from '@/components/LandingSectionHeader';

// JPYC 入門+運用・ウォレット選びの note 記事 (2026-08-05 user 指示で追加)。
const JPYC_NOTE_ARTICLE_URL = 'https://note.com/masia02/n/ned04a4cdb00a';

const ITEMS: readonly { key: 1 | 2 | 3 | 4; icon: LucideIcon }[] = [
  { key: 1, icon: JapaneseYen },
  { key: 2, icon: Wallet },
  { key: 3, icon: Coins },
  { key: 4, icon: Users },
];

export async function LandingWhyStablecoin() {
  const t = await getTranslations('Landing');

  return (
    <section className="mt-16 sm:mt-28">
      <LandingSectionHeader eyebrow={t('eyebrowWhy')} title={t('whyStablecoinTitle')} lead={t('whyStablecoinSubtitle')} />
      {/* スマホでも 2×2 の小さなタイル (1 列の大きなカード 4 枚 ≒ 2 画面ぶんを半分に・plans/lp-polish-2026-09.md P1)。 */}
      <div className="mx-auto mt-8 grid max-w-4xl grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {ITEMS.map(({ key, icon: Icon }) => (
          <div
            key={key}
            className="flex flex-col rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[0_2px_8px_-2px_rgba(15,23,42,0.07)] sm:p-5"
          >
            <span className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand/10 sm:h-10 sm:w-10">
                <Icon className="h-5 w-5 text-brand" aria-hidden />
              </span>
              <span className="text-sm font-bold text-slate-900 sm:text-lg">
                {t(`whyItem${key}Title`)}
              </span>
            </span>
            <p className="mt-2 text-xs leading-relaxed text-slate-600 sm:mt-3 sm:text-sm">
              {t(`whyItem${key}Body`)}
            </p>
          </div>
        ))}
      </div>
      {/* JPYC の一言説明 — 独立の大きなカードにせず、見出しと本文を 1 段落に詰めた注記として添える。 */}
      <div className="mx-auto mt-3 max-w-4xl rounded-2xl border border-blue-200/70 bg-blue-50/70 px-4 py-3 text-sm leading-relaxed text-blue-900 sm:mt-4 sm:px-5 sm:py-4">
        <p>
          <span className="font-bold">{t('jpycNoteTitle')}</span>
          <span className="text-blue-800/90">　{t('jpycNoteBody')}</span>
        </p>
        <a
          href={JPYC_NOTE_ARTICLE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1.5 inline-flex items-center gap-1.5 text-sm font-semibold text-brand underline-offset-2 hover:underline"
        >
          {t('jpycNoteLink')}
          <ExternalLink className="h-4 w-4" aria-hidden />
        </a>
      </div>
    </section>
  );
}
