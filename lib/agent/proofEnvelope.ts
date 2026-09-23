import type { Address, Hex } from 'viem';
import { normalizeAgentAddress } from './purchaseAddress';

export const AGENT_PROOF_MAX_BYTES = 1024;
export type AgentProof = { v: 1; address: Address; nonce: Hex; signature: Hex };

const fixedHex = (value: unknown, bytes: number): value is Hex =>
  typeof value === 'string' && value.length === 2 + bytes * 2 && /^0x[0-9a-fA-F]+$/.test(value);

/** Strict, unpadded base64url envelope; supplied times/domain are never adopted. */
export function parseAgentProof(encoded: unknown): AgentProof | null {
  if (typeof encoded !== 'string' || encoded.length > AGENT_PROOF_MAX_BYTES || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const bytes = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
    if (btoa(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== encoded) return null;
    const proof = JSON.parse(new TextDecoder('utf-8', { ignoreBOM: true }).decode(Uint8Array.from(bytes, (char) => char.charCodeAt(0))));
    const address = normalizeAgentAddress(proof?.address);
    if (!proof || proof.v !== 1 || !address || Object.keys(proof).sort().join(',') !== 'address,nonce,signature,v' ||
        !fixedHex(proof.nonce, 32) || !fixedHex(proof.signature, 65)) return null;
    return { v: 1, address, nonce: proof.nonce.toLowerCase() as Hex, signature: proof.signature };
  } catch {
    // Untrusted envelope parsing must not escape into the page or the verification route.
    return null;
  }
}

