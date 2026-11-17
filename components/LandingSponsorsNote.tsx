// トップの下部 (締めの節の後・フッターの前) の小さな案内: スポンサー・広告掲載の募集 (/sponsors) への入口。Server Component。
// 2026-11-18 user 裁定の第 1 段 (募集ページと導線だけ)。文は承認済み (Landing.sponsorsNote)。リンクの名前は募集ページの題
// (lib/sponsors.ts の title・同じページを場所ごとに別の名前で呼ばない)。
// 節にしない (見出しを足さない・トップの構成を変えない)。client の JS を足さない (bundle の予算・Lighthouse)。
// 文字リンクの型 (押せる高さ 44px)。リンク名は可視テキストだけ (矢印は aria-hidden・掟 8)。

import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { ArrowRight } from 'lucide-react';
import { LANDING_LINK_ARROW, LANDING_NOTE_CENTERED, LANDING_TEXT_LINK } from '@/components/LandingControls';
import { phrased } from '@/components/Phrased';
import { sponsorsContentFor } from '@/lib/sponsors';

export async function LandingSponsorsNote() {
  const [locale, t] = await Promise.all([getLocale(), getTranslations('Landing')]);
  const sponsors = sponsorsContentFor(locale);

  return (
    <div className="mt-10 text-center sm:mt-12">
      <p className={LANDING_NOTE_CENTERED}>{phrased(t('sponsorsNote'), locale)}</p>
      <p className="mt-1">
        <Link href={`/${locale}/sponsors`} prefetch={false} className={LANDING_TEXT_LINK.brand}>
          {sponsors.title}
          <ArrowRight aria-hidden className={LANDING_LINK_ARROW} />
        </Link>
      </p>
    </div>
  );
}
