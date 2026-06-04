'use client';

// /create 共通「記帳・会計 (任意)」折りたたみセクション。QR の「会計用の任意項目」と
// レジの「管理番号・採番」を 1 概念に統合する。i18n は labels prop (namespace 非依存)。
//
//   variant='manual' (決済QR): 商品名 / メモ / 税 (TaxCategorySelect) / 管理番号 を手入力。
//   variant='cart'   (レジ):   商品名/税はカート明細から自動反映するので手入力欄は出さず、
//                              管理番号 + 採番 + 注記 のみ。
// receiptNo はどちらも呼出側の component-local state (値+setter+採番ハンドラを受ける)。

import { ChevronRight, Hash } from 'lucide-react';
import { Field } from './Field';
import { TaxCategorySelect } from './TaxCategorySelect';
import type { TaxCategory } from '@/lib/tax';

const INPUT_CLASS =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none';

export type AccountingSectionLabels = {
  title: string;
  hint?: string;
  productName: string;
  productNamePlaceholder?: string;
  memo: string;
  memoPlaceholder?: string;
  tax: string;
  taxCustom?: string;
  receiptNo: string;
  receiptNoPlaceholder?: string;
  generate?: string;
  cartAutoNote?: string;
};

export function AccountingSection({
  variant,
  labels,
  productName,
  onProductNameChange,
  memo,
  onMemoChange,
  taxRate,
  taxCategory,
  onTaxChange,
  receiptNo,
  onReceiptNoChange,
  onGenerateReceiptNo,
}: {
  variant: 'manual' | 'cart';
  labels: AccountingSectionLabels;
  // manual のみ:
  productName?: string;
  onProductNameChange?: (v: string) => void;
  memo?: string;
  onMemoChange?: (v: string) => void;
  taxRate?: number | null;
  taxCategory?: TaxCategory | null;
  onTaxChange?: (next: {
    taxRate: number | null;
    taxCategory: TaxCategory | null;
  }) => void;
  // 共通:
  receiptNo: string;
  onReceiptNoChange: (v: string) => void;
  onGenerateReceiptNo?: () => void;
}) {
  return (
    <details className="group rounded-2xl border border-slate-200 bg-white p-4">
      <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-slate-700">
        <span>{labels.title}</span>
        <ChevronRight
          className="h-4 w-4 text-slate-400 transition-transform group-open:rotate-90"
          aria-hidden
        />
      </summary>
      {labels.hint && <p className="mt-2 text-xs text-slate-500">{labels.hint}</p>}
      <div className="mt-3 space-y-4">
        {variant === 'manual' && (
          <>
            <Field label={labels.productName}>
              <input
                type="text"
                value={productName ?? ''}
                onChange={(e) => onProductNameChange?.(e.target.value)}
                placeholder={labels.productNamePlaceholder}
                className={INPUT_CLASS}
                maxLength={80}
              />
            </Field>
            <Field label={labels.memo}>
              <input
                type="text"
                value={memo ?? ''}
                onChange={(e) => onMemoChange?.(e.target.value)}
                placeholder={labels.memoPlaceholder}
                className={INPUT_CLASS}
                maxLength={200}
              />
            </Field>
            <Field label={labels.tax}>
              <TaxCategorySelect
                taxRate={taxRate ?? null}
                taxCategory={taxCategory ?? null}
                onChange={(next) => onTaxChange?.(next)}
                ariaLabel={labels.tax}
                customAriaLabel={labels.taxCustom}
              />
            </Field>
          </>
        )}
        {variant === 'cart' && labels.cartAutoNote && (
          <p className="text-xs text-slate-500">{labels.cartAutoNote}</p>
        )}
        <Field label={labels.receiptNo}>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={receiptNo}
              onChange={(e) => onReceiptNoChange(e.target.value)}
              placeholder={labels.receiptNoPlaceholder}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs focus:border-brand focus:outline-none"
              maxLength={64}
            />
            {onGenerateReceiptNo && labels.generate && (
              <button
                type="button"
                onClick={onGenerateReceiptNo}
                className="flex shrink-0 items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-600 hover:border-brand"
              >
                <Hash className="h-3.5 w-3.5" aria-hidden />
                {labels.generate}
              </button>
            )}
          </div>
        </Field>
      </div>
    </details>
  );
}
