// モバイルオーダーの訴求の直下に置く「注文リンク」の 1 行の案内 (Server Component・2026-11-05)。
//
// 注文リンク (/create の「注文リンク」タブ) は LINE 公式アカウントや DM で注文を受けるお店向け。トップのどこにも
// 出ていなかったので、店舗オペレーションの章 (モバイルオーダー) の隣に、小さな 1 枚で入口だけを置く。
// 行き先はガイド (/guide/order-link・使い方動画と「作る」ボタンがある)。大きな訴求はモバイルオーダーに残す (主役を割らない)。
// 利用料の説明はここに書かない (料金の欄 = LandingSupport と料金ページが lib/pricing.ts から出す・掟 14)。

import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { ArrowRight, Link2 } from 'lucide-react';
import { LANDING_CARD, LANDING_ICON_BOX, LANDING_LINK_ARROW, LANDING_TEXT_LINK } from '@/components/LandingControls';

export async function LandingOrderLink() {
  const locale = await getLocale();
  const t = await getTranslations('Landing');

  return (
    <section className="mt-4">
      {/* カードの型・アイコンの箱の型 (36px)。 */}
      <div className={`flex flex-col gap-2 p-5 sm:flex-row sm:items-center sm:gap-5 sm:p-6 ${LANDING_CARD}`}>
        <div className="flex min-w-0 flex-1 items-start gap-3.5">
          <span className={`${LANDING_ICON_BOX} bg-emerald-50`}>
            <Link2 className="h-5 w-5 text-emerald-700" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-bold leading-snug text-slate-900 [word-break:auto-phrase] sm:text-lg">
              {t('orderLinkStripTitle')}
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-slate-600 [word-break:auto-phrase]">{t('orderLinkStripBody')}</p>
          </div>
        </div>
        {/* 文字リンクの型 (押せる高さ 44px)。色はこの節の緑。リンク名は可視テキストだけ (矢印は aria-hidden・掟 8)。
            スマホの字下げ (アイコンの箱 36px + 間 14px = 3.125rem) は margin で取る (padding だと focus の輪が字下げの空きまで囲む)。 */}
        <Link
          href={`/${locale}/guide/order-link`}
          prefetch={false}
          className={`ml-[3.125rem] shrink-0 self-start sm:ml-0 sm:self-center ${LANDING_TEXT_LINK.shop}`}
        >
          {t('orderLinkStripLink')}
          <ArrowRight aria-hidden className={LANDING_LINK_ARROW} />
        </Link>
      </div>
    </section>
  );
}
