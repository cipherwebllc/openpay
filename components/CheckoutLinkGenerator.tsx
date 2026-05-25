'use client';

import { useCallback, useMemo, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useTranslations } from 'next-intl';
import { type Address } from 'viem';
import { AddressInput } from './AddressInput';
import { Field } from './Field';
import { useCheckoutSettings } from '@/hooks/useCheckoutSettings';
import { useOrigin } from '@/hooks/useOrigin';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { chainForSlug, USDC_CHAINS, type ChainSlug } from '@/lib/chains';
import type { GasMode, PayMode } from '@/lib/fee';
import { isLikelyName } from '@/lib/nameDetection';
import { formatTokenAmount, pickEffectiveAddress } from '@/lib/format';
import {
  DEFAULT_CHAIN_FOR_SYMBOL,
  defaultDeploymentForSymbol,
  deploymentForSlug,
  isGaslessSupported,
  type TokenSymbol,
} from '@/lib/tokens';
import {
  buildCheckoutUrl,
  calcCheckoutTotal,
  CHECKOUT_MAX_ITEMS,
  parseCheckoutItemDrafts,
  type CheckoutItemDraft,
  type CheckoutParams,
} from '@/lib/url';

// draft validation の reason → i18n key マップ (parseCheckoutItemDrafts の reason と同型)
const ITEM_ERROR_KEY = {
  empty: 'itemErrorEmpty',
  qty: 'itemErrorQty',
  price: 'itemErrorPrice',
} as const;

