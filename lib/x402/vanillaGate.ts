// vanilla x402 (単一 transferWithAuthorization・外部 facilitator 精算) の v2 dual-stack ゲート。
//
// 背景: x402-next は最新 (1.2.0) でも **v1 応答しか出せず**、x402scan は v1 を
// 「migrate to v2 spec」で登録拒否する (2026-07-28 実測)。そこで first-party JPYC 経路で
// x402scan の v2 パースを通過済みの自前 dual-stack (lib/x402/v2.ts・#125) を、外部
// facilitator 向けに薄く再利用する。
//
// forwarder-split (自前 facilitator・extra.openpay・nonce 分割コミット) とは**別 money-path**:
// こちらは標準クライアント (x402-fetch / CDP 等) がそのまま支払える素の exact scheme で、
// OpenPay 手数料は存在しない (表示価格の 100% が payTo へ)。
//
// network 表記の変換 (実測に基づく):
//   - v1 表面 (JSON body) と facilitator への verify/settle body = 'base' (v1 命名)。
//     payai は CAIP-2 命名の body を 500 で落とす (2026-07-28 実測)。
//   - v2 表面 (PAYMENT-REQUIRED / accepted 照合) = 'eip155:8453' (CAIP-2・v2 慣習)。
//
// 買い手保護: verify → content → (content が 2xx/3xx のときだけ) settle の順。
// x402-next と同一の順序で、データ不能 (503) 時に課金されない。settle 応答の喪失時に
// 再配信する仕組み (first-party の redelivery KV) は**意図的に持たない** — 標準 x402
// サーバー (x402-next 含む) と同じ残余リスクで、EIP-3009 nonce はオンチェーンで消費済みの
// ため二重課金にはならない (再リクエストは verify で落ち 402 に戻るだけ)。

import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { generateCdpJwt } from './cdpJwt';
import { x402Config } from './config';
import {
  buildBazaarQueryExtensionV2,
  buildPaymentRequiredV2,
  decodePaymentSignatureHeaderValue,
  encodePaymentRequiredHeaderValue,
  encodePaymentResponseHeaderValue,
  toV2Accept,
  v2PayloadToV1Body,
  type BazaarExtensionV2,
  type FacilitatorV1Body,
  type PaymentRequirementsV1,
} from './v2';

const FACILITATOR_TIMEOUT_MS = 20_000;

// x402 パッケージ (node_modules/x402) の per-network 定義と一致させた USDC メタ。
// bridged USDC.e ではなく native USDC のみ。
const VANILLA_NETWORKS = {
  base: {
    caip2: 'eip155:8453',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    extra: { name: 'USD Coin', version: '2' },
  },
  'base-sepolia': {
    caip2: 'eip155:84532',
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    extra: { name: 'USDC', version: '2' },
  },
} as const;

type VanillaNetwork = keyof typeof VANILLA_NETWORKS;

export type VanillaPaidResource = {
  /** canonical な resource URL (402 の accepts と一致させる)。 */
  resourceUrl: string;
  description: string;
  /** "$0.02" 形式 (USD)。USDC 6 桁 atomic へ厳密変換する。 */
  price: string;
  /** x402scan bazaar 向けの発見メタ (任意)。 */
  outputSchema?: { input: unknown; output?: unknown };
};

/** "$0.02" → "20000"。float を経由しない厳密変換 (6 桁超の端数は設定ミスとして throw)。 */
export function usdPriceToAtomic(price: string): string {
  const m = /^\$?([0-9]+)(?:\.([0-9]{1,6}))?$/.exec(price);
  if (!m) {
    throw new Error(`vanilla x402: unsupported USD price format: ${price}`);
  }
  const frac = (m[2] ?? '').padEnd(6, '0');
  return (BigInt(m[1]) * 10n ** 6n + BigInt(frac)).toString();
}

