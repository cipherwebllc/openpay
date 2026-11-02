'use client';

// 注文の 1 行。スマホは 2 段 (商品名 / 数量と単価)、PC は 1 行。見出しは欄の中の文字で足り、ラベルは読み上げ用に残す。
// 入力後は「単価」の文字が消えるので、数量が 2 以上の行は小計を出す (小計を単価の欄に入れて倍額のリンクを作らない)。

import { Minus, Plus, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { forwardRef } from 'react';
import { groupAmountDigits } from '@/lib/amount';
import {
  orderLinkLineAmount,
  ORDER_LINK_NAME_MAX,
  type OrderLinkLine,
  type OrderLinkLineIssue,
} from '@/lib/orderLink';
import { CHECKOUT_QTY_MAX } from '@/lib/url/checkout';
import { OrderLinkAmountField, ORDER_LINK_INPUT_CLASS, invalidClass } from './OrderLinkAmountField';

function halfWidthDigits(value: string): string {
  return value.replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0));
}

export const OrderLinkLineRow = forwardRef<
  HTMLInputElement,
  {
    id: number;
    line: OrderLinkLine;
    issues: readonly OrderLinkLineIssue[];
    removable: boolean;
    onChange: (patch: Partial<OrderLinkLine>) => void;
    onRemove: () => void;
  }
>(function OrderLinkLineRow({ id, line, issues, removable, onChange, onRemove }, nameRef) {
  const t = useTranslations('OrderLinkBuilder');
  const qty = Number(line.qty);
  const amount = orderLinkLineAmount(line);
  const stepTo = (next: number) => {
    if (Number.isInteger(next) && next >= 1 && next <= CHECKOUT_QTY_MAX) onChange({ qty: String(next) });
  };
  return (
    <li
      className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 ${
        removable ? 'sm:grid-cols-[minmax(0,1fr)_auto_9.5rem_auto]' : 'sm:grid-cols-[minmax(0,1fr)_auto_9.5rem]'
      }`}
    >
      <div className={removable ? '' : 'col-span-2 sm:col-span-1'}>
        <label htmlFor={`order-link-name-${id}`} className="sr-only">
          {t('itemNameLabel')}
        </label>
        <input
          ref={nameRef}
          id={`order-link-name-${id}`}
          value={line.name}
          maxLength={ORDER_LINK_NAME_MAX}
          placeholder={t('itemNameLabel')}
          enterKeyHint="next"
          aria-invalid={issues.includes('name') || undefined}
          onChange={(event) => onChange({ name: event.target.value })}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
            event.preventDefault();
            document.getElementById(`order-link-price-${id}`)?.focus();
          }}
          className={`${ORDER_LINK_INPUT_CLASS} ${invalidClass(issues.includes('name'))}`}
        />
      </div>
      {removable && (
        <button
          type="button"
          onClick={onRemove}
          className="order-2 flex h-11 w-11 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-700 sm:order-4"
        >
          <X className="h-4 w-4" aria-hidden />
          <span className="sr-only">{t('removeLine')}</span>
        </button>
      )}
      <div className="col-span-2 order-3 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 sm:contents">
        <div className="flex shrink-0 items-center rounded-xl ring-1 ring-slate-200 sm:order-2">
          <button
            type="button"
            onClick={() => stepTo(qty - 1)}
            disabled={!(qty > 1)}
            className="flex h-11 w-11 items-center justify-center rounded-l-xl text-slate-600 hover:bg-slate-100 disabled:text-slate-300 disabled:hover:bg-transparent"
          >
            <Minus className="h-4 w-4" aria-hidden />
            <span className="sr-only">{t('qtyDecrease')}</span>
          </button>
          <label htmlFor={`order-link-qty-${id}`} className="sr-only">
            {t('itemQtyLabel')}
          </label>
          <input
            id={`order-link-qty-${id}`}
            value={line.qty}
            inputMode="numeric"
            aria-invalid={issues.includes('qty') || undefined}
            // 数字以外を消すと 1.5 が 15 になる。全角の数字だけ直し、残りは欄の誤りとして止める。
            onChange={(event) => onChange({ qty: halfWidthDigits(event.target.value).trim() })}
            className={`h-11 w-9 bg-transparent text-center text-base font-semibold tabular-nums text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand/30 ${
              issues.includes('qty') ? 'text-rose-700' : ''
            }`}
          />
          <button
            type="button"
            onClick={() => stepTo(qty + 1)}
            disabled={qty >= CHECKOUT_QTY_MAX}
            className="flex h-11 w-11 items-center justify-center rounded-r-xl text-slate-600 hover:bg-slate-100 disabled:text-slate-300 disabled:hover:bg-transparent"
          >
            <Plus className="h-4 w-4" aria-hidden />
            <span className="sr-only">{t('qtyIncrease')}</span>
          </button>
        </div>
        <div className="min-w-0 sm:order-3">
          <OrderLinkAmountField
            id={`order-link-price-${id}`}
            label={t('itemPriceLabel')}
            placeholder={t('itemPriceLabel')}
            value={line.price}
            invalid={issues.includes('price')}
            onChange={(price) => onChange({ price })}
          />
        </div>
      </div>
      {amount !== null && qty > 1 && (
        <p className="order-4 col-span-full text-right text-xs tabular-nums text-slate-500 sm:order-5">
          {t('lineSubtotal', { price: groupAmountDigits(line.price.trim()), qty, amount: groupAmountDigits(amount) })}
        </p>
      )}
    </li>
  );
});
