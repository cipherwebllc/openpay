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

function redactStewardPreview(text, config) {
  let redacted = String(text);
  for (const secret of [config.apiKey, config.signerSecret]) {
    if (typeof secret === 'string' && secret.length > 0) {
      redacted = redacted.split(secret).join('[redacted_secret]');
    }
  }
  return redacted
    .replace(/\b0x[0-9a-fA-F]{64}\b/g, '[redacted_private_key]')
    .replace(/\b0x[0-9a-fA-F]{130}\b/g, '[redacted_signature]');
}

async function readStewardJson(res, config) {
  const text = await res.text();
  if (text.length === 0) return { body: null, preview: '' };
  const preview = redactStewardPreview(text, config).slice(0, 200);
  try {
    return { body: JSON.parse(text), preview };
  } catch {
    return { body: null, preview };
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
  const { body, preview } = await readStewardJson(res, config);
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

function createStewardSignerFromConfig(config, fetchImpl) {
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

function createStewardSigner(env, fetchImpl) {
  return createStewardSignerFromConfig(
    {
      url: requireHttpUrl(requireEnv(env, 'STEWARD_URL'), 'STEWARD_URL'),
      tenant: requireEnv(env, 'STEWARD_TENANT'),
      apiKey: requireEnv(env, 'STEWARD_API_KEY'),
      agentId: requireEnv(env, 'STEWARD_AGENT_ID'),
      agentAddress: getAddress(requireEnv(env, 'STEWARD_AGENT_ADDRESS')),
      signerId: requireEnv(env, 'STEWARD_SIGNER_ID'),
      signerSecret: requireEnv(env, 'STEWARD_SIGNER_SECRET'),
    },
    fetchImpl,
  );
}

export function createSigner(env = process.env, { fetchImpl = fetch } = {}) {
  const mode = readSignerMode(env);
  if (mode === SIGNER_MODES.envKey) return createEnvKeySigner(env);
  return createStewardSigner(env, fetchImpl);
}

function requireOptionsObject(options) {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new Error('client options must be an object');
  }
  return options;
}

function requireStewardOption(steward, key, label) {
  const value = nonEmpty(steward[key]);
  if (value === undefined) {
    throw new Error(`${label} is required when SIGNER_MODE=steward`);
  }
  return value;
}

function parseStewardOptions(steward) {
  if (typeof steward !== 'object' || steward === null || Array.isArray(steward)) {
    throw new Error('steward must be an object');
  }
  return {
    url: requireHttpUrl(
      requireStewardOption(steward, 'url', 'STEWARD_URL'),
      'STEWARD_URL',
    ),
    tenant: requireStewardOption(steward, 'tenant', 'STEWARD_TENANT'),
    apiKey: requireStewardOption(steward, 'apiKey', 'STEWARD_API_KEY'),
    agentId: requireStewardOption(steward, 'agentId', 'STEWARD_AGENT_ID'),
    agentAddress: getAddress(
      requireStewardOption(steward, 'agentAddress', 'STEWARD_AGENT_ADDRESS'),
    ),
    signerId: requireStewardOption(steward, 'signerId', 'STEWARD_SIGNER_ID'),
    signerSecret: requireStewardOption(
      steward,
      'signerSecret',
      'STEWARD_SIGNER_SECRET',
    ),
  };
}

function parseCustomSigner(signer) {
  if (typeof signer !== 'object' || signer === null || Array.isArray(signer)) {
    throw new Error('signer must be an object');
  }
  if (typeof signer.address !== 'string') {
    throw new Error('signer.address must be an EVM address');
  }
  let address;
  try {
    address = getAddress(signer.address);
  } catch {
    throw new Error('signer.address must be an EVM address');
  }
  if (typeof signer.signTypedData !== 'function') {
    throw new Error('signer.signTypedData must be a function');
  }
  return { signer, address };
}

export function parseSignerOptions(options = {}) {
  const input = requireOptionsObject(options);
  const selections = ['privateKey', 'steward', 'signer'].filter(
    (key) => input[key] !== undefined && input[key] !== null,
  );
  if (selections.length > 1) {
    throw new Error('privateKey, steward, and signer are mutually exclusive');
  }

  if (input.privateKey !== undefined && input.privateKey !== null) {
    const privateKey = nonEmpty(input.privateKey);
    if (privateKey === undefined) return { kind: 'none' };
    if (!isHex(privateKey) || privateKey.length !== 66) {
      throw new Error('BUYER_PRIVATE_KEY must be a 32-byte 0x-prefixed hex string');
    }
    return { kind: 'private-key', privateKey };
  }
  if (input.steward !== undefined && input.steward !== null) {
    return { kind: 'steward', config: parseStewardOptions(input.steward) };
  }
  if (input.signer !== undefined && input.signer !== null) {
    return { kind: 'custom', ...parseCustomSigner(input.signer) };
  }
  return { kind: 'none' };
}

export function createSignerFromOptions(
  options = {},
  { fetchImpl = fetch } = {},
) {
  const parsed = parseSignerOptions(options);
  if (parsed.kind === 'none') return null;
  if (parsed.kind === 'private-key') {
    const account = privateKeyToAccount(parsed.privateKey);
    return {
      mode: SIGNER_MODES.envKey,
      address: account.address,
      signTypedData: (typedData) => account.signTypedData(typedData),
    };
  }
  if (parsed.kind === 'steward') {
    return createStewardSignerFromConfig(parsed.config, fetchImpl);
  }
  return {
    mode: 'custom',
    address: parsed.address,
    signTypedData: (typedData) => parsed.signer.signTypedData(typedData),
  };
}