function vanillaNetwork(): { name: VanillaNetwork } & (typeof VANILLA_NETWORKS)[VanillaNetwork] {
  const name = x402Config.network;
  if (name !== 'base' && name !== 'base-sepolia') {
    // polygon 系は JPYC facilitator (forwarder-split) の領分。ここに来るのは配線ミス。
    throw new Error(`vanilla x402: unsupported network for USDC gate: ${name}`);
  }
  return { name, ...VANILLA_NETWORKS[name] };
}

type PreparedAccepts = {
  /** v1 命名 (network='base') — v1 JSON body と facilitator body に使う。 */
  v1: PaymentRequirementsV1;
  /** CAIP-2 命名 — v2 ヘッダと accepted 照合に使う。 */
  v1Caip2: PaymentRequirementsV1;
};

function buildAccepts(resource: VanillaPaidResource): PreparedAccepts {
  const net = vanillaNetwork();
  const v1: PaymentRequirementsV1 = {
    scheme: 'exact',
    network: net.name,
    maxAmountRequired: usdPriceToAtomic(resource.price),
    resource: resource.resourceUrl,
    description: resource.description,
    mimeType: 'application/json',
    payTo: x402Config.payTo,
    maxTimeoutSeconds: 300,
    asset: net.usdc,
    extra: { ...net.extra },
  };
  return { v1, v1Caip2: { ...v1, network: net.caip2 } };
}

