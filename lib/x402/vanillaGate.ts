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
// **成功応答を再配信する cache** (first-party の settled redelivery) は**意図的に持たない** —
// 標準 x402 サーバー (x402-next 含む) と同じ残余リスクで、EIP-3009 nonce はオンチェーンで
// 消費済みのため二重課金にはならない (再リクエストは verify で落ち 402 に戻るだけ)。
//
// ただし **resource 束縛の claim は持つ** (lib/x402/vanillaResourceClaim.ts・B5(b)):
// exact scheme の verify は `value >= maxAmountRequired` しか見ず resource を署名に含めない
// ため、1 通の署名済み X-PAYMENT を同額・別 resource へ**同時に**投げると両方が verify を
// 通り、settle の原子性が 2 本目の課金を止める頃には 2 本目のコンテンツ生成が終わっている。
// **verify が isValid:true を返した後・content 生成の前**に「payment identity →
// resource + canonical query」を KV へ原子的に束縛し、別束縛での再利用だけを 409 で弾く
// (同一束縛の再送は従来どおり素通り)。claim を verify の後に置くのは、未認証の書き込み経路を
// 作らないため — first-party JPYC 経路 (app/api/paid/_shared.ts) と同じ位置。KV は money truth
// ではないので、未構成・障害時は fail-open (warn のみ) で従来経路を止めない。

import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { atomicToHuman, recordSettleLedgerAfterResponse } from '@/lib/x402/settleLedger';
import { generateCdpJwt } from './cdpJwt';
import { ARC_GATEWAY_MAX_TIMEOUT_SECONDS, x402Config } from './config';
import { recordFunnelAfterResponse } from './funnel';
import { isFacilitatorPreBroadcastRejection } from './paymentRedelivery';
import {
  buildBazaarQueryExtensionV2,
  buildPaymentRequiredV2,
  decodePaymentSignatureHeaderValue,
  encodePaymentRequiredHeaderValue,
  encodePaymentResponseHeaderValue,
  toV2Accept,
  v2PayloadToV1Body,
  type BazaarExtensionV2,
  type BazaarQueryDeclaration,
  type FacilitatorV1Body,
  type PaymentRequirementsV1,
} from './v2';
import {
  claimVanillaResource,
  releaseVanillaResource,
  vanillaPaymentIdentity,
  vanillaResourceBinding,
  type VanillaResourceClaimIdentity,
} from './vanillaResourceClaim';

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
  /** x402scan bazaar 向けの発見メタ (任意)。v1 body の accepts[].outputSchema に載る。 */
  outputSchema?: { input: unknown; output?: unknown };
  /**
   * CDP Bazaar / agentic.market 向けの v2 宣言 (引数スキーマ・応答例)。
   * outputSchema がある資源でのみ使われ、未指定なら引数なし GET の最小形。
   */
  bazaar?: BazaarQueryDeclaration;
  /**
   * 検索・カード表示用メタ (CDP 拡張)。402 の resource と settle 封筒の resource の両方に載せる —
   * 掲載メタは settle 時に確定するため (#384)。名前は「ブランド」でなく「実行する仕事」で付ける。
   */
  serviceName?: string;
  tags?: readonly string[];
  iconUrl?: string;
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

export type PreparedAccepts = {
  /** v1 命名 (network='base') — v1 JSON body と facilitator body に使う。 */
  v1: PaymentRequirementsV1;
  /** CAIP-2 命名 — v2 ヘッダと accepted 照合に使う。 */
  v1Caip2: PaymentRequirementsV1;
  /**
   * Arc rail (Circle Gateway x402 facilitator)。first-party の 402 だけが付ける (flag ON 時)。
   * **v2 面 (PAYMENT-REQUIRED / accepted 照合) にのみ**現れ、v1 body と facilitator の v1 wire には出ない —
   * Gateway は x402 v2 のみで、v1 クライアントには支払えない accept を見せないため。
   * network は最初から CAIP-2 (`eip155:5042`)。plans/arc-x402-gateway.md。
   */
  arc?: PaymentRequirementsV1;
};

/** どの facilitator へ verify/settle を送るか。既定 (Base) は従来どおり CDP/payai。 */
type FacilitatorRail = 'base' | 'arc-gateway';

