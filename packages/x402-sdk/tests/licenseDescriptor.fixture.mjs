import { keccak256, toBytes } from 'viem';

export const product = `h_${'a'.repeat(32)}`;
export function descriptor(overrides = {}) {
  return {
    version: 1, productId: product, chainId: 137, contract: '0x3333333333333333333333333333333333333333',
    tokenId: keccak256(toBytes(`openpay:license:${product}`)), transferable: false,
    termsUrl: 'https://seller.example/terms', termsVersion: '1', supply: 10, remaining: 7,
    saleActive: true, registered: true, productUrl: `https://open-pay.jp/@seller?product=${product}`,
    verifyUrl: `https://open-pay.jp/api/license/verify?product=${product}`, sellerRole: 'third_party', ...overrides,
  };
}
