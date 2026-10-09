'use client';

import { useTranslations } from 'next-intl';
import { formatUnits } from 'viem';
import { groupAmountDigits } from '@/lib/amount';
import type { DiscountInput } from '@/hooks/useDiscountInput';

/**
 * 値引きの入力欄 (任意・plans/discount-common.md)。使わない店には「値引きを追加」の 1 行だけ。開くと 値引き額 +
 * 金額 / 割引率 と入力欄。状態と計算は hooks/useDiscountInput.ts。レジと決済QR が共有する。
 */
export function DiscountField({
  discount,
  idPrefix,
  symbol,
  decimals,
}: {
  discount: DiscountInput;
  /** 画面内で一意な id の接頭辞 (見出し・入力欄・エラーの id)。 */
  idPrefix: string;
  symbol: string;
  decimals: number;
}) {
  const t = useTranslations('Discount');
  const headingId = `${idPrefix}-discount-heading`;
  const inputId = `${idPrefix}-discount-input`;
  const errorId = `${idPrefix}-discount-error`;
  const unitLabel = `${discount.displayDecimals === 0 ? '1' : '0.01'} ${symbol}`;

  if (!discount.open) {
    return (
      <button
        ref={discount.addRef}
        type="button"
        onClick={discount.add}
        className="text-xs font-medium text-brand hover:underline"
      >
        {t('add')}
      </button>
    );
  }

  return (
    <div role="group" aria-labelledby={headingId} className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
      <div className="flex items-baseline justify-between gap-2">
        <span id={headingId} className="text-slate-500">
          {t('label')}
          {discount.mode === 'percent' && discount.wei !== null && (
            <span className="ml-1 tabular-nums">{t('percentNote', { percent: discount.raw })}</span>
          )}
        </span>
        <span className="tabular-nums font-medium text-rose-700">
          {discount.wei !== null ? `−${groupAmountDigits(formatUnits(discount.wei, decimals))} ${symbol}` : '—'}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <div className="inline-flex shrink-0 rounded-lg bg-slate-100 p-0.5 text-xs">
          {(['amount', 'percent'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={discount.mode === mode}
              onClick={() => discount.setMode(mode)}
              className={`rounded-md px-2.5 py-1 font-medium ${
                discount.mode === mode ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'
              }`}
            >
              {t(`mode.${mode}`)}
            </button>
          ))}
        </div>
        <label htmlFor={inputId} className="sr-only">
          {discount.mode === 'amount' ? t('amountInput') : t('percentInput')}
        </label>
        <input
          id={inputId}
          ref={discount.inputRef}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={discount.input}
          onChange={(e) => discount.setInput(e.target.value)}
          placeholder={discount.mode === 'amount' ? '20' : '2'}
          aria-invalid={discount.invalid}
          aria-describedby={discount.invalid ? errorId : undefined}
          className="w-20 min-w-0 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-right text-sm tabular-nums focus:border-brand focus:outline-none"
        />
        <span className="text-sm text-slate-600">{discount.mode === 'amount' ? symbol : '%'}</span>
        <button
          type="button"
          onClick={discount.remove}
          className="ml-auto text-xs text-slate-500 underline underline-offset-2 hover:text-slate-700"
        >
          {t('remove')}
        </button>
      </div>
      {discount.invalid && (
        <p id={errorId} className="mt-1.5 text-xs text-red-600">
          {discount.mode === 'amount'
            ? t('errorAmount', { unit: unitLabel })
            : discount.percentTooSmall
              ? t('errorPercentTooSmall', { unit: unitLabel })
              : t('errorPercent')}
        </p>
      )}
    </div>
  );
}
