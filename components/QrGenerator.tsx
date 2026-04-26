'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useTranslations } from 'next-intl';
import { isAddress, getAddress, type Address } from 'viem';
import { AddressInput } from './AddressInput';
import { Field } from './Field';
import { useQrSettings, type SplitDraft } from '@/hooks/useQrSettings';
import {
  buildPayUrl,
  SPLIT_MAX_ENTRIES,
  type PayParams,
  type PayMode,
  type SplitEntry,
} from '@/lib/url';
import { TOKENS, type TokenSymbol } from '@/lib/tokens';
import type { FeeMode } from '@/lib/fee';
import { env } from '@/lib/env';
import { isLikelyName } from '@/lib/nameDetection';

type Mode = 'amount' | 'static';

// Drafts → 検証済 SplitEntry[] へ変換。1 件でも不正があれば null を返す
// (URL に部分的に組み込むのは混乱を招くため "all-or-nothing")。
// 主 to との重複・split 内の重複・% 合計 100 以上もここで弾く。
function parseSplitDrafts(
  drafts: ReadonlyArray<SplitDraft>,
  primary: Address | null,
): { entries: SplitEntry[] | null; sum: number; error: 'addr' | 'pct' | 'sum' | 'dup' | null } {
  const entries: SplitEntry[] = [];
  const seen = new Set<string>();
  let sum = 0;
  let firstError: 'addr' | 'pct' | 'sum' | 'dup' | null = null;
  for (const d of drafts) {
    const a = d.address.trim();
    const p = d.percent.trim();
    if (a.length === 0 && p.length === 0) continue;
    if (!isAddress(a)) {
      if (!firstError) firstError = 'addr';
      continue;
    }
    if (!/^\d+$/.test(p)) {
      if (!firstError) firstError = 'pct';
      continue;
    }
    const percent = Number(p);
    if (percent < 1 || percent > 99) {
      if (!firstError) firstError = 'pct';
      continue;
    }
    const checksum = getAddress(a);
    const lower = checksum.toLowerCase();
    if (primary && lower === primary.toLowerCase()) {
      if (!firstError) firstError = 'dup';
      continue;
    }
    if (seen.has(lower)) {
      if (!firstError) firstError = 'dup';
      continue;
    }
    seen.add(lower);
    sum += percent;
    entries.push({ to: checksum, percent });
  }
  if (sum >= 100) {
    return { entries: null, sum, error: 'sum' };
  }
  if (firstError) {
    return { entries: null, sum, error: firstError };
  }
  return { entries, sum, error: null };
}

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

  // direct mode では split は無視する (PaymentForm 側でも無視するので URL に
  // 含めると混乱)。それ以外では parseSplitDrafts で検証して、有効な entries
  // のみ URL に含める。
  const splitParsed = useMemo(
    () => parseSplitDrafts(settings.splits, effectiveReceiver),
    [settings.splits, effectiveReceiver],
  );
  const splitsForUrl =
    !settings.directTransfer &&
    splitParsed.entries &&
    splitParsed.entries.length > 0
      ? splitParsed.entries
      : undefined;

  const payUrl = useMemo(() => {
    if (!hydrated || !effectiveReceiver || !origin || !amountValid) return '';
    const params: PayParams = {
      to: effectiveReceiver,
      token: settings.token,
      fee: settings.fee,
      amount: mode === 'amount' ? amount : undefined,
      mode: payMode,
      split: splitsForUrl,
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
    splitsForUrl,
  ]);

  function setSplits(next: SplitDraft[]) {
    setSettings((s) => ({ ...s, splits: next }));
  }
  function addSplit() {
    if (settings.splits.length >= SPLIT_MAX_ENTRIES) return;
    setSplits([...settings.splits, { address: '', percent: '' }]);
  }
  function removeSplit(idx: number) {
    setSplits(settings.splits.filter((_, i) => i !== idx));
  }
  function updateSplit(idx: number, patch: Partial<SplitDraft>) {
    setSplits(
      settings.splits.map((s, i) => (i === idx ? { ...s, ...patch } : s)),
    );
  }

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

          {!settings.directTransfer && (
            <Field
              label={t('splitLabel', {
                primaryPercent: 100 - splitParsed.sum,
              })}
            >
              <p className="mb-2 text-xs text-slate-500">
                {t('splitDescription', { max: SPLIT_MAX_ENTRIES })}
              </p>
              <div className="space-y-2">
                {settings.splits.map((s, i) => (
                  <div key={i} className="flex flex-wrap items-start gap-2">
                    <input
                      type="text"
                      value={s.address}
                      onChange={(e) =>
                        updateSplit(i, { address: e.target.value.trim() })
                      }
                      placeholder="0x..."
                      className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs focus:border-brand focus:outline-none"
                      spellCheck={false}
                      autoCapitalize="off"
                      autoCorrect="off"
                    />
                    <input
                      type="text"
                      inputMode="numeric"
                      value={s.percent}
                      onChange={(e) =>
                        updateSplit(i, {
                          percent: e.target.value.replace(/[^\d]/g, ''),
                        })
                      }
                      placeholder="%"
                      className="w-16 rounded-lg border border-slate-300 bg-white px-2 py-2 text-center text-sm focus:border-brand focus:outline-none"
                      maxLength={2}
                      aria-label={t('splitPercentLabel')}
                    />
                    <button
                      type="button"
                      onClick={() => removeSplit(i)}
                      aria-label={t('splitRemove')}
                      className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-500 hover:border-red-300 hover:text-red-600"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              {settings.splits.length < SPLIT_MAX_ENTRIES && (
                <button
                  type="button"
                  onClick={addSplit}
                  className="mt-2 rounded-md border border-dashed border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:border-brand hover:text-brand-dark"
                >
                  {t('splitAdd')}
                </button>
              )}
              {splitParsed.error && (
                <p className="mt-2 text-xs text-red-600">
                  {t(`splitError.${splitParsed.error}`)}
                </p>
              )}
              {splitsForUrl && splitsForUrl.length > 0 && (
                <p className="mt-2 text-xs text-emerald-700">
                  {t('splitSummary', {
                    count: splitsForUrl.length,
                    primaryPercent: 100 - splitParsed.sum,
                  })}
                </p>
              )}
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
