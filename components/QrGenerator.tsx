'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useTranslations } from 'next-intl';
import { isAddress, getAddress, type Address } from 'viem';
import { AddressInput } from './AddressInput';
import { Field } from './Field';
import { useQrSettings } from '@/hooks/useQrSettings';
import { buildPayUrl, type PayParams, type PayMode } from '@/lib/url';
import { TOKENS, type TokenSymbol } from '@/lib/tokens';
import type { FeeMode } from '@/lib/fee';
import { env } from '@/lib/env';
import { isLikelyName } from '@/lib/nameDetection';

type Mode = 'amount' | 'static';

function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function QrGenerator() {
  const { settings, setSettings, hydrated } = useQrSettings();
  const [mode, setMode] = useState<Mode>('amount');
  const [amount, setAmount] = useState('');
  const [origin, setOrigin] = useState('');
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const [accordionOpen, setAccordionOpen] = useState(true);
  const [accordionInitialized, setAccordionInitialized] = useState(false);
  const [resolvedReceiver, setResolvedReceiver] = useState<Address | null>(null);

  const t = useTranslations('QrGenerator');

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setOrigin(window.location.origin);
    }
  }, []);

  const effectiveReceiver: Address | null = useMemo(() => {
    if (isAddress(settings.receiver)) return getAddress(settings.receiver);
    if (resolvedReceiver) return resolvedReceiver;
    return null;
  }, [settings.receiver, resolvedReceiver]);

  useEffect(() => {
    if (!hydrated || accordionInitialized) return;
    setAccordionOpen(effectiveReceiver === null);
    setAccordionInitialized(true);
  }, [hydrated, effectiveReceiver, accordionInitialized]);

  const receiverValid = effectiveReceiver !== null;
  const amountValid =
    mode === 'static' ||
    (mode === 'amount' && /^\d+(\.\d+)?$/.test(amount) && Number(amount) > 0);
  const payMode: PayMode = settings.directTransfer ? 'direct' : 'gasless';

  const payUrl = useMemo(() => {
    if (!hydrated || !effectiveReceiver || !origin || !amountValid) return '';
    const params: PayParams = {
      to: effectiveReceiver,
      token: settings.token,
      fee: settings.fee,
      amount: mode === 'amount' ? amount : undefined,
      mode: payMode,
    };
    return buildPayUrl(origin, params);
  }, [
    hydrated,
    effectiveReceiver,
    origin,
    amountValid,
    settings.token,
    settings.fee,
    mode,
    amount,
    payMode,
  ]);

  const handleResolved = useCallback((addr: Address | null) => {
    setResolvedReceiver(addr);
  }, []);

  const tokenInfo = TOKENS[settings.token];

  async function copyUrl() {
    if (!payUrl) return;
    await navigator.clipboard.writeText(payUrl);
    setCopyState('copied');
    setTimeout(() => setCopyState('idle'), 1500);
  }

  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <section className="space-y-5">
        <Field label={t('amountLabel', { symbol: tokenInfo.displaySymbol })}>
          <div className="flex flex-col gap-2">
            <div className="inline-flex w-full rounded-lg border border-slate-200 bg-slate-100 p-1">
              {(
                [
                  ['amount', t('modeAmount')],
                  ['static', t('modeStatic')],
                ] as const
              ).map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m as Mode)}
                  className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition ${
                    mode === m
                      ? 'bg-white text-brand-dark shadow-sm'
                      : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {mode === 'amount' ? (
              <input
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) =>
                  setAmount(e.target.value.replace(/[^\d.]/g, ''))
                }
                placeholder={settings.token === 'jpyc' ? '1000' : '10.00'}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-3 text-2xl font-bold focus:border-brand focus:outline-none"
                autoFocus
              />
            ) : (
              <p className="rounded-lg bg-slate-50 px-3 py-3 text-sm text-slate-500">
                {t('staticHint')}
              </p>
            )}
          </div>
        </Field>

        <SettingsAccordion
          open={accordionOpen}
          onToggle={() => setAccordionOpen((o) => !o)}
          summaryLabel={t('advancedSettings')}
          summary={
            <SettingsSummary
              token={settings.token}
              receiver={settings.receiver}
              fee={settings.fee}
              direct={settings.directTransfer}
            />
          }
        >
          <Field label={t('tokenLabel')}>
            <div className="grid grid-cols-2 gap-2">
              {(['usdc', 'jpyc'] as TokenSymbol[]).map((tok) => {
                const info = TOKENS[tok];
                const active = settings.token === tok;
                return (
                  <button
                    key={tok}
                    type="button"
                    onClick={() => setSettings((s) => ({ ...s, token: tok }))}
                    className={`rounded-lg border px-3 py-3 text-left text-sm transition ${
                      active
                        ? 'border-brand bg-brand/5 text-brand-dark'
                        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                    }`}
                  >
                    <div className="font-semibold">{info.displaySymbol}</div>
                    <div className="text-xs text-slate-500">
                      {t('tokenChainHint', {
                        chainName: tok === 'usdc' ? 'Base' : 'Polygon',
                        chainId: info.chainId,
                      })}
                    </div>
                  </button>
                );
              })}
            </div>
          </Field>

          <Field label={t('receiverLabel')}>
            <AddressInput
              value={settings.receiver}
              onChange={(v) => setSettings((s) => ({ ...s, receiver: v }))}
              onResolved={handleResolved}
            />
            {settings.receiver &&
              !receiverValid &&
              !isLikelyName(settings.receiver) && (
                <p className="mt-1 text-xs text-red-600">
                  {t('addressInvalid')}
                </p>
              )}
          </Field>

          {settings.directTransfer ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-800">
              {t('directHint')}
            </div>
          ) : (
            <Field label={t('feeLabel')}>
              <div className="grid grid-cols-2 gap-2">
                {(['include', 'exclude'] as FeeMode[]).map((f) => {
                  const active = settings.fee === f;
                  return (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setSettings((s) => ({ ...s, fee: f }))}
                      className={`rounded-lg border px-3 py-3 text-left text-sm transition ${
                        active
                          ? 'border-brand bg-brand/5 text-brand-dark'
                          : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                      }`}
                    >
                      <div className="font-semibold">
                        {f === 'include'
                          ? t('feeIncludeTitle')
                          : t('feeExcludeTitle')}
                      </div>
                      <div className="text-xs text-slate-500">
                        {f === 'include'
                          ? t('feeIncludeDesc')
                          : t('feeExcludeDesc')}
                      </div>
                    </button>
                  );
                })}
              </div>
            </Field>
          )}

          <AdvancedSection label={t('advancedExtra')}>
            <label className="flex cursor-pointer items-start gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={settings.directTransfer}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    directTransfer: e.target.checked,
                  }))
                }
                className="mt-0.5"
              />
              <span>
                <span className="font-medium text-slate-700">
                  {t('directOption')}
                </span>
                <span className="block text-slate-500">
                  {t('directOptionDesc')}
                </span>
              </span>
            </label>
          </AdvancedSection>
        </SettingsAccordion>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-800">
            {t('qrTitle')}
          </h2>
          <p className="text-sm text-slate-500">{t('qrDescription')}</p>
        </div>
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-slate-200 bg-white p-6">
          {payUrl ? (
            <>
              <QRCodeSVG value={payUrl} size={240} includeMargin level="M" />
              <div className="w-full break-all rounded-lg bg-slate-50 px-3 py-2 font-mono text-xs text-slate-600">
                {payUrl}
              </div>
              <button
                type="button"
                onClick={copyUrl}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
              >
                {copyState === 'copied' ? t('qrCopied') : t('qrCopy')}
              </button>
            </>
          ) : (
            <div className="grid h-60 w-60 place-items-center rounded-lg bg-slate-50 text-center text-sm text-slate-400">
              {!receiverValid
                ? t('qrPlaceholderNoAddress')
                : !amountValid
                  ? t('qrPlaceholderNoAmount')
                  : t('qrPlaceholderGenerating')}
            </div>
          )}
        </div>
        {!settings.directTransfer && (
          <div className="rounded-lg bg-slate-50 px-4 py-3 text-xs text-slate-600">
            <p className="font-semibold text-slate-700">
              {t('feeReceiverHeading')}
            </p>
            <p className="mt-1 break-all font-mono">{env.feeReceiver}</p>
            <p className="mt-2 text-slate-500">{t('feeReceiverHint')}</p>
          </div>
        )}
      </section>
    </div>
  );
}

