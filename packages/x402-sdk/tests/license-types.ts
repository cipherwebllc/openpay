import { createPublicClient, http, type Address } from 'viem';
import {
  createLicenseGate, hasLicense, verifyLicense, LicenseError, LicenseRpcError,
  type LicenseBalance, type LicenseSession, type LicenseVerification, type LicenseNonceStore,
} from 'openpay-x402-sdk';

// Included by the repository's typecheck; this function is never executed.
export async function licenseTypeContracts(address: Address, contract: Address) {
  const identity = { chainId: 137, contract, tokenId: 1n };
  const publicClient = createPublicClient({ transport: http('https://rpc.example') });
  const balance: LicenseBalance = await hasLicense({ ...identity, address, publicClient });
  await hasLicense({ ...identity, address, tokenId: '0xffff', rpcUrl: 'https://rpc.example' });
  // @ts-expect-error JS numbers lose uint256 identity precision
  hasLicense({ ...identity, address, tokenId: 1 });
  // @ts-expect-error chainId is part of the required full identity
  hasLicense({ address, contract, tokenId: 1n });
  // @ts-expect-error choose exactly one RPC transport
  hasLicense({ ...identity, address, publicClient, rpcUrl: 'https://rpc.example' });
  const verification: LicenseVerification = await verifyLicense({ address, product: `h_${'a'.repeat(32)}` });
  // @ts-expect-error unknown rights cannot be assigned to boolean
  const entitled: boolean = verification.entitled;
  const nonceStore: LicenseNonceStore = { set() {}, consume() { return undefined; } };
  const gate = createLicenseGate({ ...identity, publicClient, nonceStore, session: { secret: 's'.repeat(32) } });
  const message: string = await gate.challenge(address);
  const token: string = await gate.verify({ message, signature: '0xabc' });
  const session: LicenseSession = gate.check(token);
  // @ts-expect-error gate identity also rejects numbers
  createLicenseGate({ ...identity, tokenId: 1, session: { secret: 's'.repeat(32) } });
  const rpcError: LicenseError = new LicenseRpcError();
  return { balance, verification, entitled, session, rpcError };
}
