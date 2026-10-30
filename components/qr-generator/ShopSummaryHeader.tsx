'use client';

// 会計のカードの先頭に出す「お店の設定」の要約 (どの店名・受取先・通貨とチェーン・支払い方法で出すか・「設定」)。
// 状態は持たない — 設定と「お店がガス代を肩代わり」を選んでいるか (storeRequested) は親の QrGenerator が持ち、
// ここは支払い方法の短い名前とピルの色を選んで ShopSummaryRow に渡すだけ。

import { useTranslations } from 'next-intl';
import type { Address } from 'viem';
import { ShopSummaryRow } from '@/components/ShopSummaryRow';
import type { ChainSlug } from '@/lib/chains';
import type { PayMode } from '@/lib/fee';
import type { TokenSymbol } from '@/lib/tokens';

export function ShopSummaryHeader({
  storeName,
  receiver,
  token,
  tokenLabel,
  chainSlug,
  chainName,
  storeRequested,
  payMode,
  onOpenSettings,
}: {
  storeName: string;
  receiver: Address | null;
  token: TokenSymbol;
  tokenLabel: string;
  chainSlug: ChainSlug;
  chainName: string;
  storeRequested: boolean;
  payMode: PayMode;
  onOpenSettings: () => void;
}) {
  const t = useTranslations('QrGenerator');
  return (
    <ShopSummaryRow
      storeName={storeName}
      receiver={receiver}
      token={token}
      tokenLabel={tokenLabel}
      chainSlug={chainSlug}
      chainName={chainName}
      payLabel={
        storeRequested
          ? t('storeDevice.posterBadge')
          : payMode === 'gasless'
            ? t('posterPayModeGasless')
            : t('shopSummary.payStandard')
      }
      payTone={storeRequested || payMode === 'gasless' ? 'gasless' : 'standard'}
      onOpenSettings={onOpenSettings}
      labels={{
        settings: t('shopSettings.open'),
        noStoreName: t('shopSummary.noStoreName'),
        noReceiver: t('shopSummary.noReceiver'),
      }}
    />
  );
}
