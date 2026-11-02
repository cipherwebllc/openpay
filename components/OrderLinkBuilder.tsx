'use client';

// /create「注文リンク」タブ: 通販の注文ごとに、お客様へ送る /checkout のリンクを作る。
// ブラウザの中で完結し、サーバーへ送らない (lib/orderLink.ts)。氏名・住所の欄は作らない。
// 金額はお客様が URL で書き換えられるので、発送の前に届いた額を確かめる案内を結果と同じ場所に出す。

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Check, Copy, ExternalLink, Package, Plus, Truck, Wallet } from 'lucide-react';
import { AddressInput } from '@/components/AddressInput';
import { ChainChooser } from '@/components/ChainChooser';
import { Field } from '@/components/Field';
import { ReceiverWalletChip } from '@/components/ReceiverWalletChip';
import { SectionCard } from '@/components/SectionCard';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { useOrderLinkSettings } from '@/hooks/useOrderLinkSettings';
import { useOrigin } from '@/hooks/useOrigin';
import { useReceiverAutofill, type ReceiverSource } from '@/hooks/useReceiverAutofill';
import { useResolveAddress } from '@/hooks/useResolveAddress';
import { JPYC_CHAINS } from '@/lib/chains';
import type { PayMode } from '@/lib/fee';
import { pickEffectiveAddress } from '@/lib/format';
import { isLikelyName } from '@/lib/nameDetection';
import {
  buildOrderLink,
  orderLinkChains,
  ORDER_LINK_DESCRIPTION_MAX,
  ORDER_LINK_ID_MAX,
  ORDER_LINK_NAME_MAX,
  type OrderLinkLine,
} from '@/lib/orderLink';
import { CHECKOUT_MAX_ITEMS } from '@/lib/url/checkout';

const INPUT_CLASS =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20';
const MODES: readonly PayMode[] = ['gasless', 'standard'];
const EMPTY_LINE: OrderLinkLine = { name: '', qty: '1', price: '' };
// 送料の行の分を残す (/checkout の明細は送料を含めて CHECKOUT_MAX_ITEMS 行まで)。
const MAX_LINES = CHECKOUT_MAX_ITEMS - 1;