export function CheckoutLinkGenerator() {
  const { settings, setSettings, hydrated } = useCheckoutSettings();
  const origin = useOrigin();
  const { copied, copy } = useCopyToClipboard();
  const [resolvedReceiver, setResolvedReceiver] = useState<Address | null>(null);

  const t = useTranslations('CheckoutLinkGenerator');

  const effectiveReceiver = useMemo(
    () => pickEffectiveAddress(settings.receiver, resolvedReceiver),
    [settings.receiver, resolvedReceiver],
  );

  const deployment = deploymentForSlug(settings.token, settings.chain);
  const itemsParsed = useMemo(
    () => parseCheckoutItemDrafts(settings.items, deployment.decimals),
    [settings.items, deployment.decimals],
  );
  const totalWei = useMemo(
    () =>
      itemsParsed.items
        ? calcCheckoutTotal(itemsParsed.items, deployment.decimals)
        : 0n,
    [itemsParsed.items, deployment.decimals],
  );
  const fmt = (wei: bigint) => formatTokenAmount(wei, deployment);

  const checkoutUrl = useMemo(() => {
    if (!hydrated || !effectiveReceiver || !origin || !itemsParsed.items) {
      return '';
    }
    const params: CheckoutParams = {
      to: effectiveReceiver,
      token: settings.token,
      chain: settings.chain,
      gas: settings.gasMode,
      mode: settings.payMode,
      items: itemsParsed.items,
      orderId: settings.orderId.trim() || undefined,
      description: settings.description.trim() || undefined,
      customerEmail: settings.customerEmail.trim() || undefined,
      successUrl: settings.successUrl.trim() || undefined,
      cancelUrl: settings.cancelUrl.trim() || undefined,
      webhook: settings.webhook.trim() || undefined,
    };
    return buildCheckoutUrl(origin, params);
  }, [
    hydrated,
    effectiveReceiver,
    origin,
    itemsParsed.items,
    settings.token,
    settings.chain,
    settings.gasMode,
    settings.payMode,
    settings.orderId,
    settings.description,
    settings.customerEmail,
    settings.successUrl,
    settings.cancelUrl,
    settings.webhook,
  ]);

  const handleResolved = useCallback((addr: Address | null) => {
    setResolvedReceiver(addr);
  }, []);

  function selectToken(tok: TokenSymbol) {
    setSettings((s) => ({
      ...s,
      token: tok,
      chain: DEFAULT_CHAIN_FOR_SYMBOL[tok],
    }));
  }

  function selectChain(slug: ChainSlug) {
    // gasless 非対応 chain (paymasterMode=unavailable) 選択時は payMode を standard
    // に強制 set。生成 checkout URL が URL parser で reject されるのを未然に防ぐ。
    const dep = deploymentForSlug(settings.token, slug);
    setSettings((s) => ({
      ...s,
      chain: slug,
      payMode: isGaslessSupported(dep) ? s.payMode : 'standard',
    }));
  }

  function updateItem(idx: number, patch: Partial<CheckoutItemDraft>) {
    setSettings((s) => ({
      ...s,
      items: s.items.map((it, i) => (i === idx ? { ...it, ...patch } : it)),
    }));
  }

  function addItem() {
    if (settings.items.length >= CHECKOUT_MAX_ITEMS) return;
    setSettings((s) => ({
      ...s,
      items: [...s.items, { name: '', qty: '', price: '' }],
    }));
  }

  function removeItem(idx: number) {
    setSettings((s) => {
      // 最後の 1 行は残す (空 row なら次の入力に再利用される)
      const next = s.items.filter((_, i) => i !== idx);
      return { ...s, items: next.length > 0 ? next : [{ name: '', qty: '', price: '' }] };
    });
  }


  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <section className="space-y-5">
        <Field label={t('merchantAddressLabel')}>
          <AddressInput
            value={settings.receiver}
            onChange={(v) => setSettings((s) => ({ ...s, receiver: v }))}
            onResolved={handleResolved}
          />
          {settings.receiver &&
            !effectiveReceiver &&
            !isLikelyName(settings.receiver) && (
              <p className="mt-1 text-xs text-red-600">{t('addressInvalid')}</p>
            )}
        </Field>

        <Field label={t('tokenLabel')}>
          <div className="grid grid-cols-2 gap-2">
            {(['jpyc', 'usdc'] as TokenSymbol[]).map((tok) => {
              const info = defaultDeploymentForSymbol(tok);
              const active = settings.token === tok;
              return (
                <button
                  key={tok}
                  type="button"
                  onClick={() => selectToken(tok)}
                  className={`rounded-lg border px-3 py-3 text-left text-sm transition ${
                    active
                      ? 'border-brand bg-brand/5 text-brand-dark'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                  }`}
                >
                  <div className="font-semibold">{info.displaySymbol}</div>
                  <div className="text-xs text-slate-500">
                    {tok === 'usdc'
                      ? t('tokenChainHintMulti', { count: USDC_CHAINS.length })
                      : t('tokenChainHint', {
                          chainName: 'Polygon',
                          chainId: info.chainId,
                        })}
                  </div>
                </button>
              );
            })}
          </div>
        </Field>

        {settings.token === 'usdc' && (
          <Field label={t('chainLabel')}>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {USDC_CHAINS.map((slug) => {
                const c = chainForSlug(slug);
                const active = settings.chain === slug;
                return (
                  <button
                    key={slug}
                    type="button"
                    onClick={() => selectChain(slug)}
                    className={`rounded-lg border px-3 py-2.5 text-left text-sm transition ${
                      active
                        ? 'border-brand bg-brand/5 text-brand-dark'
                        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                    }`}
                  >
                    <div className="font-semibold">{c.name}</div>
                    <div className="text-xs text-slate-500">id: {c.id}</div>
                  </button>
                );
              })}
            </div>
          </Field>
        )}

        <Field label={t('itemsLabel', { max: CHECKOUT_MAX_ITEMS })}>
          <p className="mb-2 text-xs text-slate-500">{t('itemsDescription')}</p>
          <div className="space-y-2">
            {settings.items.map((it, i) => {
              const errForRow = itemsParsed.errors.find((e) => e.index === i);
              return (
                <div key={i} className="space-y-1">
                  <div className="flex flex-wrap items-start gap-2">
                    <input
                      type="text"
                      value={it.name}
                      onChange={(e) => updateItem(i, { name: e.target.value })}
                      placeholder={t('itemNamePlaceholder')}
                      className="min-w-0 flex-[3] rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none"
                      maxLength={80}
                    />
                    <input
                      type="text"
                      inputMode="numeric"
                      value={it.qty}
                      onChange={(e) =>
                        updateItem(i, { qty: e.target.value.replace(/[^\d]/g, '') })
                      }
                      placeholder={t('itemQtyPlaceholder')}
                      className="w-16 rounded-lg border border-slate-300 bg-white px-2 py-2 text-center text-sm focus:border-brand focus:outline-none"
                      maxLength={3}
                      aria-label={t('itemQtyPlaceholder')}
                    />
                    <input
                      type="text"
                      inputMode="decimal"
                      value={it.price}
                      onChange={(e) =>
                        updateItem(i, {
                          price: e.target.value.replace(/[^\d.]/g, ''),
                        })
                      }
                      placeholder={t('itemPricePlaceholder')}
                      className="w-24 rounded-lg border border-slate-300 bg-white px-2 py-2 text-right font-mono text-sm focus:border-brand focus:outline-none"
                      aria-label={t('itemPricePlaceholder')}
                    />
                    <button
                      type="button"
                      onClick={() => removeItem(i)}
                      aria-label={t('itemRemove')}
                      className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-500 hover:border-red-300 hover:text-red-600"
                    >
                      ×
                    </button>
                  </div>
                  {errForRow && (
                    <p className="text-xs text-red-600">
                      {t('itemError', {
                        index: i + 1,
                        reason: t(ITEM_ERROR_KEY[errForRow.reason]),
                      })}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          {settings.items.length < CHECKOUT_MAX_ITEMS && (
            <button
              type="button"
              onClick={addItem}
              className="mt-2 rounded-md border border-dashed border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:border-brand hover:text-brand-dark"
            >
              {t('itemAdd')}
            </button>
          )}
          {itemsParsed.items && (
            <p className="mt-2 text-xs text-emerald-700">
              {t('totalPreview', { total: fmt(totalWei) })}
            </p>
          )}
        </Field>

        <Field label={t('payModeLabel')}>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {(['gasless', 'standard'] as PayMode[]).map((pm) => {
              const active = settings.payMode === pm;
              // gasless 非対応 chain (paymasterMode=unavailable) では gasless button
              // を grey-out。selectChain で auto-switch されるが、UI 側でも明示。
              const disabled =
                pm === 'gasless' && !isGaslessSupported(deployment);
              return (
                <button
                  key={pm}
                  type="button"
                  disabled={disabled}
                  aria-disabled={disabled}
                  onClick={() => {
                    if (disabled) return;
                    setSettings((s) => ({ ...s, payMode: pm }));
                  }}
                  className={`rounded-lg border px-3 py-3 text-left text-sm transition ${
                    disabled
                      ? 'cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400'
                      : active
                      ? 'border-brand bg-brand/5 text-brand-dark'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                  }`}
                >
                  <div className="font-semibold">
                    {pm === 'gasless'
                      ? t('payModeGaslessTitle')
                      : t('payModeStandardTitle')}
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    {pm === 'gasless'
                      ? t('payModeGaslessDesc')
                      : t('payModeStandardDesc')}
                  </div>
                </button>
              );
            })}
          </div>
        </Field>

        {settings.payMode === 'gasless' && (
          <Field label={t('gasLabel')}>
            <div className="grid grid-cols-2 gap-2">
              {(['customer', 'merchant'] as GasMode[]).map((g) => {
                const active = settings.gasMode === g;
                return (
                  <button
                    key={g}
                    type="button"
                    onClick={() => setSettings((s) => ({ ...s, gasMode: g }))}
                    className={`rounded-lg border px-3 py-3 text-left text-sm transition ${
                      active
                        ? 'border-brand bg-brand/5 text-brand-dark'
                        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                    }`}
                  >
                    <div className="font-semibold">
                      {g === 'customer'
                        ? t('gasCustomerTitle')
                        : t('gasMerchantTitle')}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      {g === 'customer'
                        ? t('gasCustomerDesc')
                        : t('gasMerchantDesc')}
                    </div>
                  </button>
                );
              })}
            </div>
          </Field>
        )}

        <Field label={t('orderIdLabel')}>
          <input
            type="text"
            value={settings.orderId}
            onChange={(e) =>
              setSettings((s) => ({ ...s, orderId: e.target.value }))
            }
            placeholder={t('orderIdPlaceholder')}
            maxLength={64}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs focus:border-brand focus:outline-none"
          />
        </Field>

        <Field label={t('descriptionLabel')}>
          <textarea
            value={settings.description}
            onChange={(e) =>
              setSettings((s) => ({ ...s, description: e.target.value }))
            }
            placeholder={t('descriptionPlaceholder')}
            maxLength={200}
            rows={2}
            className="w-full resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none"
          />
        </Field>

        <Field label={t('customerEmailLabel')}>
          <input
            type="email"
            value={settings.customerEmail}
            onChange={(e) =>
              setSettings((s) => ({ ...s, customerEmail: e.target.value }))
            }
            placeholder={t('customerEmailPlaceholder')}
            maxLength={240}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none"
          />
        </Field>

        <Field label={t('successUrlLabel')}>
          <input
            type="url"
            value={settings.successUrl}
            onChange={(e) =>
              setSettings((s) => ({ ...s, successUrl: e.target.value }))
            }
            placeholder={t('successUrlPlaceholder')}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs focus:border-brand focus:outline-none"
          />
          <p className="mt-1 text-xs text-slate-500">{t('successUrlHint')}</p>
        </Field>

        <Field label={t('cancelUrlLabel')}>
          <input
            type="url"
            value={settings.cancelUrl}
            onChange={(e) =>
              setSettings((s) => ({ ...s, cancelUrl: e.target.value }))
            }
            placeholder={t('cancelUrlPlaceholder')}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs focus:border-brand focus:outline-none"
          />
        </Field>

        <Field label={t('webhookLabel')}>
          <input
            type="url"
            value={settings.webhook}
            onChange={(e) =>
              setSettings((s) => ({ ...s, webhook: e.target.value }))
            }
            placeholder={t('webhookPlaceholder')}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs focus:border-brand focus:outline-none"
          />
          <p className="mt-1 text-xs text-slate-500">{t('webhookHint')}</p>
        </Field>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-800">
            {t('checkoutUrlTitle')}
          </h2>
        </div>
        <div className="flex flex-col items-stretch gap-3 rounded-2xl border border-slate-200 bg-white p-5">
          {checkoutUrl ? (
            <>
              <div className="break-all rounded-lg bg-slate-50 px-3 py-2 font-mono text-xs text-slate-600">
                {checkoutUrl}
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => copy(checkoutUrl)}
                  className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
                >
                  {copied ? t('copiedButton') : t('copyButton')}
                </button>
                <a
                  href={checkoutUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:border-slate-400 hover:bg-slate-50"
                >
                  {t('openInNewTab')}
                </a>
              </div>
              <div className="mt-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {t('qrTitle')}
                </h3>
                <p className="mb-2 text-xs text-slate-500">{t('qrDescription')}</p>
                <div className="flex justify-center">
                  <QRCodeSVG
                    value={checkoutUrl}
                    size={200}
                    includeMargin
                    level="L"
                  />
                </div>
              </div>
            </>
          ) : (
            <p className="text-sm text-slate-400">{t('previewPlaceholder')}</p>
          )}
        </div>

        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
          {t('securityWarning')}
        </div>
      </section>
    </div>
  );
}