function noStore(res: NextResponse): NextResponse {
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

function paymentChallenge(
  resource: VanillaPaidResource,
  accepts: PreparedAccepts,
  error: string,
): NextResponse {
  // v1 body の accepts には outputSchema (発見メタ) を添付するが、facilitator へ渡す
  // requirements には含めない (first-party と同じ判断)。
  const discoverable = {
    ...accepts.v1,
    ...(resource.outputSchema ? { outputSchema: resource.outputSchema } : {}),
  };
  const res = NextResponse.json(
    { x402Version: 1, accepts: [discoverable], error },
    { status: 402 },
  );
  const paymentRequired = buildPaymentRequiredV2({
    url: resource.resourceUrl,
    description: resource.description,
    mimeType: 'application/json',
    accepts: [toV2Accept(accepts.v1Caip2)],
    // v1 body の outputSchema (x402scan 互換) はそのまま・v2 面だけ公式形 {info, schema}。
    // CDP Bazaar は schema 無しを severity=required で掲載拒否する (validate API 実測)。
    ...(resource.outputSchema ? { bazaar: buildBazaarQueryExtensionV2() } : {}),
    error,
  });
  res.headers.set(
    'PAYMENT-REQUIRED',
    encodePaymentRequiredHeaderValue(paymentRequired),
  );
  return res;
}

function facilitatorUnavailable(message: string): NextResponse {
  return NextResponse.json(
    { x402Version: 1, error: 'payment_facility_unavailable', message },
    { status: 503 },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** v1 X-PAYMENT ヘッダ (base64 JSON) → facilitator body。形が違えば null。 */
function v1HeaderToBody(
  raw: string,
  accepts: PreparedAccepts,
): FacilitatorV1Body | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(decoded)) return null;
  const { scheme, network, payload } = decoded;
  if (
    scheme !== 'exact' ||
    network !== accepts.v1.network ||
    !isRecord(payload)
  ) {
    return null;
  }
  return {
    x402Version: 1,
    paymentPayload: { x402Version: 1, scheme: 'exact', network: accepts.v1.network, payload },
    paymentRequirements: accepts.v1,
  };
}

/** v2 PAYMENT-SIGNATURE ヘッダ → facilitator body (network は v1 命名へ戻す)。 */
function v2HeaderToBody(
  raw: string,
  accepts: PreparedAccepts,
): FacilitatorV1Body | null {
  let payload: unknown;
  try {
    payload = decodePaymentSignatureHeaderValue(raw);
  } catch {
    return null;
  }
  // accepted の照合は CAIP-2 形で行い (v2 表面と一致)、facilitator へは v1 命名で渡す。
  const matched = v2PayloadToV1Body(payload, [accepts.v1Caip2]);
  if (!matched) return null;
  return {
    x402Version: 1,
    paymentPayload: {
      ...matched.paymentPayload,
      network: accepts.v1.network,
    },
    paymentRequirements: accepts.v1,
  };
}

export async function postFacilitator(
  path: '/verify' | '/settle',
  body: FacilitatorV1Body,
  cdpWire: {
    accept: ReturnType<typeof toV2Accept>;
    resource: { resourceUrl: string; description: string };
    /** Bazaar カタログ登録メタ。指定時のみ paymentPayload.extensions に載せる。 */
    bazaar?: BazaarExtensionV2;
  },
): Promise<Record<string, unknown>> {
  const { url: baseUrl, cdpAuth } = x402Config.vanillaFacilitator;
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cdpAuth) {
    // CDP は uri claim をリクエストに束縛した 2 分 JWT を要求する — 呼び出しごとに生成。
    // 生成失敗 (鍵形式不正等) は throw → 呼び出し側の catch で 503 (課金は発生しない)。
    headers.authorization = `Bearer ${generateCdpJwt({
      keyId: cdpAuth.keyId,
      keySecret: cdpAuth.keySecret,
      method: 'POST',
      url,
    })}`;
  }
  // ワイヤは facilitator ごとに異なる (2026-08-20 本番実測):
  //   - payai: v1 命名 ('base'・maxAmountRequired) のみ受理 (CAIP-2 body は 500)
  //   - CDP (/platform/v2/x402): v1 命名 body を 400 invalid_request で拒否。
  //     canonical は v2 (CAIP-2・amount・payload に accepted/resource を同梱)
  // 署名は EIP-3009 authorization のみを覆うため、v1 client の支払いを v2 封筒へ
  // 詰め替えても署名検証には影響しない。
  // Bazaar のカタログ登録は 402 応答でなく **facilitator に送る paymentPayload.extensions**
  // から抽出される (coinbase/x402 bazaar/facilitator.ts extractDiscoveryInfo: v2 は
  // paymentPayload.extensions['bazaar'] と paymentPayload.resource.url を読む)。公式 client は
  // 402 の extensions を payload へ写して verify/settle 両方に同じ payload を送るため、
  // v1 client を v2 封筒へ詰め替える我々も同じ形にする。
  // 出所は client でなく**自分の resource 宣言**に限定する (client 由来の値を載せると
  // 他人が我々の payTo で任意 URL をカタログ登録できる = catalog poisoning)。
  const wireBody = cdpAuth
    ? {
        x402Version: 2,
        paymentPayload: {
          x402Version: 2,
          accepted: cdpWire.accept,
          payload: body.paymentPayload.payload,
          resource: {
            url: cdpWire.resource.resourceUrl,
            description: cdpWire.resource.description,
            mimeType: 'application/json',
          },
          ...(cdpWire.bazaar ? { extensions: { bazaar: cdpWire.bazaar } } : {}),
        },
        paymentRequirements: cdpWire.accept,
      }
    : body;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(wireBody),
    signal: AbortSignal.timeout(FACILITATOR_TIMEOUT_MS),
  });
  const parsed: unknown = await res.json().catch(() => null);
  if (res.ok && isRecord(parsed)) return parsed;
  // CDP は invalid な支払いを 200 でなく 4xx + 正規の判定 body で返す (2026-08-20 本番実測:
  // 400 {isValid:false, invalidReason:'invalid_payload', payer:...})。これは facilitator
  // 障害ではなく「判定が出た」状態なので結果として呼び出し側へ返す — isValid/success の
  // 真偽判定は呼び出し側の fail-closed (true 以外は解錠・settle しない) が担う。
  // 5xx はこれまでどおり障害として throw → 503 (課金は発生しない)。
  if (
    cdpAuth &&
    res.status < 500 &&
    isRecord(parsed) &&
    ('isValid' in parsed || 'success' in parsed)
  ) {
    return parsed;
  }
  throw new Error(`facilitator ${path} HTTP ${res.status}`);
}

/**
 * vanilla x402 の有料 GET を処理する。応答は一律 no-store (#277 と同じ判断)。
 * content は「支払い済みのときだけ呼ばれる」のではなく settle 前に呼ばれる点に注意 —
 * 4xx/5xx を返せば settle されない (買い手保護)。
 */
