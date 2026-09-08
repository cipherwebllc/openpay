import 'server-only';

import { getAddress, isAddress, type Address } from 'viem';
import { env } from '@/lib/env';

export function licenseNftEnabled(): boolean {
  return env.enableCreatorStore === true && env.enableLicenseNft === true;
}

/** 空・checksum 不正を許可に変えない。rollout の誤設定が一般出品へ波及するのを防ぐ。 */
export function licenseSellerAllowed(address: string): boolean {
  if (!licenseNftEnabled() || !isAddress(address)) return false;
  const entries = (process.env.LICENSE_NFT_SELLER_ALLOWLIST ?? '').split(',').map((v) => v.trim());
  if (entries.some((v) => !isAddress(v) || getAddress(v) !== v)) return false;
  return entries.includes(getAddress(address));
}

export function licenseDeployment(): { chainId: 137 | 80002; contract: Address } | null {
  const chainId = env.networkEnv === 'mainnet' ? 137 : 80002;
  const contract = chainId === 137 ? env.licenseNftPolygon : env.licenseNftAmoy;
  if (!contract || !isAddress(contract) || /^0x0{40}$/i.test(contract)) return null;
  return { chainId, contract: getAddress(contract) };
}

/** デジタル商品は flag/KV/RPC の追加依存なしで従来どおり通す。 */
export function licenseVisible(value: { productKind?: 'license' }): boolean {
  return value.productKind !== 'license' || licenseNftEnabled();
}
