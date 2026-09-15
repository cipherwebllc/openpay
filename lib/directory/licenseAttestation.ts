import 'server-only';

import { getAddress, keccak256, recoverTypedDataAddress, toBytes, type Address, type Hex } from 'viem';
import { receiptSignerAddress, receiptSigningAccount } from '@/lib/x402/receipt';

export const DIRECTORY_LICENSE_EIP712_DOMAIN = {
  name: 'OpenPay Directory License',
  version: '1',
} as const;

export const DIRECTORY_LICENSE_TYPES = {
  DirectoryLicense: [
    { name: 'licensee', type: 'address' },
    { name: 'licenseId', type: 'string' },
    { name: 'contentHash', type: 'bytes32' },
    { name: 'rows', type: 'uint256' },
    { name: 'issuedAt', type: 'uint256' },
  ],
} as const;

// JSON-safe integers: rows is the array length; issuedAt is Unix seconds.
export type DirectoryLicenseMessage = {
  licensee: Address;
  licenseId: string;
  contentHash: Hex;
  rows: number;
  issuedAt: number;
};

export function directoryContentHash(items: readonly unknown[]): Hex {
  return keccak256(toBytes(JSON.stringify(items)));
}

function typedData(message: DirectoryLicenseMessage) {
  return {
    domain: DIRECTORY_LICENSE_EIP712_DOMAIN,
    types: DIRECTORY_LICENSE_TYPES,
    primaryType: 'DirectoryLicense' as const,
    message: { ...message, rows: BigInt(message.rows), issuedAt: BigInt(message.issuedAt) },
  };
}

export async function signDirectoryLicense(message: DirectoryLicenseMessage): Promise<Hex | null> {
  const account = receiptSigningAccount();
  return account ? account.signTypedData(typedData(message)) : null;
}

export async function verifyDirectoryLicense(message: DirectoryLicenseMessage, signature: Hex) {
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