export async function handleVanillaPaidGet(
  req: Request,
  resource: VanillaPaidResource,
  content: (ctx: { payer?: string }) => Promise<NextResponse> | NextResponse,
): Promise<NextResponse> {
  return noStore(await handleVanillaPaidGetInner(req, resource, content));
}

async function handleVanillaPaidGetInner(
  req: Request,
  resource: VanillaPaidResource,
  content: (ctx: { payer?: string }) => Promise<NextResponse> | NextResponse,
): Promise<NextResponse> {
  if (x402Config.testMode) {
    return content({});
  }

  let accepts: PreparedAccepts;
  try {
    accepts = buildAccepts(resource);
  } catch (e) {
    // 設定ミス (mainnet で payTo 欠落等) で壊れた 402 を配らない。
    return facilitatorUnavailable(e instanceof Error ? e.message : String(e));
  }

  const v2Header = req.headers.get('PAYMENT-SIGNATURE');
  const v1Header = req.headers.get('x-payment');
  if (!v2Header && !v1Header) {
    return paymentChallenge(resource, accepts, 'payment_required');
  }

  const facilitatorBody = v2Header
    ? v2HeaderToBody(v2Header, accepts)
    : v1HeaderToBody(v1Header!, accepts);
  if (!facilitatorBody) {
    return paymentChallenge(resource, accepts, 'invalid_payment_payload');
  }

  let verify: Record<string, unknown>;
  try {
    verify = await postFacilitator('/verify', facilitatorBody, {
      accept: toV2Accept(accepts.v1Caip2),
      resource,
      // 402 で配ったのと同じ宣言を facilitator にも渡す (Bazaar カタログ登録の入力)。
      ...(resource.outputSchema ? { bazaar: buildBazaarQueryExtensionV2() } : {}),
    });
  } catch (e) {
    logger.warn('x402.vanilla.verify_unavailable', {
      error: e instanceof Error ? e.message : String(e),
      resource: resource.resourceUrl,
    });
    return facilitatorUnavailable('Payment verification failed. Please retry later.');
  }
  if (verify.isValid !== true) {
    const reason =
      typeof verify.invalidReason === 'string'
        ? verify.invalidReason
        : 'payment_invalid';
    return paymentChallenge(resource, accepts, reason);
  }
  const payer = typeof verify.payer === 'string' ? verify.payer : undefined;

  const res = await content({ payer });
  if (res.status >= 400) {
    // settle しない = 課金しない。
    return res;
  }

  let settle: Record<string, unknown>;
  try {
    settle = await postFacilitator('/settle', facilitatorBody, {
      accept: toV2Accept(accepts.v1Caip2),
      resource,
      // カタログ登録は settle 時に確定する — verify と同じ payload 形で送る。
      ...(resource.outputSchema ? { bazaar: buildBazaarQueryExtensionV2() } : {}),
    });
  } catch (e) {
    logger.warn('x402.vanilla.settle_unavailable', {
      error: e instanceof Error ? e.message : String(e),
      resource: resource.resourceUrl,
    });
    return facilitatorUnavailable('Payment settlement failed. Please retry later.');
  }
  if (settle.success !== true) {
    const reason =
      typeof settle.errorReason === 'string'
        ? settle.errorReason
        : 'settlement_failed';
    return paymentChallenge(resource, accepts, reason);
  }

  const settlement = {
    success: true,
    transaction: typeof settle.transaction === 'string' ? settle.transaction : null,
    network: typeof settle.network === 'string' ? settle.network : accepts.v1.network,
    payer: typeof settle.payer === 'string' ? settle.payer : payer,
  };
  res.headers.set(
    'X-PAYMENT-RESPONSE',
    Buffer.from(JSON.stringify(settlement), 'utf8').toString('base64'),
  );
  res.headers.set('PAYMENT-RESPONSE', encodePaymentResponseHeaderValue(settlement));
  return res;
}