export function OrderLinkBuilder() {
  const t = useTranslations('OrderLinkBuilder');
  const locale = useLocale();
  const origin = useOrigin();
  const copier = useCopyToClipboard();
  const { settings, setSettings, hydrated } = useOrderLinkSettings();
  const [orderId, setOrderId] = useState('');
  const [description, setDescription] = useState('');
  const [lines, setLines] = useState<OrderLinkLine[]>([EMPTY_LINE]);
  const [shipping, setShipping] = useState('');

  const receiverName = settings.receiver.trim();
  const ens = useResolveAddress(isLikelyName(receiverName) ? receiverName : '');
  // 再解決に失敗しても react-query は前回の解決結果を残すので、失敗中は使わない (古いアドレスのリンクを作らない)。
  const effectiveReceiver = useMemo(
    () => pickEffectiveAddress(settings.receiver, ens.error ? null : ens.data?.address ?? null),
    [settings.receiver, ens.data, ens.error],
  );
  const setReceiver = useCallback(
    (value: string, source: ReceiverSource) =>
      setSettings((current) => ({ ...current, receiver: value, receiverSource: source })),
    [setSettings],
  );
  const autofill = useReceiverAutofill({
    receiver: settings.receiver,
    receiverSource: settings.receiverSource,
    effectiveReceiver,
    hydrated,
    setReceiver,
  });

  const chains = useMemo(() => orderLinkChains(JPYC_CHAINS), []);
  const result = useMemo(
    () =>
      buildOrderLink({
        origin: origin || 'https://open-pay.jp',
        to: effectiveReceiver,
        chain: settings.chain,
        mode: settings.payMode,
        orderId,
        description,
        lines,
        shipping,
        shippingLabel: t('shippingLineName'),
      }),
    [origin, effectiveReceiver, settings.chain, settings.payMode, orderId, description, lines, shipping, t],
  );

  const updateLine = (index: number, patch: Partial<OrderLinkLine>) =>
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  const removeLine = (index: number) =>
    setLines((current) => current.filter((_, i) => i !== index));

  const errorText = result.ok
    ? null
    : result.error === 'tooSmall'
      ? t('errors.tooSmall', { minimum: result.minimum ?? '' })
      : result.error === 'tooManyLines'
        ? t('errors.tooManyLines', { max: CHECKOUT_MAX_ITEMS })
        : t(`errors.${result.error}`);

  return (
    <div className="space-y-5">
      <p className="text-sm leading-relaxed text-slate-600">{t('intro')}</p>

      <SectionCard title={t('receiveTitle')} headingId="order-link-receive" icon={Wallet}>
        <div className="space-y-4">
          <Field label={t('receiverLabel')}>
            <AddressInput value={settings.receiver} onChange={autofill.handleManualChange} />
            <ReceiverWalletChip
              canUse={autofill.canUseConnected}
              matches={autofill.matchesConnected}
              onUse={autofill.useConnectedWallet}
              useLabel={t('useConnectedWallet')}
              matchLabel={t('receiverMatchesWallet')}
            />
            <p className="mt-1.5 text-xs leading-relaxed text-slate-500">{t('receiverHint')}</p>
          </Field>
          <Field label={t('chainLabel')}>
            <ChainChooser
              slugs={chains}
              selected={settings.chain}
              onSelect={(chain) => setSettings((current) => ({ ...current, chain }))}
              showId={false}
            />
          </Field>
          <Field label={t('modeLabel')}>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={settings.payMode === mode}
                  onClick={() => setSettings((current) => ({ ...current, payMode: mode }))}
                  className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                    settings.payMode === mode
                      ? 'border-brand bg-brand/5 font-semibold text-brand-dark'
                      : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400'
                  }`}
                >
                  {t(`modes.${mode}`)}
                </button>
              ))}
            </div>
          </Field>
        </div>
      </SectionCard>

      <SectionCard title={t('orderTitle')} headingId="order-link-order" icon={Package}>
        <div className="space-y-4">
          <Field label={t('orderIdLabel')} htmlFor="order-link-id">
            <input
              id="order-link-id"
              value={orderId}
              maxLength={ORDER_LINK_ID_MAX}
              onChange={(event) => setOrderId(event.target.value)}
              placeholder={t('orderIdPlaceholder')}
              className={INPUT_CLASS}
            />
            <p className="mt-1.5 text-xs leading-relaxed text-slate-500">{t('orderIdHint')}</p>
          </Field>

          <div className="space-y-3">
            {lines.map((line, index) => (
              <fieldset key={index} className="min-w-0 rounded-xl bg-slate-50 p-3">
                <legend className="sr-only">{t('lineLegend', { number: index + 1 })}</legend>
                <div className="space-y-2">
                  <Field label={t('itemNameLabel')} htmlFor={`order-link-name-${index}`}>
                    <input
                      id={`order-link-name-${index}`}
                      value={line.name}
                      maxLength={ORDER_LINK_NAME_MAX}
                      onChange={(event) => updateLine(index, { name: event.target.value })}
                      placeholder={t('itemNamePlaceholder')}
                      className={INPUT_CLASS}
                    />
                  </Field>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label={t('itemQtyLabel')} htmlFor={`order-link-qty-${index}`}>
                      <input
                        id={`order-link-qty-${index}`}
                        value={line.qty}
                        inputMode="numeric"
                        onChange={(event) => updateLine(index, { qty: event.target.value })}
                        className={INPUT_CLASS}
                      />
                    </Field>
                    <Field label={t('itemPriceLabel')} htmlFor={`order-link-price-${index}`}>
                      <input
                        id={`order-link-price-${index}`}
                        value={line.price}
                        inputMode="decimal"
                        onChange={(event) => updateLine(index, { price: event.target.value })}
                        className={INPUT_CLASS}
                      />
                    </Field>
                  </div>
                </div>
                {lines.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeLine(index)}
                    className="mt-2 text-xs font-medium text-slate-500 underline underline-offset-2 hover:text-slate-800"
                  >
                    {t('removeLine')}
                  </button>
                )}
              </fieldset>
            ))}
            {lines.length < MAX_LINES && (
              <button
                type="button"
                onClick={() => setLines((current) => [...current, EMPTY_LINE])}
                className="inline-flex items-center gap-1.5 text-sm font-medium text-brand hover:text-brand-dark"
              >
                <Plus className="h-4 w-4" aria-hidden />
                {t('addLine')}
              </button>
            )}
          </div>

          <Field label={t('shippingLabel')} htmlFor="order-link-shipping">
            <input
              id="order-link-shipping"
              value={shipping}
              inputMode="decimal"
              onChange={(event) => setShipping(event.target.value)}
              className={INPUT_CLASS}
            />
            <p className="mt-1.5 text-xs leading-relaxed text-slate-500">{t('shippingHint')}</p>
          </Field>

          <Field label={t('descriptionLabel')} htmlFor="order-link-description">
            <input
              id="order-link-description"
              value={description}
              maxLength={ORDER_LINK_DESCRIPTION_MAX}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t('descriptionPlaceholder')}
              className={INPUT_CLASS}
            />
          </Field>
          <p className="text-xs leading-relaxed text-amber-800">{t('noPersonalData')}</p>
        </div>
      </SectionCard>

      <SectionCard title={t('resultTitle')} headingId="order-link-result" icon={Truck}>
        {result.ok ? (
          <div className="space-y-4">
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-slate-600">{t('summaryTotal')}</dt>
                <dd className="font-semibold text-slate-900">{result.total} JPYC</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-600">{t('summaryFee')}</dt>
                <dd className="text-slate-700">{result.fee} JPYC</dd>
              </div>
              <div className="flex justify-between gap-3 border-t border-slate-200 pt-1">
                <dt className="text-slate-600">{t('summaryReceive')}</dt>
                <dd className="font-semibold text-slate-900">{result.receive} JPYC</dd>
              </div>
            </dl>
            <Field label={t('linkLabel')} htmlFor="order-link-url">
              <textarea
                id="order-link-url"
                readOnly
                rows={4}
                value={result.url}
                className={`${INPUT_CLASS} break-all font-mono text-xs`}
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              {copier.available && (
                <button
                  type="button"
                  onClick={() => void copier.copy(result.url)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark"
                >
                  {copier.copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
                  {copier.copied ? t('copied') : t('copy')}
                </button>
              )}
              <a
                href={result.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-400"
              >
                <ExternalLink className="h-4 w-4" aria-hidden />
                {t('open')}
              </a>
            </div>
            <div className="rounded-xl bg-amber-50 p-3 ring-1 ring-amber-200/70">
              <p className="text-sm font-semibold text-amber-900">{t('checksTitle')}</p>
              <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs leading-relaxed text-amber-900">
                <li>{t('checkAmount', { receive: result.receive })}</li>
                <li>{t('checkTxHash')}</li>
                <li>{t('checkRecord')}</li>
                <li>{t('checkExpiry')}</li>
              </ul>
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-600">{errorText}</p>
        )}
      </SectionCard>

      <p className="text-xs leading-relaxed text-slate-500">
        {t('sellerDuty')}{' '}
        <Link
          href={`/${locale}/pricing`}
          prefetch={false}
          className="font-medium text-brand underline underline-offset-2 hover:text-brand-dark"
        >
          {t('pricingLink')}
        </Link>
      </p>
    </div>
  );
}
