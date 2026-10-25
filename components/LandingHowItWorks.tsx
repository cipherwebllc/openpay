// 「使い方」: 操作の短い動画 3 本 + お店の 3 ステップ + ガイドへの入口。Server Component。
// お客様 (支払う側) の 3 ステップは外した: トップの読者はお店で、支払う流れは動画の ③ と支払い方のガイドが持つ
// (2026-10-25 引き算・plans/lp-polish-2026-10-25.md)。お店の 3 ステップは動画の下に 1 段で並べる。

import { getTranslations } from 'next-intl/server';
import { LandingEntryPoints } from '@/components/LandingEntryPoints';
import { Store } from 'lucide-react';
import { LandingSectionHeader } from '@/components/LandingSectionHeader';
import { STEP_BADGE } from '@/components/guide/PosGuidePieces';
import { LandingDemoVideos } from '@/components/LandingDemoVideos';

export async function LandingHowItWorks() {
  const t = await getTranslations('Landing');

  const merchant = [
    t('howItWorksMerchantStep1'),
    t('howItWorksMerchantStep2'),
    t('howItWorksMerchantStep3'),
  ];

  return (
    <section className="mt-16 sm:mt-28">
      <LandingSectionHeader eyebrow={t('eyebrowStart')} title={t('howItWorksTitle')} lead={t('howItWorksSubtitle')} />

      {/* 操作の短い動画 3 本 (2026-10-13 にいまの画面で撮り直した)。旧 UI の 3 本 (public/demo/*-mobile.*) は
          README の GIF と scripts/gen-intro-video.mjs の素材なので残してある。 */}
      <LandingDemoVideos
        caption={t('howItWorksDemoCaption')}
        note={t('howItWorksDemoNote')}
        pauseLabel={t('howItWorksDemoPause')}
        playLabel={t('howItWorksDemoPlay')}
        demos={[
          {
            src: '/demo/lp-qr.mp4',
            poster: '/demo/lp-qr-poster.webp',
            label: t('howItWorksDemoQr'),
            description: t('howItWorksDemoQrAlt'),
          },
          {
            src: '/demo/lp-register.mp4',
            poster: '/demo/lp-register-poster.webp',
            label: t('howItWorksDemoRegister'),
            description: t('howItWorksDemoRegisterAlt'),
          },
          {
            src: '/demo/lp-pay.mp4',
            poster: '/demo/lp-pay-poster.webp',
            label: t('howItWorksDemoPay'),
            description: t('howItWorksDemoPayAlt'),
          },
        ]}
      />
      <article className="mt-8 rounded-2xl bg-white p-6 shadow-card ring-1 ring-slate-200/70">
        <h3 className="flex items-center gap-2 text-base font-semibold text-emerald-900">
          <Store aria-hidden className="h-5 w-5 text-emerald-600" />
          {t('howItWorksMerchantTitle')}
        </h3>
        <ol className="mt-4 grid gap-3 sm:grid-cols-3 sm:gap-5">
          {merchant.map((step, i) => (
            <li key={i} className="flex items-start gap-3 text-sm text-slate-700">
              <span className={STEP_BADGE}>{i + 1}</span>
              <span className="pt-0.5 leading-relaxed">{step}</span>
            </li>
          ))}
        </ol>
      </article>

      {/* ガイドへの入口はここ 1 か所 (手順を読んだ直後の「次の一歩」・ガイドのハブと同じカード)。 */}
      <LandingEntryPoints />

    </section>
  );
}
