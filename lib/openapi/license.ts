// 利用ライセンス NFT (ENABLE_CREATOR_STORE かつ ENABLE_LICENSE_NFT) の公開 operation。
// 掲載可否は lib/openapi/document.ts の buildOpenApiDocument が文書生成ごとに判定する。

import { schemaFromExample } from '@/lib/openapi/schema';

export const LICENSE_OPENAPI_PATHS = {
  '/api/license/metadata/{id}': {
    get: {
      operationId: 'licenseMetadata', tags: ['Licenses'], security: [],
      summary: 'ERC-1155 wallet metadata for a registered license product',
      description: 'Public JSON with Japanese product name, image and terms. Feature OFF, invalid/unknown/unregistered products or no public seller handle return 404. Paused licenses remain resolvable.',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^h_[0-9a-f]{32}$' } }],
      responses: {
        '200': { description: 'ERC-1155 metadata with OpenSea attributes',
          headers: { 'Cache-Control': { schema: { type: 'string', const: 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400' } } },
          content: { 'application/json': { schema: {
            type: 'object',
            properties: {
              ...(schemaFromExample({ name: '利用ライセンス', description: '利用条件: https://seller.example/terms (v1)', image: 'https://open-pay.jp/og/handle?h=seller&locale=ja', external_url: 'https://open-pay.jp/@seller?product=h_4fa999236d92e95a76bb36dcd7446208' }).properties as Record<string, unknown>),
              attributes: { type: 'array', items: { type: 'object',
                properties: { trait_type: { type: 'string' }, value: { type: ['string', 'integer'] } } } },
            },
          } } } },
        '404': { description: 'License metadata unavailable' },
        '503': { description: 'Product or handle storage unavailable' },
      },
    },
  },
  '/api/license/products/{id}': {
    get: {
      operationId: 'resolveLicense', tags: ['Licenses'], security: [],
      summary: 'Resolve a license product to its immutable ERC-1155 identity',
      description: 'Public HTTPS descriptor; feature OFF, unknown/digital products or no public seller handle return 404. Paused licenses remain resolvable. Stock is display-only and can be null.',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^h_[0-9a-f]{32}$' } }],
      responses: {
        '200': { description: 'Version 1 license product descriptor',
          headers: { 'Cache-Control': { schema: { type: 'string', const: 'public, s-maxage=60, stale-while-revalidate=300' } } },
          content: { 'application/json': { schema: { $ref: '#/components/schemas/LicenseDescriptor' } } } },
        '400': { description: 'Invalid product ID; rejected before IO' },
        '404': { description: 'License unavailable' },
        '429': { description: 'Trusted-IP rate limit exceeded', headers: { 'Retry-After': { schema: { type: 'string', const: '60' } } } },
        '503': { description: 'Product or handle storage unavailable' },
      },
    },
  },
  '/api/license/verify': {
    get: {
      operationId: 'verifyLicense', tags: ['Licenses'], security: [],
      summary: 'Read purchase or holder rights for a wallet and license product',
      description: 'Public HTTPS status, not authentication or signed proof. entitled:null means unknown. Feature OFF returns 404. 30 requests per trusted IP per minute; bounded RPC budget.',
      parameters: [
        { name: 'address', in: 'query', required: true, schema: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' } },
        { name: 'product', in: 'query', required: true, schema: { type: 'string', pattern: '^h_[0-9a-f]{32}$' } },
      ],
      responses: {
        '200': { description: 'Version 1 status; unknown is entitled:null', headers: { 'Cache-Control': { schema: { type: 'string', const: 'no-store' } } },
          content: { 'application/json': { schema: { $ref: '#/components/schemas/LicenseVerification' } } } },
        '400': { description: 'Invalid or duplicated selectors; rejected before IO' },
        '404': { description: 'License unavailable' },
        '429': { description: 'Trusted-IP rate limit exceeded', headers: { 'Retry-After': { schema: { type: 'string', const: '60' } } } },
        '503': { description: 'Product storage unavailable' },
      },
    },
  },
} as const;
