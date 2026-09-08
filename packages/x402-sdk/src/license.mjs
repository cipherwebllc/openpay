import { createPublicClient, http, keccak256, parseAbi, toBytes } from 'viem';
import { polygon, polygonAmoy } from 'viem/chains';
import {
  DEFAULT_LICENSE_ORIGIN, MAX_LICENSE_UINT256, LicenseError, LicenseRpcError,
  licenseAddress, licenseIdentity, licenseOrigin,
} from './licenseCommon.mjs';

export { LicenseError, LicenseRpcError } from './licenseCommon.mjs';

const BALANCE_ABI = parseAbi(['function balanceOf(address account, uint256 id) view returns (uint256)']);
const NFT_STATUSES = new Set([
  'awaiting_finality', 'pending', 'submitted', 'minted', 'registered',
  'retryable', 'needs_repair', 'unknown',
]);

export async function hasLicense({ address, chainId, contract, tokenId, rpcUrl, publicClient }) {
  const holderAddress = licenseAddress(address);
  const identity = licenseIdentity({ chainId, contract, tokenId });
  if (rpcUrl !== undefined && publicClient !== undefined) {
    throw new TypeError('Provide rpcUrl or publicClient, not both');
  }
  const chain = [polygon, polygonAmoy].find((value) => value.id === chainId);
  if (publicClient === undefined && rpcUrl === undefined && !chain) {
    throw new TypeError('rpcUrl or publicClient is required for this chainId');
  }
  if (rpcUrl !== undefined && (typeof rpcUrl !== 'string' || !/^https?:\/\//.test(rpcUrl))) {
    throw new TypeError('rpcUrl must be an HTTP(S) URL');
  }
  const client = publicClient ?? createPublicClient({
    chain, transport: http(rpcUrl, { retryCount: 0, timeout: 10_000 }),
  });
  try {
    // Verify the endpoint's chain, then pin balanceOf to the reported block. A wrong
    // network or partial RPC response must never become a false ownership verdict.
    if (await client.getChainId() !== chainId) throw new Error('RPC chainId mismatch');
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
  if (typeof product !== 'string' || !/^h_[0-9a-f]{32}$/.test(product)) {
    throw new TypeError('product must be an OpenPay product ID (h_ plus 32 lowercase hex digits)');
  }
  const trustedOrigin = licenseOrigin(origin);
  const url = new URL('/api/license/verify', trustedOrigin);
  url.searchParams.set('address', expectedAddress);
  url.searchParams.set('product', product);
  let response;
  try {
    response = await fetchImpl(url.toString(), {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15_000),
      headers: { accept: 'application/json' },
    });
  } catch (cause) {
    throw new LicenseError('network_error', 'License verify request failed', { cause });
  }
  // Never send the query to a redirect destination. Also reject an injected fetch
  // that reports following a redirect or returning a different origin's response.
  if (response.redirected || response.type === 'opaqueredirect' ||
    (response.status >= 300 && response.status < 400) ||
    (response.url && new URL(response.url).origin !== trustedOrigin)) {
    throw new LicenseError('redirect', 'License verify redirects are not allowed');
  }
  if (!response.ok) throw new LicenseError('http_error', `License verify failed: HTTP ${response.status}`);
  let body;
  try { body = await response.json(); } catch (cause) {
    throw new LicenseError('invalid_response', 'License verify response must be JSON', { cause });
  }
  return validateResponse(body, expectedAddress, product);
}
