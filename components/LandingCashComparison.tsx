// 「現金に戻したお店へ」セクション (Server Component)。
// ターゲット = カード / コード決済の手数料が痛くて現金に戻した飲食 / 小売店主。
// crypto 語彙を避け、①現金を否定しない比較表 ②円⇄JPYC の 1:1 図解
// ③節約シミュレータ (client) で「損ゼロで置ける選択肢」を直感的に訴求する。
//
// 見出しスケールは他の Landing セクション (LandingBenefits) と揃える
// (text-2xl sm:text-3xl・中央)。手数料の数字は hero / 開示と整合させ、
// OpenPay はレジ JPYC の料率・ガスレス最低額・無料の範囲を併記する。比較先の料率は脚注で例示。

import { LANDING_PAYMENT_FEE_VALUES } from '@/lib/legal';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { ArrowRight } from 'lucide-react';
import { TokenLogo } from '@/components/AssetLogo';
import { SavingsSimulator } from '@/components/SavingsSimulator';

// 比較表の行定義。i18n key は `cashCell{Row}{Col}` で命名統一。
type RowId = 'Fee' | 'Settle' | 'Setup' | 'Lock';
const ROWS: readonly { id: RowId; labelKey: string }[] = [
  { id: 'Fee', labelKey: 'cashRowFee' },
  { id: 'Settle', labelKey: 'cashRowSettle' },
  { id: 'Setup', labelKey: 'cashRowSetup' },
  { id: 'Lock', labelKey: 'cashRowLock' },
];

export async function LandingCashComparison() {
  const locale = await getLocale();
  const t = await getTranslations('Landing');

  return (
    <section className="mt-16 sm:mt-28">
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="text-[1.75rem] font-bold leading-tight tracking-tight text-slate-900 sm:text-4xl">
          {t('cashTitle')}
        </h2>
        <p className="mt-3 text-sm text-slate-500 sm:text-base">{t('cashSubtitle')}</p>
      </div>

      {/* 比較表: モバイルでも 3 列が 1 画面に収まるよう圧縮 (結論の OpenPay 列を隠さない)。overflow-x-auto は保険。
          OpenPay 列を brand tint で強調しつつ、現金列を否定しないトーン。 */}
      <div className="mx-auto mt-8 max-w-3xl overflow-x-auto rounded-2xl border border-slate-200 shadow-card">
        <table className="w-full border-collapse bg-white text-[13px] sm:text-sm">
          <thead>
            <tr className="border-b border-slate-200">
              <th className="px-2 py-3 sm:px-4 text-left text-xs font-semibold text-slate-400" />
              <th className="px-2 py-3 sm:px-4 text-center font-semibold text-slate-700">
                {t('cashColCash')}
              </th>
              <th className="px-2 py-3 sm:px-4 text-center font-semibold text-slate-700">
                {t('cashColCard')}
              </th>
              <th className="bg-brand/5 px-2 py-3 sm:px-4 text-center font-bold text-brand-dark">
                {t('cashColOpenPay')}
              </th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map(({ id, labelKey }) => (
              <tr
                key={id}
                className="border-b border-slate-100 last:border-b-0"
              >
                <th
                  scope="row"
                  className="whitespace-nowrap px-2 py-3 sm:px-4 text-left text-xs font-semibold text-slate-500"
                >
                  {t(labelKey)}
                </th>
                <td className="px-2 py-3 sm:px-4 text-center text-slate-600">
                  {t(`cashCell${id}Cash`)}
                </td>
                <td className="px-2 py-3 sm:px-4 text-center text-slate-600">
                  {t(`cashCell${id}Card`)}
                </td>
                <td className="bg-brand/5 px-2 py-3 sm:px-4 text-center font-semibold text-slate-900">
                  {t(`cashCell${id}OpenPay`, LANDING_PAYMENT_FEE_VALUES)}
                  {id === 'Fee' && (
                    <span className="mt-1 block text-[11px] font-normal leading-snug text-slate-500">
                      {t('cashCellFeeOpenPayNote', LANDING_PAYMENT_FEE_VALUES)}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mx-auto mt-3 max-w-3xl text-[11px] leading-relaxed text-slate-500">
        {t('cashTableFootnote')}
      </p>
      <div className="mx-auto mt-4 flex max-w-3xl justify-center">
        <Link
          href={`/${locale}/kit`}
          prefetch={false}
          className="inline-flex items-center rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-card hover:border-brand hover:text-brand-dark"
        >
          {t('cashStoreKitCta')}
        </Link>
      </div>

      {/* 円⇄JPYC の 1:1 図解: 円 → (購入) → JPYC → (JPYC EX で 1:1 換金) → 円。帯の地色の上では slate-600 以上 (AA)。
          既存 FAQ / MarketRates の表現を踏襲し、新しい法的主張は発明しない。大きなカードにせず 1 本の帯にする
          (直前の「なぜ今」で 1 JPYC = 1 円は伝えてあるので、ここは「円に戻せる」道筋だけを短く・plans/lp-polish-2026-09.md P1)。 */}
      <div className="mx-auto mt-6 max-w-3xl rounded-2xl bg-slate-100/70 px-4 py-4 sm:px-6">
        <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-between sm:gap-6">
          <h3 className="shrink-0 text-sm font-bold text-slate-900 sm:text-base">{t('cashFlowTitle')}</h3>
          <div className="flex items-center gap-2 sm:gap-3">
            <FlowStep label={t('cashFlowYen')}>
              <span className="text-base font-bold text-slate-700">¥</span>
            </FlowStep>
            <FlowArrow label={t('cashFlowBuy')} />
            <FlowStep label="JPYC">
              <TokenLogo symbol="jpyc" size={24} alt="JPYC" />
            </FlowStep>
            <FlowArrow label={t('cashFlowRedeem')} />
            <FlowStep label={t('cashFlowBackYen')}>
              <span className="text-base font-bold text-slate-700">¥</span>
            </FlowStep>
          </div>
        </div>
        <p className="mt-3 text-center text-xs leading-relaxed text-slate-600 sm:text-right">
          {/* JPYC EX はテキストリンク (新規タブ)。href/描画は LandingFaq の <jpycEx> と同一パターン。 */}
          {t.rich('cashFlowNote', {
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
      </div>

      {/* 節約シミュレータ (client) */}
      <div className="mx-auto max-w-3xl">
        <SavingsSimulator />
      </div>
    </section>
  );
}

// 1:1 図解の 1 段 (丸 + ラベル)。
function FlowStep({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="flex flex-col items-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white">
        {children}
      </span>
      <span className="mt-1 text-[11px] font-semibold text-slate-600">{label}</span>
    </span>
  );
}

// 1:1 図解の矢印 (装飾の矢印 + 可視ラベル)。
function FlowArrow({ label }: { label: string }) {
  return (
    <span className="flex flex-col items-center text-slate-400">
      <ArrowRight className="h-4 w-4" aria-hidden />
      <span className="mt-1 whitespace-nowrap text-[10px] text-slate-600">{label}</span>
    </span>
  );
}