function buildAcceptsCore(args: {
  resourceUrl: string;
  description: string;
  price: string;
  payTo: string;
}): PreparedAccepts {
  const net = vanillaNetwork();
  const v1: PaymentRequirementsV1 = {
    scheme: 'exact',
    network: net.name,
    maxAmountRequired: usdPriceToAtomic(args.price),
    resource: args.resourceUrl,
    description: args.description,
    mimeType: 'application/json',
    payTo: args.payTo,
    maxTimeoutSeconds: 300,
    asset: net.usdc,
    extra: { ...net.extra },
  };
  return { v1, v1Caip2: { ...v1, network: net.caip2 } };
}

function buildAccepts(resource: VanillaPaidResource): PreparedAccepts {
  // 無効設定の null 受取先を支払い要件へ載せる波及を断つ (呼出側で既存の 503 に変換)。
  if (x402Config.payTo === null) {
    throw new Error('Payment service is unavailable.');
  }
  const core = buildAcceptsCore({
    resourceUrl: resource.resourceUrl,
    description: resource.description,
    price: resource.price,
    payTo: x402Config.payTo,
  });
  // optional chaining は「arcGateway を持たない config スタブ (兄弟テストの vi.mock)」が全有料 API を
  // 503 に落とす波及を断つため (掟 6)。本物の config は常に {enabled:boolean} を持つ。
  const arc = x402Config.arcGateway;
  if (arc?.enabled !== true) return core;
  // Arc accept: 同じ resource・同じ USD 価格を Arc USDC (6 桁) で。署名 domain は Gateway Wallet
  // (USDC の domain ではない) なので extra に name/version/verifyingContract を載せる — Circle の
  // client はこの extra から EIP-712 domain を組み立てる。有効期間は Gateway の下限 (3 日) を満たす 7 日+。
  return {
    ...core,
    arc: {
      ...core.v1,
      network: arc.caip2,
      payTo: arc.payTo,
      asset: arc.usdc,
      maxTimeoutSeconds: ARC_GATEWAY_MAX_TIMEOUT_SECONDS,
      extra: {
        name: 'GatewayWalletBatched',
        version: '1',
        verifyingContract: arc.gatewayWallet,
      },
    },
  };
}

/**
 * dual-rail リレー (出品者の USDC 面) 用: payTo を出品者受取先に差し替えた accepts。
 * first-party の buildAccepts と同一の生成規則 (asset/extra/network/期限) を共有し、
 * リレーと 402 表面の要件がずれる余地を残さない。設定不正 (network が base 系でない等) は throw。
 */
export function buildRelayAccepts(args: {
  resourceUrl: string;
  description: string;
  price: string;
  payTo: string;
}): PreparedAccepts {
  return buildAcceptsCore(args);
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
    ...(resource.serviceName ? { serviceName: resource.serviceName } : {}),
    ...(resource.tags ? { tags: resource.tags } : {}),
    ...(resource.iconUrl ? { iconUrl: resource.iconUrl } : {}),
    // Arc は v2 面にだけ並べる (Base が先・従来の client は先頭を選ぶ)。
    accepts: [
      toV2Accept(accepts.v1Caip2),
      ...(accepts.arc ? [toV2Accept(accepts.arc)] : []),
    ],
    // v1 body の outputSchema (x402scan 互換) はそのまま・v2 面だけ公式形 {info, schema}。
    // CDP Bazaar は schema 無しを severity=required で掲載拒否する (validate API 実測)。
    ...(resource.outputSchema ? { bazaar: buildBazaarQueryExtensionV2(resource.bazaar) } : {}),
    error,
  });
  res.headers.set(
    'PAYMENT-REQUIRED',
    encodePaymentRequiredHeaderValue(paymentRequired),
  );
  return res;
}

/**
 * 同じ authorization が**別 resource / 別 query** に再利用されたときだけ返す 409。
 * 402 challenge に混ぜないのは、同じ支払いを署名し直しても解決しない (= 再挑戦させても
 * 無意味な) 状態だから。code は hostedUsdcPaidRoute の同義ケースと同じ語彙を使う。
 */
