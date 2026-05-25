'use client';

import { useCallback, useMemo, useState } from 'react';
// `Image` は global の HTMLImageElement constructor と name 衝突する典型 pitfall
// (QrGenerator.tsx で同じ衝突あり) なので、next/image は NextImage 別名で輸入する。
import NextImage from 'next/image';
import { useTranslations } from 'next-intl';
import { type Address } from 'viem';
import { AddressInput } from './AddressInput';
import { Field } from './Field';
import { useTipSettings } from '@/hooks/useTipSettings';
import { useOrigin } from '@/hooks/useOrigin';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import {
  DEFAULT_CHAIN_FOR_SYMBOL,
  defaultDeploymentForSymbol,
  deploymentForSlug,
  isGaslessSupported,
  type TokenSymbol,
} from '@/lib/tokens';
import {
  chainForSlug,
  JPYC_CHAINS,
  USDC_CHAINS,
  type ChainSlug,
} from '@/lib/chains';
import { isLikelyName } from '@/lib/nameDetection';
import { pickEffectiveAddress } from '@/lib/format';
import {
  buildTipUrl,
  COLOR_PATTERN,
  DECIMAL_PATTERN,
  DEFAULT_TIP_PRESETS,
  type TipParams,
} from '@/lib/url';

const IFRAME_WIDTH = 380;
const IFRAME_HEIGHT = 640;

// Tip widget は gasless 固定なので、受信可能な chain は gasless 対応のものだけ。
// USDC は全 mainnet chain (Ethereum L1 含む) で ERC20 paymaster 対応、JPYC は
// Polygon / Kaia 2 chain。token chooser hint の count 表示と chain chooser の grid
// 描画で共用する。chain 集合は build 時に確定するため module-level で 1 度だけ計算する。
const RECEIVABLE_USDC_CHAINS = USDC_CHAINS.filter((slug) =>
  isGaslessSupported(deploymentForSlug('usdc', slug)),
);
const RECEIVABLE_JPYC_CHAINS = JPYC_CHAINS.filter((slug) =>
  isGaslessSupported(deploymentForSlug('jpyc', slug)),
);

