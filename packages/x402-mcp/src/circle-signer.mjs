import { getAddress } from 'viem';
import { createCliSigner } from './cliSigner.mjs';

const CHAINS = new Map([
  ['eip155:137', 'MATIC'],
  ['eip155:80002', 'MATIC-AMOY'],
]);

export function createCircleSigner(env = process.env, { execFileImpl } = {}) {
  const rawAddress = env.CIRCLE_WALLET_ADDRESS?.trim();
  if (!rawAddress) throw new Error('CIRCLE_WALLET_ADDRESS is required when SIGNER_MODE=circle');
  let address;
  try {
    address = getAddress(rawAddress);
  } catch {
    // Invalid configuration must not echo an accidentally pasted secret through startup errors.
    throw new Error('CIRCLE_WALLET_ADDRESS must be an EVM address when SIGNER_MODE=circle');
  }
  const bin = env.CIRCLE_BIN?.trim() || 'circle';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(bin)) {
    throw new Error('CIRCLE_BIN must be a PATH executable name');
  }
  return createCliSigner({
    address, env, execFileImpl, bin,
    deadlineMs: 60_000,
    excludedEnvPrefixes: ['STEWARD_', 'KOVA_'],
    args({ domain }, json) {
      // Chain selection comes only from SDK-validated typed-data, never an env override.
      const chain = CHAINS.get(`eip155:${domain.chainId}`);
      if (!chain) throw new Error('circle_sign_failed');
      return ['wallet', 'sign', 'typed-data', json, '--address', address, '--chain', chain, '--output', 'json'];
    },
    parseResponse(stdout) {
      let body;
      try {
        body = JSON.parse(stdout);
      } catch {
        // The CLI also emits bare hex (table/quiet). Common validation rejects all other text.
        return { signature: stdout.trim() };
      }
      if (body?.error) return { errorCode: body.error.code ?? 'INTERNAL' };
      // @circle-fin/cli 1.1.4 bundle: extractSignature reads challengeResult.data.signature;
      // emitSignature -> output({ signature }) wraps stdout as { data: { signature } }.
      // Also accept a direct JSON signature per the adapter contract; never scan noisy output.
      return { signature: body?.data?.signature ?? body?.signature ?? stdout.trim() };
    },
    errors: {
      failed: 'circle_sign_failed',
      notFound: 'circle_not_found',
      // loadAgentEnv -> resolveOrReport: absent/locally expired session -> AUTH_REQUIRED.
      // mapErrorToOutput -> codeForApiStatus: CircleApiError/SdkApiError HTTP 401 -> AUTH_EXPIRED.
      response: {
        AUTH_REQUIRED: 'circle_login_required',
        AUTH_EXPIRED: 'circle_login_required',
      },
      // PERMISSION_DENIED covers both HTTP 403 and unaccepted Terms in this bundle.
      // A policy-specific typed-data denial code is unknown: do not infer circle_policy_denied.
    },
  });
}

// 1.1.4 statusCommand -> output(buildJsonResult): { data: { type: 'agent',
// mainnet: { email?, tokenStatus, expiresIn? }, testnet: { ... } } }.
// tokenStatus = VALID / EXPIRED / NOT_LOGGED_IN; neither section exposes expiresAt.
// No sessions -> { error: { code: 'AUTH_REQUIRED', message } }. MCP does not probe status
// or read sessions. Non-TTY challenge completion, policy enforcement on typed-data, and
// Amoy/mainnet purchases remain unverified; a signature alone proves no payment.
