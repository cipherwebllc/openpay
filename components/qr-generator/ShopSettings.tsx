'use client';

// 「お店の設定」シート (受取先・通貨とチェーン・支払い方法・控えとポスター)。状態は持たない — シートの開閉と閉じたときの
// 処理・設定・受取先の解決と自動補完・通貨とチェーンの切替 (selectToken / selectChain)・支払い方法の判定 (無料の
// ガスレス / JPYC の回収・分配) は親の QrGenerator が持ち、ここは 4 つの節に並べて中継するだけ (値の変え方は
// 今までの handler のまま)。

import type { Dispatch, SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import type { Address, Chain } from 'viem';
import { ChainChooser } from '@/components/ChainChooser';
import {
  QrReceiptPosterFields,
  QrReceiverFields,
  QrStoreNameField,
} from '@/components/qr/QrReceiverSection';
import { QrSettingsSection } from '@/components/qr/QrSettingsSection';
import { ShopSettingsSection, ShopSettingsSheet } from '@/components/ShopSettingsSheet';
import { TokenChooser } from '@/components/TokenChooser';
import type { QrSettings } from '@/hooks/useQrSettings';
import type { useReceiverAutofill } from '@/hooks/useReceiverAutofill';
import { JPYC_CHAINS, USDC_CHAINS, type ChainSlug } from '@/lib/chains';
import type { TokenDeployment, TokenSymbol } from '@/lib/tokens';
import type { SplitDraftsParseResult, SplitEntry } from '@/lib/url';

export function ShopSettings({
  open,
  onClose,
  settings,
  setSettings,
  deployment,
  chain,
  effectiveReceiver,
  receiverValid,
  autofill,
  handleResolved,
  onSelectToken,
  onSelectChain,
  hideGasMode,
  isJpycRecover,
  isStandard,
  splitParsed,
  splitsForUrl,
}: {
  open: boolean;
  onClose: () => void;
  settings: QrSettings;
  setSettings: Dispatch<SetStateAction<QrSettings>>;
  deployment: TokenDeployment;
  chain: Chain;
  effectiveReceiver: Address | null;
  receiverValid: boolean;
  autofill: ReturnType<typeof useReceiverAutofill>;
  handleResolved: (addr: Address | null) => void;
  onSelectToken: (token: TokenSymbol) => void;
  onSelectChain: (slug: ChainSlug) => void;
  hideGasMode: boolean;
  isJpycRecover: boolean;
  isStandard: boolean;
  splitParsed: SplitDraftsParseResult;
  splitsForUrl: SplitEntry[] | undefined;
}) {
  const t = useTranslations('QrGenerator');
  return (
    <ShopSettingsSheet
      open={open}
      onClose={onClose}
      title={t('shopSettings.title')}
      doneLabel={t('shopSettings.done')}
    >
      <ShopSettingsSection title={t('shopSettings.sections.receive')}>
        <QrReceiverFields
          settings={settings}
          deployment={deployment}
          chain={chain}
          effectiveReceiver={effectiveReceiver}
          receiverValid={receiverValid}
          autofill={autofill}
          handleResolved={handleResolved}
        />
        <QrStoreNameField settings={settings} setSettings={setSettings} />
      </ShopSettingsSection>
      <ShopSettingsSection title={t('shopSettings.sections.currency')}>
        <TokenChooser selected={settings.token} onSelect={onSelectToken} />
        <ChainChooser
          slugs={settings.token === 'usdc' ? USDC_CHAINS : JPYC_CHAINS}
          selected={settings.chain}
          onSelect={onSelectChain}
          gridClassName="grid grid-cols-2 gap-2"
          showId={false}
        />
      </ShopSettingsSection>
      <ShopSettingsSection title={t('shopSettings.sections.payment')}>
        <QrSettingsSection
          settings={settings}
          setSettings={setSettings}
          deployment={deployment}
          hideGasMode={hideGasMode}
          isJpycRecover={isJpycRecover}
          isStandard={isStandard}
          splitParsed={splitParsed}
          splitsForUrl={splitsForUrl}
        />
      </ShopSettingsSection>
      <ShopSettingsSection title={t('shopSettings.sections.receipt')}>
        <QrReceiptPosterFields settings={settings} setSettings={setSettings} />
      </ShopSettingsSection>
    </ShopSettingsSheet>
  );
}
