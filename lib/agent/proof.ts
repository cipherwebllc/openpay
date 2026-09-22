import 'server-only';

import { randomBytes } from 'node:crypto';
import { recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { kvGet, kvGetDel, kvSetNxGet } from '@/lib/kv';
import { normalizeAgentAddress } from './purchaseAddress';

export const AGENT_PROOF_DOMAIN = { name: 'OpenPay Agent Proof', version: '1', chainId: 137 } as const;
export const AGENT_PROOF_TYPES = {
  Proof: [
    { name: 'address', type: 'address' },
    { name: 'purpose', type: 'string' },
    { name: 'audience', type: 'string' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint256' },
    { name: 'expiresAt', type: 'uint256' },
  ],
} as const;
export const AGENT_PROOF_PURPOSE = 'bind-purchase-history';
export const AGENT_PROOF_AUDIENCE = 'https://open-pay.jp';
export const AGENT_PROOF_TTL_SEC = 300;
export const AGENT_PROOF_MAX_BYTES = 1024;

export type AgentProof = { v: 1; address: Address; nonce: Hex; signature: Hex };
export type AgentProofChallenge = { nonce: Hex; issuedAt: number; expiresAt: number };
export type AgentProofFailure = 'malformed' | 'expired_or_unknown' | 'signature_mismatch' | 'already_used' | 'storage_error';
type Failure = { ok: false; reason: AgentProofFailure };

const nonceKey = (address: string, nonce: string) => `agent:proof:nonce:${address.toLowerCase()}:${nonce.toLowerCase()}`;
const nowSec = () => Math.floor(Date.now() / 1000);
const fixedHex = (value: unknown, bytes: number): value is Hex =>
  typeof value === 'string' && value.length === 2 + bytes * 2 && /^0x[0-9a-fA-F]+$/.test(value);

/** Strict, unpadded base64url envelope; supplied times/domain are never adopted. */
export function parseAgentProof(encoded: unknown): AgentProof | null {
  if (typeof encoded !== 'string' || encoded.length > AGENT_PROOF_MAX_BYTES || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) return null;
    const proof = JSON.parse(bytes.toString('utf8'));
    const address = normalizeAgentAddress(proof?.address);
    if (!proof || proof.v !== 1 || !address || Object.keys(proof).sort().join(',') !== 'address,nonce,signature,v' ||
        !fixedHex(proof.nonce, 32) || !fixedHex(proof.signature, 65)) return null;
    return { v: 1, address, nonce: proof.nonce.toLowerCase() as Hex, signature: proof.signature };
  } catch {
    // Untrusted envelope parsing must not escape as a route exception.
    return null;
  }
}

export function agentProofTypedData(address: Address, challenge: AgentProofChallenge) {
  return {
    domain: AGENT_PROOF_DOMAIN,
    types: AGENT_PROOF_TYPES,
    primaryType: 'Proof' as const,
    message: {
      address,
      purpose: AGENT_PROOF_PURPOSE,
      audience: AGENT_PROOF_AUDIENCE,
      nonce: challenge.nonce,
      issuedAt: BigInt(challenge.issuedAt),
      expiresAt: BigInt(challenge.expiresAt),
    },
  };
}

export async function issueAgentProofChallenge(address: string): Promise<({ ok: true } & AgentProofChallenge) | Failure> {
  const normalized = normalizeAgentAddress(address);
  if (!normalized) return { ok: false, reason: 'malformed' };
  try {
    const nonce = `0x${randomBytes(32).toString('hex')}` as Hex;
    const issuedAt = nowSec();
    const expiresAt = issuedAt + AGENT_PROOF_TTL_SEC;
    const saved = await kvSetNxGet(nonceKey(normalized, nonce), JSON.stringify({ issuedAt, expiresAt }), AGENT_PROOF_TTL_SEC);
    if (!saved.ok || saved.value !== null) return { ok: false, reason: 'storage_error' };
    return { ok: true, nonce, issuedAt, expiresAt };
  } catch {
    // No challenge may be issued without a confirmed server-side nonce record.
    return { ok: false, reason: 'storage_error' };
  }
}

export async function verifyAgentProof(encoded: unknown): Promise<{ ok: true; address: Address } | Failure> {
  const proof = parseAgentProof(encoded);
  if (!proof) return { ok: false, reason: 'malformed' };
  try {
    const key = nonceKey(proof.address, proof.nonce);
    const stored = await kvGet(key);
    if (!stored.ok) return { ok: false, reason: 'storage_error' };
    if (stored.value === null) return { ok: false, reason: 'expired_or_unknown' };
    const record = JSON.parse(stored.value);
    if (!record || !Number.isSafeInteger(record.issuedAt) || !Number.isSafeInteger(record.expiresAt) ||
        record.issuedAt < 0 || record.expiresAt - record.issuedAt !== AGENT_PROOF_TTL_SEC) {
      return { ok: false, reason: 'storage_error' };
    }
    if (record.issuedAt > nowSec() || record.expiresAt <= nowSec()) return { ok: false, reason: 'expired_or_unknown' };
    let recovered: Address;
    try {
      recovered = await recoverTypedDataAddress({
        ...agentProofTypedData(proof.address, { nonce: proof.nonce, issuedAt: record.issuedAt, expiresAt: record.expiresAt }),
        signature: proof.signature,
      });
    } catch {
      // Bad EOA signatures must not consume another attempt's nonce.
      return { ok: false, reason: 'signature_mismatch' };
    }
    if (recovered.toLowerCase() !== proof.address) return { ok: false, reason: 'signature_mismatch' };
    if (record.expiresAt <= nowSec()) return { ok: false, reason: 'expired_or_unknown' };
    const consumed = await kvGetDel(key);
    if (!consumed.ok) return { ok: false, reason: 'storage_error' };
    if (consumed.value === null) return { ok: false, reason: 'already_used' };
    if (consumed.value !== stored.value) return { ok: false, reason: 'storage_error' };
    if (record.expiresAt <= nowSec()) return { ok: false, reason: 'expired_or_unknown' };
    return { ok: true, address: proof.address };
  } catch {
    // Storage failure/corruption must not grant a binding or leak native error details.
    return { ok: false, reason: 'storage_error' };
  }
}
