// dual-rail 出品の USDC/Base 面: 出品者サーバー ⇄ CDP facilitator の中継 (server-only)。
//
// 出品者は自分のドメインで 402 を返し (JPYC accepts + ここが配る USDC accepts の並記)、
// USDC 支払いの verify/settle だけを当社リレー経由で CDP facilitator に中継する。
//   - コンテンツ配信と解錠判定は出品者サーバーの責任 (当社はホストしない)。
//   - 資金は購入者 → 出品者 payTo へ直接 (EIP-3009・当社は USDC 側の手数料を取らない)。
//   - Bazaar 掲載メタ (resource/extensions) は**当社レジストリの登録値のみ**から注入する。
//     呼び出し body 由来の URL/description を載せると、他人が任意 URL を我々の CDP 鍵で
//     カタログ登録できてしまう (catalog poisoning) — その経路を断つのがこのリレーの要。
//
// ゲート: ENABLE_X402_DUAL_RAIL (server-only・既定 OFF=404) AND enableX402Facilitator
// (レジストリの親 flag)。動作には X402_VANILLA_FACILITATOR=cdp (CDP 鍵) が必要 (無ければ 503
// = 「掲載されない中継」を黙って提供しない)。
//
// 認証なし (rate limit のみ) で安全な理由: verify/settle の入力は購入者が EIP-3009 で署名した
// 支払いそのもの。第三者が横取りしても settle 先は登録済み出品者の payTo に固定され、nonce は
// 一度で消費される — 不正者が得るものがない。requirements は公開情報 (402 に載る内容) のみ。

import 'server-only';

import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { readJsonBodyCapped } from '@/lib/httpBodyCap';
import { logger } from '@/lib/logger';
import { clientIp, hashIp } from '@/lib/net/ipHash';
import { checkIpRateLimit } from '@/lib/relay/relayGuards';
import { x402Config } from './config';
import { getResource, type X402Resource } from './registry';
import {
  buildRelayAccepts,
  decodeVanillaPaymentHeader,
  postFacilitator,
  type PreparedAccepts,
} from './vanillaGate';
import {
  buildBazaarQueryExtensionV2,
  buildPaymentRequiredV2,
  encodePaymentRequiredHeaderValue,
  toV2Accept,
} from './v2';

export const RELAY_BODY_MAX_BYTES = 32 * 1024; // v2 支払い封筒 (base64) + 余白
export const RELAY_RATE_LIMIT_MAX = 60;
export const RELAY_RATE_LIMIT_WINDOW_SEC = 60;
const MAX_RESOURCE_ID = 100;

