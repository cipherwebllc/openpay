'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatUnits } from 'viem';
import { discountFromPercent, parseDiscountAmount } from '@/lib/discount';

export type DiscountMode = 'amount' | 'percent';

/**
 * 値引きの入力 (任意・1 会計に 1 つ・plans/discount-common.md)。レジと決済QR が共有する。
 * 「値引きを追加」で開き、金額 / 割引率を選んで入れる。値引きは入力があるときだけ確かめる (率は最小単位未満を切り捨て)。
 * 描画は components/DiscountField.tsx。
 */
export function useDiscountInput(subtotalWei: bigint, decimals: number, displayDecimals: number) {
  const [open, setOpen] = useState(false);
  const [mode, setModeState] = useState<DiscountMode>('amount');
  const [input, setInput] = useState('');
  // 「値引きを追加」で入力欄へ、「外す」で「値引きを追加」へ focus を移す (押したボタンが消えて body に落ちない)。
  const inputRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<'input' | 'add' | null>(null);
  useEffect(() => {
    if (focusNext.current === 'input' && open) inputRef.current?.focus();
    if (focusNext.current === 'add' && !open) addRef.current?.focus();
    focusNext.current = null;
  }, [open]);

  const raw = open ? input.trim() : '';
  const wei =
    raw === ''
      ? null
      : mode === 'amount'
        ? parseDiscountAmount(raw, subtotalWei, decimals, displayDecimals)
        : discountFromPercent(subtotalWei, raw, decimals, displayDecimals);
  // 入力があるのに使えない値引き (形・単位・値引き前の額以上・率の範囲)。QR は出さず、理由を 1 行出す。
  const invalid = raw !== '' && wei === null;
  // 率は範囲内なのに、値引き前の額が小さく値引きが最小単位 (1 円・0.01) 未満に切り捨てられた。
  const percentTooSmall =
    invalid && mode === 'percent' && /^\d+(\.\d{1,2})?$/.test(raw) && Number(raw) > 0 && Number(raw) < 100;
  // URL・受け渡しに載せる値引き額 (トークン単位の 10 進)。使える値引きが無ければ undefined。
  const param = wei !== null ? formatUnits(wei, decimals) : undefined;

  const add = useCallback(() => {
    focusNext.current = 'input';
    setOpen(true);
  }, []);
  const remove = useCallback(() => {
    focusNext.current = 'add';
    setOpen(false);
    setInput('');
  }, []);
  // 会計が終わった・値引きを使えない QR に切り替えた等で、focus を動かさずに外す。
  const reset = useCallback(() => {
    setOpen(false);
    setInput('');
  }, []);
  const setMode = (next: DiscountMode) => {
    // 金額 ↔ 割引率 で入力を持ち越さない (20 円のつもりが 20% にならない)。
    if (next !== mode) setInput('');
    setModeState(next);
  };

  return {
    open,
    mode,
    input,
    raw,
    wei,
    invalid,
    percentTooSmall,
    param,
    displayDecimals,
    setInput,
    setMode,
    add,
    remove,
    reset,
    inputRef,
    addRef,
  };
}

export type DiscountInput = ReturnType<typeof useDiscountInput>;
