// 公開ライセンス API の v1 契約。OpenAPI と実応答の Ajv fence で共有する。
const PRODUCT_ID = { type: 'string', pattern: '^h_[0-9a-f]{32}$' } as const;
const ADDRESS = { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$', not: { const: '0x' + '0'.repeat(40) } } as const;
const TOKEN_ID = { type: 'string', pattern: '^0x[0-9a-f]{64}$' } as const;
const IDENTITY = { productId: PRODUCT_ID, chainId: { type: 'integer', enum: [137, 80002] }, contract: ADDRESS, tokenId: TOKEN_ID } as const;

export const LICENSE_DESCRIPTOR_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['version', 'productId', 'chainId', 'contract', 'tokenId', 'transferable', 'termsUrl', 'termsVersion', 'supply', 'remaining', 'saleActive', 'registered', 'productUrl', 'verifyUrl', 'sellerRole'],
  properties: {
    version: { const: 1 }, ...IDENTITY,
    transferable: { type: 'boolean' },
    termsUrl: { type: 'string', pattern: '^https://', maxLength: 512 },
    termsVersion: { type: 'string', minLength: 1, maxLength: 128, pattern: '\\S' },
    supply: { type: 'integer', minimum: 1, maximum: 10000 },
    remaining: { type: ['integer', 'null'], minimum: 0, maximum: 10000, description: 'supply minus sold and reserved; null when stock is unknown. Display only, not a reservation.' },
    protectedDelivery: { type: 'boolean', description: 'Seller configured ticket delivery; not a protection or availability guarantee.' },
    saleActive: { type: 'boolean' }, registered: { type: 'boolean' },
    productUrl: { type: 'string', pattern: '^https://open-pay\\.jp/@[^/?#]+\\?product=h_[0-9a-f]{32}$' },
    verifyUrl: { type: 'string', pattern: '^https://open-pay\\.jp/api/license/verify\\?product=h_[0-9a-f]{32}$', description: 'Append address to check wallet rights.' },
    sellerRole: { type: 'string', enum: ['operator', 'third_party'] },
  },
} as const;

export const LICENSE_VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['version', 'address', 'license', 'entitled', 'basis', 'nft', 'checkedAt'],
  properties: {
    version: { const: 1 }, address: ADDRESS,
    license: { type: 'object', additionalProperties: false, required: ['productId', 'chainId', 'contract', 'tokenId'], properties: IDENTITY },
    entitled: { type: ['boolean', 'null'], description: 'null is unknown, never a negative ownership verdict.' },
    basis: { enum: [null, 'purchase', 'holder'] },
    nft: { type: 'object', additionalProperties: false, required: ['status'], properties: {
      status: { enum: ['awaiting_finality', 'pending', 'submitted', 'minted', 'registered', 'retryable', 'needs_repair', 'unknown'] },
      mintTxHash: TOKEN_ID,
    } },
    observedBlock: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
    checkedAt: { type: 'string', format: 'date-time' },
  },
} as const;