function noStore(res: NextResponse): NextResponse {
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

function jsonError(status: number, error: string): NextResponse {
  return noStore(NextResponse.json({ error }, { status }));
}

// flag OFF は 404 (完全 inert)。ON でも CDP 鍵が無ければ 503 — fallback facilitator へ
// 黙って流すと「Bazaar に掲載される」という dual-rail の約束が満たせないまま成功に見える。
function gate(): NextResponse | null {
  if (!env.enableX402DualRail || !env.enableX402Facilitator) {
    return jsonError(404, 'not_found');
  }
  if (!x402Config.vanillaFacilitator.cdpAuth) {
    logger.warn('x402.dualrail.misconfigured', { reason: 'cdp_auth_missing' });
    return jsonError(503, 'relay_unconfigured');
  }
  return null;
}

async function rateLimit(req: Request): Promise<NextResponse | null> {
  const allowed = await checkIpRateLimit(
    'x402-dual-rail',
    hashIp(clientIp(req)),
    RELAY_RATE_LIMIT_MAX,
    RELAY_RATE_LIMIT_WINDOW_SEC,
  );
  return allowed ? null : jsonError(429, 'rate_limited');
}

type RelayTarget = {
  resource: X402Resource;
  usdc: NonNullable<X402Resource['usdc']>;
  accepts: PreparedAccepts;
};

// resourceId → 中継対象。未存在 / 無効化 / モデレーション hidden / USDC 面なしはすべて 404
// (存在の有無を外部に区別させない)。accepts は登録値だけから決定的に生成する。
async function resolveTarget(
  resourceId: unknown,
): Promise<{ ok: true; target: RelayTarget } | { ok: false; response: NextResponse }> {
  if (
    typeof resourceId !== 'string' ||
    resourceId.length < 1 ||
    resourceId.length > MAX_RESOURCE_ID
  ) {
    return { ok: false, response: jsonError(400, 'invalid_resource_id') };
  }
  const resource = await getResource(resourceId);
  if (!resource || !resource.active || resource.hidden === true || !resource.usdc) {
    return { ok: false, response: jsonError(404, 'resource_not_found') };
  }
  let accepts: PreparedAccepts;
  try {
    accepts = buildRelayAccepts({
      resourceUrl: resource.url,
      description: resource.description,
      price: resource.usdc.priceUsd,
      payTo: resource.usdc.payTo,
    });
  } catch (e) {
    // network が base 系でない等の設定不正。壊れた要件を配らない。
    logger.warn('x402.dualrail.accepts_failed', {
      resourceId: resource.id,
      error: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, response: jsonError(503, 'relay_unconfigured') };
  }
  return { ok: true, target: { resource, usdc: resource.usdc, accepts } };
}

/**
 * GET /api/x402/relay/requirements?resourceId=…
 * 出品者が自分の 402 に埋め込む USDC 要件一式を返す (公開情報のみ)。
 *   - v1Accepts: v1 JSON body の accepts[] 要素 (x402scan / v1 client 互換)
 *   - v2Accept: PAYMENT-REQUIRED の accepts[] 要素 (CAIP-2)
 *   - paymentRequiredHeader: そのまま `PAYMENT-REQUIRED` ヘッダに載せられる encoded 値
 * 出品者側で組み立てさせず完成形を配ることで、リレー側の検証 (accepts 照合) と
 * 402 表面がずれて支払いが通らなくなるドリフトを防ぐ。
 */
export async function handleDualRailRequirements(req: Request): Promise<NextResponse> {
  const gated = gate();
  if (gated) return gated;
  const limited = await rateLimit(req);
  if (limited) return limited;
  const resourceId = new URL(req.url).searchParams.get('resourceId');
  const resolved = await resolveTarget(resourceId);
  if (!resolved.ok) return resolved.response;
  const { resource, usdc, accepts } = resolved.target;
  const v2Accept = toV2Accept(accepts.v1Caip2);
  const paymentRequired = buildPaymentRequiredV2({
    url: resource.url,
    description: resource.description,
    mimeType: 'application/json',
    ...(usdc.serviceName ? { serviceName: usdc.serviceName } : {}),
    accepts: [v2Accept],
    bazaar: buildBazaarQueryExtensionV2(),
    error: 'payment_required',
  });
  return noStore(
    NextResponse.json({
      resourceId: resource.id,
      v1Accepts: accepts.v1,
      v2Accept,
      paymentRequiredHeader: encodePaymentRequiredHeaderValue(paymentRequired),
    }),
  );
}

/**
 * POST /api/x402/relay/{verify|settle}
 * body: { resourceId, paymentSignatureHeader? (v2), paymentHeader? (v1) } — どちらか必須。
 * facilitator の判定 body (isValid / success …) を 200 で素通しする。判定の解釈
 * (true 以外は解錠しない fail-closed) は出品者サーバーの責任で、リレーは真実を写すだけ。
 * facilitator 障害 (5xx / timeout) は 503 — 判定が出ていない状態を成功にも失敗にも見せない。
 */
export async function handleDualRailRelay(
  req: Request,
  action: 'verify' | 'settle',
): Promise<NextResponse> {
  const gated = gate();
  if (gated) return gated;
  const limited = await rateLimit(req);
  if (limited) return limited;
  const body = await readJsonBodyCapped(req, RELAY_BODY_MAX_BYTES);
  if (!body.ok) {
    return jsonError(body.reason === 'too_large' ? 413 : 400, body.reason);
  }
  if (typeof body.value !== 'object' || body.value === null) {
    return jsonError(400, 'invalid_body');
  }
  const b = body.value as Record<string, unknown>;
  const resolved = await resolveTarget(b.resourceId);
  if (!resolved.ok) return resolved.response;
  const { resource, usdc, accepts } = resolved.target;

  const v2Header =
    typeof b.paymentSignatureHeader === 'string' ? b.paymentSignatureHeader : null;
  const v1Header = typeof b.paymentHeader === 'string' ? b.paymentHeader : null;
  const facilitatorBody = decodeVanillaPaymentHeader(
    { v2: v2Header, v1: v1Header },
    accepts,
  );
  if (!facilitatorBody) {
    return jsonError(400, 'invalid_payment_payload');
  }

  try {
    const judgment = await postFacilitator(`/${action}`, facilitatorBody, {
      accept: toV2Accept(accepts.v1Caip2),
      // 掲載メタは registry の登録値のみ (catalog poisoning 防止・冒頭コメント参照)。
      resource: {
        resourceUrl: resource.url,
        description: resource.description,
        ...(usdc.serviceName ? { serviceName: usdc.serviceName } : {}),
      },
      bazaar: buildBazaarQueryExtensionV2(),
    });
    if (action === 'settle' && judgment.success === true) {
      logger.info('x402.dualrail.settled', {
        resourceId: resource.id,
        transaction:
          typeof judgment.transaction === 'string' ? judgment.transaction : null,
      });
    }
    return noStore(NextResponse.json(judgment));
  } catch (e) {
    logger.warn('x402.dualrail.facilitator_unavailable', {
      action,
      resourceId: resource.id,
      error: e instanceof Error ? e.message : String(e),
    });
    return jsonError(503, 'facilitator_unavailable');
  }
}