function authorizationConflict(): NextResponse {
  return NextResponse.json(
    {
      x402Version: 1,
      error: 'authorization_conflict',
      message:
        'This payment authorization is already bound to a different resource.',
    },
    { status: 409 },
  );
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
  return v2HeaderToRailBody(raw, accepts)?.body ?? null;
}

/**
 * v2 ヘッダを rail 付きで復号する。accepted が Arc accept と一致すれば `arc-gateway`
 * (body の network/requirements は CAIP-2 のまま = Gateway の wire に直接使える)。
 * Base 一致は従来と同一の body (network を v1 命名へ戻す)。
 */
function v2HeaderToRailBody(
  raw: string,
  accepts: PreparedAccepts,
): { body: FacilitatorV1Body; rail: FacilitatorRail } | null {
  let payload: unknown;
  try {
    payload = decodePaymentSignatureHeaderValue(raw);
  } catch {
    return null;
  }
  if (accepts.arc) {
    const arcMatched = v2PayloadToV1Body(payload, [accepts.arc]);
    if (arcMatched) return { body: arcMatched, rail: 'arc-gateway' };
  }
  // accepted の照合は CAIP-2 形で行い (v2 表面と一致)、facilitator へは v1 命名で渡す。
  const matched = v2PayloadToV1Body(payload, [accepts.v1Caip2]);
  if (!matched) return null;
  return {
    body: {
      x402Version: 1,
      paymentPayload: {
        ...matched.paymentPayload,
        network: accepts.v1.network,
      },
      paymentRequirements: accepts.v1,
    },
    rail: 'base',
  };
}

/**
 * 支払いヘッダ (v2 PAYMENT-SIGNATURE 優先・v1 X-PAYMENT fallback) を facilitator body へ
 * デコードする。handleVanillaPaidGet 内部と同じ規則の公開版 (dual-rail リレーが使う)。
 * 形が違えば null (呼び出し側が 400/402 に変換する)。
 */
export function decodeVanillaPaymentHeader(
  headers: { v2: string | null; v1: string | null },
  accepts: PreparedAccepts,
): FacilitatorV1Body | null {
  if (headers.v2) return v2HeaderToBody(headers.v2, accepts);
  if (headers.v1) return v1HeaderToBody(headers.v1, accepts);
  return null;
}

type FacilitatorCdpWire = {
  accept: ReturnType<typeof toV2Accept>;
  resource: {
    resourceUrl: string;
    description: string;
    serviceName?: string;
    tags?: readonly string[];
    iconUrl?: string;
  };
  /** Bazaar カタログ登録メタ。指定時のみ paymentPayload.extensions に載せる。 */
  bazaar?: BazaarExtensionV2;
};

/**
 * 既存の呼び出し規約 (判定 body だけを返す) をそのまま保つ薄いラッパ。dualRailRelay /
 * hostedUsdcPaidRoute はこちらを使い続ける (掟 12: 既存 money-path の署名を変えない)。
 */
export async function postFacilitator(
  path: '/verify' | '/settle',
  body: FacilitatorV1Body,
  cdpWire: FacilitatorCdpWire,
): Promise<Record<string, unknown>> {
  return (await postFacilitatorWithStatus(path, body, cdpWire)).body;
}

/**
 * postFacilitator と同一のワイヤで、判定 body に **HTTP status** を添えて返す。
 * status が要るのは settle 失敗の broadcast 前後判定 (isFacilitatorPreBroadcastRejection)
 * だけで、ワイヤ・順序・応答は 1 つも変わらない。
 */
