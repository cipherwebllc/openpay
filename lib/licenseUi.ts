// ライセンスの公開表示用の型。秘密鍵・登録処理・RPC を client へ持ち込まない。
export type StoreLicenseSummary = {
  supply: number;
  remaining?: number | null;
  transferable: boolean;
  termsUrl: string;
  termsVersion: string;
  tokenChainId?: number;
};

export type StoreLicenseProduct = {
  productKind?: 'license';
  license?: StoreLicenseSummary;
  sellerRole?: SellerRole;
  sellerName?: string;
};

export type SellerRole = 'operator' | 'third_party';

export type StoreLicenseProof = {
  status: 'awaiting_finality' | 'pending' | 'submitted' | 'minted' |
    'retryable' | 'needs_repair' | 'unknown' | 'registered';
  mintTxHash?: string;
};

export const LICENSE_PURCHASE_ERRORS = {
  sold_out: 409,
  reservation_quota: 409,
  recipient_unsupported: 409,
  license_registration_pending: 409,
  license_simulation_unavailable: 503,
} as const;

export type LicensePurchaseErrorCode = keyof typeof LICENSE_PURCHASE_ERRORS;

export function isLicensePurchaseError(code: unknown): code is LicensePurchaseErrorCode {
  return typeof code === 'string' && Object.hasOwn(LICENSE_PURCHASE_ERRORS, code);
}

export function licensePurchaseErrorCode(error: unknown): LicensePurchaseErrorCode | null {
  if (!(error instanceof Error)) return null;
  const code = 'code' in error ? error.code : error.message;
  return isLicensePurchaseError(code) ? code : null;
}

export function licenseNftState(
  proof: StoreLicenseProof | undefined,
  entitled?: boolean | null,
  basis?: 'purchase' | 'holder' | null,
): 'pending' | 'minted' | 'repair' | 'transferred' | 'unknown' {
  // 不明な RPC 応答を譲渡済みにしない。保有権利の否定だけを表示へ反映する。
  if (entitled === false && basis === 'holder') return 'transferred';
  if (!proof || proof.status === 'unknown') return 'unknown';
  if (proof.status === 'minted') return 'minted';
  if (proof.status === 'retryable' || proof.status === 'needs_repair') return 'repair';
  return 'pending';
}

export function licenseMintTxUrl(hash: string | undefined, chainId?: number): string | null {
  if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return null;
  if (chainId !== 137 && chainId !== 80002) return null;
  return `https://${chainId === 80002 ? 'amoy.' : ''}polygonscan.com/tx/${hash}`;
}