function SettingsAccordion({
  open,
  onToggle,
  summary,
  summaryLabel,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  summary: React.ReactNode;
  summaryLabel: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="flex flex-1 flex-col">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            {summaryLabel}
          </span>
          {!open && (
            <span className="mt-0.5 text-xs text-slate-600">{summary}</span>
          )}
        </div>
        <span className="text-slate-400" aria-hidden>
          {open ? '▲' : '▼'}
        </span>
      </button>
      {open && (
        <div className="space-y-4 border-t border-slate-200 px-4 py-4">
          {children}
        </div>
      )}
    </div>
  );
}

function SettingsSummary({
  token,
  receiver,
  fee,
  direct,
}: {
  token: TokenSymbol;
  receiver: string;
  fee: FeeMode;
  direct: boolean;
}) {
  const tokenLabel = TOKENS[token].displaySymbol;
  const recvLabel = isAddress(receiver) ? shortAddr(receiver) : '—';
  const feeLabel = direct ? '0%' : fee === 'include' ? 'incl.' : 'excl.';
  return (
    <span className="font-mono">
      {tokenLabel} · {recvLabel} · {feeLabel}
    </span>
  );
}

function AdvancedSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-t border-dashed border-slate-200 pt-3">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
        {label}
      </p>
      {children}
    </div>
  );
}