export async function postFacilitatorWithStatus(
  path: '/verify' | '/settle',
  body: FacilitatorV1Body,
  cdpWire: FacilitatorCdpWire,
  rail: FacilitatorRail = 'base',
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (rail === 'arc-gateway') return postGatewayFacilitator(path, body, cdpWire);
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
            // 検索・カード表示用メタ (CDP 拡張)。402 と同じ値を settle にも載せる。
            ...(cdpWire.resource.serviceName ? { serviceName: cdpWire.resource.serviceName } : {}),
            ...(cdpWire.resource.tags ? { tags: [...cdpWire.resource.tags] } : {}),
            ...(cdpWire.resource.iconUrl ? { iconUrl: cdpWire.resource.iconUrl } : {}),
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
  if (res.ok && isRecord(parsed)) return { status: res.status, body: parsed };
  // CDP は invalid な支払いを 200 でなく 4xx + 正規の判定 body で返す (2026-08-20 本番実測:
  // 400 {isValid:false, invalidReason:'invalid_payload', payer:...})。これは facilitator
  // 障害ではなく「否定判定が出た」状態なので結果として呼び出し側へ返す。
  // 非 2xx の肯定 body (相反する判定の混在を含む) が解錠・台帳記録へ波及するのを断つ。
  // 肯定判定を運べるのは上の 2xx 経路だけ。
  // 5xx はこれまでどおり障害として throw → 503 (課金は発生しない)。
  if (
    cdpAuth &&
    res.status >= 400 &&
    res.status < 500 &&
    isRecord(parsed) &&
    (path === '/verify' ? parsed.isValid === false : parsed.success === false) &&
    parsed.isValid !== true &&
    parsed.success !== true
  ) {
    return { status: res.status, body: parsed };
  }
  throw new Error(`facilitator ${path} HTTP ${res.status}`);
}

/**
 * Arc rail: Circle Gateway の x402 facilitator へ verify/settle を送る。
 *   - 認証なし (`security: []`)・x402 v2 wire (CDP と同じ封筒形・Bazaar 拡張は載せない = CDP 専用)
 *   - accepted/paymentRequirements は Arc accept そのもの (CAIP-2・Gateway domain の extra)
 *   - 2xx の判定 body をそのまま返す。4xx でも `isValid`/`success` を持つ判定 body は結果として返す
 *     (CDP と同じ扱い・真偽判定は呼び出し側の fail-closed)。5xx / 形不明は throw → 503 (課金なし)。
 * Base の facilitator (CDP/payai) には一切触れない (掟 12)。
 */
