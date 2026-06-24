// x402 facilitator の受領証明 (receipt)。settle 成功時に OpenPay 専用鍵 (X402_RECEIPT_SIGNING_KEY・
// server-only・relayer 鍵とは分離) で settlement を EIP-712 署名し、オフライン検証可能な証明を発行する。
// 鍵未設定なら receipt は発行されない (settle 自体は成立する)。検証は recoverTypedDataAddress で署名者を
// 復元し、公開 facilitator signer (= receiptSignerAddress) と一致するか確認する。/supported が signer を
// 公開するため、第三者は本モジュール無しでも (任意の EIP-712 ライブラリで) 検証できる。

import { privateKeyToAccount } from 'viem/accounts';
import {
  recoverTypedDataAddress,
  getAddress,
  isAddress,
  isHex,
  type Address,
  type Hex,
} from 'viem';
import { logger } from '@/lib/logger';
import {
  buildForwarderNonce,
  type ForwarderSettleParams,
} from '@/lib/relay/forwarderIntent';

// off-chain attestation 用の EIP-712 domain (verifyingContract/chainId は持たず、chainId は message の
// フィールドに入れる)。署名・検証で完全一致させる。
const RECEIPT_EIP712_DOMAIN = {
  name: 'OpenPay x402 Facilitator',
  version: '1',
} as const;

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
} as const;

export type X402Receipt = {
  txHash: Hex; // settle の on-chain tx
  payer: Address; // 顧客 (from)
  payTo: Address; // 実 seller (merchant・表示額の受領先)
  amount: string; // atomic JPYC (merchantValue = seller 受領額)
  fee: string; // atomic JPYC (feeValue = OpenPay 手数料)
  asset: Address; // JPYC token
  chainId: number;
  timestamp: number; // unix 秒 (発行時刻)
  nonce: Hex; // forwarder commitment nonce (authorization 識別子)
};

export type SignedX402Receipt = X402Receipt & { signature: Hex };

// X402_RECEIPT_SIGNING_KEY (server-only)。不正/未設定は null → receipt 非発行 (settle は成立)。
const RECEIPT_KEY = (() => {
  const raw = process.env.X402_RECEIPT_SIGNING_KEY;
  if (!raw || !isHex(raw)) return null;
  try {
    return privateKeyToAccount(raw);
  } catch {
    logger.warn('x402.receipt.invalid_key', {});
    return null;
  }
})();

/** 公開 facilitator receipt signer アドレス (/supported で公開・検証側の期待値)。鍵未設定なら null。 */
export function receiptSignerAddress(): Address | null {
  return RECEIPT_KEY ? getAddress(RECEIPT_KEY.address) : null;
}

function toMessage(r: X402Receipt) {
  return {
    txHash: r.txHash,
    payer: r.payer,
    payTo: r.payTo,
    amount: BigInt(r.amount),
    fee: BigInt(r.fee),
    asset: r.asset,
    chainId: BigInt(r.chainId),
    timestamp: BigInt(r.timestamp),
    nonce: r.nonce,
  };
}

// settle 成功の settlement から receipt を組む (timestamp は発行時刻・nonce は forwarder commitment)。
export function makeSettlementReceipt(
  txHash: Hex,
  chainId: number,
  forwarder: Address,
  asset: Address,
  params: ForwarderSettleParams,
): X402Receipt {
  return {
    txHash,
    payer: params.from,
    payTo: params.merchant,
    amount: params.merchantValue.toString(),
    fee: params.feeValue.toString(),
    asset,
    chainId,
    timestamp: Math.floor(Date.now() / 1000),
    nonce: buildForwarderNonce(params, chainId, forwarder),
  };
}

// receipt を EIP-712 署名する。鍵未設定なら null (receipt 非発行)。
export async function signReceipt(r: X402Receipt): Promise<Hex | null> {
  if (!RECEIPT_KEY) return null;
  return RECEIPT_KEY.signTypedData({
    domain: RECEIPT_EIP712_DOMAIN,
    types: RECEIPT_TYPES,
    primaryType: 'Receipt',
    message: toMessage(r),
  });
}

// receipt + 署名を検証する。signer を復元し公開 facilitator signer と一致するか返す。
export async function verifyReceipt(
  r: X402Receipt,
  signature: Hex,
): Promise<{ valid: boolean; signer: Address | null }> {
  const expected = receiptSignerAddress();
  if (!expected) return { valid: false, signer: null };
  let signer: Address;
  try {
    signer = await recoverTypedDataAddress({
      domain: RECEIPT_EIP712_DOMAIN,
      types: RECEIPT_TYPES,
      primaryType: 'Receipt',
      message: toMessage(r),
      signature,
    });
  } catch {
    return { valid: false, signer: null };
  }
  const recovered = getAddress(signer);
  return { valid: recovered === expected, signer: recovered };
}

const isDec = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9]+$/.test(v);

// 任意 JSON から X402Receipt を検証付きで取り出す (verify-receipt route 用)。不正は null。
export function parseReceipt(raw: unknown): X402Receipt | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.txHash !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(r.txHash) ||
    !isAddress(r.payer as string) ||
    !isAddress(r.payTo as string) ||
    !isDec(r.amount) ||
    !isDec(r.fee) ||
    !isAddress(r.asset as string) ||
    typeof r.chainId !== 'number' ||
    !Number.isInteger(r.chainId) ||
    typeof r.timestamp !== 'number' ||
    !Number.isInteger(r.timestamp) ||
    typeof r.nonce !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(r.nonce)
  ) {
    return null;
  }
  return {
    txHash: r.txHash as Hex,
    payer: getAddress(r.payer as string),
    payTo: getAddress(r.payTo as string),
    amount: r.amount,
    fee: r.fee,
    asset: getAddress(r.asset as string),
    chainId: r.chainId,
    timestamp: r.timestamp,
    nonce: r.nonce as Hex,
  };
}
