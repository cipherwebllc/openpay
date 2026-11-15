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

// 値のセル。スマホは上の余白 (pt-7) に行の名前が載るので、値は上にそろえる (名前のすぐ下から読める)。
const CELL = 'px-2 pb-3 pt-7 text-center align-top sm:px-4 sm:py-3 sm:align-middle';

// 文字は変えずに、句の切れ目 (「・」「。」の後ろ・「（」の前) を優先して折る (句ごとの inline-block)。
// 句が欄に入るかぎり、文節で折る word-break:auto-phrase が効かないブラウザ (WebKit = iPhone の Safari) でも、
// 「カード・コ / ード決済」「…決済 / QR）」のように語の途中では折れない。欄より長い句は、句の中でも折る (はみ出さない)。
// keep: 空白のない句 (日本語の短い句) は、句の中でも折らない。列の最小の幅がその句の幅になる (ブラウザごとの字の幅に合う)。
// 列の見出しのように、句が必ず短いところでだけ使う。
function Phrases({ text, keep = false }: { text: string; keep?: boolean }) {
  return text.split(/(?<=[・。])|(?=（)/).map((part, i) => (
    <span key={i} className={keep && !/\s/.test(part) ? 'inline-block whitespace-nowrap' : 'inline-block'}>
      {part}
    </span>
  ));
}

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
                <td className="p-0 sm:px-4 sm:py-3" />
                <th className="min-w-[3.25rem] px-2 py-3 sm:min-w-[4.75rem] sm:px-4 text-center font-semibold text-slate-700">
                  {t('cashColCash')}
                </th>
                {/* 見出しは「カード・」「コード決済」の句の中では折らない (この列の幅が「コード決済」の幅より狭くならない)。 */}
                <th className="min-w-[4.5rem] px-2 py-3 sm:min-w-[6.5rem] sm:px-4 text-center font-semibold text-slate-700">
                  <Phrases text={t('cashColCard')} keep />
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
                  {/* スマホは、行の名前を列にしない: 列の幅を 0 にして、名前は行の上の余白 (各セルの pt-7) に重ねて置く。
                      名前の列 (約 90px) のぶんを OpenPay の列に回すため (名前の列があると OpenPay の手数料の欄は約 130px で、条件が 7 行に割れる)。
                      table のまま (display は変えない) なので、行と列の見出しの対応は読み上げでも変わらない。sm 以上は名前の列に戻す。 */}
                  <th
                    scope="row"
                    className="relative w-0 p-0 text-left text-xs font-semibold text-slate-500 sm:static sm:w-auto sm:whitespace-nowrap sm:px-4 sm:py-3"
                  >
                    <span className="absolute left-2 top-2 whitespace-nowrap sm:static">{t(labelKey)}</span>
                  </th>
                  {/* 現金の列は短い語だけ (0%・その場・0円)。狭い幅で「その/場」と折れないようにする。 */}
                  <td className={`whitespace-nowrap text-slate-600 ${CELL}`}>
                    {t(`cashCell${id}Cash`)}
                  </td>
                  <td className={`text-slate-600 ${CELL}`}>
                    {t(`cashCell${id}Card`)}
                  </td>
                  <td className={`bg-brand/5 font-semibold text-slate-900 ${CELL}`}>
                    {id === 'Fee' ? (
                      <>
                        <span className="block text-lg font-bold leading-tight text-brand-dark sm:text-xl">
                          {t('cashCellFeeOpenPay')}
                        </span>
                        {/* 条件と注は句の切れ目を優先して折る (「QR）」「別料金。」だけの短い行になりにくい)。
                            スマホは欄が狭く、句の中でも折れるので、行の長さもそろえる (text-balance)。sm 以上は欄が広いので、
                            そろえない (en の「customer pays gas」が「customer pays / gas」に割れる)。 */}
                        <span className="mt-1 block text-balance text-xs font-semibold leading-snug text-slate-800 sm:text-wrap">
                          <Phrases text={t('cashCellFeeOpenPayCondition')} />
                        </span>
                        <span className="mt-1 block text-balance text-xs font-normal leading-snug text-slate-600 sm:text-wrap">
                          <Phrases text={t('cashCellFeeOpenPayNote', LANDING_PAYMENT_FEE_VALUES)} />
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
