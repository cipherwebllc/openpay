import 'server-only';

import type { Address } from 'viem';
import { licenseNftEnabled, licenseVisible } from '@/lib/license/config';
import type { LicenseDefinition } from '@/lib/license/definition';
import type { LicenseRights } from '@/lib/license/rights';
import {
  getHostedContent,
  getHostedProduct,
  isHostedId,
  type HostedContent,
  type HostedProduct,
} from '@/lib/x402/hostedStore';
import type { PurchaseGrant } from '@/lib/x402/purchaseIntent';
import {
  readStoreOwnership,
  selectStorePurchaseGrant,
} from '@/lib/x402/storeEntitlement';

export type StoreContentSelector = {
  revision: number | null;
  intentSalt: string | null;
};

// source は HTTP 来歴の由来。購入経路でも rights.basis は holder になり得る。
type StoreContentProvenance = {
  resourceId: string;
  product: HostedProduct;
} & (
  | { source: 'purchase'; grant: PurchaseGrant; rights: LicenseRights | null }
  | { source: 'holder'; contentRevision: 1; license: LicenseDefinition; rights: LicenseRights }
);

export type StoreContentAccess =
  | { kind: 'denied' }
  | { kind: 'storage' }
  | { kind: 'rights_unknown' }
  | ({ kind: 'ended' } & StoreContentProvenance)
  | ({ kind: 'ready'; content: HostedContent } & StoreContentProvenance);

/** 認証済み address の content 権利・固定 revision を解決する。HTTP 応答は呼出側で直列化する。 */
export async function resolveStoreContentAccess({ address, resourceId, selector }: {
  address: Address;
  resourceId: string;
  selector: StoreContentSelector;
}): Promise<StoreContentAccess> {
  // 商品/content の存在を先に見ると、未所有者へ resource の存在を漏らすため own が先。
  const owned = await readStoreOwnership(address, resourceId);
  if (!owned.ok) return { kind: 'storage' };
  if (!owned.ownership) {
    if (!licenseNftEnabled() || !isHostedId(resourceId) || selector.intentSalt !== null || (selector.revision !== null && selector.revision !== 1)) return { kind: 'denied' };
    const product = await getHostedProduct(resourceId);
    if (product === 'storage') return { kind: 'storage' };
    if (!product || product.id !== resourceId || product.productKind !== 'license' || !product.license?.transferable) return { kind: 'denied' };
    const { resolveLicenseRights } = await import('@/lib/license/rights');
    const rights = await resolveLicenseRights({ address, productId: resourceId, definition: product.license, ownership: null });
    if (rights.entitled === null) return { kind: 'rights_unknown' };
    if (!rights.entitled) return { kind: 'denied' };
    const held: StoreContentProvenance = {
      source: 'holder', resourceId, product, contentRevision: 1, license: product.license, rights,
    };
    if (!product.contentAvailable) return { ...held, kind: 'ended' };
    const content = await getHostedContent(resourceId, 1);
    if (content === 'storage') return { kind: 'storage' };
    if (!content) return { ...held, kind: 'ended' };
    // 固定 revision の破損が、購入していない別形式の本文配信へ波及するのを断つ。
    if (content.kind !== 'text') return { kind: 'storage' };
    return { ...held, kind: 'ready', content };
  }

  const grant = selectStorePurchaseGrant(owned.ownership, selector);
  // 未所有 resource と、所有 record 内に指定 grant がない場合は同じ oracle-safe 404。
  if (!grant || !licenseVisible(grant.metadata)) return { kind: 'denied' };
  const product = await getHostedProduct(resourceId);
  if (product === 'storage') return { kind: 'storage' };
  // 未所有と商品レコード不在は、body/status とも同一の 404 にする。
  if (!product || !licenseVisible(product)) return { kind: 'denied' };
  if (product.id !== resourceId) {
    // key と embedded id の破損から、別商品の availability を権利判定へ波及させない。
    return { kind: 'storage' };
  }
  let rights: LicenseRights | null = null;
  if (grant.metadata.license) {
    const { resolveLicenseRights } = await import('@/lib/license/rights');
    rights = await resolveLicenseRights({ address, productId: resourceId, definition: grant.metadata.license, ownership: owned.ownership });
    if (rights.entitled === null) return { kind: 'rights_unknown' };
    if (!rights.entitled) return { kind: 'denied' };
  }
  const purchased: StoreContentProvenance = {
    source: 'purchase', resourceId, product, grant, rights,
  };
  if (!product.contentAvailable) return { ...purchased, kind: 'ended' };

  const content = await getHostedContent(resourceId, grant.contentRevision);
  if (content === 'storage') return { kind: 'storage' };
  if (!content) return { ...purchased, kind: 'ended' };
  if (content.kind !== grant.metadata.contentKind) {
    // 購入時 metadata と本文種別の不整合時に、別形式の本文を配信する偽成功を防ぐ。
    return { kind: 'storage' };
  }
  return { ...purchased, kind: 'ready', content };
}
