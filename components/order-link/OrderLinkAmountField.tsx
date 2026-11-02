'use client';

// JPYC の金額欄。3 桁区切りで見せ、値は区切りなしで持つ (編集の扱いは決済QR と同じ editGroupedAmount)。
// 単位は欄の中に置き、見出しの行を増やさない。ラベルは読み上げ用。

import { useLayoutEffect, useRef, type ChangeEvent } from 'react';
import { editGroupedAmount, groupAmountDigits } from '@/lib/amount';

export const ORDER_LINK_INPUT_CLASS =
  'h-11 w-full rounded-xl bg-white px-3 text-base text-slate-900 ring-1 ring-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-brand/40 sm:text-sm';

export function invalidClass(invalid: boolean): string {
  return invalid ? '!ring-2 !ring-rose-400' : '';
}

// 金額の入力は実用の範囲で小数 2 桁まで (JPYC の 18 桁を打たせない)。
const DECIMALS = 2;

export function OrderLinkAmountField({
  id,
  label,
  value,
  placeholder = '0',
  invalid = false,
  onChange,
}: {
  id: string;
  /** 欄の外に見える見出しがあるときは省く。 */
  label?: string;
  value: string;
  placeholder?: string;
  invalid?: boolean;
  onChange: (value: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const caretLeft = useRef<number | null>(null);

  // 区切りの増減で caret がずれないよう、数字の個数から位置を戻す。
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (input === null || caretLeft.current === null) return;
    let remaining = caretLeft.current;
    let position = 0;
    while (remaining > 0 && position < input.value.length) {
      if (input.value[position] !== ',') remaining -= 1;
      position += 1;
    }
    input.setSelectionRange(position, position);
    caretLeft.current = null;
  });

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    // 負の数を数字だけにすると別の金額になる。そのまま残して、欄の誤りとして止める。
    if (/[-−－]/.test(event.target.value)) {
      caretLeft.current = null;
      onChange(event.target.value.trim());
      return;
    }
    const native = event.nativeEvent as InputEvent;
    const { amount, caretLeft: left } = editGroupedAmount({
      value: event.target.value.replace(/[^\d.,]/g, ''),
      caret: event.target.selectionStart ?? event.target.value.length,
      inputType: native.inputType ?? '',
      prev: value,
      decimals: DECIMALS,
    });
    caretLeft.current = left;
    onChange(amount);
  };

  return (
    <div className="relative">
      {label && (
        <label htmlFor={id} className="sr-only">
          {label}
        </label>
      )}
      <input
        ref={inputRef}
        id={id}
        value={groupAmountDigits(value)}
        inputMode="decimal"
        placeholder={placeholder}
        aria-invalid={invalid || undefined}
        onChange={handleChange}
        className={`${ORDER_LINK_INPUT_CLASS} pr-12 text-right font-medium tabular-nums ${invalidClass(invalid)}`}
      />
      <span aria-hidden className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs font-medium text-slate-500">
        JPYC
      </span>
    </div>
  );
}
