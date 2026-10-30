'use client';

// 「受け取り」のカード (受取先が決まるまでは入力欄、決まったら要約 + 「設定」) と、その設定シート。状態は持たない —
// 設定・シートの開閉・入力欄をカードに出すかどうか・解決済みの受取先は親の TipEmbedGenerator が持つ。

import { SlidersHorizontal, Wallet } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { Address } from 'viem';
import { Field } from '@/components/Field';
import { ReceiverBlock } from '@/components/ReceiverBlock';
import { SectionCard } from '@/components/SectionCard';
import { ShopSettingsSection, ShopSettingsSheet } from '@/components/ShopSettingsSheet';
import { chainForSlug, JPYC_CHAINS, USDC_CHAINS, type ChainSlug } from '@/lib/chains';
import { shortAddress } from '@/lib/format';
import { isLikelyName } from '@/lib/nameDetection';
import type { TokenSymbol } from '@/lib/tokens';
import { crossChainAllowed } from '@/lib/url/shared';
import { resolveTipCapability } from '@/lib/url';
import type { SetTipSettings, TipSettings } from './shared';

// URL と同じ資格判定。Arc は両 flag 有効時だけ standard チップとして選択可能。
const receivableUsdcChains = () => USDC_CHAINS.filter((slug) =>
  resolveTipCapability('usdc', slug).ok,
);
const RECEIVABLE_JPYC_CHAINS = JPYC_CHAINS.filter((slug) =>
  resolveTipCapability('jpyc', slug).ok,
);

type ReceiverFieldsProps = {
  settings: TipSettings;
  setSettings: SetTipSettings;
  /** 受取チェーンの見出しに出す通貨の表示名 (deployment.displaySymbol)。 */
  displaySymbol: string;
  effectiveReceiver: Address | null;
  onReceiverInput: (value: string) => void;
  canUseConnected: boolean;
  matchesConnected: boolean;
  onUseConnectedWallet: () => void;
  onTokenChange: (tok: TokenSymbol) => void;
  onChainChange: (slug: ChainSlug) => void;
};

// 受取先・通貨・チェーンと、USDC の他チェーン受取。カードの入力欄と設定シートの 2 か所で同じ markup を出す。
function ReceiverFields({
  settings,
  setSettings,
  displaySymbol,
  effectiveReceiver,
  onReceiverInput,
  canUseConnected,
  matchesConnected,
  onUseConnectedWallet,
  onTokenChange,
  onChainChange,
}: ReceiverFieldsProps) {
  const t = useTranslations('TipEmbedGenerator');
  return (
    <>
      <ReceiverBlock
        receiver={settings.receiver}
        onReceiverChange={onReceiverInput}
        showAddressInvalid={
          !!settings.receiver &&
          !effectiveReceiver &&
          !isLikelyName(settings.receiver)
        }
        wallet={{
          canUse: canUseConnected,
          matches: matchesConnected,
          onUse: onUseConnectedWallet,
        }}
        token={settings.token}
        chain={settings.chain}
        availableChains={
          settings.token === 'usdc'
            ? receivableUsdcChains()
            : RECEIVABLE_JPYC_CHAINS
        }
        onTokenChange={onTokenChange}
        onChainChange={onChainChange}
        mode="editable"
        chainGridClassName={
          settings.token === 'usdc'
            ? 'grid grid-cols-2 gap-2 sm:grid-cols-3'
            : 'grid grid-cols-2 gap-2'
        }
        labels={{
          receiver: t('receiverLabel'),
          currency: t('tokenLabel'),
          chain: t('chainLabel', { symbol: displaySymbol }),
          useConnectedWallet: t('useConnectedWallet'),
          receiverMatchesWallet: t('receiverMatchesWallet'),
          addressInvalid: t('addressInvalid'),
        }}
      />
      {settings.token === 'usdc' && crossChainAllowed(settings.chain) && (
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
                {t(settings.chain === 'arc' ? 'crossChainToggleDescriptionArc' : 'crossChainToggleDescription')}
              </span>
            </span>
          </label>
        </Field>
      )}
    </>
  );
}

export function ReceiveSection({
  receiverInline,
  receiveOpen,
  onOpenSettings,
  onCloseSettings,
  ...fields
}: ReceiverFieldsProps & {
  receiverInline: boolean;
  receiveOpen: boolean;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
}) {
  const t = useTranslations('TipEmbedGenerator');
  const { settings, effectiveReceiver, matchesConnected, displaySymbol } = fields;
  return (
    <>
      <SectionCard
        title={t('receiveHeading')}
        headingId="tip-receive-heading"
        icon={Wallet}
        action={
          receiverInline ? undefined : (
            <button
              type="button"
              onClick={onOpenSettings}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-brand hover:text-brand-dark"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
              {t('receiveEdit')}
            </button>
          )
        }
      >
        {receiverInline ? (
          <div className="space-y-4">
            <ReceiverFields {...fields} />
          </div>
        ) : (
          <>
            <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
              <span className="font-mono text-slate-900">{effectiveReceiver ? shortAddress(effectiveReceiver) : ''}</span>
              {matchesConnected ? (
                <span className="text-xs text-emerald-700">{t('receiverIsWallet')}</span>
              ) : null}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {displaySymbol} · {chainForSlug(settings.chain).name}
            </p>
          </>
        )}
      </SectionCard>
      <ShopSettingsSheet
        open={receiveOpen}
        onClose={onCloseSettings}
        title={t('receiveSettingsTitle')}
        doneLabel={t('receiveDone')}
      >
        <ShopSettingsSection title={t('receiveHeading')}>
          <ReceiverFields {...fields} />
        </ShopSettingsSection>
      </ShopSettingsSheet>
    </>
  );
}
