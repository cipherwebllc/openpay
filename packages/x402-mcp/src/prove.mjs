import { fetchPaymentTarget } from 'openpay-x402-sdk';

// Keep these in sync with lib/agent/proof.ts. Remote responses never define what we sign.
const AGENT_PROOF_DOMAIN = { name: 'OpenPay Agent Proof', version: '1', chainId: 137 };
const AGENT_PROOF_TYPES = {
  Proof: [
    { name: 'address', type: 'address' },
    { name: 'purpose', type: 'string' },
    { name: 'audience', type: 'string' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint256' },
    { name: 'expiresAt', type: 'uint256' },
  ],
};
const AGENT_PROOF_PURPOSE = 'bind-purchase-history';
const AGENT_PROOF_AUDIENCE = 'https://open-pay.jp';
const AGENT_PROOF_TTL_SEC = 300;
const MAX_CHALLENGE_BYTES = 8 * 1024;
const MAX_UNIX_SECONDS = 99_999_999_999; // year 5138; anything larger is not a seconds timestamp
const NOTE = 'This link is valid for 5 minutes and can be used only once. Open it in a browser signed in to OpenPay with SIWE to bind this Agent to that account and view its purchase history. Do not forward it to anyone: if someone else opens it first while signed in, it binds to their account; run wallet_prove again to reclaim it by overwriting the binding. It does not access funds or keys. Records of what was purchased are stored on OpenPay servers for 400 days after the last record, separately from local wallet_history.';
const failure = (error) => ({ ok: false, error });

async function readChallenge(response) {
  if (response.status === 404) return failure('feature_disabled');
  if (response.status === 429 || response.status >= 500) return failure('challenge_unavailable');
  if (response.status !== 200 || response.body === null) return failure('challenge_invalid');

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CHALLENGE_BYTES) return failure('challenge_invalid');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const challenge = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    // Reject additions by key name without reading their values (including domain/types).
    if (!challenge || Object.keys(challenge).sort().join(',') !== 'expiresAt,issuedAt,nonce' ||
        typeof challenge.nonce !== 'string' || challenge.nonce.length !== 66 || !/^0x[0-9a-fA-F]{64}$/.test(challenge.nonce) ||
        !Number.isSafeInteger(challenge.issuedAt) || !Number.isSafeInteger(challenge.expiresAt) ||
        // Times are Unix seconds; a millisecond-scale value means a malformed responder, not a clock difference.
        challenge.issuedAt < 0 || challenge.issuedAt > MAX_UNIX_SECONDS || challenge.expiresAt - challenge.issuedAt !== AGENT_PROOF_TTL_SEC) {
      return failure('challenge_invalid');
    }
    return { ok: true, challenge };
  } catch {
    // Untrusted JSON/encoding must never reach the signer or appear in error output.
    return failure('challenge_invalid');
  }
}

export async function proveWallet({ signer, origin, fetchImpl, lookup }) {
  const address = signer.address;
  // Signing surface: a plaintext origin would let a network attacker hand us a challenge and steer the
  // bind link to itself (binding hijack; funds and keys are never exposed). Refuse before any request.
  if (!origin.startsWith('https://')) return failure('insecure_origin');
  let result;
  let response;
  try {
    response = await fetchPaymentTarget(`${origin}/api/agent/proof/challenge?address=${address}`, {
      fetchImpl, lookup, headers: { accept: 'application/json' },
    });
    result = await readChallenge(response);
  } catch {
    // Network/body failures must prevent signing without echoing a nonce or credentials.
    return failure('challenge_unavailable');
  } finally {
    // Oversized/broken and status-only responses must stop downloading without leaking errors.
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
  }
  if (!result.ok) return result;
  const { nonce, issuedAt, expiresAt } = result.challenge;

  let signature;
  try {
    signature = await signer.signTypedData({
      domain: AGENT_PROOF_DOMAIN,
      types: AGENT_PROOF_TYPES,
      primaryType: 'Proof',
      message: {
        address, purpose: AGENT_PROOF_PURPOSE, audience: AGENT_PROOF_AUDIENCE,
        nonce, issuedAt: BigInt(issuedAt), expiresAt: BigInt(expiresAt),
      },
    });
  } catch {
    // Signer errors can contain the typed data; return only a fixed code, never raw proof data.
    return failure('proof_signing_failed');
  }
  const proof = Buffer.from(JSON.stringify({ v: 1, address, nonce, signature })).toString('base64url');
  return { ok: true, address, bindUrl: `${origin}/agent?address=${address}#proof=${proof}`, expiresAt, note: NOTE };
}
