import 'server-only';

import { isAddressEqual, type Address } from 'viem';
import { env } from '@/lib/env';
import type { SellerRole } from '@/lib/licenseUi';

// 表示専用。受取先や表示名ではなく商品の owner を運営ウォレットと照合する。
export function sellerRoleFor(owner: Address): SellerRole {
  return isAddressEqual(owner, env.feeReceiver) ? 'operator' : 'third_party';
}

// API の返却時だけ付与する。保存する商品定義は変更しない。
export function withSellerRole<T extends { owner: Address; productKind?: 'license' }>(product: T): T & { sellerRole?: SellerRole } {
  return product.productKind === 'license'
    ? { ...product, sellerRole: sellerRoleFor(product.owner) }
    : product;
}
