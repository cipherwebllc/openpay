import { randomBytes } from 'node:crypto';
import {
  bytesToHex,
  encodeAbiParameters,
  getAddress,
  isAddress,
  keccak256,
} from 'viem';

export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

function isObject(value) {
  return typeof value === 'object' && value !== null;
}

function requireDec(value, label) {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    throw new Error(`${label} must be a decimal string`);
  }
  return value;
}

function requireAddress(value, label) {
  if (typeof value !== 'string' || !isAddress(value)) {
    throw new Error(`${label} must be an EVM address`);
  }
  return getAddress(value);
}

function requireBytes32(value, label) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} must be bytes32`);
  }
  return value;
}

export function chainIdFromNetwork(network) {
  if (typeof network !== 'string') throw new Error('network must be a string');
  const match = /^eip155:([0-9]+)$/.exec(network);
  if (!match) throw new Error(`unsupported network: ${network}`);
  return Number(match[1]);
}

export function normalizePaymentRequirements(raw) {
  if (!isObject(raw)) throw new Error('accepts[0] must be an object');
  if (raw.scheme !== 'exact') throw new Error(`unsupported scheme: ${raw.scheme}`);
  const chainId = chainIdFromNetwork(raw.network);
  const asset = requireAddress(raw.asset, 'asset');
  const payTo = requireAddress(raw.payTo, 'payTo');
  const maxAmountRequired = BigInt(
    requireDec(raw.maxAmountRequired, 'maxAmountRequired'),
  );
  const extra = raw.extra;
  if (!isObject(extra)) throw new Error('extra is required');
  if (extra.assetTransferMethod !== 'eip3009') {
    throw new Error(`unsupported assetTransferMethod: ${extra.assetTransferMethod}`);
  }
  if (typeof extra.name !== 'string' || extra.name.length === 0) {
    throw new Error('extra.name is required');
  }
  if (typeof extra.version !== 'string' || extra.version.length === 0) {
    throw new Error('extra.version is required');
  }
  const openpay = extra.openpay;
  if (!isObject(openpay) || openpay.mode !== 'forwarder-split') {
    throw new Error('extra.openpay.forwarder-split is required');
  }
  const forwarder = requireAddress(openpay.forwarder, 'extra.openpay.forwarder');
  if (payTo !== forwarder) throw new Error('payTo must match extra.openpay.forwarder');
  const merchant = requireAddress(openpay.merchant, 'extra.openpay.merchant');
  const merchantValue = BigInt(
    requireDec(openpay.merchantValue, 'extra.openpay.merchantValue'),
  );
  const feeReceiver = requireAddress(openpay.feeReceiver, 'extra.openpay.feeReceiver');
  const feeValue = BigInt(requireDec(openpay.feeValue, 'extra.openpay.feeValue'));
  const commitVersion = requireBytes32(
    openpay.commitVersion,
    'extra.openpay.commitVersion',
  );
  const total = merchantValue + feeValue;
  if (maxAmountRequired !== total) {
    throw new Error('maxAmountRequired must equal merchantValue + feeValue');
  }
  return {
    scheme: raw.scheme,
    network: raw.network,
    chainId,
    asset,
    maxTimeoutSeconds: requirePositiveInteger(
      raw.maxTimeoutSeconds,
      'maxTimeoutSeconds',
    ),
    extra: {
      name: extra.name,
      version: extra.version,
      openpay: {
        forwarder,
        merchant,
        merchantValue,
        feeReceiver,
        feeValue,
        commitVersion,
      },
    },
  };
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

export function buildForwarderNonce(params, chainId, forwarder, commitVersion) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
      ],
      [
        commitVersion,
        params.from,
        params.merchant,
        params.merchantValue,
        params.feeReceiver,
        params.feeValue,
        params.validAfter,
        params.validBefore,
        params.intentSalt,
        BigInt(chainId),
        forwarder,
      ],
    ),
  );
}

export function buildTypedDataFromPaymentRequirements(rawAccept, authorization) {
  const accept = normalizePaymentRequirements(rawAccept);
  const params = {
    from: requireAddress(authorization.from, 'authorization.from'),
    merchant: accept.extra.openpay.merchant,
    merchantValue: accept.extra.openpay.merchantValue,
    feeReceiver: accept.extra.openpay.feeReceiver,
    feeValue: accept.extra.openpay.feeValue,
    validAfter: BigInt(requireDec(authorization.validAfter, 'authorization.validAfter')),
    validBefore: BigInt(requireDec(authorization.validBefore, 'authorization.validBefore')),
    intentSalt: requireBytes32(authorization.intentSalt, 'authorization.intentSalt'),
  };
  const forwarder = accept.extra.openpay.forwarder;
  const value = params.merchantValue + params.feeValue;
  return {
    accept,
    params,
    typedData: {
      domain: {
        name: accept.extra.name,
        version: accept.extra.version,
        chainId: accept.chainId,
        verifyingContract: accept.asset,
      },
      types: RECEIVE_WITH_AUTHORIZATION_TYPES,
      primaryType: 'ReceiveWithAuthorization',
      message: {
        from: params.from,
        to: forwarder,
        value,
        validAfter: params.validAfter,
        validBefore: params.validBefore,
        nonce: buildForwarderNonce(
          params,
          accept.chainId,
          forwarder,
          accept.extra.openpay.commitVersion,
        ),
      },
    },
  };
}

export function createAuthorization(
  from,
  maxTimeoutSeconds,
  nowSec = Math.floor(Date.now() / 1000),
) {
  return {
    from: getAddress(from),
    validAfter: '0',
    validBefore: String(nowSec + maxTimeoutSeconds),
    intentSalt: bytesToHex(randomBytes(32)),
  };
}

export function encodePaymentPayload(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

export function decodePaymentResponse(raw) {
  if (!raw) return null;
  return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
}

export function paymentPayloadFor(accept, authorization, signature) {
  return {
    x402Version: 1,
    scheme: accept.scheme,
    network: accept.network,
    payload: {
      signature,
      authorization,
    },
  };
}
