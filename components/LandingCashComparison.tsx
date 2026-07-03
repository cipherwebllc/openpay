// 「現金に戻したお店へ」セクション (Server Component)。
// ターゲット = カード / コード決済の手数料が痛くて現金に戻した飲食 / 小売店主。
// crypto 語彙を避け、①現金を否定しない比較表 ②円⇄JPYC の 1:1 図解
// ③節約シミュレータ (client) で「損ゼロで置ける選択肢」を直感的に訴求する。
//
// 見出しスケールは他の Landing セクション (LandingBenefits) と揃える
// (text-2xl sm:text-3xl・中央)。手数料の数字は hero / 開示と整合させ、
// OpenPay は「0%〜1%」framing。カード 3.24% / コード 1.98% は「一般的な料率の例」と脚注。

import { getTranslations } from 'next-intl/server';
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
  const t = await getTranslations('Landing');

  return (
    <section className="mt-14">
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl">
          {t('cashTitle')}
        </h2>
        <p className="mt-2 text-sm text-slate-600">{t('cashSubtitle')}</p>
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
                  {t(`cashCell${id}OpenPay`)}
                  {id === 'Fee' && (
                    <span className="mt-1 block text-[11px] font-normal leading-snug text-slate-500">
                      {t('cashCellFeeOpenPayNote')}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mx-auto mt-3 max-w-3xl text-[11px] leading-relaxed text-slate-400">
        {t('cashTableFootnote')}
      </p>

      {/* 円⇄JPYC の 1:1 図解: 円 → (購入) → JPYC → (JPYC EX で 1:1 換金) → 円。
          既存 FAQ / MarketRates の表現を踏襲し、新しい法的主張は発明しない。 */}
      <div className="mx-auto mt-8 max-w-3xl rounded-2xl border border-slate-200 bg-white p-5 shadow-card sm:p-6">
        <h3 className="text-center text-base font-bold text-slate-900 sm:text-lg">
          {t('cashFlowTitle')}
        </h3>
        <div className="mt-5 overflow-x-auto">
          <div className="mx-auto flex min-w-max items-center justify-center gap-3 sm:gap-4">
            {/* 円 */}
            <div className="flex flex-col items-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-full border border-slate-200 bg-slate-50 text-2xl font-bold text-slate-700">
                ¥
              </span>
              <span className="mt-1.5 text-xs font-semibold text-slate-600">
                {t('cashFlowYen')}
              </span>
            </div>
            {/* → 購入 */}
            <div className="flex flex-col items-center text-slate-400">
              <ArrowRight className="h-5 w-5" aria-hidden />
              <span className="mt-1 whitespace-nowrap text-[11px] text-slate-500">
                {t('cashFlowBuy')}
              </span>
            </div>
            {/* JPYC */}
            <div className="flex flex-col items-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-full border border-slate-200 bg-white">
                <TokenLogo symbol="jpyc" size={36} alt="JPYC" />
              </span>
              <span className="mt-1.5 text-xs font-semibold text-slate-600">
                JPYC
              </span>
            </div>
            {/* → 換金 */}
            <div className="flex flex-col items-center text-slate-400">
              <ArrowRight className="h-5 w-5" aria-hidden />
              <span className="mt-1 whitespace-nowrap text-[11px] text-slate-500">
                {t('cashFlowRedeem')}
              </span>
            </div>
            {/* 円 */}
            <div className="flex flex-col items-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-full border border-slate-200 bg-slate-50 text-2xl font-bold text-slate-700">
                ¥
              </span>
              <span className="mt-1.5 text-xs font-semibold text-slate-600">
                {t('cashFlowBackYen')}
              </span>
            </div>
          </div>
        </div>
        <p className="mt-4 text-center text-xs leading-relaxed text-slate-500">
          {t('cashFlowNote')}
        </p>
      </div>

      {/* 節約シミュレータ (client) */}
      <div className="mx-auto max-w-3xl">
        <SavingsSimulator />
      </div>
    </section>
  );
}
