'use client';

// 税率/税区分の選択 (記帳補助)。1 つの選択で taxCategory と taxRate を確定し、カスタム時のみ
// 税率入力欄を出す。QR 作成フォームと簡易レジ (行ごと) で共有する小コンポーネント。
// 商品プリセット管理は「none なし / custom 入力なし」と要件が異なるため別実装のまま。

import { useTranslations } from 'next-intl';
import { TAX_OPTIONS, defaultRateForCategory, type TaxCategory } from '@/lib/tax';

type TaxValue = { taxRate: number | null; taxCategory: TaxCategory | null };

export function TaxCategorySelect({
  taxRate,
  taxCategory,
  onChange,
  ariaLabel,
  customAriaLabel,
}: {
  taxRate: number | null;
  taxCategory: TaxCategory | null;
  onChange: (next: TaxValue) => void;
  ariaLabel: string;
  customAriaLabel?: string;
}) {
  const tTax = useTranslations('Tax');
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={taxCategory ?? ''}
        aria-label={ariaLabel}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '') {
            onChange({ taxRate: null, taxCategory: null });
            return;
          }
          const cat = v as TaxCategory;
          // custom は既存税率を保持 (無ければ 0)、標準区分は既定税率を採用。
          onChange({
            taxCategory: cat,
            taxRate: cat === 'custom' ? (taxRate ?? 0) : defaultRateForCategory(cat),
          });
        }}
        className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none"
      >
        <option value="">{tTax('none')}</option>
        {TAX_OPTIONS.map((o) => (
          <option key={o.category} value={o.category}>
            {tTax(o.i18nKey)}
          </option>
        ))}
      </select>
      {taxCategory === 'custom' && (
        <span className="flex items-center gap-1">
          <input
            type="number"
            inputMode="decimal"
            min="0"
            max="100"
            value={taxRate ?? ''}
            aria-label={customAriaLabel ?? ariaLabel}
            onChange={(e) =>
              onChange({
                taxCategory: 'custom',
                taxRate: e.target.value === '' ? null : Number(e.target.value),
              })
            }
            className="w-20 rounded-lg border border-slate-300 px-2 py-2 text-right text-sm focus:border-brand focus:outline-none"
          />
          <span className="text-xs text-slate-500">%</span>
        </span>
      )}
    </div>
  );
}
