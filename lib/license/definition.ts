import { encodeAbiParameters, getAddress, isAddress, keccak256, stringToHex, toHex, type Address, type Hex } from 'viem';
import { computeLicenseTokenId } from './paymentKey';

export type LicenseDefinition = {
  schema: 1;
  rail: 'jpyc';
  tokenChainId: 137 | 80002;
  contract: Address;
  deploymentId: string;
  tokenId: Hex;
  transferable: boolean;
  termsUrl: string;
  termsVersion: string;
  termsHash: Hex;
  contentRef: string;
  supply: number;
  definitionHash: Hex;
};
export type LicenseRegistration = {
  status: 'pending' | 'registered' | 'failed';
  txHash?: Hex;
  lastError?: string;
  attempts: number;
};
export type LicenseTermsInput = Pick<LicenseDefinition, 'supply' | 'transferable' | 'termsUrl' | 'termsVersion'>;
export const LICENSE_DEFAULT_INSTRUCTIONS = '利用開始の案内は売り手の利用条件 URL を参照';
const HEX32 = /^0x[0-9a-f]{64}$/;
const DOMAIN = keccak256(stringToHex('openpay.license.definition.v1'));

/** URL と版の UTF-8 を abi.encode(string,string) して keccak256。連結の境界曖昧性を排除する。 */
export function licenseTermsHash(termsUrl: string, termsVersion: string): Hex {
  return keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'string' }], [termsUrl, termsVersion]));
}

/**
 * canonical tuple = abi.encode(bytes32 domain,uint8 schema,string rail,uint256 tokenChainId,
 * address contract,string deploymentId,uint256 tokenId,bool transferable,string termsUrl,
 * string termsVersion,bytes32 termsHash,string contentRef,uint64 supply)。
 * domain = keccak256(UTF-8 "openpay.license.definition.v1")。文字列の正規化は行わない。
 * productId は tokenId と contentRef に束縛済み。JSON 順序や address の大文字小文字に依存しない。
 */
export function computeLicenseDefinitionHash(d: Omit<LicenseDefinition, 'definitionHash'>): Hex {
  return keccak256(encodeAbiParameters(
    ['bytes32', 'uint8', 'string', 'uint256', 'address', 'string', 'uint256', 'bool', 'string', 'string', 'bytes32', 'string', 'uint64'].map((type) => ({ type })),
    [DOMAIN, d.schema, d.rail, BigInt(d.tokenChainId), d.contract, d.deploymentId, BigInt(d.tokenId), d.transferable, d.termsUrl, d.termsVersion, d.termsHash, d.contentRef, BigInt(d.supply)],
  ));
}

export function parseLicenseTerms(raw: unknown): LicenseTermsInput | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!Number.isInteger(r.supply) || Number(r.supply) < 1 || Number(r.supply) > 10_000 ||
      typeof r.transferable !== 'boolean' || typeof r.termsUrl !== 'string' || r.termsUrl.length > 512 ||
      typeof r.termsVersion !== 'string' || !r.termsVersion.trim() || r.termsVersion.length > 128) return null;
  try {
    const url = new URL(r.termsUrl);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
  } catch {
    // 不正 URL が immutable terms snapshot に保存されるのを防ぐ。
    return null;
  }
  return { supply: Number(r.supply), transferable: r.transferable, termsUrl: r.termsUrl, termsVersion: r.termsVersion };
}

/** 作成入力だけ不可譲渡を既定とする。保存済み tuple の parser には既定値を注入しない。 */
export function parseLicenseCreationTerms(raw: unknown): LicenseTermsInput | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  return parseLicenseTerms({ ...record, transferable: record.transferable === undefined ? false : record.transferable });
}

export function createLicenseDefinition(productId: string, terms: LicenseTermsInput, chainId: 137 | 80002, contract: Address): LicenseDefinition {
  const definition: Omit<LicenseDefinition, 'definitionHash'> = {
    schema: 1, rail: 'jpyc', tokenChainId: chainId, contract: getAddress(contract),
    deploymentId: 'openpay-license1155-v1:' + chainId + ':' + contract.toLowerCase(),
    tokenId: toHex(computeLicenseTokenId(productId), { size: 32 }),
    transferable: terms.transferable, termsUrl: terms.termsUrl, termsVersion: terms.termsVersion,
    termsHash: licenseTermsHash(terms.termsUrl, terms.termsVersion),
    contentRef: 'x402:hosted:' + productId + ':content:1', supply: terms.supply,
  };
  return { ...definition, definitionHash: computeLicenseDefinitionHash(definition) };
}

/** flag/現在のデプロイ先と独立した読込。rotation/OFF で保存済みの権利を別定義へ変えない。 */
export function parseLicenseDefinition(raw: unknown): LicenseDefinition | null {
  const terms = parseLicenseTerms(raw);
  if (!terms) return null;
  const r = raw as Record<string, unknown>;
  if (r.schema !== 1 || r.rail !== 'jpyc' || (r.tokenChainId !== 137 && r.tokenChainId !== 80002) ||
      typeof r.contract !== 'string' || !isAddress(r.contract) || /^0x0{40}$/i.test(r.contract) ||
      typeof r.deploymentId !== 'string' || !r.deploymentId || r.deploymentId.length > 200 ||
      typeof r.tokenId !== 'string' || !HEX32.test(r.tokenId) ||
      typeof r.termsHash !== 'string' || !HEX32.test(r.termsHash) ||
      typeof r.definitionHash !== 'string' || !HEX32.test(r.definitionHash) ||
      typeof r.contentRef !== 'string' || !/^x402:hosted:h_[0-9a-f]{32}:content:1$/.test(r.contentRef)) return null;
  const id = r.contentRef.slice('x402:hosted:'.length, -':content:1'.length);
  const d: LicenseDefinition = {
    schema: 1, rail: 'jpyc', tokenChainId: r.tokenChainId, contract: getAddress(r.contract),
    deploymentId: r.deploymentId, tokenId: r.tokenId as Hex, transferable: terms.transferable,
    termsUrl: terms.termsUrl, termsVersion: terms.termsVersion, termsHash: r.termsHash as Hex,
    contentRef: r.contentRef, supply: terms.supply, definitionHash: r.definitionHash as Hex,
  };
  if (toHex(computeLicenseTokenId(id), { size: 32 }) !== d.tokenId ||
      licenseTermsHash(d.termsUrl, d.termsVersion) !== d.termsHash || computeLicenseDefinitionHash(d) !== d.definitionHash) return null;
  return d;
}

export function parseLicenseRegistration(raw: unknown): LicenseRegistration | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!['pending', 'registered', 'failed'].includes(String(r.status)) || !Number.isSafeInteger(r.attempts) || Number(r.attempts) < 0 ||
      (r.txHash !== undefined && (typeof r.txHash !== 'string' || !HEX32.test(r.txHash))) ||
      (r.lastError !== undefined && (typeof r.lastError !== 'string' || r.lastError.length > 500)) ||
      (r.status === 'registered' && r.txHash === undefined)) return null;
  return { status: r.status as LicenseRegistration['status'], attempts: Number(r.attempts),
    ...(r.txHash ? { txHash: r.txHash as Hex } : {}), ...(r.lastError ? { lastError: r.lastError as string } : {}) };
}
