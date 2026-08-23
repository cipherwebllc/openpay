type AnyRecord = Record<string, unknown>;

export type ResourceInfoV2 = {
  url: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
};

export type PaymentRequirementsV1 = {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType?: string;
  outputSchema?: AnyRecord | null;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra?: AnyRecord | null;
};

export type PaymentRequirementsV2 = {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: AnyRecord | null;
};

export type PaymentRequiredV2 = {
  x402Version: 2;
  error?: string;
  resource: ResourceInfoV2;
  accepts: PaymentRequirementsV2[];
  extensions?: AnyRecord | null;
};

export type PaymentPayloadV2 = {
  x402Version: 2;
  resource?: ResourceInfoV2;
  accepted: PaymentRequirementsV2;
  payload: AnyRecord;
  extensions?: AnyRecord | null;
};

export type PaymentPayloadV1 = {
  x402Version: 1;
  scheme: string;
  network: string;
  payload: AnyRecord;
};

export type FacilitatorV1Body = {
  x402Version: 1;
  paymentPayload: PaymentPayloadV1;
  paymentRequirements: PaymentRequirementsV1;
};

export type BazaarInfoV2 = {
  input: unknown;
  output?: unknown;
};

/**
 * CDP x402 Bazaar が必須にする discovery extension の公式形 (coinbase/x402
 * createQueryDiscoveryExtension と同形・2026-08-20 の validate API 実測で
 * schema 欠落は severity=required で掲載拒否)。info と schema は対で、
 * schema は info を検証する JSON Schema (draft 2020-12)。
 */
export type BazaarExtensionV2 = {
  info: Record<string, unknown>;
  schema: Record<string, unknown>;
};

/**
 * GET 資源の bazaar 宣言に載せる任意メタ。coinbase/x402 の
 * createQueryDiscoveryExtension の引数と同じ意味:
 *   - queryParams: 例示値 (info 側)・queryParamsSchema: その JSON Schema (schema 側)
 *   - output: 応答例 (info.output.example) と任意の JSON Schema
 * 引数を宣言しないと、エージェントには「絞り込める」ことが見えない
 * (agentic.market で売れている検索系は全て schema に引数がある・2026-08-21 実測)。
 */
export type BazaarQueryDeclaration = {
  queryParams?: Record<string, string>;
  queryParamsSchema?: Record<string, unknown>;
  output?: { example: Record<string, unknown>; schema?: Record<string, unknown> };
};

/** GET 資源の公式 bazaar 宣言。宣言なしなら引数なし GET の最小形。 */
export function buildBazaarQueryExtensionV2(
  decl: BazaarQueryDeclaration = {},
): BazaarExtensionV2 {
  const inputProps: Record<string, unknown> = {
    type: { type: 'string', const: 'http' },
    method: { type: 'string', enum: ['GET'] },
  };
  const inputInfo: Record<string, unknown> = { type: 'http', method: 'GET' };
  if (decl.queryParams) {
    inputInfo.queryParams = decl.queryParams;
    inputProps.queryParams = { type: 'object', ...(decl.queryParamsSchema ?? {}) };
  }
  const info: Record<string, unknown> = { input: inputInfo };
  const properties: Record<string, unknown> = {
    input: {
      type: 'object',
      properties: inputProps,
      required: ['type', 'method'],
      additionalProperties: false,
    },
  };
  if (decl.output) {
    info.output = { type: 'json', example: decl.output.example };
    properties.output = {
      type: 'object',
      properties: {
        type: { type: 'string' },
        example: { type: 'object', ...(decl.output.schema ?? {}) },
      },
      required: ['type'],
    };
  }
  return {
    info,
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties,
      required: ['input'],
    },
  };
}

const BASE64_ENCODED_REGEX = /^[A-Za-z0-9+/]*={0,2}$/;

function encodeJsonBase64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function decodeJsonBase64(value: string): unknown {
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as unknown;
}

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasStringField(value: AnyRecord, key: string): boolean {
  return typeof value[key] === 'string';
}

function hasNumberField(value: AnyRecord, key: string): boolean {
  return typeof value[key] === 'number';
}

function isPaymentRequirementsV2(value: unknown): value is PaymentRequirementsV2 {
  if (!isRecord(value)) return false;
  if (!hasStringField(value, 'scheme')) return false;
  if (!hasStringField(value, 'network')) return false;
  if (!hasStringField(value, 'amount')) return false;
  if (!hasStringField(value, 'asset')) return false;
  if (!hasStringField(value, 'payTo')) return false;
  if (!hasNumberField(value, 'maxTimeoutSeconds')) return false;
  const extra = value.extra;
  return extra === undefined || extra === null || isRecord(extra);
}

