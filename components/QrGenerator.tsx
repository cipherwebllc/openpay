'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useTranslations } from 'next-intl';
import { isAddress, type Address } from 'viem';
import { AddressInput } from './AddressInput';
import { Field } from './Field';
import {
  POSTER_NOTE_MAX,
  QUICK_AMOUNT_MAX,
  STORE_NAME_MAX,
  useQrSettings,
} from '@/hooks/useQrSettings';
import { useOrigin } from '@/hooks/useOrigin';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import {
  buildPayUrl,
  DECIMAL_PATTERN,
  parseSplitDrafts,
  SPLIT_MAX_ENTRIES,
  type PayParams,
  type PayMode,
  type SplitDraft,
} from '@/lib/url';
import { buildEip681TransferUri } from '@/lib/eip681';
import {
  DEFAULT_CHAIN_FOR_SYMBOL,
  defaultDeploymentForSymbol,
  deploymentForSlug,
  type TokenSymbol,
} from '@/lib/tokens';
import { chainForSlug, USDC_CHAINS, type ChainSlug } from '@/lib/chains';
import type { GasMode } from '@/lib/fee';
import { env } from '@/lib/env';
import { isLikelyName } from '@/lib/nameDetection';
import { pickEffectiveAddress, shortAddress } from '@/lib/format';

type Mode = 'amount' | 'static';

// 数値以外を除去し、小数桁を token decimals に切り詰める。
// 入力時と token 切替時の両方で適用することで「amount の小数桁数 > decimals」
// 状態を構造的に発生させない (parseUnits の silent round / EIP-681 builder の
// throw を上流で排除)。
function sanitizeAmount(raw: string, decimals: number): string {
  const cleaned = raw.replace(/[^\d.]/g, '');
  const dotIdx = cleaned.indexOf('.');
  if (dotIdx === -1) return cleaned;
  const fracDigits = cleaned.length - dotIdx - 1;
  if (fracDigits <= decimals) return cleaned;
  return cleaned.slice(0, dotIdx + 1 + decimals);
}

const FILENAME_FALLBACK = 'openpay';

// 主要 OS (macOS APFS / Windows NTFS / Linux ext4) は UTF-8 ファイル名を許容する
// ため日本語店舗名 (例「神田珈琲」) もそのまま残す。除去対象は path separator・
// Windows 予約文字・制御文字・空白・ダッシュ連続のみ。これを ASCII 限定の
// 正規化にすると日本語名が常に fallback に潰れて merchant が混乱する。
function fileSafe(value: string): string {
  const normalized = value
    .replace(/[-\\/:*?"<>|\s\x00-\x1f\x7f]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || FILENAME_FALLBACK;
}

function svgMarkup(ref: React.RefObject<HTMLDivElement | null>): string | null {
  const svg = ref.current?.querySelector('svg');
  return svg ? new XMLSerializer().serializeToString(svg) : null;
}

function triggerDownload(href: string, filename: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.click();
}

function downloadSvg(filename: string, ref: React.RefObject<HTMLDivElement | null>) {
  const markup = svgMarkup(ref);
  if (!markup) return;
  const url = URL.createObjectURL(
    new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }),
  );
  triggerDownload(url, filename);
  URL.revokeObjectURL(url);
}

function downloadPng(filename: string, ref: React.RefObject<HTMLDivElement | null>) {
  const markup = svgMarkup(ref);
  if (!markup) return;
  const img = new Image();
  img.onload = () => {
    // QR は常に正方形 (qrcode.react 出力)、img.width = img.height
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.width;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, img.width, img.width);
    ctx.drawImage(img, 0, 0);
    triggerDownload(canvas.toDataURL('image/png'), filename);
  };
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
}

