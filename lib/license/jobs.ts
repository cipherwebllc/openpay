import 'server-only';

import { isAddress, keccak256, type Address, type Hex } from 'viem';
import { kvGet } from '@/lib/kv';
import type { PurchaseAuthorizationClaim } from '@/lib/x402/purchaseIntent';
import { parseLicenseDefinition, type LicenseDefinition } from './definition';
import { licenseObligationKey } from './stock';
import { licenseRegistrationJobKey } from './product';

export type LicenseJobStatus = 'awaiting_finality' | 'pending' | 'submitted' | 'minted' | 'registered' | 'retryable' | 'needs_repair';
export type LicenseBlockEvidence = { blockNumber: string; blockHash: Hex };
export type LicenseSubmission = {
  hash: Hex; serializedTransaction: Hex; nonce: number; signer: Address; fromBlock: string;
};
type JobBase = {
  version: 1; productId: string; license: LicenseDefinition; status: LicenseJobStatus;
  attempts: number; nextAttemptAt: number; lastError?: string;
  lease?: { token: string; until: number };
  submission?: LicenseSubmission;
  mintTxHash?: Hex; mintBlock?: LicenseBlockEvidence;
  scanFromBlock?: string; alertPending?: boolean; alertedAt?: number;
};
export type LicenseMintJob = JobBase & {
  kind: 'mint'; paymentKey: Hex; payer: Address; intentSalt: Hex;
  payment: PurchaseAuthorizationClaim; txHash: Hex; purchasedAt: number;
  paymentBlock?: LicenseBlockEvidence;
};
export type LicenseJob = LicenseMintJob | (JobBase & { kind: 'register' });
export type LicenseProof = { status: LicenseJobStatus | 'unknown'; mintTxHash?: Hex };

const HEX32 = /^0x[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const hex32 = (v: unknown): v is Hex => typeof v === 'string' && HEX32.test(v);
function block(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const b = v as LicenseBlockEvidence;
  return typeof b.blockNumber === 'string' && DECIMAL.test(b.blockNumber) && hex32(b.blockHash);
}

/** B1 の registration kind も読み、新規保存時だけ register に揃える。 */
export function parseLicenseJob(raw: string | null): LicenseJob | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw);
    const license = parseLicenseDefinition(r?.license);
    if (!license || r.version !== 1 || !['mint', 'register', 'registration'].includes(r.kind) ||
      typeof r.productId !== 'string' || license.contentRef !== 'x402:hosted:' + r.productId + ':content:1' ||
      !['awaiting_finality', 'pending', 'submitted', 'minted', 'registered', 'retryable', 'needs_repair'].includes(r.status) ||
      !integer(r.attempts) || !integer(r.nextAttemptAt)) return null;
    if (r.lease !== undefined && (typeof r.lease?.token !== 'string' || !integer(r.lease.until))) return null;
    if (r.mintTxHash !== undefined && !hex32(r.mintTxHash)) return null;
    if (r.paymentBlock !== undefined && !block(r.paymentBlock)) return null;
    if (r.mintBlock !== undefined && !block(r.mintBlock)) return null;
    if (r.status === 'submitted' && !r.submission) return null;
    if ((r.status === 'minted' || r.status === 'registered') && (!r.mintTxHash || !r.mintBlock)) return null;
    if (r.scanFromBlock !== undefined && (typeof r.scanFromBlock !== 'string' || !DECIMAL.test(r.scanFromBlock))) return null;
    if (r.submission !== undefined) {
      const s = r.submission;
      if (!hex32(s?.hash) || typeof s.serializedTransaction !== 'string' || !/^0x(?:[0-9a-f]{2})+$/.test(s.serializedTransaction) ||
        keccak256(s.serializedTransaction) !== s.hash || !integer(s.nonce) || !isAddress(s.signer) ||
        typeof s.fromBlock !== 'string' || !DECIMAL.test(s.fromBlock)) return null;
    }
    if (r.kind === 'mint' && (!hex32(r.paymentKey) || !hex32(r.intentSalt) || !hex32(r.txHash) ||
      !isAddress(r.payer) || !integer(r.purchasedAt) || !r.payment || typeof r.payment !== 'object' || !hex32(r.payment.nonce))) return null;
    return { ...r, kind: r.kind === 'registration' ? 'register' : r.kind, license };
  } catch {
    // 壊れた義務を新規ジョブと解釈して再発行する波及を断つ。原本/index は削除しない。
    return null;
  }
}

export function licenseJobKey(member: string): string | null {
  if (HEX32.test(member)) return licenseObligationKey(member);
  if (/^registration:h_[0-9a-f]{32}$/.test(member)) return licenseRegistrationJobKey(member.slice(13));
  return null;
}

export async function readLicenseProof(paymentKey: Hex): Promise<LicenseProof> {
  const result = await kvGet(licenseObligationKey(paymentKey));
  // 証明の保存障害を、購入時点に発生した権利の消滅へ波及させない。
  if (!result.ok) return { status: 'unknown' };
  const job = parseLicenseJob(result.value);
  if (!job || job.kind !== 'mint' || job.paymentKey !== paymentKey) return { status: 'unknown' };
  return { status: job.status, ...(job.mintTxHash ? { mintTxHash: job.mintTxHash } : job.submission ? { mintTxHash: job.submission.hash } : {}) };
}