function isPaymentPayloadV2(value: unknown): value is PaymentPayloadV2 {
  if (!isRecord(value)) return false;
  return (
    value.x402Version === 2 &&
    isPaymentRequirementsV2(value.accepted) &&
    isRecord(value.payload)
  );
}

function deepStrictEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepStrictEqual(item, b[i]));
  }

  if (isRecord(a) || isRecord(b)) {
    if (!isRecord(a) || !isRecord(b)) return false;
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (!deepStrictEqual(aKeys, bKeys)) return false;
    return aKeys.every((key) => deepStrictEqual(a[key], b[key]));
  }

  return false;
}

export function toV2Accept(v1Req: PaymentRequirementsV1): PaymentRequirementsV2 {
  const accept: PaymentRequirementsV2 = {
    scheme: v1Req.scheme,
    network: v1Req.network,
    amount: v1Req.maxAmountRequired,
    asset: v1Req.asset,
    payTo: v1Req.payTo,
    maxTimeoutSeconds: v1Req.maxTimeoutSeconds,
  };
  if (v1Req.extra !== undefined) {
    accept.extra = v1Req.extra;
  }
  return accept;
}

export function buildPaymentRequiredV2(input: {
  url: string;
  description?: string;
  mimeType?: string;
  /** CDP Bazaar の検索・カード表示用 (上流 core の ResourceInfo には無い CDP 拡張・掲載 100 件中 58 件が保持)。 */
  serviceName?: string;
  tags?: readonly string[];
  iconUrl?: string;
  accepts: readonly PaymentRequirementsV2[];
  bazaarInfo?: BazaarInfoV2;
  /** 公式形 (info+schema)。指定時は bazaarInfo より優先 — CDP Bazaar 掲載に必須。 */
  bazaar?: BazaarExtensionV2;
  error?: string;
}): PaymentRequiredV2 {
  const resource: ResourceInfoV2 = { url: input.url };
  if (input.description !== undefined) resource.description = input.description;
  if (input.mimeType !== undefined) resource.mimeType = input.mimeType;
  if (input.serviceName !== undefined) resource.serviceName = input.serviceName;
  if (input.tags !== undefined) resource.tags = [...input.tags];
  if (input.iconUrl !== undefined) resource.iconUrl = input.iconUrl;

  const paymentRequired: PaymentRequiredV2 = {
    x402Version: 2,
    resource,
    accepts: [...input.accepts],
  };
  if (input.error !== undefined) paymentRequired.error = input.error;
  if (input.bazaar !== undefined) {
    paymentRequired.extensions = { bazaar: input.bazaar };
  } else if (input.bazaarInfo !== undefined) {
    paymentRequired.extensions = {
      bazaar: {
        info: input.bazaarInfo,
      },
    };
  }
  return paymentRequired;
}

export function encodePaymentRequiredHeaderValue(
  paymentRequired: PaymentRequiredV2,
): string {
  return encodeJsonBase64(paymentRequired);
}

export function decodePaymentSignatureHeaderValue(raw: string): PaymentPayloadV2 {
  if (!BASE64_ENCODED_REGEX.test(raw)) {
    throw new Error('Invalid payment signature header');
  }
  return decodeJsonBase64(raw) as PaymentPayloadV2;
}

export function encodePaymentResponseHeaderValue(paymentResponse: unknown): string {
  return encodeJsonBase64(paymentResponse);
}

export function v2PayloadToV1Body(
  paymentPayloadV2: unknown,
  v1Requirements: readonly PaymentRequirementsV1[],
): FacilitatorV1Body | null {
  if (!isPaymentPayloadV2(paymentPayloadV2)) return null;

  const matchedRequirement = v1Requirements.find((v1Req) =>
    deepStrictEqual(paymentPayloadV2.accepted, toV2Accept(v1Req)),
  );
  if (!matchedRequirement) return null;

  return {
    x402Version: 1,
    paymentPayload: {
      x402Version: 1,
      scheme: matchedRequirement.scheme,
      network: matchedRequirement.network,
      payload: paymentPayloadV2.payload,
    },
    paymentRequirements: matchedRequirement,
  };
}
