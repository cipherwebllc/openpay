// AI・開発者向けの節: AI エージェントが JPYC で支払う・API を売る入口。Server Component。
// 決済手段の変遷の図 (現金 → カード → QR → AI・#672) は外した: 宛名を「AI・開発者向け」にした節では、読者が決めるのに
// 要るのは「何がつながるか」と入口で、図は装飾だった (2026-10-25 引き算・plans/lp-polish-2026-10-25.md)。
// 「OpenPay = AI の支払いだけ」に見えない役目は、お店向けのヒーローとこの節の宛名が持つ。

import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { env } from '@/lib/env';
import { LandingSectionHeader } from '@/components/LandingSectionHeader';
import { LANDING_ACTION_ROW, LANDING_NOTE_CENTERED, LANDING_PRIMARY, LANDING_SECONDARY } from '@/components/LandingControls';

export async function LandingAiAgents() {
  const locale = await getLocale();
  const t = await getTranslations('Landing');

  return (
    <section id="lp-ai" className="mt-16 scroll-mt-24 sm:mt-28">
      {/* ヒーローの「AI・開発者向け」から飛んでくる節 (ヘッダの下に見出しが隠れないよう余白を取る)。 */}
      <LandingSectionHeader eyebrow={t('eyebrowAgent')} title={t('aiEraTitle')} lead={t('aiEraBody')} />

      {/* 主導線は /agent (Agent を接続して試す)。/agent は flag なしで常に公開。節の主ボタンの型 (中身の幅。スマホでも全幅にしない =
          ヒーローの主ボタンより大きく見せない)。 */}
      <div className="mt-8 flex flex-col items-center">
        <Link href={`/${locale}/agent`} prefetch={false} className={LANDING_PRIMARY.brand}>
          {t('aiEraCtaAgent')}
        </Link>
        {/* 注は 4 文ある。スマホで中央寄せにすると行の頭がそろわず読みにくいので、スマホは左寄せ (注の型)。 */}
        <p className={`mt-3 ${LANDING_NOTE_CENTERED}`}>{t('aiEraAgentNote')}</p>
      </div>

      {/* 補助の 3 つは小さな横並び (スマホで 3 段の全幅ボタンにすると主導線と同じ重さに見える)。 */}
      <div className={`mt-5 ${LANDING_ACTION_ROW}`}>
        {/* /discovery は flag OFF で notFound になるため、OFF 環境では 404 導線を出さない。 */}
        {env.enableX402Facilitator && (
          <Link
            href={`/${locale}/discovery`}
            prefetch={false}
            className={LANDING_SECONDARY.brand}
          >
            {t('aiEraCtaStore')}
          </Link>
        )}
        <Link
          href={`/${locale}/guide/ai-pay`}
          prefetch={false}
          className={LANDING_SECONDARY.brand}
        >
          {t('aiEraCtaPay')}
        </Link>
        <Link
          href={`/${locale}/guide/sell`}
          prefetch={false}
          className={LANDING_SECONDARY.brand}
        >
          {t('aiEraCtaSell')}
        </Link>
      </div>
      {/* 売り手側の一言: 「実売済み」の証拠は /guide/sell が持つ (LP は控えめに 1 行だけ)。 */}
      <p className={`mt-3 ${LANDING_NOTE_CENTERED}`}>{t('aiEraSellNote')}</p>
    </section>
  );
}
