// モバイルオーダーの訴求の直下に置く「注文リンク」の 1 行の案内 (Server Component・2026-11-05)。
//
// 注文リンク (/create の「注文リンク」タブ) は LINE 公式アカウントや DM で注文を受けるお店向け。トップのどこにも
// 出ていなかったので、店舗オペレーションの章 (モバイルオーダー) の隣に、小さな 1 枚で入口だけを置く。
// 行き先はガイド (/guide/order-link・使い方動画と「作る」ボタンがある)。大きな訴求はモバイルオーダーに残す (主役を割らない)。
// 利用料の説明はここに書かない (料金の欄 = LandingSupport と料金ページが lib/pricing.ts から出す・掟 14)。

import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { ArrowRight, Link2 } from 'lucide-react';

export async function LandingOrderLink() {
  const locale = await getLocale();
  const t = await getTranslations('Landing');

  return (
    <section className="mt-4">
      <div className="flex flex-col gap-2 rounded-[1.5rem] bg-white p-5 shadow-card ring-1 ring-slate-200/70 sm:flex-row sm:items-center sm:gap-5 sm:p-6">
        <div className="flex min-w-0 flex-1 items-start gap-3.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-emerald-50 ring-1 ring-inset ring-emerald-200/70">
            <Link2 className="h-5 w-5 text-emerald-700" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-bold leading-snug text-slate-900 [word-break:auto-phrase] sm:text-lg">
              {t('orderLinkStripTitle')}
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-slate-600 [word-break:auto-phrase]">{t('orderLinkStripBody')}</p>
          </div>
        </div>
        {/* リンク名は可視テキストだけ (矢印は aria-hidden・掟 8)。min-h-11 で押せる範囲 44px。 */}
        <Link
          href={`/${locale}/guide/order-link`}
          prefetch={false}
          className="group inline-flex min-h-11 shrink-0 items-center gap-1 self-start pl-[3.375rem] text-sm font-semibold text-emerald-800 underline-offset-2 hover:underline sm:self-center sm:pl-0"
        >
          {t('orderLinkStripLink')}
          <ArrowRight aria-hidden className="h-4 w-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>
    </section>
  );
}
