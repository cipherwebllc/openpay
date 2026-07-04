import { getAddress, isHex, verifyTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const SIGNER_MODES = {
  envKey: 'env-key',
  steward: 'steward',
};

function nonEmpty(raw) {
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

export function readSignerMode(env = process.env) {
  const mode = nonEmpty(env.SIGNER_MODE) ?? SIGNER_MODES.envKey;
  if (mode !== SIGNER_MODES.envKey && mode !== SIGNER_MODES.steward) {
    throw new Error('SIGNER_MODE must be "env-key" or "steward"');
  }
  return mode;
}

function requireEnv(env, name) {
  const value = nonEmpty(env[name]);
  if (value === undefined) throw new Error(`${name} is required when SIGNER_MODE=steward`);
  return value;
}

function requireHttpUrl(raw, label) {
  if (typeof raw !== 'string') throw new Error(`${label} must be an http(s) URL`);
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error(`${label} must be an http(s) URL`);
    }
    return url.toString().replace(/\/+$/, '');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${label} must be`)) {
      throw error;
    }
    throw new Error(`${label} must be an http(s) URL`);
  }
}

function requirePrivateKey(env) {
  const key = nonEmpty(env.BUYER_PRIVATE_KEY);
  if (key === undefined) {
    throw new Error('BUYER_PRIVATE_KEY is required when SIGNER_MODE=env-key');
  }
  if (!isHex(key) || key.length !== 66) {
    throw new Error('BUYER_PRIVATE_KEY must be a 32-byte 0x-prefixed hex string');
  }
  return key;
}

function toJsonValue(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, toJsonValue(item)]),
  );
}

function stewardRequestBody(typedData) {
  return {
    domain: toJsonValue(typedData.domain),
    types: toJsonValue(typedData.types),
    primaryType: typedData.primaryType,
    value: toJsonValue(typedData.message),
  };
}

async function readStewardJson(res) {
  const text = await res.text();
  if (text.length === 0) return { body: null, preview: '' };
  try {
    return { body: JSON.parse(text), preview: text.slice(0, 200) };
  } catch {
    return { body: null, preview: text.slice(0, 200) };
  }
}

function isObject(value) {
  return typeof value === 'object' && value !== null;
}

function stewardFailure(status, preview) {
  const suffix = preview.length > 0 ? preview : 'empty response body';
  return new Error(`steward sign-typed-data failed (${status}): ${suffix}`);
}

async function requestStewardSignature(config, fetchImpl, typedData) {
  const res = await fetchImpl(
    `${config.url}/vault/${encodeURIComponent(config.agentId)}/sign-typed-data`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Steward-Key': config.apiKey,
        'X-Steward-Tenant': config.tenant,
        'x-steward-signer-id': config.signerId,
        'x-steward-signer-secret': config.signerSecret,
      },
      body: JSON.stringify(stewardRequestBody(typedData)),
    },
  );
  const { body, preview } = await readStewardJson(res);
  if (
    !res.ok ||
    !isObject(body) ||
    body.ok !== true ||
    !isObject(body.data) ||
    typeof body.data.signature !== 'string'
  ) {
    throw stewardFailure(res.status, preview);
  }
  return body.data.signature;
}

function createEnvKeySigner(env) {
  const account = privateKeyToAccount(requirePrivateKey(env));
  return {
    mode: SIGNER_MODES.envKey,
    address: account.address,
    signTypedData: (typedData) => account.signTypedData(typedData),
  };
}

function createStewardSigner(env, fetchImpl) {
  const config = {
    url: requireHttpUrl(requireEnv(env, 'STEWARD_URL'), 'STEWARD_URL'),
    tenant: requireEnv(env, 'STEWARD_TENANT'),
    apiKey: requireEnv(env, 'STEWARD_API_KEY'),
    agentId: requireEnv(env, 'STEWARD_AGENT_ID'),
    agentAddress: getAddress(requireEnv(env, 'STEWARD_AGENT_ADDRESS')),
    signerId: requireEnv(env, 'STEWARD_SIGNER_ID'),
    signerSecret: requireEnv(env, 'STEWARD_SIGNER_SECRET'),
  };
  let firstSignatureVerified = false;

  return {
    mode: SIGNER_MODES.steward,
    address: config.agentAddress,
    async signTypedData(typedData) {
      const signature = await requestStewardSignature(config, fetchImpl, typedData);
      if (!firstSignatureVerified) {
        const verified = await verifyTypedData({
          ...typedData,
          address: config.agentAddress,
          signature,
        });
        // This contains agent/signer credential mix-ups before they propagate as invalid payment signatures sent to x402 resources.
        if (!verified) {
          throw new Error(
            'steward signature self-verification failed for STEWARD_AGENT_ADDRESS',
          );
        }
        firstSignatureVerified = true;
      }
      return signature;
    },
  };
}

export function createSigner(env = process.env, { fetchImpl = fetch } = {}) {
  const mode = readSignerMode(env);
  if (mode === SIGNER_MODES.envKey) return createEnvKeySigner(env);
  return createStewardSigner(env, fetchImpl);
}
