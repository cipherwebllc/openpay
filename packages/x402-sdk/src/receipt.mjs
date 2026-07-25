import {
  getAddress,
  isAddress,
  recoverTypedDataAddress,
} from 'viem';
import {
  DEFAULT_PAYMENT_FETCH_TIMEOUT_MS,
  fetchPaymentTarget,
} from './network.mjs';

const RECEIPT_DOMAIN = {
  name: 'OpenPay x402 Facilitator',
  version: '1',
};

const RECEIPT_TYPES = {
  Receipt: [
    { name: 'txHash', type: 'bytes32' },
    { name: 'payer', type: 'address' },
    { name: 'payTo', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'fee', type: 'uint256' },
    { name: 'asset', type: 'address' },
    { name: 'chainId', type: 'uint256' },
    { name: 'timestamp', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBytes32(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isSignature(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{130}$/.test(value);
}

function isUintString(value) {
  return typeof value === 'string' && /^[0-9]{1,78}$/.test(value);
}

async function readJson(response) {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function createReceiptSignerResolver({
  discoveryUrl,
  fetchImpl = globalThis.fetch,
  lookup,
  requestTimeoutMs = DEFAULT_PAYMENT_FETCH_TIMEOUT_MS,
}) {
  const supportedUrl = new URL(
    '/api/facilitator/supported',
    new URL(discoveryUrl).origin,
  ).toString();
  let cachedSigner = null;
  let pending = null;

  return async function resolveReceiptSigner() {
    if (cachedSigner !== null) return cachedSigner;
    if (pending !== null) return pending;
    pending = (async () => {
      try {
        const response = await fetchPaymentTarget(supportedUrl, {
          fetchImpl,
          lookup,
          timeoutMs: requestTimeoutMs,
          headers: { accept: 'application/json' },
        });
        const body = await readJson(response);
        if (
          !response.ok ||
          !isObject(body) ||
          !isAddress(body.receiptSigner)
        ) {
          return null;
        }
        cachedSigner = getAddress(body.receiptSigner);
        return cachedSigner;
      } catch {
        return null;
      } finally {
        pending = null;
      }
    })();
    return pending;
  };
}

function parsedSignedReceipt(paymentResponse) {
  if (
    !isObject(paymentResponse) ||
    paymentResponse.success !== true ||
    !isBytes32(paymentResponse.transaction) ||
    typeof paymentResponse.network !== 'string' ||
    !isAddress(paymentResponse.payer) ||
    !isObject(paymentResponse.receipt)
  ) {
    return null;
  }
  const receipt = paymentResponse.receipt;
  if (
    !isBytes32(receipt.txHash) ||
    !isAddress(receipt.payer) ||
    !isAddress(receipt.payTo) ||
    !isUintString(receipt.amount) ||
    !isUintString(receipt.fee) ||
    !isAddress(receipt.asset) ||
    !Number.isSafeInteger(receipt.chainId) ||
    receipt.chainId <= 0 ||
    !Number.isSafeInteger(receipt.timestamp) ||
    receipt.timestamp < 0 ||
    !isBytes32(receipt.nonce) ||
    !isSignature(receipt.signature)
  ) {
    return null;
  }
  return {
    paymentResponse,
    receipt: {
      txHash: receipt.txHash,
      payer: getAddress(receipt.payer),
      payTo: getAddress(receipt.payTo),
      amount: receipt.amount,
      fee: receipt.fee,
      asset: getAddress(receipt.asset),
      chainId: receipt.chainId,
      timestamp: receipt.timestamp,
      nonce: receipt.nonce,
      signature: receipt.signature,
    },
  };
}

export async function verifyBoundPaymentResponse(
  paymentResponse,
  {
    expectedSigner,
    payer,
    network,
    asset,
    chainId,
    merchant,
    merchantValue,
    feeValue,
    nonce,
  },
) {
  if (!isAddress(expectedSigner)) return false;
  const parsed = parsedSignedReceipt(paymentResponse);
  if (parsed === null) return false;
  const { receipt } = parsed;
  if (
    parsed.paymentResponse.transaction.toLowerCase() !==
      receipt.txHash.toLowerCase() ||
    parsed.paymentResponse.network !== network ||
    getAddress(parsed.paymentResponse.payer) !== getAddress(payer) ||
    receipt.payer !== getAddress(payer) ||
    receipt.payTo !== getAddress(merchant) ||
    receipt.amount !== merchantValue.toString() ||
    receipt.fee !== feeValue.toString() ||
    receipt.asset !== getAddress(asset) ||
    receipt.chainId !== chainId ||
    receipt.nonce.toLowerCase() !== nonce.toLowerCase()
  ) {
    return false;
  }

  try {
    const recovered = await recoverTypedDataAddress({
      domain: RECEIPT_DOMAIN,
      types: RECEIPT_TYPES,
      primaryType: 'Receipt',
      message: {
        txHash: receipt.txHash,
        payer: receipt.payer,
        payTo: receipt.payTo,
        amount: BigInt(receipt.amount),
        fee: BigInt(receipt.fee),
        asset: receipt.asset,
        chainId: BigInt(receipt.chainId),
        timestamp: BigInt(receipt.timestamp),
        nonce: receipt.nonce,
      },
      signature: receipt.signature,
    });
    return getAddress(recovered) === getAddress(expectedSigner);
  } catch {
    return false;
  }
}
