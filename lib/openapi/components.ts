// 基底文書 (lib/openapi/document.ts の OPENAPI_DOCUMENT) の components。schemas は Directory の
// 型と全領域共有の Error、responses は全領域が $ref する共通応答 (StorageUnavailable は
// buildOpenApiDocument が生成時に足す)。

export const BASE_OPENAPI_SCHEMAS = {
  DirectoryEntry: {
    type: 'object',
    required: [
      'slug',
      'name',
      'nameJa',
      'status',
      'sourceUrl',
      'sourceType',
      'verifiedAt',
      'updatedAt',
      'attribution',
      'facts',
      'editorial',
      'sourceCheckedAt',
      'sourceOk',
    ],
    properties: {
      slug: { type: 'string' },
      name: { type: 'string' },
      nameJa: { type: 'string' },
      status: { type: 'string', const: 'published' },
      sourceUrl: { type: 'string', format: 'uri' },
      sourceType: { type: 'string', enum: ['official', 'manual'] },
      verifiedAt: { type: 'string', format: 'date' },
      updatedAt: { type: 'string', format: 'date' },
      sourceCheckedAt: { type: ['string', 'null'], format: 'date-time' },
      sourceOk: {
        type: ['boolean', 'null'],
        description:
          'Source URL reachability only; it does not establish whether the directory information is true. true = reachable (2xx/3xx), false = confirmed gone (404/410), null = indeterminate (no current result, bot protection, or transient failure).',
      },
      attribution: { type: 'string' },
      facts: {
        type: 'object',
        required: [
          'description',
          'category',
          'tags',
          'tokens',
          'chains',
          'languages',
          'supportsJpyc',
          'supportsUsdc',
          'supportsX402',
          'supportsMcp',
        ],
        properties: {
          description: { type: 'string' },
          category: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          tokens: { type: 'array', items: { type: 'string' } },
          chains: { type: 'array', items: { type: 'string' } },
          languages: { type: 'array', items: { type: 'string' } },
          supportsJpyc: { type: 'boolean' },
          supportsUsdc: { type: 'boolean' },
          supportsX402: { type: 'boolean' },
          supportsMcp: { type: 'boolean' },
        },
      },
      editorial: {
        type: 'object',
        required: ['summaryJa', 'summaryEn'],
        properties: {
          summaryJa: { type: 'string' },
          summaryEn: { type: 'string' },
        },
      },
    },
  },
  DirectoryLicensedEnvelope: {
    type: 'object',
    allOf: [
      { $ref: '#/components/schemas/DirectoryEnvelope' },
      {
        type: 'object',
        required: ['license', 'attestation', 'signer', 'verify'],
        properties: {
          license: {
            type: 'object',
            required: ['id', 'name', 'url', 'licensee', 'issuedAt', 'grants', 'requires', 'prohibits'],
            properties: {
              id: { type: 'string', const: 'openpay-directory-license-v1' },
              name: { type: 'string', const: 'OpenPay Directory Data License v1' },
              url: { type: 'string', format: 'uri' },
              licensee: { type: ['string', 'null'], pattern: '^0x[0-9a-fA-F]{40}$' },
              issuedAt: { type: 'string', format: 'date-time' },
              grants: { type: 'array', items: { type: 'string' } },
              requires: { type: 'array', items: { type: 'string' } },
              prohibits: { type: 'array', items: { type: 'string' } },
            },
          },
          attestation: {
            type: ['object', 'null'],
            required: ['message', 'signature'],
            properties: {
              message: {
                type: 'object',
                required: ['licensee', 'licenseId', 'contentHash', 'rows', 'issuedAt'],
                properties: {
                  licensee: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$', description: 'Zero address when the payer is unknown.' },
                  licenseId: { type: 'string', const: 'openpay-directory-license-v1' },
                  contentHash: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$', description: 'keccak256 of UTF-8 JSON.stringify(items), preserving array order.' },
                  rows: { type: 'integer', minimum: 0 },
                  issuedAt: { type: 'integer', minimum: 0, description: 'Unix seconds.' },
                },
              },
              signature: { type: 'string', pattern: '^0x[0-9a-fA-F]{130}$' },
            },
          },
          signer: { type: ['string', 'null'], pattern: '^0x[0-9a-fA-F]{40}$' },
          verify: {
            type: 'object',
            required: ['method', 'domain', 'types'],
            properties: {
              method: { type: 'string', const: 'EIP-712 recoverTypedDataAddress' },
              domain: {
                type: 'object',
                required: ['name', 'version'],
                additionalProperties: false,
                properties: {
                  name: { type: 'string', const: 'OpenPay Directory License' },
                  version: { type: 'string', const: '1' },
                },
              },
              types: {
                type: 'object',
                required: ['DirectoryLicense'],
                additionalProperties: false,
                properties: {
                  DirectoryLicense: {
                    type: 'array',
                    const: [
                      { name: 'licensee', type: 'address' },
                      { name: 'licenseId', type: 'string' },
                      { name: 'contentHash', type: 'bytes32' },
                      { name: 'rows', type: 'uint256' },
                      { name: 'issuedAt', type: 'uint256' },
                    ],
                    items: {
                      type: 'object',
                      required: ['name', 'type'],
                      properties: { name: { type: 'string' }, type: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    ],
  },
  DirectoryEnvelope: {
    type: 'object',
    required: [
      'schemaVersion',
      'query',
      'items',
      'total',
      'generatedAt',
      'dataFreshness',
      'licenseNotice',
      'attribution',
    ],
    properties: {
      schemaVersion: { type: 'string', const: '1.0' },
      query: { type: 'object' },
      items: {
        type: 'array',
        items: { $ref: '#/components/schemas/DirectoryEntry' },
      },
      total: { type: 'integer', minimum: 0 },
      generatedAt: { type: 'string', format: 'date-time' },
      dataFreshness: {
        type: 'object',
        required: ['oldest', 'newestVerifiedAt', 'oldestSourceCheckedAt'],
        properties: {
          oldest: { type: ['string', 'null'], format: 'date' },
          newestVerifiedAt: { type: ['string', 'null'], format: 'date' },
          oldestSourceCheckedAt: {
            type: ['string', 'null'],
            format: 'date-time',
          },
        },
      },
      licenseNotice: {
        type: 'string',
        description:
          'sourceOk reports source URL reachability only, not whether the information is true.',
      },
      attribution: {
        type: 'array',
        uniqueItems: true,
        items: { type: 'string' },
      },
    },
  },
  Error: {
    type: 'object',
    required: ['ok', 'error'],
    properties: {
      ok: { type: 'boolean', const: false },
      error: {
        type: 'string',
        enum: [
          'invalid_query',
          'not_found',
          'rate_limited',
          'storage_unavailable',
        ],
      },
    },
  },
} as const;

export const BASE_OPENAPI_RESPONSES = {
  InvalidQuery: {
    description: 'A query value is outside the documented allowlist.',
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/Error' },
        example: { ok: false, error: 'invalid_query' },
      },
    },
  },
  NotFound: {
    description: 'Feature disabled, slug absent, or entry not published.',
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/Error' },
        example: { ok: false, error: 'not_found' },
      },
    },
  },
  RateLimited: {
    description: 'Best-effort per-IP request limit exceeded.',
    headers: {
      'Retry-After': { schema: { type: 'integer' }, description: 'Seconds' },
    },
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/Error' },
        example: { ok: false, error: 'rate_limited' },
      },
    },
  },
  PaymentRequired: {
    description:
      'x402 payment challenge. Amount is denominated in JPYC on Polygon or Polygon Amoy; the existing buyer-added facilitator fee is included in maxAmountRequired.',
    headers: {
      'PAYMENT-REQUIRED': {
        schema: { type: 'string' },
        description: 'Base64-encoded x402 v2 payment requirements.',
      },
    },
    content: {
      'application/json': {
        example: {
          x402Version: 1,
          accepts: [
            {
              scheme: 'exact',
              network: 'eip155:137',
              resource:
                'https://open-pay.jp/api/paid/japan-web3-directory',
              maxAmountRequired: '3000000000000000000',
              asset: 'JPYC',
            },
          ],
          error: 'payment_required',
        },
      },
    },
  },
} as const;
