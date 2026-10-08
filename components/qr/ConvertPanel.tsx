'use client';

import { useTranslations } from 'next-intl';
import { ArrowRightLeft } from 'lucide-react';
import { formatRemaining } from '@/lib/fx';
import type { ConvertState, FxRateWarning } from '@/hooks/useFxConvert';

export function ConvertPanel({
  canShowConvert,
  rateOk,
  convert,
  convertExpired,
  convertRemaining,
  convertTargetDisplay,
  convertAnchorDisplay,
  amount,
  displaySymbol,
  isUsdc,
  onApply,
  onRecalc,
  onRevert,
  fxWarning,
  onAcknowledgeFxWarning,
}: {
  canShowConvert: boolean;
  rateOk: boolean;
  convert: ConvertState | null;
  convertExpired: boolean;
  convertRemaining: number;
  convertTargetDisplay: string;
  convertAnchorDisplay: string;
  amount: string;
  displaySymbol: string;
  isUsdc: boolean;
  onApply: () => void;
  onRecalc: () => void;
  onRevert: () => void;
  fxWarning: FxRateWarning | null;
  onAcknowledgeFxWarning: () => void;
}) {
  const t = useTranslations('QrGenerator');
  return (
    <>
      {/* レート急変警告 (F8・defense-in-depth)。前回良好レート (LKG) から ±20% を超えて
          跳ねたときだけ表示。生成は止めず、両レートを見せて確認を促す。 */}
      {fxWarning && (
        <div className="space-y-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-3">
          <p className="text-sm font-semibold text-amber-800">
            {t('fxWarnTitle')}
          </p>
          <p className="text-xs text-amber-700">
            {t('fxWarnDetail', {
              lkg: String(fxWarning.lkgRate),
              current: String(fxWarning.newRate),
            })}
          </p>
          <button
            type="button"
            onClick={onAcknowledgeFxWarning}
            className="mt-1 rounded-md border border-amber-400 bg-white px-3 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-100"
          >
            {t('fxWarnAck')}
          </button>
        </div>
      )}
      {/* 他トークン建てで受け取る (FX 換算・画面上の期限目安付き動的 QR)。
          例: JPYC 1000 入力 → USDC 建てで受け取る → 現レートで USDC 額を確定し
          3 分の UI カウントダウン付き QR を生成。未署名 URL なのでサーバ強制の期限ではない。
          スワップ無し (顧客が払った USDC をそのまま受領)。 */}
      {canShowConvert && rateOk && (
        // まれに使う機能なので、金額の下の控えめな文字のボタンにする (2026-10 磨き上げ P2・動作は不変)。
        <button
          type="button"
          onClick={onApply}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand hover:underline"
        >
          <ArrowRightLeft className="h-4 w-4" aria-hidden />
          {t('convertButton', { symbol: convertTargetDisplay })}
        </button>
      )}
      {/* レートが取れないときはボタンを出さないだけ (頼まれていない説明で会計画面を増やさない)。 */}
      {convert && (
        <div
          className={`space-y-1.5 rounded-lg border px-3 py-3 ${
            convertExpired
              ? 'border-amber-300 bg-amber-50'
              : 'border-emerald-200 bg-emerald-50'
          }`}
        >
          <p className="text-sm font-semibold text-slate-800">
            {t('convertActiveSummary', {
              anchorAmount: convert.anchorAmount,
              anchorSymbol: convertAnchorDisplay,
              amount,
              symbol: displaySymbol,
            })}
          </p>
          <p className="text-xs text-slate-600">
            {t('convertRate', { rate: convert.fxRate })}
          </p>
          {convertExpired ? (
            <p className="text-xs font-medium text-amber-700">
              {t('convertExpired')}
            </p>
          ) : (
            <p className="text-xs text-slate-600">
              {t('convertRemaining', {
                time: formatRemaining(convertRemaining),
              })}
            </p>
          )}
          {isUsdc && (
            <p className="text-xs text-slate-500">
              {t('convertCrossChainNote')}
            </p>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              onClick={onRecalc}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-brand hover:text-brand-dark"
            >
              {t('convertRecalc')}
            </button>
            <button
              type="button"
              onClick={onRevert}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-brand hover:text-brand-dark"
            >
              {t('convertRevert', { symbol: convertAnchorDisplay })}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
