'use client';

import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { type Address } from 'viem';
import {
  ChevronDown,
  Code2,
  Share2,
  Sparkles,
  Wallet,
} from 'lucide-react';
import { ReceiverBlock } from './ReceiverBlock';
import { Field } from './Field';
import { StepCard } from './StepCard';
import { useTipSettings } from '@/hooks/useTipSettings';
import {
  useReceiverAutofill,
  type ReceiverSource,
} from '@/hooks/useReceiverAutofill';
import { useOrigin } from '@/hooks/useOrigin';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import {
  DEFAULT_CHAIN_FOR_SYMBOL,
  deploymentForSlug,
  isGaslessSupported,
  type TokenSymbol,
} from '@/lib/tokens';
import {
  JPYC_CHAINS,
  USDC_CHAINS,
  type ChainSlug,
} from '@/lib/chains';
import { isLikelyName } from '@/lib/nameDetection';
import { pickEffectiveAddress } from '@/lib/format';
import { normalizeAmountList, truncateAmount } from '@/lib/amount';
import {
  buildTipUrl,
  COLOR_PATTERN,
  DEFAULT_TIP_PRESETS,
  TIP_PRESET_MAX,
  type TipParams,
} from '@/lib/url';

const IFRAME_WIDTH = 380;
const IFRAME_HEIGHT = 640;
// color 入力が不正 (COLOR_PATTERN 不一致) のときのプレビュー/プレースホルダ既定色。
const DEFAULT_PREVIEW_COLOR = '#2563eb';

// Tip widget は gasless 固定なので、受信可能な chain は gasless 対応のものだけ。
// USDC は全 mainnet chain (Ethereum L1 含む) で ERC20 paymaster 対応、JPYC は
// Polygon / Kaia 2 chain。chain 集合は build 時に確定するため module-level で 1 度計算。
const RECEIVABLE_USDC_CHAINS = USDC_CHAINS.filter((slug) =>
  isGaslessSupported(deploymentForSlug('usdc', slug)),
);
const RECEIVABLE_JPYC_CHAINS = JPYC_CHAINS.filter((slug) =>
  isGaslessSupported(deploymentForSlug('jpyc', slug)),
);

