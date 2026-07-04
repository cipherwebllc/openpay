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
  accepts: readonly PaymentRequirementsV2[];
  bazaarInfo?: BazaarInfoV2;
  error?: string;
}): PaymentRequiredV2 {
  const resource: ResourceInfoV2 = { url: input.url };
  if (input.description !== undefined) resource.description = input.description;
  if (input.mimeType !== undefined) resource.mimeType = input.mimeType;

  const paymentRequired: PaymentRequiredV2 = {
    x402Version: 2,
    resource,
    accepts: [...input.accepts],
  };
  if (input.error !== undefined) paymentRequired.error = input.error;
  if (input.bazaarInfo !== undefined) {
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
