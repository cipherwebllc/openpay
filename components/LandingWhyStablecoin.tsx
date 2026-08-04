// LP「なぜ今、ステーブルコインなのか + JPYCとは」— トップ総合案内化 P1
// (plans/site-ia-guides-ruling.md N1・2026-08-04 user 承認)。初訪問者向けの前提知識を
// 1 セクションに統合する (2 分割は LP の縦長化に対して冗長という裁定)。
// 投資・価格上昇の訴求はしない。1 JPYC = 1 円は言い切る (2026-08-05 user 裁定)。

import { getTranslations } from 'next-intl/server';
import { JapaneseYen, Wallet, Coins, Users, type LucideIcon } from 'lucide-react';

const ITEMS: readonly { key: 1 | 2 | 3 | 4; icon: LucideIcon }[] = [
  { key: 1, icon: JapaneseYen },
  { key: 2, icon: Wallet },
  { key: 3, icon: Coins },
  { key: 4, icon: Users },
];

export async function LandingWhyStablecoin() {
  const t = await getTranslations('Landing');

  return (
    <section className="mt-24 sm:mt-28">
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="text-[1.75rem] font-bold leading-tight tracking-tight text-slate-900 sm:text-4xl">
          {t('whyStablecoinTitle')}
        </h2>
        <p className="mt-3 text-sm text-slate-500 sm:text-base">
          {t('whyStablecoinSubtitle')}
        </p>
      </div>
      <div className="mx-auto mt-8 grid max-w-4xl grid-cols-1 gap-4 sm:grid-cols-2">
        {ITEMS.map(({ key, icon: Icon }) => (
          <div
            key={key}
            className="flex flex-col rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[0_2px_8px_-2px_rgba(15,23,42,0.07)]"
          >
            <span className="flex items-center gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand/10">
                <Icon className="h-5 w-5 text-brand" aria-hidden />
              </span>
              <span className="text-lg font-bold text-slate-900">
                {t(`whyItem${key}Title`)}
              </span>
            </span>
            <p className="mt-3 text-sm leading-relaxed text-slate-600">
              {t(`whyItem${key}Body`)}
            </p>
          </div>
        ))}
      </div>
      {/* JPYC の一言説明 — 独立セクションにせず補足カードとして添える。 */}
      <div className="mx-auto mt-4 max-w-4xl rounded-2xl border border-blue-200/70 bg-gradient-to-br from-blue-50 to-blue-100/30 p-5 sm:p-6">
        <h3 className="text-base font-bold text-blue-900 sm:text-lg">
          {t('jpycNoteTitle')}
        </h3>
        <p className="mt-2 text-sm leading-relaxed text-blue-800/90">
          {t('jpycNoteBody')}
        </p>
      </div>
    </section>
  );
}
