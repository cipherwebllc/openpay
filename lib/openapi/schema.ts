// OpenAPI の schema / 応答の共有部品。応答例から JSON Schema を導出する helper と、
// 複数の領域 module が同じ参照を共有する応答断片を置く。lib/openapi/document.ts を import しない。

/**
 * 応答例から JSON Schema (型のみ) を導出する。Circle Agent Marketplace は「OpenAPI で入出力が
 * 読めること」を掲載条件にするため (2026-09-11)、example だけだった 200 応答に schema を添える。
 * 例と型が食い違わないよう手書きせず example から機械的に作る (nullable/enum は付けない)。
 */
export function schemaFromExample(example: unknown): Record<string, unknown> {
  if (Array.isArray(example)) {
    return { type: 'array', ...(example.length ? { items: schemaFromExample(example[0]) } : {}) };
  }
  if (example !== null && typeof example === 'object') {
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(example as Record<string, unknown>)) {
      properties[key] = schemaFromExample(value);
    }
    return { type: 'object', properties };
  }
  if (typeof example === 'number') return { type: Number.isInteger(example) ? 'integer' : 'number' };
  if (typeof example === 'boolean') return { type: 'boolean' };
  return { type: 'string' };
}

export const ERROR_RESPONSES = {
  '400': { $ref: '#/components/responses/InvalidQuery' },
  '404': { $ref: '#/components/responses/NotFound' },
  '429': { $ref: '#/components/responses/RateLimited' },
  '503': { $ref: '#/components/responses/StorageUnavailable' },
} as const;

export const PAID_RESPONSES = {
  '402': { $ref: '#/components/responses/PaymentRequired' },
  '404': { $ref: '#/components/responses/NotFound' },
  '503': { $ref: '#/components/responses/StorageUnavailable' },
} as const;

// JPYC オンチェーン・ライブデータ (lib/jpyc/liveResources.ts が SoT・応答例も共用)。
export const JPYC_LIVE_402 = {
  description:
    'Standard x402 payment challenge (USDC on Base, exact scheme, single transferWithAuthorization).',
};
export const JPYC_LIVE_503 = {
  description:
    'All configured RPC endpoints failed for the requested chains. Nothing is settled; the buyer is not charged.',
};
export const JPYC_LIVE_400 = { description: 'Unknown query key, unsupported chain, or malformed address/limit.' };
