'use client';

// レジの注文パネルの 1 行 (2026-10 磨き上げ P3): 名前 / − 数量 + / 金額 を 1 行に。名前を押すと単価・税・メモ・名前・削除が
// 開く (店員が毎回触るのは数量だけ・細かい編集は必要なときだけ)。値の持ち方と計算は RegisterMode のまま (ここは描画だけ)。

import { useTranslations } from 'next-intl';
import { ChevronDown, Minus, Plus, Trash2 } from 'lucide-react';
import { Field } from '../Field';
import { TaxCategorySelect } from '../TaxCategorySelect';
import type { TaxCategory } from '@/lib/tax';

export type RegisterCartLineValue = {
  id: string;
  name: string;
  unitPrice: string;
  quantity: number;
  taxRate: number | null;
  taxCategory: TaxCategory | null;
  memo: string;
};

const INPUT =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none';

export function RegisterCartLine({
  line,
  amountText,
  symbol,
  open,
  onToggle,
  onUpdate,
  onRemove,
  onQty,
}: {
  line: RegisterCartLineValue;
  /** 行の金額 (例「1,000 JPYC」・未入力は「—」)。 */
  amountText: string;
  symbol: string;
  open: boolean;
  onToggle: () => void;
  onUpdate: (patch: Partial<RegisterCartLineValue>) => void;
  onRemove: () => void;
  onQty: (qty: number) => void;
}) {
  const t = useTranslations('RegisterMode');
  const detailsId = `cart-line-${line.id}`;
  return (
    <li>
      <div className="flex items-center gap-2 px-5 py-2.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={detailsId}
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
        >
          <span className={`truncate text-sm font-medium ${line.name.trim() ? 'text-slate-800' : 'text-slate-500'}`}>
            {line.name.trim() || t('productNamePlaceholder')}
          </span>
          <ChevronDown
            className={`h-3.5 w-3.5 flex-none text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
            aria-hidden
          />
        </button>
        {/* 数量: タップ領域は 44px (指で押しやすく)。 */}
        <div className="flex shrink-0 items-center">
          <button
            type="button"
            onClick={() => onQty(line.quantity - 1)}
            className="flex h-11 w-11 items-center justify-center rounded-full text-slate-600 hover:bg-slate-100"
          >
            <Minus className="h-4 w-4" aria-hidden />
            <span className="sr-only">{t('quantityDecrement')}</span>
          </button>
          <input
            type="text"
            inputMode="numeric"
            value={line.quantity}
            aria-label={t('quantityLabel')}
            onChange={(e) => {
              const n = Number(e.target.value.replace(/[^\d]/g, ''));
              onQty(Number.isFinite(n) && n >= 1 ? n : 1);
            }}
            className="h-9 w-9 rounded-lg bg-transparent text-center text-base font-semibold tabular-nums text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand"
          />
          <button
            type="button"
            onClick={() => onQty(line.quantity + 1)}
            className="flex h-11 w-11 items-center justify-center rounded-full text-slate-600 hover:bg-slate-100"
          >
            <Plus className="h-4 w-4" aria-hidden />
            <span className="sr-only">{t('quantityIncrement')}</span>
          </button>
        </div>
        <span className="w-24 shrink-0 text-right text-sm font-semibold tabular-nums text-slate-900">
          {amountText}
        </span>
      </div>
      {open && (
        <div id={detailsId} className="space-y-3 bg-slate-50 px-5 pb-4 pt-3">
          <Field label={t('productNameLabel')} htmlFor={`${detailsId}-name`}>
            <input
              id={`${detailsId}-name`}
              type="text"
              value={line.name}
              onChange={(e) => onUpdate({ name: e.target.value })}
              placeholder={t('productNamePlaceholder')}
              className={INPUT}
              maxLength={80}
              autoFocus={!line.name}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('unitPriceLabel', { symbol })} htmlFor={`${detailsId}-price`}>
              <input
                id={`${detailsId}-price`}
                type="text"
                inputMode="decimal"
                value={line.unitPrice}
                onChange={(e) => onUpdate({ unitPrice: e.target.value.replace(/[^\d.]/g, '') })}
                placeholder="0"
                className={`${INPUT} text-right tabular-nums`}
              />
            </Field>
            <Field label={t('taxLabel')}>
              <TaxCategorySelect
                taxRate={line.taxRate}
                taxCategory={line.taxCategory}
                onChange={(next) => onUpdate(next)}
                ariaLabel={t('taxLabel')}
                customAriaLabel={t('taxCustomLabel')}
              />
            </Field>
          </div>
          <input
            type="text"
            value={line.memo}
            onChange={(e) => onUpdate({ memo: e.target.value })}
            placeholder={t('memoPlaceholder')}
            aria-label={t('memoLabel')}
            className={INPUT}
            maxLength={80}
          />
          <button
            type="button"
            onClick={onRemove}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-600 hover:underline"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
            {t('removeLine')}
          </button>
        </div>
      )}
    </li>
  );
}
