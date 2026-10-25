// AI・開発者向けの節: AI エージェントが JPYC で支払う・API を売る入口。Server Component。
// 決済手段の変遷の図 (現金 → カード → QR → AI・#672) は外した: 宛名を「AI・開発者向け」にした節では、読者が決めるのに
// 要るのは「何がつながるか」と入口で、図は装飾だった (2026-10-25 引き算・plans/lp-polish-2026-10-25.md)。
// 「OpenPay = AI の支払いだけ」に見えない役目は、お店向けのヒーローとこの節の宛名が持つ。

import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { env } from '@/lib/env';
import { LandingSectionHeader } from '@/components/LandingSectionHeader';

export async function LandingAiAgents() {
  const locale = await getLocale();
  const t = await getTranslations('Landing');

  return (
    <section id="lp-ai" className="mt-16 scroll-mt-24 sm:mt-28">
      {/* ヒーローの「AI・開発者向け」から飛んでくる節 (ヘッダの下に見出しが隠れないよう余白を取る)。 */}
      <LandingSectionHeader eyebrow={t('eyebrowAgent')} title={t('aiEraTitle')} lead={t('aiEraBody')} />

      {/* 主導線は /agent (Agent を接続して試す)。/agent は flag なしで常に公開。ボタンの形 (角丸・高さ 44px) はガイドとそろえる。 */}
      <div className="mt-8 flex flex-col items-center">
        <Link
          href={`/${locale}/agent`}
          prefetch={false}
          className="inline-flex min-h-11 w-full items-center justify-center whitespace-nowrap rounded-xl bg-blue-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 active:scale-[0.98] sm:w-auto sm:text-base"
        >
          {t('aiEraCtaAgent')}
        </Link>
        <p className="mt-3 text-center text-xs text-slate-500 sm:text-sm">{t('aiEraAgentNote')}</p>
      </div>

      {/* 補助の 3 つは小さな横並び (スマホで 3 段の全幅ボタンにすると主導線と同じ重さに見える)。 */}
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2 sm:gap-3">
        {/* /discovery は flag OFF で notFound になるため、OFF 環境では 404 導線を出さない。 */}
        {env.enableX402Facilitator && (
          <Link
            href={`/${locale}/discovery`}
            prefetch={false}
            className="inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-xl bg-white px-4 text-sm font-semibold text-slate-700 ring-1 ring-inset ring-slate-300 transition-colors hover:bg-slate-50 hover:text-brand active:scale-[0.98] sm:px-5"
          >
            {t('aiEraCtaStore')}
          </Link>
        )}
        <Link
          href={`/${locale}/guide/ai-pay`}
          prefetch={false}
          className="inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-xl bg-white px-4 text-sm font-semibold text-slate-700 ring-1 ring-inset ring-slate-300 transition-colors hover:bg-slate-50 hover:text-brand active:scale-[0.98] sm:px-5"
        >
          {t('aiEraCtaPay')}
        </Link>
        <Link
          href={`/${locale}/guide/sell`}
          prefetch={false}
          className="inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-xl bg-white px-4 text-sm font-semibold text-slate-700 ring-1 ring-inset ring-slate-300 transition-colors hover:bg-slate-50 hover:text-brand active:scale-[0.98] sm:px-5"
        >
          {t('aiEraCtaSell')}
        </Link>
      </div>
      {/* 売り手側の一言: 「実売済み」の証拠は /guide/sell が持つ (LP は控えめに 1 行だけ)。 */}
      <p className="mt-3 text-center text-xs text-slate-500">{t('aiEraSellNote')}</p>
    </section>
  );
}
