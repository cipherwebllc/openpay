'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// `Image` という名前は downloadPng() 内の `new Image()` (window.Image / HTMLImageElement
// constructor) と global scope で衝突するため、next/image は NextImage として別名輸入する。
import NextImage from 'next/image';
import { QRCodeSVG } from 'qrcode.react';
import { useTranslations } from 'next-intl';
import type { Address } from 'viem';
import {
  Coins,
  Fuel,
  Printer,
  QrCode as QrCodeIcon,
  Store,
  Zap,
} from 'lucide-react';
import { AddressInput } from './AddressInput';
import { Field } from './Field';
import { StepCard } from './StepCard';
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
  type SplitDraft,
} from '@/lib/url';
import { buildEip681TransferUri } from '@/lib/eip681';
import {
  DEFAULT_CHAIN_FOR_SYMBOL,
  defaultDeploymentForSymbol,
  deploymentForSlug,
  isGaslessSupported,
  type TokenSymbol,
} from '@/lib/tokens';
import {
  addressExplorerUrl,
  buyerUsdcChainNames,
  chainForSlug,
  JPYC_CHAINS,
  USDC_CHAINS,
  type ChainSlug,
} from '@/lib/chains';
import type { GasMode, PayMode } from '@/lib/fee';
import { env } from '@/lib/env';
import { isLikelyName } from '@/lib/nameDetection';
import { pickEffectiveAddress, shortAddress } from '@/lib/format';
import { triggerDownload } from '@/lib/download';

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
  // 高度な設定 (payMode / gas / split / quickAmount editor) は default 閉じる。
  const [accordionOpen, setAccordionOpen] = useState(false);
  // Step 2 (受取先) の collapsible 状態。受取先は設定後ほぼ変更しないので、有効な
  // address が localStorage に既にある returning user では default 折り畳む。
  // 新規 user (receiver 未設定) には Step 2 を default open で出して入力を促す。
  // useState の初期値は true (open) で SSR と一致させ、hydrate 後 useEffect で
  // effectiveReceiver 由来の真値に切り替える (一度のみ、以降は user が制御)。
  const [step2Open, setStep2Open] = useState(true);
  const [step2Initialized, setStep2Initialized] = useState(false);
  const [resolvedReceiver, setResolvedReceiver] = useState<Address | null>(null);

  const t = useTranslations('QrGenerator');

  const effectiveReceiver = useMemo(
    () => pickEffectiveAddress(settings.receiver, resolvedReceiver),
    [settings.receiver, resolvedReceiver],
  );

  // Step 2 の初期 open 状態を hydrate 後に一度だけ決定する。step2Initialized 後は
  // ユーザの click 操作だけが state を変えるので、receiver を typed して有効化
  // した瞬間に section が勝手に閉じることはない (= 入力フローを中断しない)。
  useEffect(() => {
    if (!hydrated || step2Initialized) return;
    setStep2Open(effectiveReceiver === null);
    setStep2Initialized(true);
  }, [hydrated, effectiveReceiver, step2Initialized]);

  const receiverValid = effectiveReceiver !== null;
  const amountValid =
    mode === 'static' ||
    (mode === 'amount' && DECIMAL_PATTERN.test(amount) && Number(amount) > 0);
  const payMode: PayMode = settings.payMode;
  const isStandard = payMode === 'standard';

  // standard mode では split は無視する (PaymentForm 側でも無視するので URL に
  // 含めると混乱)。それ以外では parseSplitDrafts で検証して、有効な entries
  // のみ URL に含める。
  const splitParsed = useMemo(
    () => parseSplitDrafts(settings.splits, effectiveReceiver),
    [settings.splits, effectiveReceiver],
  );
  const splitsForUrl =
    !isStandard && splitParsed.entries && splitParsed.entries.length > 0
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
      // crossChain は USDC のみ意味あり (JPYC は Gateway / CCTP V2 非対応)。
      // settings に false を持っていても token=jpyc なら URL に出ても無害だが、
      // 旧 QR との互換性を最大化するため token=usdc 時のみ出力する。
      crossChain: settings.token === 'usdc' ? settings.crossChain : undefined,
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
    settings.crossChain,
    mode,
    amount,
    payMode,
    splitsForUrl,
  ]);

  function setSplits(next: SplitDraft[]) {
    setSettings((s) => ({ ...s, splits: next }));
  }
  function addSplit() {
    // UI 側 ({splits.length < MAX && ...}) で button が消えるため通常 unreachable。
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

  // 互換 QR (EIP-681) — standard + amount のときだけ併発行 (gasless / split は
  // EIP-681 で表現不可)。standard でも OpenPay の決済 UI を経由する派生 QR とは
  // 別建てで「純粋な ERC20 transfer」も同時提供する利便性のため (店舗の主動線は
  // OpenPay decentpath、EIP-681 は MetaMask Mobile 等の直接 scan 用 fallback)。
  // amount は sanitizeAmount で常に decimals 内に切り詰められているため、builder は
  // throw しない。
  const eip681Uri = useMemo(() => {
    if (
      !hydrated ||
      !effectiveReceiver ||
      !isStandard ||
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
    isStandard,
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
    // (token, chain) の deployment が gasless 非対応 (例: USDC on Ethereum L1) なら
    // payMode を standard に強制 set。これがないと「gasless 選択中 → Ethereum 選択」
    // 時に URL parser で reject される QR が生成されてしまう。
    const dep = deploymentForSlug(settings.token, slug);
    setSettings((s) => ({
      ...s,
      chain: slug,
      payMode: isGaslessSupported(dep) ? s.payMode : 'standard',
    }));
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
    <div className="grid gap-6 lg:grid-cols-2 print:block print:gap-0">
      <div className="space-y-5 print:hidden">
        <StepCard step={1} icon={Coins} title={t('steps.amount')}>
          <div className="space-y-4">
            {/* token + chain は顧客ごとに変更頻度が高い (JPYC か USDC か、USDC なら
                どの chain か) ため Step 1 に置く。amount のシンボル表示も token に
                依存するので、視覚的にも入力順は token → (chain) → amount が自然。 */}
            <Field label={t('tokenLabel')}>
              <div className="grid grid-cols-2 gap-2">
                {(['jpyc', 'usdc'] as TokenSymbol[]).map((tok) => {
                  const info = defaultDeploymentForSymbol(tok);
                  const active = settings.token === tok;
                  // chain 一覧 hint (例: "2 chain 対応 (Polygon / Kaia)") は下の
                  // 受取 chain chooser で同情報が見えるので削除 (2026-05-24)。
                  // 公式ロゴ (public/tokens/{jpyc,usdc}.svg) + symbol テキストの
                  // 2 要素に絞って視覚密度を下げる。
                  return (
                    <button
                      key={tok}
                      type="button"
                      onClick={() => selectToken(tok)}
                      className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-3 text-sm font-semibold transition ${
                        active
                          ? 'border-brand bg-brand/5 text-brand-dark'
                          : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                      }`}
                    >
                      <NextImage
                        src={`/tokens/${tok}.svg`}
                        alt=""
                        width={24}
                        height={24}
                        className="h-6 w-6 shrink-0"
                        aria-hidden
                      />
                      <span>{info.displaySymbol}</span>
                    </button>
                  );
                })}
              </div>
            </Field>

            {/* chain chooser: token=usdc は USDC_CHAINS (5 chain — phase 4a で
                Ethereum L1 追加)、token=jpyc は JPYC_CHAINS (polygon + kaia の 2
                chain)。両者で chain object の取得経路 (chainForSlug) と active 判定
                (settings.chain) は共通。grid 列数だけ token に応じて切替 (USDC は
                mobile 2 列 / sm 5 列、JPYC は常に 2 列で十分)。
                2026-05-24: 公式 logo (public/chains/{slug}.svg) を chain 名横に
                並べ、視覚的識別性を上げる。logo は aria-hidden で a11y tree から除外、
                accessible name は viem Chain.name (例: "Base Sepolia")。 */}
            <Field label={t('chainLabel')}>
              <div
                className={
                  settings.token === 'usdc'
                    ? 'grid grid-cols-2 gap-2 sm:grid-cols-5'
                    : 'grid grid-cols-2 gap-2'
                }
              >
                {(settings.token === 'usdc' ? USDC_CHAINS : JPYC_CHAINS).map(
                  (slug) => {
                    const c = chainForSlug(slug);
                    const active = settings.chain === slug;
                    return (
                      <button
                        key={slug}
                        type="button"
                        onClick={() => selectChain(slug)}
                        className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-left text-sm transition ${
                          active
                            ? 'border-brand bg-brand/5 text-brand-dark'
                            : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                        }`}
                      >
                        <NextImage
                          src={`/chains/${slug}.svg`}
                          alt=""
                          width={20}
                          height={20}
                          className="h-5 w-5 shrink-0"
                          aria-hidden
                        />
                        <div className="min-w-0">
                          <div className="truncate font-semibold">{c.name}</div>
                          <div className="text-xs text-slate-500">
                            chain id: {c.id}
                          </div>
                        </div>
                      </button>
                    );
                  },
                )}
              </div>
            </Field>

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
          </div>
        </StepCard>

        <StepCard
          step={2}
          icon={Store}
          title={t('steps.receiver')}
          collapsible
          open={step2Open}
          onToggle={() => setStep2Open((o) => !o)}
          collapsedSummary={
            <Step2Summary
              storeName={settings.storeName}
              receiver={effectiveReceiver}
              fallback={t('steps.receiverNotSet')}
            />
          }
        >
          <div className="space-y-4">
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
              {/* 受取先確定後に Explorer の /address/ ページへ link。店主に「DB ではなく
                  チェーン上が source of truth」を毎回視認させ、Phase 2 (ローカル履歴) 投入
                  後も Explorer が一次資料である運用を維持する。 */}
              {effectiveReceiver && (
                <a
                  href={addressExplorerUrl(deployment.chainId, effectiveReceiver)}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-2 inline-flex text-xs text-brand underline underline-offset-2 hover:opacity-80"
                >
                  {t('merchantExplorerLink', { chainName: chain.name })}
                </a>
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

            <SettingsAccordion
              open={accordionOpen}
              onToggle={() => setAccordionOpen((o) => !o)}
              summaryLabel={t('advancedSettings')}
              summary={
                <SettingsSummary gasMode={settings.gasMode} payMode={payMode} />
              }
            >
              <Field label={t('payModeLabel')}>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {(['gasless', 'standard'] as PayMode[]).map((pm) => {
                    const active = settings.payMode === pm;
                    const isGasless = pm === 'gasless';
                    const ModeIcon = isGasless ? Zap : Fuel;
                    const iconColor = isGasless ? 'text-emerald-600' : 'text-amber-600';
                    // gasless 非対応 chain (例: USDC on Ethereum L1) では gasless
                    // button を disable。click は selectChain 側で防御済だが、UI
                    // 上でも明示的に grey-out して standard 強制を視覚化する。
                    const disabled = isGasless && !isGaslessSupported(deployment);
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
                        <div className="flex items-center gap-2 font-semibold">
                          <ModeIcon
                            className={`h-4 w-4 flex-none ${iconColor}`}
                            aria-hidden
                          />
                          <span>
                            {isGasless
                              ? t('payModeGaslessTitle')
                              : t('payModeStandardTitle')}
                          </span>
                          {isGasless && (
                            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                              {t('payModeGaslessBadge')}
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 text-xs text-slate-500">
                          {isGasless
                            ? t('payModeGaslessDesc')
                            : t('payModeStandardDesc')}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </Field>

              {isStandard ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-800">
                  {t('standardHint')}
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

              {!isStandard && (
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
              </AdvancedSection>

              {/* Cross-chain 受信許可 toggle (USDC のみ意味あり、JPYC では disable)。
                  Default ON。Off にすると PaymentForm が代替経路 hint を出さない
                  (店主が「同一 chain で受け取りたい」と明示する用途)。 */}
              {settings.token === 'usdc' && (
                <AdvancedSection label={t('crossChainHeading')}>
                  <label className="flex cursor-pointer items-start gap-3">
                    <input
                      type="checkbox"
                      checked={settings.crossChain}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          crossChain: e.target.checked,
                        }))
                      }
                      className="mt-0.5 h-4 w-4 rounded border-slate-300"
                    />
                    <span className="text-xs">
                      <span className="font-semibold text-slate-700">
                        {t('crossChainToggleLabel')}
                      </span>
                      <span className="block text-slate-500">
                        {t('crossChainToggleDescription')}
                      </span>
                    </span>
                  </label>
                </AdvancedSection>
              )}

              {/* 手数料徴収先アドレス: 長い 0x... を常時露出すると一般 user に
                  不安を与えるため、高度な設定 accordion 内 (default 閉) に移動。
                  透明性 (誰が手数料を受け取るか可視) は維持しつつ初見ノイズを下げる。 */}
              <AdvancedSection label={t('feeReceiverHeading')}>
                <p className="break-all font-mono text-xs text-slate-700">
                  {env.feeReceiver}
                </p>
                <p className="mt-2 text-xs text-slate-500">
                  {isStandard
                    ? t('feeReceiverHintStandard')
                    : t(
                        settings.token === 'jpyc'
                          ? 'feeReceiverHintJpyc'
                          : 'feeReceiverHintUsdc',
                      )}
                </p>
              </AdvancedSection>
            </SettingsAccordion>
          </div>
        </StepCard>
      </div>

      <div className="space-y-4 print:space-y-0">
        <StepCard
          step={3}
          icon={QrCodeIcon}
          title={t('steps.qr')}
          variant="qr-prominent"
        >
          <p className="-mt-2 mb-3 text-xs text-slate-500 print:hidden">
            {t('qrDescription')}
          </p>
          <div className="flex flex-col items-center gap-4 print:hidden">
            {payUrl ? (
              <>
                <div ref={qrRef}>
                  <QRCodeSVG value={payUrl} size={240} includeMargin level="M" />
                </div>
                <div className="w-full break-all rounded-lg bg-slate-50 px-3 py-2 font-mono text-xs text-slate-600">
                  {payUrl}
                </div>
                {/* Print は店舗向けの primary CTA (review #2 + #8 への対応)。
                    Copy / SVG / PNG は secondary 扱いで outline。 */}
                <div className="flex flex-wrap justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => window.print()}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark"
                  >
                    <Printer className="h-4 w-4" aria-hidden />
                    {t('printPoster')}
                  </button>
                  <button
                    type="button"
                    onClick={() => copy(payUrl)}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:border-brand hover:text-brand-dark"
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
                </div>
              </>
            ) : receiverValid && amountValid ? (
              // receiver + amount valid だが payUrl 未確定の遷移状態 (origin 空 = SSR / hydrate
              // 直後の数フレーム間)。「生成中」を出すことで「checkbox 全部 ✓ なのに QR が出ない」
              // 不整合の混乱を回避する。
              <p className="rounded-lg bg-slate-50 px-4 py-6 text-sm text-slate-400">
                {t('qrPlaceholderGenerating')}
              </p>
            ) : (
              <QrEmptyState
                title={t('qrEmptyState.title')}
                needLabel={t('qrEmptyState.needLabel')}
                items={[
                  {
                    label: t('qrEmptyState.needAddress'),
                    done: receiverValid,
                  },
                  {
                    label: t('qrEmptyState.needAmount'),
                    done: amountValid,
                  },
                ]}
              />
            )}
          </div>
        </StepCard>
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
              {/* 高度な設定を閉じたままだと creator は USDC+Ethereum 選択時に
                  payMode が standard 強制された事実に気付けない。pay mode badge を
                  poster に常時出すことで: (a) creator が screen preview で違和感に
                  気付ける、(b) 印刷物を見た顧客が「自分で gas 必要か」事前判断可能。
                  色: gasless=emerald (安心)、standard=amber (要 ETH/POL の注意喚起)。 */}
              <p
                className={`mt-3 inline-block rounded-full border px-3 py-1 text-xs font-semibold print:px-4 print:py-1.5 print:text-base ${
                  payMode === 'gasless'
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : 'border-amber-200 bg-amber-50 text-amber-700'
                }`}
              >
                {payMode === 'gasless'
                  ? t('posterPayModeGasless')
                  : t('posterPayModeStandard', {
                      nativeToken: chain.nativeCurrency.symbol,
                    })}
              </p>
              <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-4 print:mt-10 print:p-8">
                <QRCodeSVG value={payUrl} size={260} includeMargin level="M" />
              </div>
              <p className="mt-4 text-sm font-medium text-slate-700 print:text-xl">
                {settings.posterNote.trim() || t('posterDefaultNote')}
              </p>
              {/* 受信 chain の表示。crossChain ON + USDC では、buyer 視点で「どの
                  chain の USDC でも払える」ことを示すため対応 7 chain (merchant 5
                  + buyer-only Avalanche/Unichain) を全列挙する (poster はお客向け
                  = 顧客が「自分の chain で払えるか」確認するための情報)。phase
                  4b-1 で buyer source が 5 → 7 chain に拡張、表示も追従。
                  crossChain OFF or JPYC では従来通り単一 chain (target chain) を表示。 */}
              <p className="mt-3 font-mono text-xs text-slate-500 print:text-base">
                {deployment.displaySymbol} ·{' '}
                {settings.token === 'usdc' && settings.crossChain
                  ? buyerUsdcChainNames().join(' / ')
                  : chain.name}
              </p>
              <p className="mt-1 break-all font-mono text-[10px] text-slate-400 print:max-w-2xl print:text-sm">
                {effectiveReceiver ? shortAddress(effectiveReceiver) : ''}
              </p>
            </div>
          </section>
        )}
        {eip681Uri && (
          // EIP-681 互換 QR は default 閉 (上の OpenPay QR + poster QR で 2 つ
          // 既に並ぶため視覚的ノイズを減らす)。Hashport / MetaMask Mobile 等の
          // EIP-7702 非対応 wallet を救済する fallback として必要な人が summary
          // クリックで開く動線。
          <details className="rounded-2xl border border-dashed border-slate-300 bg-white print:hidden">
            <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-slate-800 marker:hidden">
              <span className="flex items-center gap-2">
                <span>{t('eip681Title')}</span>
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
                  {t('eip681SummaryBadge')}
                </span>
              </span>
              <span className="text-slate-400" aria-hidden>
                ▼
              </span>
            </summary>
            <div className="flex flex-col items-center gap-3 border-t border-dashed border-slate-200 px-4 py-4">
              <p className="self-start text-xs text-slate-500">
                {t('eip681Description')}
              </p>
              {/* 店主向け fee bypass 警告: EIP-681 QR は OpenPay の checkout を経由しない
                   純粋 ERC20 transfer のため OpenPay 利用手数料が徴収されない。 */}
              <div className="w-full self-stretch rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900">
                <p className="font-semibold">{t('eip681FeeBypassTitle')}</p>
                <p className="mt-0.5">{t('eip681FeeBypassBody')}</p>
              </div>
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
          </details>
        )}
      </div>
    </div>
  );
}

// Step 2 collapsed 時の summary。store name (任意) + short address を 1 行で示し、
// 店主が「受取先は設定済みだが今は触らなくて良い」と一目で判断できるようにする。
// receiver 未設定の場合は fallback ("受取先未設定") を出す (Step 2 default open で
// あまり当たらないが、user が手動で閉じた + receiver clear した時の保険)。
function Step2Summary({
  storeName,
  receiver,
  fallback,
}: {
  storeName: string;
  receiver: Address | null;
  fallback: string;
}) {
  if (!receiver) return <span>{fallback}</span>;
  const addr = shortAddress(receiver);
  const name = storeName.trim();
  return <span className="font-mono">{name ? `${name} · ${addr}` : addr}</span>;
}

// 必要な項目を checkmark 付きで明示する empty state。初見店主が「何を
// 入れれば QR が出るか」を一目で理解できるようにする (review #2 + #8)。
function QrEmptyState({
  title,
  needLabel,
  items,
}: {
  title: string;
  needLabel: string;
  items: { label: string; done: boolean }[];
}) {
  return (
    <div className="flex w-full max-w-xs flex-col items-center gap-3 rounded-lg bg-slate-50 px-4 py-6 text-center">
      <p className="text-sm font-medium text-slate-700">{title}</p>
      <div className="w-full">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          {needLabel}
        </p>
        <ul className="space-y-1.5 text-left">
          {items.map((item) => (
            <li
              key={item.label}
              className="flex items-center gap-2 text-sm"
            >
              <span
                aria-hidden
                className={`inline-flex h-4 w-4 flex-none items-center justify-center rounded-full text-[10px] font-bold ${
                  item.done
                    ? 'bg-emerald-500 text-white'
                    : 'border border-slate-300 bg-white text-slate-400'
                }`}
              >
                {item.done ? '✓' : ''}
              </span>
              <span className={item.done ? 'text-slate-500 line-through' : 'text-slate-700'}>
                {item.label}
              </span>
            </li>
          ))}
        </ul>
      </div>
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
  gasMode,
  payMode,
}: {
  gasMode: GasMode;
  payMode: PayMode;
}) {
  // 高度な設定 accordion 内には payMode / gas / split / quickAmount editor / 手数料
  // 徴収先 のみ。summary では payMode (+ gasless 時のみ gas 負担者) を日本語/英語の
  // 自然文で表示する。token / chain は Step 1、receiver は Step 2 summary に出るので
  // ここでは重複させない。font-mono は外し、開発者向け内部値に見えないようにする。
  const t = useTranslations('QrGenerator');
  const label =
    payMode === 'standard'
      ? t('advancedSummary.standard')
      : gasMode === 'customer'
        ? t('advancedSummary.gaslessCustomerGas')
        : t('advancedSummary.gaslessMerchantGas');
  return <span>{label}</span>;
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
