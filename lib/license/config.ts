import 'server-only';

import { getAddress, isAddress, type Address } from 'viem';
import { env } from '@/lib/env';

export function licenseNftEnabled(): boolean {
  return env.enableCreatorStore === true && env.enableLicenseNft === true;
}

/** 公開時も親 flag と address 検証は必須。SIWE・プロフィール等は既存の出品 API で検証する。 */
export function licenseSellerAllowed(address: string): boolean {
  if (!licenseNftEnabled() || !isAddress(address)) return false;
  if (process.env.ENABLE_LICENSE_NFT_PUBLIC === '1') return true;
  // 限定公開では空・checksum 不正を許可に変えない。
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
