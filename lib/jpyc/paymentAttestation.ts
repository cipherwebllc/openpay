import 'server-only';

import { getAddress, keccak256, recoverTypedDataAddress, toBytes, type Address, type Hex } from 'viem';
import { receiptSignerAddress, receiptSigningAccount } from '@/lib/x402/receipt';

export const JPYC_PAYMENT_ATTESTATION_EIP712_DOMAIN = {
  name: 'OpenPay JPYC Payment Attestation',
  version: '1',
} as const;

export const JPYC_PAYMENT_ATTESTATION_TYPES = {
  JpycPayment: [
    { name: 'chainId', type: 'uint256' },
    { name: 'txHash', type: 'bytes32' },
    { name: 'blockNumber', type: 'uint256' },
    { name: 'transfersHash', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint256' },
    { name: 'licensee', type: 'address' },
  ],
} as const;

// Block numbers remain decimal strings in the JSON message.
export type JpycPaymentMessage = {
  chainId: number;
  txHash: Hex;
  blockNumber: string;
  transfersHash: Hex;
  issuedAt: number;
  licensee: Address;
};

export function transfersHash(items: readonly unknown[]): Hex {
  return keccak256(toBytes(JSON.stringify(items)));
}

function typedData(message: JpycPaymentMessage) {
  return {
    domain: JPYC_PAYMENT_ATTESTATION_EIP712_DOMAIN,
    types: JPYC_PAYMENT_ATTESTATION_TYPES,
    primaryType: 'JpycPayment' as const,
    message: { ...message, chainId: BigInt(message.chainId), blockNumber: BigInt(message.blockNumber), issuedAt: BigInt(message.issuedAt) },
  };
}

export async function signJpycPaymentAttestation(message: JpycPaymentMessage): Promise<Hex | null> {
  const account = receiptSigningAccount();
  return account ? account.signTypedData(typedData(message)) : null;
}

export async function verifyJpycPaymentAttestation(message: JpycPaymentMessage, signature: Hex) {
  const expected = receiptSignerAddress();
  if (!expected) return { valid: false, signer: null };
  try {
    const signer = getAddress(await recoverTypedDataAddress({ ...typedData(message), signature }));
    return { valid: signer === expected, signer };
  } catch {
    // Invalid external signatures are verification failures, not request failures.
    return { valid: false, signer: null };
  }
}
