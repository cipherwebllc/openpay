'use client';

import { useCallback, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { type Address } from 'viem';
import {
  ChevronDown,
  Code2,
  QrCode,
  Share2,
  Sparkles,
  Wallet,
} from 'lucide-react';
import { LinkQrModal } from './LinkQrModal';
import { ReceiverBlock } from './ReceiverBlock';
import { Field } from './Field';
import { StepCard } from './StepCard';
import { HandleThemePicker } from './HandleThemePicker';
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

const TipFormPreview = dynamic(
  () => import('./TipForm').then((mod) => mod.TipForm),
  { ssr: false },
);

const IFRAME_WIDTH = 380;
const IFRAME_HEIGHT = 640;
// QR を描く tipUrl の上限長。これを超えると qrcode.react が「Data too long」で throw し
// share タブが落ちる (長い webhook/thanksUrl/preset で URL が肥大した場合)。容量に余裕を
// 持たせた閾値で、超過時は QR を省略する (リンク/X シェアは長い URL でも機能する)。
const QR_MAX_URL_LEN = 1200;
// color 入力が不正 (COLOR_PATTERN 不一致) のときのプレビュー/プレースホルダ既定色。
const DEFAULT_PREVIEW_COLOR = '#2563eb';
const PREVIEW_RECEIVER =
  '0x0000000000000000000000000000000000000001' as Address;

// Tip widget は gasless 固定なので、受信可能な chain は gasless 対応のものだけ。
// USDC は全 mainnet chain (Ethereum L1 含む) で ERC20 paymaster 対応、JPYC は
// Polygon / Kaia (+ enableJpycAvalanche=ON で Avalanche)。chain 集合は build 時に確定するため
// module-level で 1 度計算。
const RECEIVABLE_USDC_CHAINS = USDC_CHAINS.filter((slug) =>
  isGaslessSupported(deploymentForSlug('usdc', slug)),
);
const RECEIVABLE_JPYC_CHAINS = JPYC_CHAINS.filter((slug) =>
  isGaslessSupported(deploymentForSlug('jpyc', slug)),
);

type PublishMode = 'share' | 'embed';
type EmbedFormat = 'iframe' | 'button';

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
  const [embedFormat, setEmbedFormat] = useState<EmbedFormat>('iframe');
  const [devOpen, setDevOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const t = useTranslations('TipEmbedGenerator');
  const tProfile = useTranslations('HandleProfile');

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
      theme: settings.theme ?? 'clean',
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
    settings.theme,
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

  // SNS シェア: X (Twitter) の intent。text と url を別々に渡し、X 側で url を unfurl
  // させる (P1 の動的 OG カードが表示される)。tipUrl 未確定なら空。
  const shareText = settings.name
    ? t('shareTextNamed', { name: settings.name })
    : t('shareTextGeneric');
  const xShareUrl = useMemo(() => {
    if (!tipUrl) return '';
    return `https://twitter.com/intent/tweet?text=${encodeURIComponent(
      shareText,
    )}&url=${encodeURIComponent(tipUrl)}`;
  }, [tipUrl, shareText]);

  // ボタン埋め込み: note / Linktree / ブログに貼れる「チップ」ボタン (styled <a>)。
  // ラベル・URL とも HTML へ実体参照化して注入 (escapeAttr は & " < > を変換)。
  const buttonLabel = settings.name
    ? t('buttonLabelNamed', { name: settings.name })
    : t('buttonLabelGeneric');
  const buttonColor = colorValid ? settings.color : DEFAULT_PREVIEW_COLOR;
  const buttonSnippet = useMemo(() => {
    if (!tipUrl) return '';
    return `<a href="${escapeAttr(tipUrl)}" target="_blank" rel="noopener"
  style="display:inline-block;background:${buttonColor};color:#fff;font-weight:700;padding:12px 22px;border-radius:9999px;text-decoration:none;font-family:system-ui,-apple-system,sans-serif">${escapeAttr(buttonLabel)}</a>`;
  }, [tipUrl, buttonColor, buttonLabel]);

  // embed タブで実際に表示/コピーするスニペット (iframe / button の切替)。
  const activeSnippet = embedFormat === 'iframe' ? iframeSnippet : buttonSnippet;

  const previewParams = useMemo<TipParams>(
    () => ({
      to: effectiveReceiver ?? PREVIEW_RECEIVER,
      token: settings.token,
      chain: settings.chain,
      name: settings.name || undefined,
      message: settings.message || undefined,
      color: colorValid ? settings.color : undefined,
      theme: settings.theme ?? 'clean',
      presets: activePresets,
      crossChain:
        settings.token === 'usdc' ? settings.crossChain : undefined,
    }),
    [
      effectiveReceiver,
      settings.token,
      settings.chain,
      settings.name,
      settings.message,
      settings.color,
      settings.theme,
      settings.crossChain,
      colorValid,
      activePresets,
    ],
  );

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
    <div className="grid grid-cols-1 gap-5 lg:grid lg:grid-cols-[1fr_minmax(300px,360px)] lg:items-start lg:gap-6">
      {/* 左カラム: 入力 (Step 1 受取先 / Step 2 カスタマイズ) */}
      <div className="contents min-w-0 lg:block lg:space-y-5 [&>section:first-child]:order-1 [&>section:nth-child(2)]:order-2">
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

            <HandleThemePicker
              accent={colorValid ? settings.color : DEFAULT_PREVIEW_COLOR}
              selected={settings.theme ?? 'clean'}
              onSelect={(theme) =>
                setSettings((current) => ({ ...current, theme }))
              }
              label={tProfile('themeLabel')}
              hint={tProfile('themeHint')}
            />

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

        {/* 高度な設定は変更可能な cross-chain 設定がある USDC でのみ表示する。 */}
        {settings.token === 'usdc' && (
          <div className="order-4 rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70">
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
              <div className="border-t border-slate-200 px-4 py-4">
                {/* Default ON。OFF で creator が指定 chain での同一 chain 送金のみ受け付ける。 */}
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
              </div>
            )}
          </div>
        )}
      </div>

      {/* mobile は contents + order で preview を高度な設定より前へ。desktop は従来の sticky 右カラム。 */}
      <aside className="contents min-w-0 self-start lg:sticky lg:top-4 lg:block lg:max-h-[calc(100vh-2rem)] lg:space-y-4 lg:overflow-y-auto [&>section]:order-5">
        {/* 実 TipForm を MobileOrderBuilder / プロフと同じスマホ枠で描く。 */}
        <div className="order-3 rounded-2xl border border-brand/30 bg-white p-4 shadow-sm ring-1 ring-brand/10">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            {t('previewTitle')}
          </h3>
          <div
            data-testid="tip-preview-frame"
            className="mx-auto max-w-[360px] overflow-hidden rounded-[2rem] border-[6px] border-slate-900 bg-white shadow-xl ring-1 ring-black/5"
          >
            <div
              data-testid="tip-preview-scroll"
              className="max-h-[56vh] overflow-y-auto bg-slate-50 p-3"
            >
              <TipFormPreview
                key={`${settings.token}:${settings.chain}:${activePresets.join(',')}`}
                params={previewParams}
                preview
              />
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
              {tipUrl && (
                <div className="mt-3 space-y-3">
                  {/* X (Twitter) シェア: 貼ると P1 の動的 OG カードが unfurl される。 */}
                  <a
                    href={xShareUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-slate-400"
                  >
                    <Share2 className="h-3.5 w-3.5" aria-hidden />
                    {t('shareXButton')}
                  </a>
                  {/* リンクの QR: 常時表示せずボタン → ポップアップ (プロフの所有一覧と同じ作法)。
                      URL が QR 容量を超える長さだと qrcode.react が throw するため、閾値以下のみ提示。 */}
                  {tipUrl.length <= QR_MAX_URL_LEN && (
                    <div>
                      <button
                        type="button"
                        onClick={() => setQrOpen(true)}
                        className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-slate-400"
                      >
                        <QrCode className="h-3.5 w-3.5" aria-hidden />
                        {t('qrTitle')}
                      </button>
                      <p className="mt-1.5 text-xs text-slate-400">
                        {t('qrHint')}
                      </p>
                      <LinkQrModal
                        open={qrOpen}
                        value={tipUrl}
                        title={t('qrTitle')}
                        closeLabel={t('qrClose')}
                        onClose={() => setQrOpen(false)}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div>
              {/* 形式切替: iframe (全画面ウィジェット) / button (リンク貼付)。default iframe。 */}
              <div
                className="mb-2 inline-flex rounded-lg border border-slate-200 bg-slate-100 p-1"
                role="tablist"
              >
                {(
                  [
                    ['iframe', t('embedIframeTab')],
                    ['button', t('embedButtonTab')],
                  ] as const
                ).map(([fmt, label]) => (
                  <button
                    key={fmt}
                    type="button"
                    role="tab"
                    aria-selected={embedFormat === fmt}
                    onClick={() => setEmbedFormat(fmt)}
                    className={`rounded-md px-3 py-1 text-xs font-semibold transition ${
                      embedFormat === fmt
                        ? 'bg-white text-brand-dark shadow-sm'
                        : 'text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="mb-1.5 flex items-center justify-between">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {embedFormat === 'iframe'
                    ? t('iframeTitle')
                    : t('buttonSnippetTitle')}
                </h4>
                <button
                  type="button"
                  onClick={() => iframeCopy.copy(activeSnippet)}
                  disabled={!activeSnippet}
                  className="rounded-md bg-slate-900 px-2.5 py-1 text-xs font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {iframeCopy.copied ? t('copied') : t('copy')}
                </button>
              </div>
              <pre className="overflow-x-auto rounded-lg bg-slate-900 px-3 py-2 font-mono text-xs leading-relaxed text-slate-100">
                <code>
                  {activeSnippet || (
                    <span className="text-slate-500">
                      {t('snippetPlaceholder')}
                    </span>
                  )}
                </code>
              </pre>
              <p className="mt-2 text-xs text-slate-500">
                {embedFormat === 'iframe'
                  ? t('embedHint')
                  : t('buttonSnippetHint')}
              </p>
            </div>
          )}

          <p className="mt-3 text-xs text-slate-400">{t('feeNote')}</p>
        </StepCard>

        {/* @handle 恒久リンクは「プロフ」タブ (HandleProfileBuilder) へ移設。チップタブは
            単一チップの生成に専念する。 */}

        {/* 開発者向け設定 (折りたたみ、default 閉): 成功画面 + webhook */}
        <div className="order-6 rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70">
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