type PublishMode = 'share' | 'embed';

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function TipEmbedGenerator() {
  const { settings, setSettings, hydrated } = useTipSettings();
  const origin = useOrigin();
  const urlCopy = useCopyToClipboard();
  const iframeCopy = useCopyToClipboard();
  const [resolvedReceiver, setResolvedReceiver] = useState<Address | null>(null);
  const [publishMode, setPublishMode] = useState<PublishMode>('share');
  const [devOpen, setDevOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const t = useTranslations('TipEmbedGenerator');
  const tHeader = useTranslations('TipForm');

  const effectiveReceiver = useMemo(
    () => pickEffectiveAddress(settings.receiver, resolvedReceiver),
    [settings.receiver, resolvedReceiver],
  );

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

  const colorValid = COLOR_PATTERN.test(settings.color);
  const deployment = deploymentForSlug(settings.token, settings.chain);

  // 現在 token のプリセットリスト (token ごと独立)。エディタ・適用ともこのリストだけ操作。
  const tokenPresets = settings.presets[settings.token];

  // 表示・URL 生成に使う有効プリセット: decimals に丸め → 0/不正/重複を除外。
  // 空 (全削除 or 全不正) なら token 別 default に fallback。
  const activePresets = useMemo(() => {
    const normalized = normalizeAmountList(tokenPresets, deployment.decimals);
    return normalized.length > 0
      ? normalized
      : DEFAULT_TIP_PRESETS[settings.token];
  }, [tokenPresets, deployment.decimals, settings.token]);

  // URL の preset は default と値が異なる時のみ送る (default ちょうどなら省略し URL を簡潔に)。
  const presetsForUrl = useMemo(
    () =>
      sameList(activePresets, DEFAULT_TIP_PRESETS[settings.token])
        ? undefined
        : activePresets,
    [activePresets, settings.token],
  );

  const tipUrl = useMemo(() => {
    if (!hydrated || !effectiveReceiver || !origin) return '';
    const params: TipParams = {
      to: effectiveReceiver,
      token: settings.token,
      chain: settings.chain,
      name: settings.name || undefined,
      message: settings.message || undefined,
      color: colorValid ? settings.color : undefined,
      presets: presetsForUrl,
      thanks: settings.thanks || undefined,
      thanksUrl: settings.thanksUrl || undefined,
      webhook: settings.webhook || undefined,
      // crossChain は USDC でのみ意味がある。JPYC では URL 出力時に無視 (false 時の
      // URL bloat 回避)。default true なので false 時のみ URL に乗る。
      crossChain:
        settings.token === 'usdc' ? settings.crossChain : undefined,
    };
    return buildTipUrl(origin, params);
  }, [
    hydrated,
    effectiveReceiver,
    origin,
    settings.token,
    settings.chain,
    settings.name,
    settings.message,
    settings.color,
    colorValid,
    presetsForUrl,
    settings.thanks,
    settings.thanksUrl,
    settings.webhook,
    settings.crossChain,
  ]);

  const handleResolved = useCallback((addr: Address | null) => {
    setResolvedReceiver(addr);
  }, []);

  const iframeSnippet = useMemo(() => {
    if (!tipUrl) return '';
    return `<iframe
  src="${escapeAttr(tipUrl)}"
  width="${IFRAME_WIDTH}"
  height="${IFRAME_HEIGHT}"
  style="border:0;max-width:100%"
  title="OpenPay Tip"
  loading="lazy"
></iframe>`;
  }, [tipUrl]);

  function selectToken(tok: TokenSymbol) {
    setSettings((s) => ({
      ...s,
      token: tok,
      chain: DEFAULT_CHAIN_FOR_SYMBOL[tok],
    }));
  }

  function selectChain(slug: ChainSlug) {
    setSettings((s) => ({ ...s, chain: slug }));
  }

  // プリセット編集は現 token のサブリストだけを操作 (QR レジ金額と同型)。
  function updatePreset(idx: number, value: string) {
    setSettings((s) => ({
      ...s,
      presets: {
        ...s.presets,
        [s.token]: s.presets[s.token].map((p, i) =>
          i === idx ? truncateAmount(value, deployment.decimals) : p,
        ),
      },
    }));
  }

  function addPreset() {
    setSettings((s) => ({
      ...s,
      presets: { ...s.presets, [s.token]: [...s.presets[s.token], ''] },
    }));
  }

  function removePreset(idx: number) {
    setSettings((s) => {
      const next = s.presets[s.token].filter((_, i) => i !== idx);
      return {
        ...s,
        presets: { ...s.presets, [s.token]: next.length > 0 ? next : [''] },
      };
    });
  }

  const defaultPresetsList = DEFAULT_TIP_PRESETS[settings.token].join(', ');

  return (
    <div className="lg:grid lg:grid-cols-[1fr_minmax(300px,360px)] lg:items-start lg:gap-6">
      {/* 左カラム: 入力 (Step 1 受取先 / Step 2 カスタマイズ) */}
      <div className="min-w-0 space-y-5">
        <StepCard step={1} icon={Wallet} title={t('step1Title')}>
          <div className="space-y-4">
            <ReceiverBlock
              receiver={settings.receiver}
              onReceiverChange={autofill.handleManualChange}
              onResolved={handleResolved}
              showAddressInvalid={
                !!settings.receiver &&
                !effectiveReceiver &&
                !isLikelyName(settings.receiver)
              }
              wallet={{
                canUse: autofill.canUseConnected,
                matches: autofill.matchesConnected,
                onUse: autofill.useConnectedWallet,
              }}
              token={settings.token}
              chain={settings.chain}
              availableChains={
                settings.token === 'usdc'
                  ? RECEIVABLE_USDC_CHAINS
                  : RECEIVABLE_JPYC_CHAINS
              }
              onTokenChange={selectToken}
              onChainChange={selectChain}
              mode="editable"
              chainGridClassName={
                settings.token === 'usdc'
                  ? 'grid grid-cols-2 gap-2 sm:grid-cols-3'
                  : 'grid grid-cols-2 gap-2'
              }
              labels={{
                receiver: t('receiverLabel'),
                currency: t('tokenLabel'),
                chain: t('chainLabel', { symbol: deployment.displaySymbol }),
                useConnectedWallet: t('useConnectedWallet'),
                receiverMatchesWallet: t('receiverMatchesWallet'),
                addressInvalid: t('addressInvalid'),
              }}
            />
          </div>
        </StepCard>

        <StepCard step={2} icon={Sparkles} title={t('step2Title')}>
          <div className="space-y-4">
            <Field label={t('nameLabel')}>
              <input
                type="text"
                value={settings.name}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, name: e.target.value }))
                }
                placeholder={t('namePlaceholder')}
                maxLength={60}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none"
              />
            </Field>

            <Field label={t('messageLabel')}>
              <textarea
                value={settings.message}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, message: e.target.value }))
                }
                placeholder={t('messagePlaceholder')}
                maxLength={200}
                rows={2}
                className="w-full resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none"
              />
              <p className="mt-1 text-xs text-slate-400">
                {t('messageCounter', { count: settings.message.length })}
              </p>
            </Field>

            <Field label={t('colorLabel')}>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={colorValid ? settings.color : DEFAULT_PREVIEW_COLOR}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, color: e.target.value }))
                  }
                  className="h-10 w-14 cursor-pointer rounded-md border border-slate-200 bg-white p-0.5"
                />
                <input
                  type="text"
                  value={settings.color}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, color: e.target.value }))
                  }
                  placeholder={DEFAULT_PREVIEW_COLOR}
                  className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm focus:border-brand focus:outline-none"
                />
              </div>
              {settings.color && !colorValid && (
                <p className="mt-1 text-xs text-red-600">{t('colorInvalid')}</p>
              )}
            </Field>

            {/* チップ金額プリセット: token ごと独立のボタン編集 UI */}
            <Field label={t('presetsLabel')}>
              <div className="space-y-2">
                {tokenPresets.map((p, i) => (
                  <div key={i} className="flex gap-2">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={p}
                      onChange={(e) => updatePreset(i, e.target.value)}
                      placeholder={t('presetAmountPlaceholder')}
                      className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none"
                    />
                    <span className="flex items-center px-1 text-xs text-slate-400">
                      {deployment.displaySymbol}
                    </span>
                    <button
                      type="button"
                      onClick={() => removePreset(i)}
                      aria-label={t('presetRemoveLabel', { n: i + 1 })}
                      className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-500 hover:border-red-300 hover:text-red-600"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              {tokenPresets.length < TIP_PRESET_MAX && (
                <button
                  type="button"
                  onClick={addPreset}
                  className="mt-2 rounded-md border border-dashed border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:border-brand hover:text-brand-dark"
                >
                  {t('presetAddButton')}
                </button>
              )}
              <p className="mt-1.5 text-xs text-slate-400">
                {t('presetsHint', { defaults: defaultPresetsList })}
              </p>
            </Field>
          </div>
        </StepCard>

        {/* ▸ 高度な設定 (任意): チップは設計上常にガスレス固定 (読み取り表示) +
            crossChain (USDC のみ)。3 モードの IA を揃えるため折りたたみで集約。 */}
        <div className="rounded-2xl border border-slate-200 bg-white">
          <button
            type="button"
            onClick={() => setAdvancedOpen((o) => !o)}
            aria-expanded={advancedOpen}
            className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm font-medium text-slate-700"
          >
            <span>{t('advancedTitle')}</span>
            <ChevronDown
              className={`h-4 w-4 flex-none text-slate-400 transition-transform ${
                advancedOpen ? 'rotate-180' : ''
              }`}
              aria-hidden
            />
          </button>
          {advancedOpen && (
            <div className="space-y-4 border-t border-slate-200 px-4 py-4">
            {/* 決済方法 (読み取り): チップは常にガスレス固定 (ファンはガス代不要)。 */}
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                {t('paymentMethodLabel')}
              </p>
              <p className="mt-1 text-sm text-slate-700">
                {t('paymentMethodGasless')}
              </p>
            </div>

            {/* Cross-chain 受信許可 toggle (USDC のみ意味あり)。Default ON。OFF で
                creator が指定 chain での同一 chain 送金のみ受け付ける。 */}
            {settings.token === 'usdc' && (
              <Field label={t('crossChainHeading')}>
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
              </Field>
            )}
            </div>
          )}
        </div>
      </div>

      {/* 右カラム: プレビュー (主役) + 公開 + 開発者向け設定。desktop は sticky。 */}
      <aside className="mt-6 min-w-0 space-y-4 self-start lg:mt-0 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
        {/* プレビュー hero */}
        <div className="rounded-2xl border border-brand/30 bg-white p-4 shadow-sm ring-1 ring-brand/10">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            {t('previewTitle')}
          </h3>
          <div
            className="rounded-2xl p-4 text-white shadow-sm"
            style={{ backgroundColor: colorValid ? settings.color : DEFAULT_PREVIEW_COLOR }}
          >
            <p className="text-xs uppercase tracking-wider opacity-80">
              {tHeader('header')}
            </p>
            <p className="mt-2 text-lg font-bold">
              {settings.name
                ? tHeader('headerNamed', { name: settings.name })
                : tHeader('headerGeneric')}
            </p>
            {settings.message && (
              <p className="mt-2 whitespace-pre-wrap text-sm opacity-90">
                {settings.message}
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-1.5">
              {activePresets.map((p) => (
                <span
                  key={p}
                  className="rounded-md bg-white/20 px-2 py-1 font-mono text-xs"
                >
                  {p} {deployment.displaySymbol}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Step 3 公開する: リンク共有 / サイト埋め込み の 2 択 */}
        <StepCard step={3} icon={Share2} title={t('step3Title')}>
          <div
            className="mb-3 inline-flex rounded-lg border border-slate-200 bg-slate-100 p-1"
            role="tablist"
          >
            {(
              [
                ['share', t('publishShareTab')],
                ['embed', t('publishEmbedTab')],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                role="tab"
                aria-selected={publishMode === mode}
                onClick={() => setPublishMode(mode)}
                className={`rounded-md px-3 py-1 text-xs font-semibold transition ${
                  publishMode === mode
                    ? 'bg-white text-brand-dark shadow-sm'
                    : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {publishMode === 'share' ? (
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {t('tipUrlTitle')}
                </h4>
                <button
                  type="button"
                  onClick={() => urlCopy.copy(tipUrl)}
                  disabled={!tipUrl}
                  className="rounded-md bg-slate-900 px-2.5 py-1 text-xs font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {urlCopy.copied ? t('copied') : t('copy')}
                </button>
              </div>
              <div className="break-all rounded-lg bg-slate-50 px-3 py-2 font-mono text-xs text-slate-600">
                {tipUrl || (
                  <span className="text-slate-400">{t('urlPlaceholder')}</span>
                )}
              </div>
              {tipUrl && (
                <a
                  href={tipUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-block text-xs text-brand hover:underline"
                >
                  {t('openInNewTab')}
                </a>
              )}
            </div>
          ) : (
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {t('iframeTitle')}
                </h4>
                <button
                  type="button"
                  onClick={() => iframeCopy.copy(iframeSnippet)}
                  disabled={!iframeSnippet}
                  className="rounded-md bg-slate-900 px-2.5 py-1 text-xs font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {iframeCopy.copied ? t('copied') : t('copy')}
                </button>
              </div>
              <pre className="overflow-x-auto rounded-lg bg-slate-900 px-3 py-2 font-mono text-xs leading-relaxed text-slate-100">
                <code>
                  {iframeSnippet || (
                    <span className="text-slate-500">
                      {t('snippetPlaceholder')}
                    </span>
                  )}
                </code>
              </pre>
              <p className="mt-2 text-xs text-slate-500">{t('embedHint')}</p>
            </div>
          )}

          <p className="mt-3 text-xs text-slate-400">{t('feeNote')}</p>
        </StepCard>

        {/* 開発者向け設定 (折りたたみ、default 閉): 成功画面 + webhook */}
        <div className="rounded-2xl border border-slate-200 bg-white">
          <button
            type="button"
            onClick={() => setDevOpen((o) => !o)}
            aria-expanded={devOpen}
            className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
          >
            <span className="flex items-center gap-2 text-sm font-semibold text-slate-700">
              <Code2 className="h-4 w-4 text-slate-400" aria-hidden />
              {t('devSettingsToggle')}
            </span>
            <ChevronDown
              className={`h-4 w-4 flex-none text-slate-400 transition-transform ${
                devOpen ? 'rotate-180' : ''
              }`}
              aria-hidden
            />
          </button>
          {devOpen && (
            <div className="space-y-4 border-t border-slate-100 px-4 py-4">
              <Field label={t('thanksLabel')}>
                <textarea
                  value={settings.thanks}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, thanks: e.target.value }))
                  }
                  placeholder={t('thanksPlaceholder')}
                  maxLength={200}
                  rows={2}
                  className="w-full resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none"
                />
                <p className="mt-1 text-xs text-slate-400">
                  {t('messageCounter', { count: settings.thanks.length })}
                </p>
              </Field>

              <Field label={t('thanksUrlLabel')}>
                <input
                  type="text"
                  value={settings.thanksUrl}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, thanksUrl: e.target.value }))
                  }
                  placeholder={t('thanksUrlPlaceholder')}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs focus:border-brand focus:outline-none"
                />
                <p className="mt-1 text-xs text-slate-500">{t('thanksUrlHint')}</p>
              </Field>

              <Field label={t('webhookLabel')}>
                <input
                  type="text"
                  value={settings.webhook}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, webhook: e.target.value }))
                  }
                  placeholder={t('webhookPlaceholder')}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs focus:border-brand focus:outline-none"
                />
                <p className="mt-1 text-xs text-slate-500">
                  {t('webhookHint', {
                    payload: '{ txHash, amount, token, from, message }',
                  })}
                </p>
              </Field>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function escapeAttr(value: string): string {
  // iframe src 属性に埋め込むため、ダブルクォートと < > & を実体参照化。
  // URLSearchParams の出力は既に URL エンコード済みなので、追加の HTML エスケープのみ必要。
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