export function QrGenerator() {
  const { settings, setSettings, hydrated } = useQrSettings();
  const [mode, setMode] = useState<Mode>('amount');
  const [amount, setAmount] = useState('');
  const origin = useOrigin();
  const { copied, copy } = useCopyToClipboard();
  const { copied: eip681Copied, copy: eip681Copy } = useCopyToClipboard();
  const qrRef = useRef<HTMLDivElement>(null);
  const [accordionOpen, setAccordionOpen] = useState(true);
  const [accordionInitialized, setAccordionInitialized] = useState(false);
  const [resolvedReceiver, setResolvedReceiver] = useState<Address | null>(null);

  const t = useTranslations('QrGenerator');

  const effectiveReceiver = useMemo(
    () => pickEffectiveAddress(settings.receiver, resolvedReceiver),
    [settings.receiver, resolvedReceiver],
  );

  useEffect(() => {
    if (!hydrated || accordionInitialized) return;
    setAccordionOpen(effectiveReceiver === null);
    setAccordionInitialized(true);
  }, [hydrated, effectiveReceiver, accordionInitialized]);

  const receiverValid = effectiveReceiver !== null;
  const amountValid =
    mode === 'static' ||
    (mode === 'amount' && DECIMAL_PATTERN.test(amount) && Number(amount) > 0);
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
      chain: settings.chain,
      gas: settings.gasMode,
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
    settings.chain,
    settings.gasMode,
    mode,
    amount,
    payMode,
    splitsForUrl,
  ]);

  function setSplits(next: SplitDraft[]) {
    setSettings((s) => ({ ...s, splits: next }));
  }
  function addSplit() {
    // UI 上は + 追加ボタンが条件付きレンダで消えるため (line ~570) このガードは
    // 通常 reachable でない。将来 button の条件を外したり別経路から呼ぶ場合の
    // 二重防御として残す。
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

  // (jpyc + 非 polygon) の不整合は useQrSettings の sanitize で阻止済 → throw 不到達。
  const deployment = deploymentForSlug(settings.token, settings.chain);
  const chain = chainForSlug(settings.chain);
  const qrFilename = useMemo(() => {
    const parts = [
      fileSafe(settings.storeName),
      settings.token,
      settings.chain,
      mode === 'amount' && amount ? amount.replace('.', '-') : 'open',
    ];
    return parts.join('-');
  }, [settings.storeName, settings.token, settings.chain, mode, amount]);

  // 互換 QR (EIP-681) — direct + amount のときだけ併発行 (gasless / split は EIP-681 で表現不可)。
  // amount は sanitizeAmount で常に decimals 内に切り詰められているため、builder は
  // throw しない。
  const eip681Uri = useMemo(() => {
    if (
      !hydrated ||
      !effectiveReceiver ||
      !settings.directTransfer ||
      mode !== 'amount' ||
      !amountValid
    ) {
      return '';
    }
    return buildEip681TransferUri({
      tokenAddress: deployment.address,
      chainId: deployment.chainId,
      to: effectiveReceiver,
      amount,
      decimals: deployment.decimals,
    });
  }, [
    hydrated,
    effectiveReceiver,
    settings.directTransfer,
    mode,
    amountValid,
    deployment.address,
    deployment.chainId,
    deployment.decimals,
    amount,
  ]);

  function selectToken(tok: TokenSymbol) {
    // token を切り替えると chain も既定 (USDC→base, JPYC→polygon) にリセット。
    // jpyc は polygon 固定なので、互換性のため reset 必須。usdc は default に
    // 戻すことで、ユーザの直前の chain 選択 (例: arbitrum) を意図せず引き継がない。
    setSettings((s) => ({
      ...s,
      token: tok,
      chain: DEFAULT_CHAIN_FOR_SYMBOL[tok],
    }));
    // 旧 token (例 JPYC decimals=18) で打った長い小数を新 token (USDC decimals=6) の
    // 範囲へ truncate。amount を超過状態のまま残すと EIP-681 section が disable 表示
    // され UX が壊れるため、入力値を新 token に合わせる。
    setAmount((current) =>
      sanitizeAmount(current, defaultDeploymentForSymbol(tok).decimals),
    );
  }

  function selectChain(slug: ChainSlug) {
    setSettings((s) => ({ ...s, chain: slug }));
  }

  function updateQuickAmount(idx: number, value: string) {
    setSettings((s) => ({
      ...s,
      quickAmounts: s.quickAmounts.map((q, i) =>
        i === idx ? sanitizeAmount(value, deployment.decimals) : q,
      ),
    }));
  }

  function addQuickAmount() {
    setSettings((s) => ({
      ...s,
      quickAmounts: [...s.quickAmounts, ''],
    }));
  }

  function removeQuickAmount(idx: number) {
    setSettings((s) => {
      const next = s.quickAmounts.filter((_, i) => i !== idx);
      return { ...s, quickAmounts: next.length > 0 ? next : [''] };
    });
  }

  // クイック金額は token 切替を跨いで永続するため、現在の token decimals に
  // 合わせて truncate してから表示・適用する。truncate 後に重複した値は除外
  // (例: JPYC で 0.1234567890123 と 0.1234567890124 を保存 → USDC では
  // どちらも 0.123456 に潰れるので片方のみ残す)。
  const activeQuickAmounts = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const q of settings.quickAmounts) {
      if (!DECIMAL_PATTERN.test(q) || Number(q) <= 0) continue;
      const truncated = sanitizeAmount(q, deployment.decimals);
      if (!DECIMAL_PATTERN.test(truncated) || Number(truncated) <= 0) continue;
      if (seen.has(truncated)) continue;
      seen.add(truncated);
      out.push(truncated);
    }
    return out;
  }, [settings.quickAmounts, deployment.decimals]);

  return (
    <div className="grid gap-8 lg:grid-cols-2 print:block print:gap-0">
      <section className="space-y-5 print:hidden">
        <Field label={t('amountLabel', { symbol: deployment.displaySymbol })}>
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
              <div className="space-y-3">
                <input
                  type="text"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) =>
                    setAmount(sanitizeAmount(e.target.value, deployment.decimals))
                  }
                  placeholder={settings.token === 'jpyc' ? '1000' : '10.00'}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-3 text-3xl font-bold focus:border-brand focus:outline-none"
                  autoFocus
                />
                {activeQuickAmounts.length > 0 && (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {activeQuickAmounts.map((q) => (
                      <button
                        key={q}
                        type="button"
                        onClick={() => setAmount(q)}
                        className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:border-brand hover:text-brand-dark"
                      >
                        {q} {deployment.displaySymbol}
                      </button>
                    ))}
                  </div>
                )}
              </div>
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
              chain={settings.chain}
              receiver={settings.receiver}
              gasMode={settings.gasMode}
              direct={settings.directTransfer}
            />
          }
        >
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
                      <div className="text-xs text-slate-500">
                        chain id: {c.id}
                      </div>
                    </button>
                  );
                })}
              </div>
            </Field>
          )}

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

          <Field label={t('storeNameLabel')}>
            <input
              type="text"
              value={settings.storeName}
              onChange={(e) =>
                setSettings((s) => ({ ...s, storeName: e.target.value }))
              }
              placeholder={t('storeNamePlaceholder')}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none"
              maxLength={STORE_NAME_MAX}
            />
          </Field>

          <Field label={t('posterNoteLabel')}>
            <input
              type="text"
              value={settings.posterNote}
              onChange={(e) =>
                setSettings((s) => ({ ...s, posterNote: e.target.value }))
              }
              placeholder={t('posterNotePlaceholder')}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none"
              maxLength={POSTER_NOTE_MAX}
            />
          </Field>

          {settings.directTransfer ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-800">
              {t('directHint')}
            </div>
          ) : (
            <Field label={t('gasLabel')}>
              <div className="grid grid-cols-2 gap-2">
                {(['customer', 'merchant'] as GasMode[]).map((g) => {
                  const active = settings.gasMode === g;
                  return (
                    <button
                      key={g}
                      type="button"
                      onClick={() =>
                        setSettings((s) => ({ ...s, gasMode: g }))
                      }
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
            <div className="mb-4">
              <p className="mb-2 text-xs font-medium text-slate-700">
                {t('quickAmountsLabel')}
              </p>
              <div className="space-y-2">
                {settings.quickAmounts.map((q, i) => (
                  <div key={i} className="flex gap-2">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={q}
                      onChange={(e) => updateQuickAmount(i, e.target.value)}
                      placeholder={t('quickAmountPlaceholder')}
                      className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => removeQuickAmount(i)}
                      aria-label={t('quickAmountRemove')}
                      className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-500 hover:border-red-300 hover:text-red-600"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              {settings.quickAmounts.length < QUICK_AMOUNT_MAX && (
                <button
                  type="button"
                  onClick={addQuickAmount}
                  className="mt-2 rounded-md border border-dashed border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:border-brand hover:text-brand-dark"
                >
                  {t('quickAmountAdd')}
                </button>
              )}
            </div>
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

      <section className="space-y-4 print:space-y-0">
        <div className="print:hidden">
          <h2 className="text-lg font-semibold text-slate-800">
            {t('qrTitle')}
          </h2>
          <p className="text-sm text-slate-500">{t('qrDescription')}</p>
        </div>
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-slate-200 bg-white p-6 print:hidden">
          {payUrl ? (
            <>
              <div ref={qrRef}>
                <QRCodeSVG value={payUrl} size={240} includeMargin level="M" />
              </div>
              <div className="w-full break-all rounded-lg bg-slate-50 px-3 py-2 font-mono text-xs text-slate-600">
                {payUrl}
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                <button
                  type="button"
                  onClick={() => copy(payUrl)}
                  className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
                >
                  {copied ? t('qrCopied') : t('qrCopy')}
                </button>
                <button
                  type="button"
                  onClick={() => downloadSvg(`${qrFilename}.svg`, qrRef)}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:border-brand hover:text-brand-dark"
                >
                  {t('downloadSvg')}
                </button>
                <button
                  type="button"
                  onClick={() => downloadPng(`${qrFilename}.png`, qrRef)}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:border-brand hover:text-brand-dark"
                >
                  {t('downloadPng')}
                </button>
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:border-brand hover:text-brand-dark"
                >
                  {t('printPoster')}
                </button>
              </div>
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
        {payUrl && (
          <section className="rounded-2xl border border-slate-200 bg-white p-5 print:fixed print:inset-0 print:z-50 print:flex print:min-h-screen print:flex-col print:items-center print:justify-center print:border-0 print:p-10">
            <div className="mx-auto flex max-w-sm flex-col items-center text-center">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 print:text-base">
                {t('posterEyebrow')}
              </p>
              <h3 className="mt-2 text-2xl font-bold text-slate-900 print:text-5xl">
                {settings.storeName.trim() || t('posterDefaultStoreName')}
              </h3>
              <p className="mt-2 text-sm text-slate-500 print:text-xl">
                {mode === 'amount'
                  ? t('posterFixedAmount', {
                      amount,
                      symbol: deployment.displaySymbol,
                    })
                  : t('posterOpenAmount', {
                      symbol: deployment.displaySymbol,
                    })}
              </p>
              <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-4 print:mt-10 print:p-8">
                <QRCodeSVG value={payUrl} size={260} includeMargin level="M" />
              </div>
              <p className="mt-4 text-sm font-medium text-slate-700 print:text-xl">
                {settings.posterNote.trim() || t('posterDefaultNote')}
              </p>
              <p className="mt-3 font-mono text-xs text-slate-500 print:text-base">
                {deployment.displaySymbol} · {chain.name}
              </p>
              <p className="mt-1 break-all font-mono text-[10px] text-slate-400 print:max-w-2xl print:text-sm">
                {effectiveReceiver ? shortAddress(effectiveReceiver) : ''}
              </p>
            </div>
          </section>
        )}
        {!settings.directTransfer && (
          <div className="rounded-lg bg-slate-50 px-4 py-3 text-xs text-slate-600 print:hidden">
            <p className="font-semibold text-slate-700">
              {t('feeReceiverHeading')}
            </p>
            <p className="mt-1 break-all font-mono">{env.feeReceiver}</p>
            <p className="mt-2 text-slate-500">
              {t(
                settings.token === 'jpyc'
                  ? 'feeReceiverHintJpyc'
                  : 'feeReceiverHintUsdc',
              )}
            </p>
          </div>
        )}
        {eip681Uri && (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-slate-300 bg-white p-4 print:hidden">
            <h3 className="self-start text-sm font-semibold text-slate-800">
              {t('eip681Title')}
            </h3>
            <p className="self-start text-xs text-slate-500">
              {t('eip681Description')}
            </p>
            <QRCodeSVG value={eip681Uri} size={180} includeMargin level="M" />
            <div className="w-full break-all rounded-lg bg-slate-50 px-3 py-2 font-mono text-[11px] text-slate-600">
              {eip681Uri}
            </div>
            <button
              type="button"
              onClick={() => eip681Copy(eip681Uri)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-brand hover:text-brand-dark"
            >
              {eip681Copied ? t('eip681Copied') : t('eip681Copy')}
            </button>
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
  chain,
  receiver,
  gasMode,
  direct,
}: {
  token: TokenSymbol;
  chain: ChainSlug;
  receiver: string;
  gasMode: GasMode;
  direct: boolean;
}) {
  const tokenLabel = defaultDeploymentForSymbol(token).displaySymbol;
  const chainLabel = chainForSlug(chain).name;
  const recvLabel = isAddress(receiver) ? shortAddress(receiver) : '—';
  // direct: 運営手数料 0% / customer: 顧客が gas / merchant: 店主が gas
  const tail = direct ? '0%' : gasMode === 'customer' ? 'gas:cust' : 'gas:merch';
  return (
    <span className="font-mono">
      {tokenLabel} · {chainLabel} · {recvLabel} · {tail}
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
