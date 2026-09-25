import { getAddress } from 'viem';
import { createCliSigner } from './cliSigner.mjs';

const CHAINS = new Map([
  ['eip155:137', 'polygon'],
  ['eip155:80002', 'polygon-amoy'],
]);

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when SIGNER_MODE=kova`);
  return value;
}

export function createKovaSigner(env = process.env, { execFileImpl } = {}) {
  const wallet = required(env, 'KOVA_WALLET');
  const rawAddress = required(env, 'KOVA_AGENT_ADDRESS');
  let address;
  try {
    address = getAddress(rawAddress);
  } catch {
    // Invalid configuration must not echo an accidentally pasted secret through startup errors.
    throw new Error('KOVA_AGENT_ADDRESS must be an EVM address when SIGNER_MODE=kova');
  }
  const bin = env.KOVA_BIN?.trim() || 'kova';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(bin)) {
    throw new Error('KOVA_BIN must be a PATH executable name');
  }
  return createCliSigner({
    address, env, execFileImpl, bin,
    deadlineMs: 30_000,
    excludedEnvPrefixes: ['STEWARD_'],
    args({ domain }, json) {
      // The installed SDK derives domain.chainId from the validated 402 network and
      // passes only typed-data to this hook. Never take a chain override from env.
      const chain = CHAINS.get(`eip155:${domain.chainId}`);
      if (!chain) throw new Error('kova_sign_failed');
      return ['sign', 'typed-data', '--name', wallet, '--chain', chain, '--data', json];
    },
    parseResponse(stdout) {
      const body = JSON.parse(stdout);
      if (body?.ok === false && body?.error?.code === 'POLICY_DENIED') {
        return { errorCode: 'POLICY_DENIED' };
      }
      // Unknown envelopes/recoveryId encodings are not repaired. Amoy/mainnet acceptance
      // completed on 2026-09-25; Kova 0.1.2 policy does not limit this typed-data path.
      return { signature: body?.ok === true ? body?.data?.signature : undefined };
    },
    errors: {
      failed: 'kova_sign_failed',
      notFound: 'kova_not_found',
      response: { POLICY_DENIED: 'kova_policy_denied' },
    },
  });
}
