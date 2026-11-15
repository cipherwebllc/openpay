'use client';

// 節約シミュレータ (components/SavingsSimulator.tsx) の結果の表示 (年間の差額)。
// どちらが安いかは、万円に丸める前の差額の符号で決めて、ラベルの言葉で示す (安くなる / OpenPay の方が高くなる /
// 変わらない・2026-11-15 user 承認の文)。数字はどれもマイナスを付けない (絶対値)。
// ja は 1 万円以上を万円で、1 万円未満を円で出す。下の行の正確な円の補足は ja だけで、見せるのは万円のときだけ
// (円のときは同じ数の繰り返しなので、場所だけ取って見せない。en は大きい数字が円そのものなので行ごと出さない)。
// 差額 0 は「0 円」と「変わりません」で、数字とラベルが同じことを言う。
// 試算の部品から分けてあるのはテストのため: 今の料率と刻み (平均決済額は 50 円刻み・最低 2 JPYC) では差額がちょうど 0 に
// ならないので、0 と -0 は差額を直接渡して確かめる。

import { useLocale, useTranslations } from 'next-intl';
import { LANDING_FIGURE } from '@/components/LandingControls';

// ja の大きい数字を万円で出すのは、差額の絶対値がこの額以上のときだけ。1 万円未満の差額を万円に丸めると「0 万円」や
// 「1 万円」になり、元の額と離れる (月商 100 万円・平均 100 円・コード決済で年 2,400 円割高なのに「0 万円」、
// 月商 10 万円・平均 150 円・コード決済で年 7,760 円なのに「1 万円」と出ていた) ので、円で出す。
const MAN_FROM_YEN = 10_000;

// 円をカンマ区切りに (整数のみ・en-US grouping は node/browser で決定的)。
export function formatYen(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function SavingsSimulatorResult({ annualDiffYen }: { annualDiffYen: number }) {
  const t = useTranslations('Landing');
  // ja は「万円」で大きい数字を出す (1 万円以上)。en は円 (万 は英語で読みにくい)。
  const isJa = useLocale() === 'ja';
  // Math.abs は -0 も 0 にする (「-0」と出さない)。
  const absYen = Math.abs(annualDiffYen);
  const inMan = isJa && absYen >= MAN_FROM_YEN;
  const figure = formatYen(inMan ? Math.round(absYen / 10000) : absYen);

  return (
    <div className="mt-6 text-center">
      <p className="text-sm text-slate-600">{t('cashSimResultPrefix')}</p>
      <p className="mt-1 flex items-baseline justify-center gap-1">
        {/* 節に 1 つだけの結果の数字 (大きい数字の型・どの幅でも 3rem)。PC のトップの右の列 (約 400px) にも、最大額のまま入る。 */}
        <span className={`text-brand ${LANDING_FIGURE.result}`}>
          {figure}
        </span>
        {/* 単位: ja の 1 万円以上は「万円」・それ以外 (ja の 1 万円未満と en) は円。 */}
        <span className="text-2xl font-bold text-brand-dark">
          {inMan ? t('cashSimResultUnit') : t('cashSimResultUnitYen')}
        </span>
      </p>
      {/* 中央寄せの短い 1 文。折り返すときは行の長さをそろえる (1〜2 字だけの行を出さない)。 */}
      <p className="mt-2 text-balance text-sm font-semibold text-slate-700 [word-break:auto-phrase]">
        {annualDiffYen > 0
          ? t('cashSimResultSavings')
          : annualDiffYen < 0
            ? t('cashSimResultExtra')
            : t('cashSimResultSame')}
      </p>
      {/* 正確な円の補足 (ja だけ)。見せるのは大きい数字が万円のときだけ。円のとき (1 万円未満・差額 0) は同じ数を 2 回言うので、
          見せず (invisible)・読ませない (aria-hidden)。行は描いたまま場所を取り、万円と円の切り替わりで試算の箱の高さを変えない
          (スライダーを動かす途中で、下の注とボタンが上下しない)。 */}
      {isJa && (
        <p
          aria-hidden={inMan ? undefined : true}
          className={`mt-1 tabular-nums text-xs text-slate-600${inMan ? '' : ' invisible'}`}
        >
          {t('cashSimYenExact', { yen: `¥${formatYen(absYen)}` })}
        </p>
      )}
    </div>
  );
}
