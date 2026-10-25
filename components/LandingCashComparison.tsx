// 「現金に戻したお店へ」セクション (Server Component)。
// ターゲット = カード / コード決済の手数料が痛くて現金に戻した飲食 / 小売店主。
// crypto 語彙を避け、①現金を否定しない比較表 ②節約シミュレータ (client) で「損ゼロで置ける選択肢」を
// 直感的に訴求する。円⇄JPYC の 1:1 の帯は「なぜ今」・JPYC の注記と重なるので外した (2026-10-12 plans/lp-polish-2026-10.md P1-5)。
//
// 見出しスケールは他の Landing セクション (LandingBenefits) と揃える
// (text-2xl sm:text-3xl・中央)。手数料の数字は hero / 開示と整合させ、
// OpenPay は「0円〜」と、その条件 (お客様がガス代を払う通常決済)・上の端 (ガスレスの料率と最低額) を同じセルに置く
// (条件を脚注に逃がすと有利誤認の懸念が残る・2026-10-25)。モバイル注文の料率は料金ページへ。
// カード・コード決済の列は、決済会社ごとに違う項目 (入金の時期・導入費) を一律に断定しない (景品表示法)。
// 解約縛りの行は外した: 縛りのない決済会社がある (2026-10 各社公式で確認)。比較先の料率は例であることをセルと脚注に書く。

import { LANDING_PAYMENT_FEE_VALUES } from '@/lib/legal';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { SavingsSimulator } from '@/components/SavingsSimulator';
import { GUIDE_SECONDARY_ACTION } from '@/components/guide/GuideHeader';
import { LandingSectionHeader } from '@/components/LandingSectionHeader';

// 比較表の行定義。i18n key は `cashCell{Row}{Col}` で命名統一。
type RowId = 'Fee' | 'Settle' | 'Setup';
const ROWS: readonly { id: RowId; labelKey: string }[] = [
  { id: 'Fee', labelKey: 'cashRowFee' },
  { id: 'Settle', labelKey: 'cashRowSettle' },
  { id: 'Setup', labelKey: 'cashRowSetup' },
];

export async function LandingCashComparison() {
  const locale = await getLocale();
  const t = await getTranslations('Landing');

  return (
    <section className="mt-16 sm:mt-28">
      <LandingSectionHeader eyebrow={t('eyebrowShops')} title={t('cashTitle')} lead={t('cashSubtitle')} />

      {/* PC (lg 以上) は 左 = 比較表 / 右 = 試算 の 2 列 (縦に積むと 1 画面半・plans/lp-polish-2026-09.md P2)。 */}
      <div className="mx-auto max-w-3xl lg:grid lg:max-w-none lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:items-start lg:gap-8">
        <div className="min-w-0">
        {/* 比較表: モバイルでも 3 列が 1 画面に収まるよう圧縮 (結論の OpenPay 列を隠さない)。overflow-x-auto は保険。
            OpenPay 列を brand tint で強調しつつ、現金列を否定しないトーン。 */}
        <div className="mx-auto mt-8 max-w-3xl overflow-x-auto rounded-2xl border border-slate-200 shadow-card">
          <table className="w-full border-collapse bg-white text-[13px] [word-break:auto-phrase] sm:text-sm">
            <thead>
              <tr className="border-b border-slate-200">
                <td className="px-2 py-3 sm:px-4" />
                <th className="min-w-[3.25rem] px-2 py-3 sm:min-w-[4.75rem] sm:px-4 text-center font-semibold text-slate-700">
                  {t('cashColCash')}
                </th>
                <th className="min-w-[4.5rem] px-2 py-3 sm:min-w-[6.5rem] sm:px-4 text-center font-semibold text-slate-700">
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
                  {/* 現金の列は短い語だけ (0%・その場・0円)。狭い幅で「その/場」と折れないようにする。 */}
                  <td className="whitespace-nowrap px-2 py-3 sm:px-4 text-center text-slate-600">
                    {t(`cashCell${id}Cash`)}
                  </td>
                  <td className="px-2 py-3 sm:px-4 text-center text-slate-600">
                    {t(`cashCell${id}Card`)}
                  </td>
                  <td className="bg-brand/5 px-2 py-3 sm:px-4 text-center font-semibold text-slate-900">
                    {id === 'Fee' ? (
                      <>
                        <span className="block text-lg font-bold leading-tight text-brand-dark sm:text-xl">
                          {t('cashCellFeeOpenPay')}
                        </span>
                        <span className="mt-1 block text-xs font-semibold leading-snug text-slate-800">
                          {t('cashCellFeeOpenPayCondition')}
                        </span>
                        <span className="mt-1 block text-xs font-normal leading-snug text-slate-600">
                          {t('cashCellFeeOpenPayNote', LANDING_PAYMENT_FEE_VALUES)}
                        </span>
                      </>
                    ) : (
                      t(`cashCell${id}OpenPay`)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mx-auto mt-3 max-w-3xl text-xs leading-relaxed text-slate-500">
          {t('cashTableFootnote')}
        </p>
        </div>
        {/* 節約シミュレータ (client) */}
        <div className="min-w-0 lg:mt-8 lg:[&>*:first-child]:mt-0">
          <SavingsSimulator />
        </div>
      </div>
      {/* 店頭キット (印刷物) への入口は、比較と試算を読み終えた節の末尾に置く (ボタンの型はガイドの従ボタンと同じ)。 */}
      <div className="mt-8 flex justify-center">
        <Link
          href={`/${locale}/kit`}
          prefetch={false}
          className={GUIDE_SECONDARY_ACTION}
        >
          {t('cashStoreKitCta')}
        </Link>
      </div>
    </section>
  );
}