export function TipEmbedGenerator() {
  const { settings, setSettings, hydrated } = useTipSettings();
  const origin = useOrigin();
  const urlCopy = useCopyToClipboard();
  const iframeCopy = useCopyToClipboard();
  const [resolvedReceiver, setResolvedReceiver] = useState<Address | null>(null);
  const t = useTranslations('TipEmbedGenerator');
  const tHeader = useTranslations('TipForm');

  const effectiveReceiver = useMemo(
    () => pickEffectiveAddress(settings.receiver, resolvedReceiver),
    [settings.receiver, resolvedReceiver],
  );

  const colorValid = COLOR_PATTERN.test(settings.color);
  const presetsParsed = useMemo(() => {
    const seen = new Set<string>();
    return settings.presets
      .split(',')
      .map((s) => s.trim())
      .filter((s) => {
        if (s.length === 0 || !DECIMAL_PATTERN.test(s) || Number(s) <= 0) {
          return false;
        }
        if (seen.has(s)) return false;
        seen.add(s);
        return true;
      })
      .slice(0, 6);
  }, [settings.presets]);

  const previewPresets =
    presetsParsed.length > 0
      ? presetsParsed
      : DEFAULT_TIP_PRESETS[settings.token];

  const tipUrl = useMemo(() => {
    if (!hydrated || !effectiveReceiver || !origin) return '';
    const params: TipParams = {
      to: effectiveReceiver,
      token: settings.token,
      chain: settings.chain,
      name: settings.name || undefined,
      message: settings.message || undefined,
      color: colorValid ? settings.color : undefined,
      presets: presetsParsed.length > 0 ? presetsParsed : undefined,
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
    presetsParsed,
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

  const deployment = deploymentForSlug(settings.token, settings.chain);
  const defaultPresetsList = DEFAULT_TIP_PRESETS[settings.token].join(', ');
  const defaultPresetsCsv = DEFAULT_TIP_PRESETS[settings.token].join(',');

  return (
    // R: grid item の min-width:auto 既定が長い 0x / tip URL で track を押し広げ
    //    mobile で overflow するため、両子に min-w-0 で shrink を許可する。
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="min-w-0 space-y-4">
        <Field label={t('receiverLabel')}>
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
              // chain 一覧 hint (例: "2 chain で受信 (Polygon / Kaia)") は下の
              // 受取 chain chooser で同情報が見えるので削除 (2026-05-24)。
              // 公式ロゴ (public/tokens/{jpyc,usdc}.svg) + symbol テキストの
              // 2 要素に絞って QR (店舗) と一貫した design に統一。
              return (
                <button
                  key={tok}
                  type="button"
                  onClick={() => selectToken(tok)}
                  className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-semibold transition ${
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

        <Field
          label={t('chainLabel', { symbol: deployment.displaySymbol })}
        >
          {/* USDC は最大 4 chain で sm 4 列、JPYC は 2 chain で 2 列固定。
              2026-05-24: 公式 logo (public/chains/{slug}.svg) を chain 名横に
              配置し QR 側と一貫した design に揃える。logo は aria-hidden、
              accessible name は viem Chain.name のみ。 */}
          <div
            className={
              settings.token === 'usdc'
                ? 'grid grid-cols-2 gap-2 sm:grid-cols-4'
                : 'grid grid-cols-2 gap-2'
            }
          >
            {(settings.token === 'usdc'
              ? RECEIVABLE_USDC_CHAINS
              : RECEIVABLE_JPYC_CHAINS
            ).map((slug) => {
              const c = chainForSlug(slug);
              const active = settings.chain === slug;
              return (
                <button
                  key={slug}
                  type="button"
                  onClick={() => selectChain(slug)}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition ${
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
                    <div className="text-[10px] text-slate-500">id: {c.id}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </Field>

        {/* Cross-chain 受信許可 toggle (USDC のみ意味あり、JPYC では非表示)。
            Default ON。OFF にすると TipForm が代替経路 hint を出さず、creator が
            指定した chain での同一 chain 送金のみ受け付ける (creator 都合の opt-out)。 */}
        {settings.token === 'usdc' && (
          <Field label={t('crossChainHeading')}>
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={settings.crossChain}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, crossChain: e.target.checked }))
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
              value={colorValid ? settings.color : '#2563eb'}
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
              placeholder="#2563eb"
              className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm focus:border-brand focus:outline-none"
            />
          </div>
          {settings.color && !colorValid && (
            <p className="mt-1 text-xs text-red-600">{t('colorInvalid')}</p>
          )}
        </Field>

        <Field
          label={t('presetsLabel', { defaults: defaultPresetsList })}
        >
          <input
            type="text"
            value={settings.presets}
            onChange={(e) =>
              setSettings((s) => ({ ...s, presets: e.target.value }))
            }
            placeholder={t('presetsPlaceholder', { defaults: defaultPresetsCsv })}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm focus:border-brand focus:outline-none"
          />
          {settings.presets && presetsParsed.length === 0 && (
            <p className="mt-1 text-xs text-amber-600">{t('presetsInvalid')}</p>
          )}
          {presetsParsed.length > 0 && (
            <p className="mt-1 text-xs text-slate-500">
              {t('presetsActive', {
                values: presetsParsed.join(', '),
                symbol: deployment.displaySymbol,
              })}
            </p>
          )}
        </Field>

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

      <div className="min-w-0 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-700">
            {t('previewTitle')}
          </h3>
          <div
            className="mt-2 rounded-2xl p-4 text-white shadow-sm"
            style={{ backgroundColor: colorValid ? settings.color : '#2563eb' }}
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
              {previewPresets.map((p) => (
                <span
                  key={p}
                  className="rounded-md bg-white/20 px-2 py-1 text-xs font-mono"
                >
                  {p} {deployment.displaySymbol}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              {t('tipUrlTitle')}
            </h3>
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

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              {t('iframeTitle')}
            </h3>
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
      </div>
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
