'use client';

// 簡易レジモード (複数商品カート MVP): 商品プリセット選択 or 手入力で商品をカートに追加し、
// 行ごとに数量/単価/税率/メモを編集、小計/税額/合計を即時計算して、明細付き /checkout の QR を
// 生成する。決済画面 (/checkout) で内訳がレシート風に表示され、CheckoutForm が履歴に売上明細
// (lineItems) + per-item 税/管理番号を保存する。
//
// - 受取先/token/chain/gas/mode は QR タブと同じ useQrSettings を共有 (住所再入力不要)。
// - 同一カートは単一通貨 (最初の商品で通貨確定・異通貨プリセットは警告)。チェーンは既存ロジック維持。
// - 本格 POS ではなくイベント販売・少量販売向け。値引/在庫/カテゴリ/レシート印刷/日報は対象外。
//   税額は税込金額からの内税の目安 (記帳補助)。最終的な会計処理は会計ソフト・税理士側で確認。

import { useCallback, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useTranslations } from 'next-intl';
import { formatUnits, type Address } from 'viem';
import { ChevronRight, Hash, Minus, Plus, Trash2 } from 'lucide-react';
import { AddressInput } from './AddressInput';
import { ReceiverWalletChip } from './ReceiverWalletChip';
import { Field } from './Field';
import { ProductPresetManager } from './ProductPresetManager';
import { useQrSettings } from '@/hooks/useQrSettings';
import { useReceiverAutofill, type ReceiverSource } from '@/hooks/useReceiverAutofill';
import { useProductPresets, type ProductPreset } from '@/hooks/useProductPresets';
import { randomId } from '@/lib/id';
import { useOrigin } from '@/hooks/useOrigin';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { pickEffectiveAddress } from '@/lib/format';
import { isLikelyName } from '@/lib/nameDetection';
import { DEFAULT_CHAIN_FOR_SYMBOL, deploymentForSlug } from '@/lib/tokens';
import {
  buildCheckoutUrl,
  calcCheckoutTotal,
  CHECKOUT_MAX_ITEMS,
  DECIMAL_PATTERN,
  exceedsTokenPrecision,
  type CheckoutItem,
} from '@/lib/url';
import { taxAmountDecimal, taxDisplayDecimals, type TaxCategory } from '@/lib/tax';
import { TaxCategorySelect } from './TaxCategorySelect';

type CartLine = {
  id: string;
  name: string;
  unitPrice: string;
  quantity: number;
  taxRate: number | null;
  taxCategory: TaxCategory | null;
  memo: string;
  presetId?: string;
};