async function postGatewayFacilitator(
  path: '/verify' | '/settle',
  body: FacilitatorV1Body,
  wire: FacilitatorCdpWire,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const arc = x402Config.arcGateway;
  if (!arc.enabled) {
    // 402 に Arc accept を配っていない限り到達しない。配線ミスは 503 (課金なし) に倒す。
    throw new Error('arc gateway rail is not enabled');
  }
  const url = `${arc.url}/v1/x402${path}`;
  const wireBody = {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      accepted: wire.accept,
      payload: body.paymentPayload.payload,
      resource: {
        url: wire.resource.resourceUrl,
        description: wire.resource.description,
        mimeType: 'application/json',
      },
    },
    paymentRequirements: wire.accept,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(wireBody),
    signal: AbortSignal.timeout(FACILITATOR_TIMEOUT_MS),
  });
  const parsed: unknown = await res.json().catch(() => null);
  if (res.ok && isRecord(parsed)) return { status: res.status, body: parsed };
  // Gateway の契約は「判定は 200 + body・400 は body 不正」(API ref)。4xx を判定として通すのは
  // **否定判定 (isValid:false / success:false) のときだけ** — 4xx の `{success:true}` (異形応答・
  // プロキシ) で解錠+台帳記録される fail-open を断つ。それ以外の 4xx/5xx は障害 → 503 (課金なし)。
  if (
    res.status < 500 &&
    isRecord(parsed) &&
    (parsed.isValid === false || parsed.success === false)
  ) {
    return { status: res.status, body: parsed };
  }
  throw new Error(`gateway facilitator ${path} HTTP ${res.status}`);
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
  // 無効な本番 network が testMode 経由でコンテンツ解錠へ波及するのを断つ。
  if (x402Config.network === null) {
    return facilitatorUnavailable('Payment service is unavailable.');
  }
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
  // 以下の recordFunnelAfterResponse はすべて応答返却後・no-throw の段階別カウンタ (lib/x402/funnel.ts)。
  // 判定・順序・応答には一切関与しない (掟 12: 追加のみ)。
  const url = resource.resourceUrl;
  if (!v2Header && !v1Header) {
    recordFunnelAfterResponse('challenge', 'none', url);
    return paymentChallenge(resource, accepts, 'payment_required');
  }

  const decoded = v2Header
    ? v2HeaderToRailBody(v2Header, accepts)
    : (() => {
        const body = v1HeaderToBody(v1Header!, accepts);
        return body ? { body, rail: 'base' as const } : null;
      })();
  if (!decoded) {
    recordFunnelAfterResponse('invalid_payload', 'none', url);
    return paymentChallenge(resource, accepts, 'invalid_payment_payload');
  }
  const { body: facilitatorBody, rail } = decoded;
  // facilitator に渡す accept: Base は従来どおり CAIP-2 化した v1 要件、Arc は Arc accept そのもの。
  const railAccept = toV2Accept(rail === 'arc-gateway' ? accepts.arc! : accepts.v1Caip2);

  let verify: Record<string, unknown>;
  try {
    verify = (
      await postFacilitatorWithStatus(
        '/verify',
        facilitatorBody,
        {
          accept: railAccept,
          resource,
          // 402 で配ったのと同じ宣言を facilitator にも渡す (Bazaar カタログ登録の入力)。
          ...(resource.outputSchema ? { bazaar: buildBazaarQueryExtensionV2(resource.bazaar) } : {}),
        },
        rail,
      )
    ).body;
  } catch (e) {
    logger.warn('x402.vanilla.verify_unavailable', {
      error: e instanceof Error ? e.message : String(e),
      resource: resource.resourceUrl,
      rail,
    });
    recordFunnelAfterResponse('facilitator_unavailable', rail, url);
    return facilitatorUnavailable('Payment verification failed. Please retry later.');
  }
  if (verify.isValid !== true) {
    const reason =
      typeof verify.invalidReason === 'string'
        ? verify.invalidReason
        : 'payment_invalid';
    recordFunnelAfterResponse('verify_failed', rail, url);
    return paymentChallenge(resource, accepts, reason);
  }
  const payer = typeof verify.payer === 'string' ? verify.payer : undefined;

  // verify が isValid:true を返した後・content 生成の前に、payment identity を
  // resource + canonical query へ原子的に束縛する (B5(b))。
  // 断つ波及: 同額・別 resource への同時再利用で 2 本目のコンテンツ生成が済んでしまうこと。
  // verify の後に置くのは、署名を検証していない誰でも 30 分の KV キーを作れる未認証の
  // 書き込み経路を作らないため (first-party JPYC 経路 app/api/paid/_shared.ts と同じ位置)。
  // identity を導出できない payload (nonce/署名を読めない形) は claim せず、判定は従来どおり
  // facilitator に委ねる — 既存の応答・順序を 1 つも変えないため。
  const claimIdentity = vanillaPaymentIdentity(facilitatorBody.paymentPayload);
  const claimBinding = vanillaResourceBinding(resource.resourceUrl, req.url);
  let ownedClaim: VanillaResourceClaimIdentity | null = null;
  if (!claimIdentity && rail === 'arc-gateway') {
    // Arc の payload 形は Circle の scheme 由来。形が変わって identity を導けなくなると束縛が
    // 無言で消えるので観測可能にする (挙動は従来どおり facilitator の判定に委ねる)。
    logger.warn('x402.vanilla.claim_skipped', { rail, resource: resource.resourceUrl });
  }
  if (claimIdentity) {
    const claim = await claimVanillaResource({
      identity: claimIdentity,
      binding: claimBinding,
      // Arc は署名の有効期間 (7 日+) いっぱい束縛する (claimVanillaResource の ttlSec 注記)。
      ...(rail === 'arc-gateway' ? { ttlSec: ARC_GATEWAY_MAX_TIMEOUT_SECONDS } : {}),
    });
    if (claim.kind === 'conflict') {
      recordFunnelAfterResponse('conflict', rail, url);
      return authorizationConflict();
    }
    // 'match' (同一束縛の再送) は従来どおり content/settle へ進む。claim を張ったのが
    // 自分の request のときだけ、settle 前に落ちた場合の解放権を持つ。
    if (claim.kind === 'claimed') ownedClaim = claimIdentity;
  }
  const releaseClaim = async (): Promise<void> => {
    if (!ownedClaim) return;
    await releaseVanillaResource({
      identity: ownedClaim,
      binding: claimBinding,
    });
    ownedClaim = null;
  };

  const res = await content({ payer });
  if (res.status >= 400) {
    // settle しない = 課金しない。署名も未使用なので claim を戻す (引数不足 400 の後に
    // 引数を足して同じ支払いで叩き直す正直な再送を、別 query = 別束縛で塞がないため)。
    // 残余リスク (受容): 解放は content が**走った後**なので、4xx を返す resource を踏み台に
    // claim を外して別 resource へ回すことはできる。ただし 4xx body は有料コンテンツでは
    // なく (エラー封筒)、settle も走らない = 課金もされないため、二重「解錠」にはならない。
    await releaseClaim();
    recordFunnelAfterResponse('content_error', rail, url);
    return res;
  }

  let settle: { status: number; body: Record<string, unknown> };
  try {
    settle = await postFacilitatorWithStatus(
      '/settle',
      facilitatorBody,
      {
        accept: railAccept,
        resource,
        // カタログ登録は settle 時に確定する — verify と同じ payload 形で送る。
        ...(resource.outputSchema ? { bazaar: buildBazaarQueryExtensionV2(resource.bazaar) } : {}),
      },
      rail,
    );
  } catch (e) {
    logger.warn('x402.vanilla.settle_unavailable', {
      error: e instanceof Error ? e.message : String(e),
      resource: resource.resourceUrl,
      rail,
    });
    // settle 以降は broadcast 済みの可能性がある = 署名が使用済みかもしれない。claim は
    // **戻さない** (使用済みかもしれない authorization を別 resource へ流用させない)。
    recordFunnelAfterResponse('facilitator_unavailable', rail, url);
    return facilitatorUnavailable('Payment settlement failed. Please retry later.');
  }
  if (settle.body.success !== true) {
    const reason =
      typeof settle.body.errorReason === 'string'
        ? settle.body.errorReason
        : 'settlement_failed';
    // 「broadcast 前の拒否と契約上保証される」reason (insufficient_balance 等) のときだけ
    // claim を戻す。pending/reverted/未知 reason は broadcast 済みかもしれないので保持し、
    // 使用済みかもしれない authorization が別 resource へ回るのを防ぐ。判定式は
    // first-party 経路と同一 (lib/x402/paymentRedelivery.ts)。
    // Arc (Gateway) の settle は「検証・残高ロック・バッチ待ち行列」で broadcast を伴わないため、
    // success:false は常に broadcast 前 = claim を戻してよい (使用済み nonce は次の verify が落とす)。
    if (rail === 'arc-gateway' || isFacilitatorPreBroadcastRejection(settle.status, settle.body)) {
      await releaseClaim();
    }
    recordFunnelAfterResponse('settle_failed', rail, url);
    return paymentChallenge(resource, accepts, reason);
  }

  const settlement = {
    success: true,
    transaction:
      typeof settle.body.transaction === 'string' ? settle.body.transaction : null,
    // Arc は network をローカルで確定済み (Gateway のエコーを信じない = 台帳/透明性集計が Base に
    // 化ける波及を断つ)。Base は従来どおり facilitator の値を優先 (挙動不変)。
    network:
      rail === 'arc-gateway'
        ? facilitatorBody.paymentRequirements.network
        : typeof settle.body.network === 'string'
          ? settle.body.network
          : facilitatorBody.paymentRequirements.network,
    payer: typeof settle.body.payer === 'string' ? settle.body.payer : payer,
  };
  res.headers.set(
    'X-PAYMENT-RESPONSE',
    Buffer.from(JSON.stringify(settlement), 'utf8').toString('base64'),
  );
  res.headers.set('PAYMENT-RESPONSE', encodePaymentResponseHeaderValue(settlement));
  recordFunnelAfterResponse('settled', rail, url);
  // 運営台帳 (誰が・どの商品を・いくらで)。応答返却後・no-throw (掟 12/13)。
  recordSettleLedgerAfterResponse({
    at: new Date().toISOString(),
    source: 'usdc-vanilla',
    network: settlement.network,
    resource: resource.resourceUrl,
    payer: settlement.payer ?? null,
    payTo: facilitatorBody.paymentRequirements.payTo,
    amount: atomicToHuman(facilitatorBody.paymentRequirements.maxAmountRequired, 6),
    asset: 'USDC',
    tx: settlement.transaction,
  });
  return res;
}
