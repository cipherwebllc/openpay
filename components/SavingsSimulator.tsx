'use client';

// 「現金に戻したお店へ」セクションの節約シミュレータ (client)。
// 月商スライダー × 今の決済手段 (カード 3.24% / コード決済 1.98%) から、
// OpenPay のガスレス決済 (1%) に置き換えたときに「年間いくら手元に残るか」を
// ビッグナンバーで示す。crypto 語彙は出さず、店主が直感的に得を掴めるようにする。
//
// 金額計算は整数円で行い (Math.round)、float の見た目誤差 (26.8799…) を出さない。
// hydration 安全 (Date / random を使わず、既定値は固定)。

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

// 月商スライダー: 10 万円〜500 万円・10 万円刻み・既定 100 万円 (すべて「円」単位)。
const MONTHLY_MIN = 100_000;
const MONTHLY_MAX = 5_000_000;
const MONTHLY_STEP = 100_000;
const MONTHLY_DEFAULT = 1_000_000;

// OpenPay ガスレス決済の利用料率 (差額計算の基準)。
const OPENPAY_RATE = 0.01;

// 比較先チップ (今の決済手段の一般的な料率の例)。
const COMPARE = {
  card: 0.0324,
  code: 0.0198,
} as const;
type CompareId = keyof typeof COMPARE;

// 円をカンマ区切りに (整数のみ・en-US grouping は node/browser で決定的)。
function formatYen(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function SavingsSimulator() {
  const t = useTranslations('Landing');
  // ja は「万円」でヒーロー表示、en は full 円でヒーロー表示 (万 は英語で読みにくい)。
  const isJa = useLocale() === 'ja';
  const [monthlyYen, setMonthlyYen] = useState(MONTHLY_DEFAULT);
  const [compare, setCompare] = useState<CompareId>('card');

  // 年間差額 (整数円): 月商 × 12 か月 × (今の料率 − OpenPay 1%)。
  const annualDiffYen = Math.round(
    monthlyYen * 12 * (COMPARE[compare] - OPENPAY_RATE),
  );
  // ビッグナンバーは万円単位 (整数に丸めて小数の見た目誤差を避ける)。
  const annualDiffMan = Math.round(annualDiffYen / 10000);
  // スライダー現在値の表示 (万円・10 万刻みなので常に整数)。
  const monthlyMan = monthlyYen / 10000;
  // ヒーローの数字: ja=万円 (annualDiffMan) / en=full 円 (annualDiffYen)。
  const heroNumber = formatYen(isJa ? annualDiffMan : annualDiffYen);

  return (
    <div className="mt-8 rounded-2xl border border-brand/30 bg-brand/5 p-5 sm:p-6">
      <h3 className="text-center text-base font-bold text-slate-900 sm:text-lg">
        {t('cashSimTitle')}
      </h3>

      {/* 月商スライダー */}
      <div className="mt-5">
        <div className="flex items-baseline justify-between">
          <label
            htmlFor="savings-monthly"
            className="text-xs font-semibold text-slate-600"
          >
            {t('cashSimMonthlyLabel')}
          </label>
          <span className="tabular-nums text-sm font-bold text-slate-900">
            {t('cashSimManValue', {
              man: monthlyMan,
              yen: formatYen(monthlyYen),
            })}
          </span>
        </div>
        <input
          id="savings-monthly"
          type="range"
          min={MONTHLY_MIN}
          max={MONTHLY_MAX}
          step={MONTHLY_STEP}
          value={monthlyYen}
          onChange={(e) => setMonthlyYen(Number(e.target.value))}
          className="mt-2 w-full accent-blue-600"
        />
      </div>

      {/* 今の決済手段チップ */}
      <div className="mt-5">
        <p className="text-xs font-semibold text-slate-600">
          {t('cashSimCompareLabel')}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {(['card', 'code'] as const).map((id) => {
            const active = compare === id;
            return (
              <button
                key={id}
                type="button"
                aria-pressed={active}
                onClick={() => setCompare(id)}
                className={`rounded-full border px-4 py-1.5 text-sm font-semibold transition ${
                  active
                    ? 'border-brand bg-brand text-white'
                    : 'border-slate-300 bg-white text-slate-700 hover:border-brand hover:text-brand-dark'
                }`}
              >
                {id === 'card' ? t('cashSimChipCard') : t('cashSimChipCode')}
              </button>
            );
          })}
        </div>
      </div>

      {/* 結果: 年間 ◯◯万円 手元に残る (ビッグナンバー) */}
      <div className="mt-6 text-center">
        <p className="text-sm text-slate-600">{t('cashSimResultPrefix')}</p>
        <p className="mt-1 flex items-baseline justify-center gap-1">
          <span className="tabular-nums text-5xl font-extrabold leading-none text-brand sm:text-6xl">
            {heroNumber}
          </span>
          <span className="text-2xl font-bold text-brand-dark">
            {t('cashSimResultUnit')}
          </span>
        </p>
        <p className="mt-2 text-sm font-semibold text-slate-700">
          {t('cashSimResultSuffix')}
        </p>
        {/* 万円ヒーロー (ja) は端数を丸めるため、正確な円差額を補足。en は
            ヒーローが full 円ゆえ重複しないよう出さない。 */}
        {isJa && (
          <p className="mt-1 tabular-nums text-xs text-slate-500">
            {t('cashSimYenExact', { yen: formatYen(annualDiffYen) })}
          </p>
        )}
      </div>

      <p className="mt-4 text-[11px] leading-relaxed text-slate-500">
        {t('cashSimNote')}
      </p>
    </div>
  );
}
