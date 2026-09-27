// 決済手段の変遷と、AI エージェントが支払う次の時代を示す。Server Component。
// OpenPay が受け持つのは QR 決済 (人が払う) から AI が支払うまで。AI だけを強調すると
// 「OpenPay = AI の支払い」と読まれるので、2 つをまとめて 1 つの「OpenPay はここ」で囲む。

import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { Banknote, Bot, CreditCard, QrCode } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { env } from '@/lib/env';

type EraStep = {
  Icon: LucideIcon;
  labelKey: 'aiEraCash' | 'aiEraCard' | 'aiEraQr' | 'aiEraAgent';
  openPay?: true;
};

// OpenPay の 2 マスは末尾に並べる (囲みの位置 = PC は右半分・スマホは下半分、を前提にしている)。
const ERA_STEPS: readonly EraStep[] = [
  { Icon: Banknote, labelKey: 'aiEraCash' },
  { Icon: CreditCard, labelKey: 'aiEraCard' },
  { Icon: QrCode, labelKey: 'aiEraQr', openPay: true },
  { Icon: Bot, labelKey: 'aiEraAgent', openPay: true },
];

export async function LandingAiAgents() {
  const locale = await getLocale();
  const t = await getTranslations('Landing');

  return (
    <section className="mt-24 sm:mt-28">
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="text-[1.75rem] font-bold leading-tight tracking-tight text-slate-900 sm:text-4xl">
          {t('aiEraTitle')}
        </h2>
        <p className="mt-4 text-sm leading-relaxed text-slate-600 sm:text-base">
          {t('aiEraBody')}
        </p>
      </div>

      {/* 囲み (枠 + ラベル) は見た目だけの重ね描き。読み上げは各マスの「OpenPay はここ」で伝える。
          行の高さは auto-rows-fr でそろえるので (文字を大きくしてラベルが折り返しても)、囲みは PC で右半分・スマホで下半分に一致する。 */}
      <div className="relative mt-12">
        <ol className="grid auto-rows-fr overflow-hidden rounded-3xl border border-slate-200/80 bg-white shadow-card divide-y divide-slate-200 sm:grid-cols-4 sm:divide-x sm:divide-y-0">
          {ERA_STEPS.map(({ Icon, labelKey, openPay }) => (
            <li
              key={labelKey}
              className={`flex items-center gap-4 p-5 sm:min-h-44 sm:flex-col sm:justify-center sm:text-center ${
                openPay ? 'bg-blue-50/80' : ''
              }`}
            >
              <span
                className={`flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-2xl ${
                  openPay ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'
                }`}
              >
                <Icon className="h-6 w-6" strokeWidth={1.75} aria-hidden />
              </span>
              <span className={`text-sm font-semibold ${openPay ? 'text-brand' : 'text-slate-700'}`}>
                {t(labelKey)}
                {openPay ? <span className="sr-only"> {t('aiEraNow')}</span> : null}
              </span>
            </li>
          ))}
        </ol>
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 top-1/2 rounded-b-3xl border-2 border-blue-500 sm:inset-y-0 sm:left-1/2 sm:right-0 sm:rounded-bl-none sm:rounded-r-3xl"
        >
          <span className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full bg-blue-600 px-3 py-1 text-xs font-semibold text-white shadow-sm">
            {t('aiEraNow')}
          </span>
        </div>
      </div>

      {/* 主導線は /agent (Agent を接続して試す)。/agent は flag なしで常に公開。 */}
      <div className="mt-8 flex flex-col items-center">
        <Link
          href={`/${locale}/agent`}
          prefetch={false}
          className="inline-flex w-full items-center justify-center whitespace-nowrap rounded-full bg-blue-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 active:scale-[0.98] sm:w-auto sm:text-base"
        >
          {t('aiEraCtaAgent')}
        </Link>
        <p className="mt-3 text-center text-xs text-slate-500 sm:text-sm">{t('aiEraAgentNote')}</p>
      </div>

      <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
        {/* /discovery は flag OFF で notFound になるため、OFF 環境では 404 導線を出さない。 */}
        {env.enableX402Facilitator && (
          <Link
            href={`/${locale}/discovery`}
            prefetch={false}
            className="inline-flex w-full items-center justify-center whitespace-nowrap rounded-full border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:border-blue-300 hover:text-brand active:scale-[0.98] sm:w-auto"
          >
            {t('aiEraCtaStore')}
          </Link>
        )}
        <Link
          href={`/${locale}/guide/ai-pay`}
          prefetch={false}
          className="inline-flex w-full items-center justify-center whitespace-nowrap rounded-full border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:border-blue-300 hover:text-brand active:scale-[0.98] sm:w-auto"
        >
          {t('aiEraCtaPay')}
        </Link>
        <Link
          href={`/${locale}/guide/sell`}
          prefetch={false}
          className="inline-flex w-full items-center justify-center whitespace-nowrap rounded-full border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:border-blue-300 hover:text-brand active:scale-[0.98] sm:w-auto"
        >
          {t('aiEraCtaSell')}
        </Link>
      </div>
      {/* 売り手側の一言: 「実売済み」の証拠は /guide/sell が持つ (LP は控えめに 1 行だけ)。 */}
      <p className="mt-3 text-center text-xs text-slate-500">{t('aiEraSellNote')}</p>
    </section>
  );
}
