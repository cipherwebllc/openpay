'use client';

// チップの受け取りリンク / 埋め込みコードを作るタブ。設定 (useTipSettings)・受取先の解決・UI の状態 (シートの開閉・
// 公開の 2 択・埋め込みの形式・QR・コピー) と、URL / 埋め込みコード / プレビューの params はここが持ち、
// 各節 (components/tip-embed-generator/*) は props で受け取って描画と操作の中継だけを行う。

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { type Address } from 'viem';
import { useResolveAddress } from '@/hooks/useResolveAddress';
import { useTipSettings } from '@/hooks/useTipSettings';
import {
  useReceiverAutofill,
  type ReceiverSource,
} from '@/hooks/useReceiverAutofill';
import { useOrigin } from '@/hooks/useOrigin';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { env } from '@/lib/env';
import { crossChainAllowed } from '@/lib/url/shared';
import {
  DEFAULT_CHAIN_FOR_SYMBOL,
  deploymentForSlug,

  type TokenSymbol,
} from '@/lib/tokens';
import { type ChainSlug } from '@/lib/chains';
import { isLikelyName } from '@/lib/nameDetection';
import { pickEffectiveAddress } from '@/lib/format';
import { normalizeAmountList } from '@/lib/amount';
import {
  buildTipUrl,
  COLOR_PATTERN,
  DEFAULT_TIP_PRESETS,
  formatTipPreset,
  parseTipPreset,
  resolveTipCapability,
  type TipParams,
} from '@/lib/url';
import { CustomizeSection } from './tip-embed-generator/CustomizeSection';
import { PreviewSection } from './tip-embed-generator/PreviewSection';
import { PublishSection } from './tip-embed-generator/PublishSection';
import { ReceiveSection } from './tip-embed-generator/ReceiveSection';
import {
  DEFAULT_PREVIEW_COLOR,
  type EmbedFormat,
  type PublishMode,
} from './tip-embed-generator/shared';
import {
  buttonSnippetFor,
  iframeSnippetFor,
  xShareUrlFor,
} from './tip-embed-generator/snippets';
import { TipMessageInbox } from './tip-embed-generator/TipMessageInbox';

