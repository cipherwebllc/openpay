'use client';

// 「受け取り」のカード (受取先と受け取る方法の要約 + 「設定」) と、その設定シート。受取先と受け取る方法は
// 一度決めたら変えないので、カードは要約だけを出し、編集はシートで行う。状態は持たない — 下書き・シートの
// 開閉・受取先の欄をカードに出すかどうか・解決済みの受取先は親の HandleProfileBuilder が持つ。

import { SlidersHorizontal, Wallet } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { Address } from 'viem';
import { env, isArcTipEnabled } from '@/lib/env';
import { AddressInput } from '@/components/AddressInput';
import { methodLabel } from '@/components/ReceiveMethodPicker';
import { SectionCard } from '@/components/SectionCard';
import { ShopSettingsSection, ShopSettingsSheet } from '@/components/ShopSettingsSheet';
import { shortAddress } from '@/lib/format';
import type { HandleProfileDraft } from '@/hooks/useHandleProfileDraft';
import type { HandleReceiveMethod } from '@/lib/handle';
import { Field, type DraftUpdate } from './fields';

function ReceiverField({
  value,
  update,
  connected,
  onUseConnected,
}: {
  value: string;
  update: DraftUpdate;
  connected: Address | undefined;
  onUseConnected: () => void;
}) {
  const t = useTranslations('HandleProfile');
  return (
    <Field label={t('receiverLabel')} hint={t('receiverHint')}>
      <AddressInput
        value={value}
        onChange={(v) => update({ to: v })}
      />
      {connected && (
        <button
          type="button"
          onClick={onUseConnected}
          className="mt-1.5 text-xs font-medium text-brand hover:underline"
        >
          {t('useConnectedWallet')}
        </button>
      )}
    </Field>
  );
}

export function ReceiveSection({
  draft,
  update,
  connected,
  onUseConnected,
  effectiveReceiver,
  methods,
  receiverInline,
  receiveOpen,
  onOpenSettings,
}: {
  draft: HandleProfileDraft;
  update: DraftUpdate;
  connected: Address | undefined;
  onUseConnected: () => void;
  effectiveReceiver: Address | null;
  methods: HandleReceiveMethod[];
  receiverInline: boolean;
  receiveOpen: boolean;
  onOpenSettings: () => void;
}) {
  const t = useTranslations('HandleProfile');
  return (
    <SectionCard
      title={t('receiveHeading')}
      headingId="handle-receive-heading"
      icon={Wallet}
      action={
        <button
          type="button"
          onClick={onOpenSettings}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-brand hover:text-brand-dark"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
          {t('receiveEdit')}
        </button>
      }
    >
      {/* 設定シートを開いている間は、受取先の欄はシートの中の 1 つだけ (同じ欄を 2 か所に出さない)。 */}
      {receiverInline && !receiveOpen ? (
        <ReceiverField value={draft.to} update={update} connected={connected} onUseConnected={onUseConnected} />
      ) : effectiveReceiver ? (
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="font-mono text-slate-900">{shortAddress(effectiveReceiver)}</span>
          {connected && effectiveReceiver.toLowerCase() === connected.toLowerCase() ? (
            <span className="text-xs text-emerald-700">{t('receiverIsWallet')}</span>
          ) : null}
        </p>
      ) : (
        <p className="text-sm font-medium text-amber-700">{t('receiverUnset')}</p>
      )}
      <p className="mt-1 text-xs text-slate-500">
        {methods.length > 0
          ? methods.map((m) => methodLabel(m, t('crossChain'))).join(' / ')
          : t('atLeastOneMethod')}
      </p>
    </SectionCard>
  );
}

