'use client';

// x402 facilitator の最小 UI: 公開カタログ (discovery) の閲覧 + 加盟店の登録/編集/削除 (SIWE)。
// カタログは /api/discovery を fetch して列挙 (誰でも閲覧)。owner は SIWE サインイン後、自分の登録を
// /api/facilitator/resources で管理する (GET=一覧 / POST=登録 / [id] PATCH=編集 / [id] DELETE=無効化)。
// 本コンポーネントは env.enableX402Facilitator が ON のページからのみマウントされる。
//
// 表示は components/x402/ の panel に分けてある (R10a)。状態 (コピー済み表示・展開・カタログの検索/絞り込み・
// 出品者の下書きと mutation) はここで 1 回だけ持つ: 節の並び替えによる panel の再マウントと状態を分離する。
// 出品者の下書き・結果表示は wallet / SIWE の切替で破棄し、接続の瞬断では保つ。
// 公開カタログ側の leaf は wagmi / SIWE / 出品者専用の部品に依存しない。

import { useEffect, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { useAccount } from 'wagmi';
import { useSiweSession } from '@/hooks/useSiweSession';
import type { UsdcCatalogItem } from '@/lib/x402/usdcCatalog';
import type { MonitorFreshness } from '@/lib/directory/monitorFreshness';
import { DiscoveryCatalogPanel, useDiscoveryCatalog } from './x402/DiscoveryCatalogPanel';
import { useDiscoveryDisplay } from './x402/discoveryDisplay';
import { DiscoveryExamples } from './x402/DiscoveryExamples';
import { DiscoveryRegistrationSection } from './x402/DiscoveryRegistrationSection';
import { useDiscoveryOwner } from './x402/useDiscoveryOwner';

function DiscoveryOwnedResourcesLoading() {
  const t = useTranslations('Facilitator');
  return (
    <section aria-busy="true">
      <h3 className="text-base font-bold text-slate-900">{t('yourResourcesTitle')}</h3>
      <p role="status" className="mt-1 text-sm text-slate-500">{t('loading')}</p>
    </section>
  );
}

const DiscoveryOwnedResources = dynamic(
  () => import('./x402/DiscoveryOwnedResources').then((m) => m.DiscoveryOwnedResources),
  {
    // 一覧はブラウザーの SIWE 認証後に取得する private UI なので SSR しない。
    // 接続/サインイン入口を持つ DiscoveryRegistrationSection は eager のまま保つ。
    ssr: false,
    loading: DiscoveryOwnedResourcesLoading,
  },
);

const EMPTY_USDC_ITEMS: UsdcCatalogItem[] = [];

export function X402DiscoveryView({
  maxResourcesPerMerchant,
  featured,
  usdcItems = EMPTY_USDC_ITEMS,
  usdcArc = false,
  freshnessByPath,
}: {
  maxResourcesPerMerchant: number;
  featured?: ReactNode;
  /** USDC (Base・標準 x402) 商品。server が静的に渡す (lib/x402/usdcCatalog)。 */
  usdcItems?: readonly UsdcCatalogItem[];
  /** first-party の USDC 商品が Arc (Circle Gateway) でも払えるとき true (表示専用・server が flag から渡す)。
   *  第三者出品の USDC 面 (dual-rail) は Base のみなので対象外。 */
  usdcArc?: boolean;
  /** 更新型商品の鮮度 (path キー)。server が静的に渡す (lib/directory/monitorFreshness)。 */
  freshnessByPath?: Readonly<Record<string, MonitorFreshness>>;
}) {
  const { address, isConnected } = useAccount();
  const { isSignedIn, signIn, isSigningIn } = useSiweSession();
  // hook の順序 = 分割前と同じく公開カタログの query を owned の query より先に登録する。
  const display = useDiscoveryDisplay(freshnessByPath);
  const catalog = useDiscoveryCatalog(usdcItems);
  // controller は dynamic 境界の外で維持し、下書き・展開・進行中の結果表示を失わない。
  const owner = useDiscoveryOwner(address, isSignedIn);

  useEffect(() => {
    if (!isSignedIn) return;
    // SIWE 成立時に両 chunk を先読みし、一覧の取得後にさらに chunk を待つ段差を減らす。
    // 付帯的な先読みの失敗を認証・カタログへ波及させない。表示時の失敗は dynamic 側で扱う。
    void Promise.all([
      import('./x402/DiscoveryRegistrationForm'),
      import('./x402/DiscoveryOwnedResources'),
    ]).catch(() => {});
  }, [isSignedIn]);

  const ownedResourcesSection = isSignedIn && owner.owned.length > 0 ? (
    <DiscoveryOwnedResources owner={owner} display={display} isSignedIn={isSignedIn} />
  ) : null;
  const registrationSection = (
    <DiscoveryRegistrationSection
      owner={owner}
      display={display}
      maxResourcesPerMerchant={maxResourcesPerMerchant}
      address={address}
      isConnected={isConnected}
      isSignedIn={isSignedIn}
      signIn={signIn}
      isSigningIn={isSigningIn}
    />
  );
  const catalogSection = (
    <DiscoveryCatalogPanel
      catalog={catalog}
      display={display}
      usdcItems={usdcItems}
      usdcArc={usdcArc}
    />
  );

  // セクションの中身を変えず、閲覧者と売り手で並びだけを切り替える。
  const sellerMode = isSignedIn;

  return (
    <div className="space-y-6">
      {sellerMode ? (
        <>
          {ownedResourcesSection}
          {registrationSection}
          {featured}
          {catalogSection}
        </>
      ) : (
        <>
          {featured}
          {catalogSection}
          {registrationSection}
        </>
      )}

      <DiscoveryExamples display={display} />
    </div>
  );
}
