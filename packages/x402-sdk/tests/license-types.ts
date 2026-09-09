import { createPublicClient, http, type Address } from 'viem';
import {
  createLicenseGate, hasLicense, verifyLicense, resolveLicense, LicenseError, LicenseRpcError,
  type LicenseDescriptor,
  type LicenseBalance, type LicenseSession, type LicenseVerification, type LicenseNonceStore,
} from 'openpay-x402-sdk';

// Included by the repository's typecheck; this function is never executed.
export async function licenseTypeContracts(address: Address, contract: Address) {
  const identity = { chainId: 137, contract, tokenId: 1n };
  const publicClient = createPublicClient({ transport: http('https://rpc.example') });
  const balance: LicenseBalance = await hasLicense({ ...identity, address, publicClient });
  const product = `h_${'a'.repeat(32)}`;
  const descriptor: LicenseDescriptor = await resolveLicense({ product, fetch: globalThis.fetch });
  await hasLicense({ address, product });
  await hasLicense({ address, product, publicClient, origin: 'https://open-pay.jp', fetch: globalThis.fetch });
  await hasLicense({ address, product, rpcUrl: 'https://rpc.example' });
  const byProduct = createLicenseGate({ product, session: { secret: 's'.repeat(32), origin: 'https://service.example' } });
  await byProduct.ready();
  const productSession: LicenseSession = byProduct.check('token');
  // @ts-expect-error do not mix an explicit identity with descriptor discovery
  hasLicense({ address, product, ...identity });
  // @ts-expect-error gates also choose exactly one identity source
  createLicenseGate({ product, ...identity, session: { secret: 's'.repeat(32) } });
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
  return { balance, verification, descriptor, productSession, entitled, session, rpcError };
}