const PREVIEW_RECEIVER =
  '0x0000000000000000000000000000000000000001' as Address;

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function TipEmbedGenerator() {
  const { settings, setSettings, hydrated } = useTipSettings();
  const origin = useOrigin();
  const urlCopy = useCopyToClipboard();
  const iframeCopy = useCopyToClipboard();
  const [publishMode, setPublishMode] = useState<PublishMode>('share');
  const [embedFormat, setEmbedFormat] = useState<EmbedFormat>('iframe');
  const [qrOpen, setQrOpen] = useState(false);
  // 受け取り (受取先・通貨・チェーン・他チェーンの USDC) の設定シート。
  const [receiveOpen, setReceiveOpen] = useState(false);
  // 受取先が決まっていない間は、受け取りのカードに入力欄を直接出す (決済QR と同じ型)。読み込み後に一度だけ決め
  // (空欄 + 接続中のウォレットは自動補完を、保存済みの ENS 名は解決を待つ)、入力の途中で消さない。
  const [receiverInline, setReceiverInline] = useState(true);
  const [receiverChecked, setReceiverChecked] = useState(false);
  const t = useTranslations('TipEmbedGenerator');

  // 受取先が ENS 名のときは、設定シート (その中の AddressInput) を開いていなくても名前を解決しておき、この解決結果
  // だけを使う (シートの AddressInput も同じ query を見る)。シートから受け取った解決値を別に持つと、閉じた後の
  // 再解決が届かず、リンクと埋め込みコードが古いアドレスを指したままになる (着金先のずれ)。
  const receiverName = settings.receiver.trim();
  const ens = useResolveAddress(isLikelyName(receiverName) ? receiverName : '');
  // 再解決に失敗しても react-query は前回の解決結果を残すので、失敗中は使わない (古いアドレスのリンクを出さない)。
  const effectiveReceiver = useMemo(
    () => pickEffectiveAddress(settings.receiver, ens.error ? null : ens.data?.address ?? null),
    [settings.receiver, ens.data, ens.error],
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

  useEffect(() => {
    if (!hydrated || receiverChecked) return;
    // 空欄 + 接続ウォレットは useReceiverAutofill が直後に自動補完するので、その確定を待つ。
    if (settings.receiver.trim() === '' && autofill.connected) return;
    // 保存済み ENS / Base 名は解決結果を待つ。失敗時は入力欄のまま (入力を失わない)。
    if (isLikelyName(settings.receiver) && !effectiveReceiver) return;
    setReceiverInline(effectiveReceiver === null);
    setReceiverChecked(true);
  }, [hydrated, receiverChecked, settings.receiver, autofill.connected, effectiveReceiver]);

  // 受取先を触り始めたら、入力欄を出すか要約にするかの初回の判定はもう行わない (保存済みの ENS 名の解決待ちの間に
  // 打ち直した名前が解決した瞬間、触っている入力欄が要約に置き換わって focus を失わないように)。
  const onReceiverInput = (value: string) => {
    setReceiverChecked(true);
    autofill.handleManualChange(value);
  };
  const onUseConnectedWallet = () => {
    setReceiverChecked(true);
    autofill.useConnectedWallet();
  };

  const colorValid = COLOR_PATTERN.test(settings.color);
  const deployment = deploymentForSlug(settings.token, settings.chain);
  const capability = resolveTipCapability(settings.token, settings.chain);
  const tipMode = capability.ok ? capability.mode : undefined;

  // 現在 token のプリセットリスト (token ごと独立)。エディタ (PresetsField)・適用ともこのリストだけ操作。
  const tokenPresets = settings.presets[settings.token];
  const tokenPresetLabels = settings.presetLabels[settings.token];

  // 表示・URL 生成に使う有効プリセット: decimals に丸め → 0/不正/重複を除外。
  // 空 (全削除 or 全不正) なら token 別 default に fallback。
  const activePresets = useMemo(() => {
    const seen = new Set<string>();
    const normalized: string[] = [];
    tokenPresets.forEach((amount, index) => {
      const normalizedAmount = normalizeAmountList(
        [amount],
        deployment.decimals,
      )[0];
      if (!normalizedAmount || seen.has(normalizedAmount)) return;
      seen.add(normalizedAmount);
      const parsed = parseTipPreset(
        `${normalizedAmount}|${tokenPresetLabels[index] ?? ''}`,
      );
      if (parsed) normalized.push(formatTipPreset(parsed));
    });
    return normalized.length > 0
      ? normalized
      : DEFAULT_TIP_PRESETS[settings.token];
  }, [
    tokenPresets,
    tokenPresetLabels,
    deployment.decimals,
    settings.token,
  ]);

  // URL の preset は default と値が異なる時のみ送る (default ちょうどなら省略し URL を簡潔に)。
  const presetsForUrl = useMemo(
    () =>
      sameList(activePresets, DEFAULT_TIP_PRESETS[settings.token])
        ? undefined
        : activePresets,
    [activePresets, settings.token],
  );

  const tipUrl = useMemo(() => {
    if (!hydrated || !effectiveReceiver || !origin || !tipMode) return '';
    const params: TipParams = {
      to: effectiveReceiver,
      mode: tipMode,
      token: settings.token,
      chain: settings.chain,
      name: settings.name || undefined,
      message: settings.message || undefined,
      color: colorValid ? settings.color : undefined,
      theme: settings.theme ?? 'clean',
      presets: presetsForUrl,
      thanks: settings.thanks || undefined,
      thanksUrl: settings.thanksUrl || undefined,
      // crossChain は USDC でのみ意味がある。JPYC では URL 出力時に無視 (false 時の
      // URL bloat 回避)。default true なので false 時のみ URL に乗る。
      crossChain:
        settings.token === 'usdc' ? crossChainAllowed(settings.chain, settings.crossChain) : undefined,
    };
    return buildTipUrl(origin, params);
  }, [
    tipMode,
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
    settings.crossChain,
  ]);

  const iframeSnippet = useMemo(() => {
    if (!tipUrl) return '';
    return iframeSnippetFor(tipUrl);
  }, [tipUrl]);

  // SNS シェア: X (Twitter) の intent (snippets.ts)。tipUrl 未確定なら空。
  const shareText = settings.name
    ? t('shareTextNamed', { name: settings.name })
    : t('shareTextGeneric');
  const xShareUrl = useMemo(() => {
    if (!tipUrl) return '';
    return xShareUrlFor(shareText, tipUrl);
  }, [tipUrl, shareText]);

  // ボタン埋め込み: note / Linktree / ブログに貼れる「チップ」ボタン (snippets.ts)。
  const buttonLabel = settings.name
    ? t('buttonLabelNamed', { name: settings.name })
    : t('buttonLabelGeneric');
  const buttonColor = colorValid ? settings.color : DEFAULT_PREVIEW_COLOR;
  const buttonSnippet = useMemo(() => {
    if (!tipUrl) return '';
    return buttonSnippetFor(tipUrl, buttonColor, buttonLabel);
  }, [tipUrl, buttonColor, buttonLabel]);

  // embed タブで実際に表示/コピーするスニペット (iframe / button の切替)。
  const activeSnippet = embedFormat === 'iframe' ? iframeSnippet : buttonSnippet;

  const previewParams = useMemo<TipParams | null>(
    () => tipMode ? ({
      to: effectiveReceiver ?? PREVIEW_RECEIVER,
      mode: tipMode,
      token: settings.token,
      chain: settings.chain,
      name: settings.name || undefined,
      message: settings.message || undefined,
      color: colorValid ? settings.color : undefined,
      theme: settings.theme ?? 'clean',
      presets: activePresets,
      crossChain:
        settings.token === 'usdc' ? crossChainAllowed(settings.chain, settings.crossChain) : undefined,
    }) : null,
    [
      tipMode,
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

  return (
    <div className="space-y-5">
    {/* 並び: スマホは「受け取り → 表示 → プレビュー → 公開する」(DOM の順 = 見た目の順 = focus の順)。
        PC は左に受け取りと表示、右にプレビューと公開する (追従)。番号付き手順は使わない (user 裁定 C)。 */}
    <div className="flex flex-col gap-5 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(300px,360px)] lg:grid-rows-[auto_1fr] lg:items-start lg:gap-6">
      <div className="min-w-0 lg:col-start-1 lg:row-start-1">
        <ReceiveSection
          settings={settings}
          setSettings={setSettings}
          displaySymbol={deployment.displaySymbol}
          effectiveReceiver={effectiveReceiver}
          onReceiverInput={onReceiverInput}
          canUseConnected={autofill.canUseConnected}
          matchesConnected={autofill.matchesConnected}
          onUseConnectedWallet={onUseConnectedWallet}
          onTokenChange={selectToken}
          onChainChange={selectChain}
          receiverInline={receiverInline}
          receiveOpen={receiveOpen}
          onOpenSettings={() => setReceiveOpen(true)}
          onCloseSettings={() => {
            setReceiveOpen(false);
            // 受取先が決まっていなければ、受け取りのカードに入力欄を戻す (QR を作れない状態を要約で隠さない)。
            if (!effectiveReceiver) setReceiverInline(true);
          }}
        />
      </div>

      <div className="min-w-0 lg:col-start-1 lg:row-start-2">
        <CustomizeSection
          settings={settings}
          setSettings={setSettings}
          colorValid={colorValid}
          deployment={deployment}
        />
      </div>

      {/* 右 (PC は追従): 実 TipForm をスマホ枠で描くプレビュー + 公開する。 */}
      <div className="min-w-0 space-y-5 lg:sticky lg:top-4 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto">
        <PreviewSection
          params={previewParams}
          token={settings.token}
          chain={settings.chain}
          activePresets={activePresets}
        />

        {/* 公開する: リンク共有 / サイト埋め込み の 2 択 */}
        <PublishSection
          publishMode={publishMode}
          onPublishModeChange={setPublishMode}
          tipUrl={tipUrl}
          xShareUrl={xShareUrl}
          urlCopy={urlCopy}
          qrOpen={qrOpen}
          onOpenQr={() => setQrOpen(true)}
          onCloseQr={() => setQrOpen(false)}
          embedFormat={embedFormat}
          onEmbedFormatChange={setEmbedFormat}
          activeSnippet={activeSnippet}
          iframeCopy={iframeCopy}
        />
      </div>
    </div>

      {/* flag OFF では子を mount せず、SIWE / React Query / fetch を完全に不活性化する。
          ⚠️ grid コンテナの「外」に置くこと: sticky なプレビュー列は containing block
          (= grid コンテナ) の中でしか動けないため、外に出せば重なりが構造的に起きない。
          grid 内 col-span-2 の 2 行目に置くと、スクロール追随した sticky 列が上に被さる
          (2026-07-29 実機で再現・全desktop幅)。 */}
      {env.enableTipMessage ? <TipMessageInbox /> : null}
    </div>
  );
}
