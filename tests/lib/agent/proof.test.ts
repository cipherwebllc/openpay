// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address } from 'viem';

const kv = vi.hoisted(() => ({ kvGet: vi.fn(), kvMget: vi.fn(), kvGetDel: vi.fn(), kvSetNxGet: vi.fn(), kvEval: vi.fn(), kvLrange: vi.fn() }));
vi.mock('@/lib/kv', () => kv);
import {
  AGENT_PROOF_AUDIENCE, AGENT_PROOF_DOMAIN, AGENT_PROOF_PURPOSE, AGENT_PROOF_TYPES,
  agentProofTypedData, issueAgentProofChallenge, parseAgentProof, verifyAgentProof,
} from '@/lib/agent/proof';
import { agentPurchasesKv } from '../../_helpers/agentPurchasesKv';

const agent = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const other = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const address = agent.address.toLowerCase() as Address;
const encode = (data: unknown) => Buffer.from(JSON.stringify(data)).toString('base64url');
let store: ReturnType<typeof agentPurchasesKv>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(1800000000000);
  store = agentPurchasesKv(kv);
});
afterEach(() => vi.restoreAllMocks());

async function signed(signer = agent, declared = address) {
  const challenge = await issueAgentProofChallenge(declared);
  if (!challenge.ok) throw new Error(challenge.reason);
  const signature = await signer.signTypedData(agentProofTypedData(declared, challenge));
  const data = { v: 1, address: declared, nonce: challenge.nonce, signature };
  return { challenge, data, proof: encode(data), key: `agent:proof:nonce:${declared.toLowerCase()}:${challenge.nonce}` };
}