export function RegisterMode() {
  const t = useTranslations('RegisterMode');
  const { settings, setSettings, hydrated } = useQrSettings();
  const presetStore = useProductPresets();
  const origin = useOrigin();
  const { copied, copy } = useCopyToClipboard();

  const [cart, setCart] = useState<CartLine[]>([]);
  const [receiptNo, setReceiptNo] = useState('');
  const [resolvedReceiver, setResolvedReceiver] = useState<Address | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [currencyWarning, setCurrencyWarning] = useState(false);

  const effectiveReceiver = pickEffectiveAddress(settings.receiver, resolvedReceiver);
  const setReceiver = useCallback(
    (value: string, source: ReceiverSource) =>
      setSettings((s) => ({ ...s, receiver: value, receiverSource: source })),
    [setSettings],
  );
  const autofill = useReceiverAutofill({
    receiver: settings.receiver,
    receiverSource: settings.receiverSource,
    effectiveReceiver,
    hydrated,
    setReceiver,
  });
  const deployment = deploymentForSlug(settings.token, settings.chain);
  const symbol = deployment.displaySymbol;
  const taxDec = taxDisplayDecimals(settings.token);

  function addFromPreset(p: ProductPreset) {
    // 異通貨プリセットはカート非空時に警告 (同一カート単一通貨)。空なら通貨を切替。
    if (cart.length > 0 && p.token !== settings.token) {
      setCurrencyWarning(true);
      return;
    }
    setCurrencyWarning(false);
    if (cart.length === 0 && p.token !== settings.token) {
      setSettings((s) => ({
        ...s,
        token: p.token,
        chain: DEFAULT_CHAIN_FOR_SYMBOL[p.token],
      }));
    }
    setCart((c) => {
      const existing = c.find((l) => l.presetId === p.id);
      if (existing) {
        // 同じプリセットの再追加は数量 +1 (レジとして自然)。
        return c.map((l) =>
          l.id === existing.id ? { ...l, quantity: Math.min(999, l.quantity + 1) } : l,
        );
      }
      if (c.length >= CHECKOUT_MAX_ITEMS) return c;
      return [
        ...c,
        {
          id: randomId(),
          name: p.name,
          unitPrice: p.unitPrice,
          quantity: 1,
          taxRate: p.taxRate,
          taxCategory: p.taxCategory,
          memo: p.memo ?? '',
          presetId: p.id,
        },
      ];
    });
  }

  function addEmptyLine() {
    setCurrencyWarning(false);
    setCart((c) =>
      c.length >= CHECKOUT_MAX_ITEMS
        ? c
        : [
            ...c,
            {
              id: randomId(),
              name: '',
              unitPrice: '',
              quantity: 1,
              taxRate: null,
              taxCategory: null,
              memo: '',
            },
          ],
    );
  }

  function updateLine(id: string, patch: Partial<CartLine>) {
    setCart((c) => c.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }
  function removeLine(id: string) {
    setCart((c) => c.filter((l) => l.id !== id));
  }
  function setQty(id: string, qty: number) {
    updateLine(id, { quantity: Math.max(1, Math.min(999, qty)) });
  }

  // 各行を検証・金額/税額を算出。
  const lines = cart.map((l) => {
    const priceValid =
      DECIMAL_PATTERN.test(l.unitPrice) &&
      Number(l.unitPrice) > 0 &&
      !exceedsTokenPrecision(l.unitPrice, deployment.decimals);
    const valid = l.name.trim().length > 0 && priceValid && l.quantity >= 1;
    const amountWei = valid
      ? calcCheckoutTotal(
          [{ name: l.name, qty: l.quantity, price: l.unitPrice }],
          deployment.decimals,
        )
      : 0n;
    const amountHuman = formatUnits(amountWei, deployment.decimals);
    const lineTax = valid
      ? taxAmountDecimal(Number(amountHuman), l.taxRate, taxDec)
      : null;
    return { l, valid, amountHuman, lineTax };
  });

  const validItems: CheckoutItem[] = lines
    .filter((x) => x.valid)
    .map(({ l }) => ({
      name: l.name.trim(),
      qty: l.quantity,
      price: l.unitPrice,
      taxRate: l.taxRate ?? undefined,
      taxCategory: l.taxCategory ?? undefined,
      memo: l.memo.trim() || undefined,
    }));

  const totalWei = calcCheckoutTotal(validItems, deployment.decimals);
  const totalHuman = formatUnits(totalWei, deployment.decimals);
  const totalTax = lines.reduce((s, x) => s + (x.lineTax ?? 0), 0);
  const totalTaxRounded =
    Math.round(totalTax * 10 ** taxDec) / 10 ** taxDec;

  const checkoutUrl =
    hydrated && effectiveReceiver && origin && validItems.length > 0
      ? buildCheckoutUrl(origin, {
          to: effectiveReceiver,
          token: settings.token,
          chain: settings.chain,
          gas: settings.gasMode,
          mode: settings.payMode,
          items: validItems,
          receiptNo: receiptNo || undefined,
        })
      : '';

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-slate-800">{t('heading')}</h2>
        <p className="mt-1 text-sm text-slate-500">{t('subheading')}</p>
      </div>

      <Field label={t('merchantAddressLabel')}>
        <AddressInput
          value={settings.receiver}
          onChange={autofill.handleManualChange}
          onResolved={setResolvedReceiver}
        />
        <ReceiverWalletChip
          canUse={autofill.canUseConnected}
          matches={autofill.matchesConnected}
          onUse={autofill.useConnectedWallet}
          useLabel={t('useConnectedWallet')}
          matchLabel={t('receiverMatchesWallet')}
        />
        {settings.receiver &&
          !effectiveReceiver &&
          !isLikelyName(settings.receiver) && (
            <p className="mt-1 text-xs text-red-600">{t('addressInvalid')}</p>
          )}
      </Field>

      {/* 商品プリセット (有効・配列順) */}
      {presetStore.enabledPresets.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-semibold text-slate-500">
            {t('presetsLabel')}
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {presetStore.enabledPresets.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => addFromPreset(p)}
                className="rounded-xl border border-slate-200 bg-white px-3 py-3 text-left transition hover:border-brand active:bg-brand/5"
              >
                <div className="truncate text-sm font-semibold text-slate-800">
                  {p.name}
                </div>
                <div className="font-mono text-xs text-slate-500">
                  {p.unitPrice}{' '}
                  {deploymentForSlug(p.token, DEFAULT_CHAIN_FOR_SYMBOL[p.token])
                    .displaySymbol}
                </div>
              </button>
            ))}
          </div>
          {currencyWarning && (
            <p className="mt-2 text-xs text-amber-600">
              {t('currencyMismatch', { symbol })}
            </p>
          )}
        </div>
      )}

      {/* カート (商品行カード) */}
      {cart.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-400">
          {t('cartEmpty')}
        </p>
      ) : (
        <ul className="space-y-3">
          {lines.map(({ l, amountHuman, valid }) => (
            <li
              key={l.id}
              className="space-y-3 rounded-2xl border border-slate-200 bg-white p-3"
            >
              <div className="flex items-start gap-2">
                <input
                  type="text"
                  value={l.name}
                  onChange={(e) => updateLine(l.id, { name: e.target.value })}
                  placeholder={t('productNamePlaceholder')}
                  aria-label={t('productNameLabel')}
                  className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-base focus:border-brand focus:outline-none"
                  maxLength={80}
                />
                <button
                  type="button"
                  onClick={() => removeLine(l.id)}
                  aria-label={t('removeLine')}
                  className="rounded-lg border border-slate-200 p-2 text-slate-400 hover:border-red-300 hover:text-red-600"
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              </div>

              <div className="flex flex-wrap items-end gap-3">
                <Field label={t('unitPriceLabel', { symbol })}>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={l.unitPrice}
                    onChange={(e) =>
                      updateLine(l.id, {
                        unitPrice: e.target.value.replace(/[^\d.]/g, ''),
                      })
                    }
                    placeholder="0"
                    aria-label={t('unitPriceLabel', { symbol })}
                    className="w-28 rounded-lg border border-slate-300 px-3 py-2 text-right font-mono text-base focus:border-brand focus:outline-none"
                  />
                </Field>
                <Field label={t('quantityLabel')}>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setQty(l.id, l.quantity - 1)}
                      aria-label={t('quantityDecrement')}
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-slate-300 text-slate-600 hover:border-brand"
                    >
                      <Minus className="h-5 w-5" aria-hidden />
                    </button>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={l.quantity}
                      aria-label={t('quantityLabel')}
                      onChange={(e) => {
                        const n = Number(e.target.value.replace(/[^\d]/g, ''));
                        setQty(l.id, Number.isFinite(n) && n >= 1 ? n : 1);
                      }}
                      className="h-11 w-14 rounded-lg border border-slate-300 text-center font-mono text-lg focus:border-brand focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setQty(l.id, l.quantity + 1)}
                      aria-label={t('quantityIncrement')}
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-slate-300 text-slate-600 hover:border-brand"
                    >
                      <Plus className="h-5 w-5" aria-hidden />
                    </button>
                  </div>
                </Field>
                <Field label={t('taxLabel')}>
                  <TaxCategorySelect
                    taxRate={l.taxRate}
                    taxCategory={l.taxCategory}
                    onChange={(next) => updateLine(l.id, next)}
                    ariaLabel={t('taxLabel')}
                    customAriaLabel={t('taxCustomLabel')}
                  />
                </Field>
                <div className="ml-auto text-right">
                  <div className="text-[11px] text-slate-400">{t('lineAmount')}</div>
                  <div className="font-mono text-sm font-semibold text-slate-800">
                    {valid ? `${amountHuman} ${symbol}` : '—'}
                  </div>
                </div>
              </div>

              <input
                type="text"
                value={l.memo}
                onChange={(e) => updateLine(l.id, { memo: e.target.value })}
                placeholder={t('memoPlaceholder')}
                aria-label={t('memoLabel')}
                className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-xs focus:border-brand focus:outline-none"
                maxLength={80}
              />
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={addEmptyLine}
        disabled={cart.length >= CHECKOUT_MAX_ITEMS}
        className="w-full rounded-xl border border-dashed border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-600 hover:border-brand hover:text-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
      >
        {t('addLine')}
      </button>

      <Field label={t('receiptNoLabel')}>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={receiptNo}
            onChange={(e) => setReceiptNo(e.target.value)}
            placeholder={t('receiptNoPlaceholder')}
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 font-mono text-sm focus:border-brand focus:outline-none"
            maxLength={64}
          />
          <button
            type="button"
            onClick={() => setReceiptNo(presetStore.nextReceiptNo())}
            className="flex shrink-0 items-center gap-1 rounded-xl border border-slate-300 px-3 py-2.5 text-xs font-medium text-slate-600 hover:border-brand"
          >
            <Hash className="h-3.5 w-3.5" aria-hidden />
            {t('receiptNoGenerate')}
          </button>
        </div>
      </Field>

      {/* 小計/税額/合計 */}
      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
        <dl className="space-y-1.5 text-sm">
          <div className="flex justify-between">
            <dt className="text-slate-500">{t('subtotal')}</dt>
            <dd className="font-mono text-slate-800">
              {totalHuman} {symbol}
            </dd>
          </div>
          {totalTaxRounded > 0 && (
            <div className="flex justify-between">
              <dt className="text-slate-500">{t('taxAmount')}</dt>
              <dd className="font-mono text-slate-600">
                {totalTaxRounded} {symbol}
              </dd>
            </div>
          )}
          <div className="flex justify-between border-t border-slate-200 pt-1.5 text-base font-semibold">
            <dt>{t('total')}</dt>
            <dd className="font-mono text-slate-900">
              {totalHuman} {symbol}
            </dd>
          </div>
        </dl>
        <p className="mt-2 text-[11px] text-slate-400">{t('taxInclusiveNote')}</p>
      </div>

      {/* QR 生成 */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5">
        {checkoutUrl ? (
          <div className="space-y-3">
            <div className="flex justify-center">
              <QRCodeSVG value={checkoutUrl} size={220} includeMargin level="M" />
            </div>
            <div className="break-all rounded-lg bg-slate-50 px-3 py-2 font-mono text-[11px] text-slate-500">
              {checkoutUrl}
            </div>
            <button
              type="button"
              onClick={() => copy(checkoutUrl)}
              className="w-full rounded-xl bg-brand px-4 py-3 text-base font-semibold text-white hover:bg-brand-dark"
            >
              {copied ? t('copied') : t('copyUrl')}
            </button>
          </div>
        ) : (
          <p className="text-center text-sm text-slate-400">
            {t('previewPlaceholder')}
          </p>
        )}
      </div>

      {/* 商品プリセット管理 (折りたたみ) */}
      <details
        className="group rounded-2xl border border-slate-200 bg-white p-4"
        open={managerOpen}
      >
        <summary
          onClick={(e) => {
            e.preventDefault();
            setManagerOpen((o) => !o);
          }}
          className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-slate-700"
        >
          <span>{t('presetManagerTitle')}</span>
          <ChevronRight
            className="h-4 w-4 text-slate-400 transition-transform group-open:rotate-90"
            aria-hidden
          />
        </summary>
        <div className="mt-3">
          <ProductPresetManager
            presets={presetStore.presets}
            addPreset={presetStore.addPreset}
            updatePreset={presetStore.updatePreset}
            removePreset={presetStore.removePreset}
            movePreset={presetStore.movePreset}
          />
        </div>
      </details>
    </div>
  );
}
