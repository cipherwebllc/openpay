import { getAddress, isAddress, zeroAddress } from 'viem';

export const DEFAULT_LICENSE_ORIGIN = 'https://open-pay.jp';
export const MAX_LICENSE_UINT256 = (1n << 256n) - 1n;

export class LicenseError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'LicenseError';
    this.code = code;
  }
}

export class LicenseRpcError extends LicenseError {
  constructor(message = 'License RPC failed', options) {
    super('rpc_error', message, options);
    this.name = 'LicenseRpcError';
  }
}

export function licenseAddress(value, label = 'address') {
  if (typeof value !== 'string' || !isAddress(value) || value.toLowerCase() === zeroAddress) {
    throw new TypeError(`${label} must be a non-zero EVM address`);
  }
  return getAddress(value);
}

export function licenseIdentity({ chainId, contract, tokenId }) {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new TypeError('chainId must be a positive safe integer');
  }
  if (typeof tokenId !== 'bigint' &&
    !(typeof tokenId === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(tokenId))) {
    throw new TypeError('tokenId must be a uint256 bigint or 0x-hex string, never a number');
  }
  const id = BigInt(tokenId);
  if (id < 0n || id > MAX_LICENSE_UINT256) throw new TypeError('tokenId must fit uint256');
  return { chainId, contract: licenseAddress(contract, 'contract'), tokenId: id };
}

export function licenseOrigin(value) {
  let url;
  try { url = new URL(value); } catch {
    throw new TypeError('origin must be an HTTPS origin');
  }
  // The status authority and signing domain must not be substituted over plaintext.
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
    url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('origin must use HTTPS (HTTP only for localhost/127.0.0.1), without credentials or a path');
  }
  return url.origin;
}