describe('Agent proof', () => {
  it('pins the EIP-712 domain, fields, purpose and audience', () => {
    expect(AGENT_PROOF_DOMAIN).toEqual({ name: 'OpenPay Agent Proof', version: '1', chainId: 137 });
    expect(AGENT_PROOF_AUDIENCE).toBe('https://open-pay.jp');
    expect(AGENT_PROOF_PURPOSE).toBe('bind-purchase-history');
    expect(AGENT_PROOF_TYPES.Proof).toEqual([
      { name: 'address', type: 'address' }, { name: 'purpose', type: 'string' },
      { name: 'audience', type: 'string' }, { name: 'nonce', type: 'bytes32' },
      { name: 'issuedAt', type: 'uint256' }, { name: 'expiresAt', type: 'uint256' },
    ]);
  });

  it('issues a random 32-byte nonce with lowercase key, server times and NX EX 300', async () => {
    const a = await issueAgentProofChallenge(agent.address);
    const b = await issueAgentProofChallenge(agent.address);
    expect(a).toMatchObject({ ok: true, issuedAt: 1800000000, expiresAt: 1800000300 });
    if (!a.ok || !b.ok) throw new Error('challenge');
    expect(a.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a.nonce).not.toBe(b.nonce);
    expect(kv.kvSetNxGet).toHaveBeenCalledWith(`agent:proof:nonce:${address}:${a.nonce}`, JSON.stringify({ issuedAt: 1800000000, expiresAt: 1800000300 }), 300);
  });

  it('verifies an actual EOA signature and consumes exactly once', async () => {
    const { proof, key } = await signed();
    expect(await verifyAgentProof(proof)).toEqual({ ok: true, address });
    expect(store.strings.has(key)).toBe(false);
    expect(await verifyAgentProof(proof)).toEqual({ ok: false, reason: 'expired_or_unknown' });
  });

  it('only one simultaneous submit succeeds (the other loses GETDEL)', async () => {
    const { proof } = await signed();
    const results = await Promise.all([verifyAgentProof(proof), verifyAgentProof(proof)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results).toContainEqual({ ok: false, reason: 'already_used' });
  });

  it('signature mismatch does not consume the nonce', async () => {
    const { proof, key } = await signed(other);
    expect(await verifyAgentProof(proof)).toEqual({ ok: false, reason: 'signature_mismatch' });
    expect(kv.kvGetDel).not.toHaveBeenCalled();
    expect(store.strings.has(key)).toBe(true);
  });

  it('changing address cannot reuse another address nonce', async () => {
    const { data } = await signed();
    expect(await verifyAgentProof(encode({ ...data, address: other.address }))).toEqual({ ok: false, reason: 'expired_or_unknown' });
    expect(kv.kvGetDel).not.toHaveBeenCalled();
  });

  it('accepts checksum address but returns lowercase', async () => {
    const { proof } = await signed(agent, agent.address);
    expect(await verifyAgentProof(proof)).toEqual({ ok: true, address });
  });

  it.each([300, 301])('rejects expiration after %i seconds without consuming', async (seconds) => {
    const { proof } = await signed();
    vi.mocked(Date.now).mockReturnValue(1800000000000 + seconds * 1000);
    expect(await verifyAgentProof(proof)).toEqual({ ok: false, reason: 'expired_or_unknown' });
    expect(kv.kvGetDel).not.toHaveBeenCalled();
  });

  it('uses only the stored time, rejecting a signature over different times', async () => {
    const { proof, key, challenge } = await signed();
    store.strings.set(key, JSON.stringify({ issuedAt: challenge.issuedAt - 1, expiresAt: challenge.expiresAt - 1 }));
    expect(await verifyAgentProof(proof)).toEqual({ ok: false, reason: 'signature_mismatch' });
    expect(kv.kvGetDel).not.toHaveBeenCalled();
  });

  it('does not use a supplied audience, domain or purpose', async () => {
    const { data, challenge } = await signed();
    const typedData = agentProofTypedData(address, challenge);
    for (const message of [{ ...typedData.message, audience: 'https://attacker.test' }, { ...typedData.message, purpose: 'read-history' }]) {
      const signature = await agent.signTypedData({ ...typedData, message });
      expect(await verifyAgentProof(encode({ ...data, signature }))).toEqual({ ok: false, reason: 'signature_mismatch' });
    }
    const signature = await agent.signTypedData({ ...typedData, domain: { ...typedData.domain, chainId: 1 } });
    expect(await verifyAgentProof(encode({ ...data, signature }))).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it.each([null, 1, '', 'a'.repeat(1025), '****', 'e30=', 'e30\n', 'e30', 'bm90LWpzb24'])('rejects malformed envelope %s', async (value) => {
    expect(parseAgentProof(value)).toBeNull();
    expect(await verifyAgentProof(value)).toEqual({ ok: false, reason: 'malformed' });
    expect(kv.kvGet).not.toHaveBeenCalled();
  });

  it.each([
    { v: 2 }, { address: `${address}\n` }, { address: '0x123' },
    { nonce: '0x11' }, { nonce: `0x${'z'.repeat(64)}` }, { signature: '0x00' },
    { issuedAt: 1800000000 }, { expiresAt: 1800000300 }, { audience: 'https://attacker.test' },
  ])('rejects malformed fields or additions %j', async (change) => {
    const { data } = await signed();
    expect(await verifyAgentProof(encode({ ...data, ...change }))).toEqual({ ok: false, reason: 'malformed' });
    expect(kv.kvGet).not.toHaveBeenCalled();
  });

  it.each(['kvGet', 'kvGetDel'] as const)('%s storage failures return fixed code', async (op) => {
    const { proof } = await signed();
    kv[op].mockResolvedValueOnce({ ok: false, reason: 'network_error' });
    expect(await verifyAgentProof(proof)).toEqual({ ok: false, reason: 'storage_error' });
    kv[op].mockRejectedValueOnce(new Error('private storage details'));
    expect(await verifyAgentProof(proof)).toEqual({ ok: false, reason: 'storage_error' });
  });

  it('nonce collision or write failure never issues a challenge', async () => {
    for (const result of [{ ok: true, value: 'existing' }, { ok: false, reason: 'timeout' }]) {
      kv.kvSetNxGet.mockResolvedValueOnce(result);
      expect(await issueAgentProofChallenge(address)).toEqual({ ok: false, reason: 'storage_error' });
    }
    kv.kvSetNxGet.mockRejectedValueOnce(new Error('down'));
    expect(await issueAgentProofChallenge(address)).toEqual({ ok: false, reason: 'storage_error' });
  });

  it.each(['{', 'null', '{}', '{"issuedAt":1,"expiresAt":2}'])('corrupt nonce record %s fails closed', async (raw) => {
    const { proof, key } = await signed();
    store.strings.set(key, raw);
    expect(await verifyAgentProof(proof)).toEqual({ ok: false, reason: 'storage_error' });
    expect(kv.kvGetDel).not.toHaveBeenCalled();
  });
});
