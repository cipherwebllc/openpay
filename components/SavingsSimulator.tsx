'use client';

// 「現金に戻したお店へ」セクションの節約シミュレータ (client)。
// 月商・平均決済額スライダー × 今の決済手段 (カード 3.24% / コード決済 1.98%) から、
// OpenPay のガスレス決済 (開示料率・1 回あたりの最低額) に置き換えた年間差額を
// ビッグナンバーで示す (結果の出し分けは components/SavingsSimulatorResult.tsx)。crypto 語彙は出さず、店主が直感的に得を掴めるようにする。
//
// 金額計算は整数円で行い (Math.round)、float の見た目誤差 (26.8799…) を出さない。
// hydration 安全 (Date / random を使わず、既定値は固定)。

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { DISCLOSED_RECOVER_FEE } from '@/lib/disclosedRecoverFee';
import { LANDING_NOTE } from '@/components/LandingControls';
import { SavingsSimulatorResult, formatYen } from '@/components/SavingsSimulatorResult';

// 月商スライダー: 10 万円〜500 万円・10 万円刻み・既定 100 万円 (すべて「円」単位)。
const MONTHLY_MIN = 100_000;
const MONTHLY_MAX = 5_000_000;
const MONTHLY_STEP = 100_000;
const MONTHLY_DEFAULT = 1_000_000;

// 全決済がこの金額と同額という概算。最低利用料は月商でなく 1 決済ごとに適用する。
const TICKET_MIN = 50;
const TICKET_MAX = 10_000;
const TICKET_STEP = 50;
const TICKET_DEFAULT = 1_000;

// 比較先チップ (今の決済手段の一般的な料率の例)。
const COMPARE = {
  card: 0.0324,
  code: 0.0198,
} as const;
type CompareId = keyof typeof COMPARE;

export function SavingsSimulator() {
  const t = useTranslations('Landing');
  // 月商の現在値: ja は「万円」、en は full 円 (万 は英語で読みにくい)。
  const isJa = useLocale() === 'ja';
  const [monthlyYen, setMonthlyYen] = useState(MONTHLY_DEFAULT);
  const [ticketYen, setTicketYen] = useState(TICKET_DEFAULT);
  const [compare, setCompare] = useState<CompareId>('card');

  const feePerPayment = Math.max(
    DISCLOSED_RECOVER_FEE.floorJpyc,
    ticketYen * DISCLOSED_RECOVER_FEE.percentFromJulyBps / 10_000,
  );
  // 年間差額 (整数円): 比較先の年額 − 月間決済件数 × 1 決済の利用料 × 12。正 = OpenPay の方が安い。
  const annualDiffYen = Math.round(
    monthlyYen * 12 * COMPARE[compare] - (monthlyYen / ticketYen) * feePerPayment * 12,
  );
  // スライダー現在値の表示 (万円・10 万刻みなので常に整数)。
  const monthlyMan = monthlyYen / 10000;

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
            {/* ja/en とも同じ引数名 {value} を使う (ja=万円の数値・en=full 円の
                カンマ区切り)。引数名が locale ごとに違うと、片方を落としたときに
                片方の locale だけ壊れて気付けない。 */}
            {t('cashSimManValue', {
              value: isJa ? monthlyMan : formatYen(monthlyYen),
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

      <div className="mt-5">
        <div className="flex items-baseline justify-between">
          <label htmlFor="savings-ticket" className="text-xs font-semibold text-slate-600">
            {t('cashSimTicketLabel')}
          </label>
          <span className="tabular-nums text-sm font-bold text-slate-900">
            {t('cashSimTicketValue', { value: formatYen(ticketYen) })}
          </span>
        </div>
        <input
          id="savings-ticket"
          type="range"
          min={TICKET_MIN}
          max={TICKET_MAX}
          step={TICKET_STEP}
          value={ticketYen}
          onChange={(e) => setTicketYen(Number(e.target.value))}
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
                // スマホ (sm 未満) は押せる高さを 40px にする (字の高さ + 余白だけだと 34px)。sm 以上は今の高さのまま。
                className={`inline-flex items-center rounded-full border px-4 py-1.5 text-sm font-semibold transition max-sm:min-h-10 ${
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

      <SavingsSimulatorResult annualDiffYen={annualDiffYen} />

      {/* 試算の前提の注 (注の型)。上の空きは、ほかの注と同じ mt-3。 */}
      <p className={`mt-3 ${LANDING_NOTE}`}>
        {t('cashSimNote', {
          percent: DISCLOSED_RECOVER_FEE.percentFromJulyBps / 100,
          floor: DISCLOSED_RECOVER_FEE.floorJpyc,
        })}
      </p>
    </div>
  );
}