export function ReceiveSettingsSheet({
  draft,
  update,
  connected,
  onUseConnected,
  methods,
  open,
  onClose,
}: {
  draft: HandleProfileDraft;
  update: DraftUpdate;
  connected: Address | undefined;
  onUseConnected: () => void;
  methods: HandleReceiveMethod[];
  open: boolean;
  onClose: () => void;
}) {
  const t = useTranslations('HandleProfile');
  const tb = useTranslations('HandleProfileBuilder');

  // 受取方法トグルの選択肢。Avalanche はチップの JPYC_CHAINS と同思想で
  // env.enableJpycAvalanche=ON のときだけ表示 (既定 OFF=非表示で完全 inert)。実際に受取可能か
  // (forwarder 設定で gasless 成立) は公開ページ/publish 時の parseTipParams が判定する。
  const methodOptions: Array<
    ['jpycPolygon' | 'jpycKaia' | 'jpycAvalanche', HandleReceiveMethod]
  > = [
    ['jpycPolygon', { token: 'jpyc', chain: 'polygon' }],
    ['jpycKaia', { token: 'jpyc', chain: 'kaia' }],
  ];
  if (env.enableJpycAvalanche) {
    methodOptions.push(['jpycAvalanche', { token: 'jpyc', chain: 'avalanche' }]);
  }
  // USDC は Base か Arc の**どちらか 1 つ** (2026-09-17 user 裁定: 両方公開すると受取ボタンが 2 つ並ぶ)。
  // draft は従来の usdcBase / usdcArc の 2 boolean のまま (旧 draft 互換)・UI で排他にする。
  // 旧レコードで両方 true のときは 'both' として明示表示し、どちらかを選ぶまで黙って落とさない。
  const usdcChoice: 'none' | 'base' | 'arc' | 'both' =
    draft.usdcBase && draft.usdcArc ? 'both' : draft.usdcArc ? 'arc' : draft.usdcBase ? 'base' : 'none';
  const showArcChoice = isArcTipEnabled() || draft.usdcArc;
  const usdcChoices: Array<['none' | 'base' | 'arc', string]> = [
    ['none', tb('usdcNone')],
    // ビルダーの選択肢はチェーン名で区別する (受け取る側が選ぶ場所)。cross-chain 可否は
    // 公開時に buildPublishMethods が付け、送る側のボタンは「USDC · cross-chain」で統一。
    ['base', methodLabel({ token: 'usdc', chain: 'base' }, t('crossChain'))],
    ...(showArcChoice ? [['arc', methodLabel({ token: 'usdc', chain: 'arc' }, t('crossChain'))] as ['arc', string]] : []),
  ];

  return (
    <ShopSettingsSheet
      open={open}
      onClose={onClose}
      title={t('receiveSettingsTitle')}
      doneLabel={t('receiveDone')}
    >
      <ShopSettingsSection title={t('receiveHeading')}>
        {/* 受取先はいつもシートの先頭にも置く (「設定」から受取先を決めようとした人が迷わない)。
            未設定の間に受け取りカードへ出している欄は、シートを開いている間は外している。 */}
        <ReceiverField value={draft.to} update={update} connected={connected} onUseConnected={onUseConnected} />
        <fieldset>
          <legend className="text-sm font-medium text-slate-700">{t('methodsLabel')}</legend>
          <div className="mt-1 space-y-1.5">
            {methodOptions.map(([key, method]) => (
              <label key={key} className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={draft[key]}
                  onChange={(e) => update({ [key]: e.target.checked } as Partial<typeof draft>)}
                />
                {methodLabel(method, t('crossChain'))}
              </label>
            ))}
          </div>
          <p className="mt-3 text-sm font-medium text-slate-700">{tb('usdcChainLabel')}</p>
          {usdcChoice === 'both' && (
            <p className="mt-1 text-xs text-amber-700">{tb('usdcBothPublished')}</p>
          )}
          <div role="radiogroup" aria-label={tb('usdcChainLabel')} className="mt-1 space-y-1.5">
            {usdcChoices.map(([value, label]) => (
              <label key={value} className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                <input
                  type="radio"
                  name="usdcChain"
                  value={value}
                  checked={usdcChoice === value}
                  disabled={value === 'arc' && !isArcTipEnabled()}
                  onChange={() => update({ usdcBase: value === 'base', usdcArc: value === 'arc' })}
                />
                {label}
                {value === 'arc' && !isArcTipEnabled() && ` (${tb('arcInactive')})`}
              </label>
            ))}
          </div>
          {draft.usdcArc && (
            <p className="mt-1 text-xs text-slate-500">{tb('usdcArcTipHint')}</p>
          )}
          {methods.length === 0 && (
            <p className="mt-1 text-xs text-red-600">{t('atLeastOneMethod')}</p>
          )}
          {draft.usdcBase && (
            <p className="mt-1 text-xs text-slate-500">{t('usdcTipHint')}</p>
          )}
        </fieldset>
      </ShopSettingsSection>
    </ShopSettingsSheet>
  );
}
