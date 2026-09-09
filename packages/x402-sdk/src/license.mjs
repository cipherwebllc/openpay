import { createPublicClient, http, keccak256, parseAbi, toBytes } from 'viem';
import { polygon, polygonAmoy } from 'viem/chains';
import {
  DEFAULT_LICENSE_ORIGIN, MAX_LICENSE_UINT256, LicenseError, LicenseRpcError,
  licenseAddress, licenseIdentity, licenseOrigin, licenseProduct, licenseSelector,
} from './licenseCommon.mjs';

export { LicenseError, LicenseRpcError } from './licenseCommon.mjs';

const BALANCE_ABI = parseAbi(['function balanceOf(address account, uint256 id) view returns (uint256)']);
const NFT_STATUSES = new Set([
  'awaiting_finality', 'pending', 'submitted', 'minted', 'registered',
  'retryable', 'needs_repair', 'unknown',
]);

export async function hasLicense({ address, product, origin, fetch, chainId, contract, tokenId, rpcUrl, publicClient }) {
  const holderAddress = licenseAddress(address);
  const selected = licenseSelector({ product, chainId, contract, tokenId });
  if (rpcUrl !== undefined && publicClient !== undefined) {
    throw new TypeError('Provide rpcUrl or publicClient, not both');
  }
  if (rpcUrl !== undefined && (typeof rpcUrl !== 'string' || !/^https?:\/\//.test(rpcUrl))) {
    throw new TypeError('rpcUrl must be an HTTP(S) URL');
  }
  const identity = selected ?? licenseIdentity(await resolveLicense({ product, origin, fetch }));
  const chain = [polygon, polygonAmoy].find((value) => value.id === identity.chainId);
  if (publicClient === undefined && rpcUrl === undefined && !chain) {
    throw new TypeError('rpcUrl or publicClient is required for this chainId');
  }
  const client = publicClient ?? createPublicClient({
    chain, transport: http(rpcUrl, { retryCount: 0, timeout: 10_000 }),
  });
  try {
    // Verify the endpoint's chain, then pin balanceOf to the reported block. A wrong
    // network or partial RPC response must never become a false ownership verdict.
    if (await client.getChainId() !== identity.chainId) throw new Error('RPC chainId mismatch');
    const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
    if (typeof blockNumber !== 'bigint' || blockNumber < 0n) throw new Error('Invalid RPC block number');
    const balance = await client.readContract({
      address: identity.contract, abi: BALANCE_ABI, functionName: 'balanceOf',
      args: [holderAddress, identity.tokenId], blockNumber,
    });
    if (typeof balance !== 'bigint' || balance < 0n || balance > MAX_LICENSE_UINT256) {
      throw new Error('Invalid RPC balance');
    }
    return { holder: balance > 0n, balance, blockNumber };
  } catch (cause) {
    throw new LicenseRpcError('Unable to read license ownership on the requested chain', { cause });
  }
}

function object(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateResponse(body, address, product) {
  try {
    if (!object(body) || body.version !== 1 || licenseAddress(body.address) !== address ||
      !object(body.license) || body.license.productId !== product ||
      typeof body.license.tokenId !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(body.license.tokenId)) {
      throw new Error('Invalid version, address echo or license identity');
    }
    const identity = licenseIdentity(body.license);
    if (identity.tokenId !== BigInt(keccak256(toBytes(`openpay:license:${product}`))) ||
      (typeof body.entitled !== 'boolean' && body.entitled !== null) ||
      ![null, 'purchase', 'holder'].includes(body.basis) ||
      (body.entitled === null && body.basis !== null) ||
      (body.entitled === true && body.basis === null) ||
      !object(body.nft) || !NFT_STATUSES.has(body.nft.status) ||
      (body.nft.mintTxHash !== undefined &&
        (typeof body.nft.mintTxHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(body.nft.mintTxHash))) ||
      (body.observedBlock !== undefined &&
        (typeof body.observedBlock !== 'string' || !/^(0|[1-9][0-9]*)$/.test(body.observedBlock))) ||
      typeof body.checkedAt !== 'string' || !Number.isFinite(Date.parse(body.checkedAt))) {
      throw new Error('Invalid license status');
    }
  } catch (cause) {
    // Reject untrusted/malformed state rather than granting or denying access from it.
    throw new LicenseError('invalid_response', 'Invalid license verify response', { cause });
  }
  // Project only the validated v1 fields; null remains the API's unknown state.
  return {
    version: 1, address: body.address,
    license: { chainId: body.license.chainId, contract: body.license.contract,
      tokenId: body.license.tokenId, productId: body.license.productId },
    entitled: body.entitled, basis: body.basis,
    nft: { status: body.nft.status, ...(body.nft.mintTxHash !== undefined ? { mintTxHash: body.nft.mintTxHash } : {}) },
    ...(body.observedBlock !== undefined ? { observedBlock: body.observedBlock } : {}),
    checkedAt: body.checkedAt,
  };
}

export async function verifyLicense({ address, product, origin = DEFAULT_LICENSE_ORIGIN, fetch: fetchImpl = globalThis.fetch }) {
  const expectedAddress = licenseAddress(address);
  licenseProduct(product);
  const trustedOrigin = licenseOrigin(origin);
  const url = new URL('/api/license/verify', trustedOrigin);
  url.searchParams.set('address', expectedAddress);
  url.searchParams.set('product', product);
  return validateResponse(await fetchLicenseJson(url, trustedOrigin, fetchImpl), expectedAddress, product);
}

async function fetchLicenseJson(url, trustedOrigin, fetchImpl, label = 'verify') {
  let response;
  try {
    response = await fetchImpl(url.toString(), {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15_000),
      headers: { accept: 'application/json' },
    });
  } catch (cause) {
    throw new LicenseError('network_error', `License ${label} request failed`, { cause });
  }
  // Never send the query to a redirect destination. Also reject an injected fetch
  // that reports following a redirect or returning a different origin's response.
  if (response.redirected || response.type === 'opaqueredirect' ||
    (response.status >= 300 && response.status < 400) ||
    (response.url && new URL(response.url).origin !== trustedOrigin)) {
    throw new LicenseError('redirect', `License ${label} redirects are not allowed`);
  }
  if (!response.ok) throw new LicenseError('http_error', `License ${label} failed: HTTP ${response.status}`);
  try { return await response.json(); } catch (cause) {
    throw new LicenseError('invalid_response', `License ${label} response must be JSON`, { cause });
  }
}

function httpsUrl(value) {
  if (typeof value !== 'string') throw new Error('URL must be a string');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid HTTPS URL');
  return url;
}

export async function resolveLicense({ product, origin = DEFAULT_LICENSE_ORIGIN, fetch: fetchImpl = globalThis.fetch }) {
  licenseProduct(product);
  const trustedOrigin = licenseOrigin(origin, { httpsOnly: true });
  const body = await fetchLicenseJson(new URL(`/api/license/products/${product}`, trustedOrigin), trustedOrigin, fetchImpl, 'descriptor');
  try {
    if (!object(body) || body.version !== 1 || body.productId !== product ||
      ![137, 80002].includes(body.chainId) || typeof body.tokenId !== 'string' ||
      !/^0x[0-9a-f]{64}$/.test(body.tokenId) ||
      licenseIdentity(body).tokenId !== BigInt(keccak256(toBytes(`openpay:license:${product}`))) ||
      typeof body.transferable !== 'boolean' || typeof body.saleActive !== 'boolean' || typeof body.registered !== 'boolean' ||
      typeof body.termsVersion !== 'string' || !body.termsVersion.trim() || body.termsVersion.length > 128 ||
      typeof body.termsUrl !== 'string' || body.termsUrl.length > 512 ||
      !Number.isSafeInteger(body.supply) || body.supply < 1 || body.supply > 10000 ||
      (body.remaining !== null && (!Number.isSafeInteger(body.remaining) || body.remaining < 0 || body.remaining > body.supply)) ||
      !['operator', 'third_party'].includes(body.sellerRole)) throw new Error('Invalid descriptor fields');
    httpsUrl(body.termsUrl);
    const productUrl = httpsUrl(body.productUrl);
    const verifyUrl = httpsUrl(body.verifyUrl);
    if (productUrl.origin !== DEFAULT_LICENSE_ORIGIN || !/^\/@[^/]+$/.test(productUrl.pathname) || productUrl.hash ||
      productUrl.search !== `?product=${product}` || verifyUrl.origin !== DEFAULT_LICENSE_ORIGIN ||
      verifyUrl.pathname !== '/api/license/verify' || verifyUrl.search !== `?product=${product}` || verifyUrl.hash) {
      throw new Error('Invalid descriptor links');
    }
  } catch (cause) {
    // Untrusted descriptor fields must never become a gate's ownership identity.
    throw new LicenseError('invalid_response', 'Invalid license product descriptor', { cause });
  }
  return {
    version: 1, productId: body.productId, chainId: body.chainId, contract: body.contract, tokenId: body.tokenId,
    transferable: body.transferable, termsUrl: body.termsUrl, termsVersion: body.termsVersion,
    supply: body.supply, remaining: body.remaining, saleActive: body.saleActive, registered: body.registered,
    productUrl: body.productUrl, verifyUrl: body.verifyUrl, sellerRole: body.sellerRole,
  };
}
