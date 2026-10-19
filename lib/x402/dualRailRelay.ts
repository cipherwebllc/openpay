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
import { atomicToHuman, recordSettleLedgerAfterResponse } from '@/lib/x402/settleLedger';
import { clientIp, hashIpBucket } from '@/lib/net/ipHash';
import { checkIpRateLimit } from '@/lib/relay/relayGuards';
import { x402Config } from './config';
import { getResource, type X402Resource } from './registry';
import {
  arcMarkKey,
  claimArcPending,
  markArcSettled,
  readArcMark,
  releaseArcPending,
  type ArcMarkState,
} from './relayArcMarks';
import {
  buildRelayAccepts,
  decodeVanillaPaymentHeaderWithRail,
  postFacilitator,
  postFacilitatorWithStatus,
  type FacilitatorRail,
  type PreparedAccepts,
} from './vanillaGate';
import {
  buildBazaarQueryExtensionV2,
  buildPaymentRequiredV2,
  deepStrictEqual,
  encodePaymentRequiredHeaderValue,
  toV2Accept,
} from './v2';
import type { FacilitatorV1Body } from './v2';

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
    hashIpBucket(clientIp(req)),
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
      // Arc 面はリレーの Arc flag と出品者のオプトインの両方が揃ったときだけ (Arc rail 自体の
      // ENABLE_X402_ARC_GATEWAY も buildRelayAccepts が確認する)。
      arc: env.enableX402DualRailArc && resource.usdc.arc === true,
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
  // Match resolveTarget's existing ID bounds before the KV limiter, preventing
  // malformed public lookups from draining storage shared with verify/settle.
  const resourceId = new URL(req.url).searchParams.get('resourceId');
  if (!resourceId || resourceId.length > MAX_RESOURCE_ID) {
    return jsonError(400, 'invalid_resource_id');
  }
  const limited = await rateLimit(req);
  if (limited) return limited;
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
  // Arc 面は既存 4 フィールドを変えずに `arc` として足す。既存の paymentRequiredHeader に Arc を
  // 混ぜると、稼働中の出品者サーバー / SDK の pin 検証 (全 accepts が Base であること) が両レールを
  // 止めるため。Arc を知るクライアントは 402 のヘッダを arc.paymentRequiredHeader (Base + Arc の
  // 完成形) に差し替える — 組み立てさせない (ドリフト防止)。
  const arc = accepts.arc
    ? (() => {
        const arcV2Accept = toV2Accept(accepts.arc);
        return {
          v2Accept: arcV2Accept,
          paymentRequiredHeader: encodePaymentRequiredHeaderValue({
            ...paymentRequired,
            accepts: [v2Accept, arcV2Accept],
          }),
        };
      })()
    : undefined;
  return noStore(
    NextResponse.json({
      resourceId: resource.id,
      v1Accepts: accepts.v1,
      v2Accept,
      paymentRequiredHeader: encodePaymentRequiredHeaderValue(paymentRequired),
      ...(arc ? { arc } : {}),
    }),
  );
}

const BASE_MONEY_FIELDS = ['payTo', 'maxAmountRequired', 'asset', 'network', 'scheme'] as const;

/**
 * 出品者サーバーが送った pin (paymentRequirements) がどの rail の現行条件と一致するか。
 * pin の形で rail を決める: v1 形 (maxAmountRequired を持つ) = Base は従来の 5 項目、
 * v2 形 = Arc はリレー自身の Arc accept と構造的に完全一致。どれとも一致しなければ null (409)。
 */
function pinnedRail(pinned: unknown, accepts: PreparedAccepts): FacilitatorRail | null {
  if (typeof pinned !== 'object' || pinned === null || Array.isArray(pinned)) return null;
  const p = pinned as Record<string, unknown>;
  if ('maxAmountRequired' in p) {
    return BASE_MONEY_FIELDS.every((field) => p[field] === accepts.v1[field]) ? 'base' : null;
  }
  return accepts.arc && deepStrictEqual(p, toV2Accept(accepts.arc)) ? 'arc-gateway' : null;
}

function alreadyUsedJudgment(state: ArcMarkState): Record<string, unknown> {
  return {
    isValid: false,
    invalidReason: state === 'settled' ? 'authorization_already_used' : 'authorization_in_use',
  };
}

/**
 * Arc 面の verify / settle。Circle Gateway へ中継し、使用済み署名の使い回しを KV の印で止める
 * (relayArcMarks.ts の冒頭コメント)。掲載メタは Gateway に送らない (Bazaar は CDP 専用)。
 */
async function relayArc(
  action: 'verify' | 'settle',
  body: FacilitatorV1Body,
  target: RelayTarget,
): Promise<NextResponse> {
  const { resource, accepts } = target;
  const arcAccept = accepts.arc!;
  const key = arcMarkKey(arcAccept.network, body.paymentPayload.payload);
  if (!key) return jsonError(400, 'invalid_payment_payload');

  if (action === 'verify') {
    const before = await readArcMark(key);
    if (before === 'settled' || before === 'pending') {
      return noStore(NextResponse.json(alreadyUsedJudgment(before)));
    }
  }

  let judgment: Record<string, unknown>;
  try {
    judgment = (
      await postFacilitatorWithStatus(
        `/${action}`,
        body,
        {
          accept: toV2Accept(arcAccept),
          resource: { resourceUrl: resource.url, description: resource.description },
        },
        'arc-gateway',
      )
    ).body;
  } catch (e) {
    logger.warn('x402.dualrail.facilitator_unavailable', {
      action,
      rail: 'arc-gateway',
      resourceId: resource.id,
      error: e instanceof Error ? e.message : String(e),
    });
    return jsonError(503, 'facilitator_unavailable');
  }

  if (action === 'verify') {
    if (judgment.isValid === true) {
      const claimed = await claimArcPending(key);
      if (claimed === 'settled' || claimed === 'pending') {
        return noStore(NextResponse.json(alreadyUsedJudgment(claimed)));
      }
    }
    return noStore(NextResponse.json(judgment));
  }

  if (judgment.success === true) {
    await markArcSettled(key);
    const transaction =
      typeof judgment.transaction === 'string' ? judgment.transaction : null;
    logger.info('x402.dualrail.settled', { resourceId: resource.id, rail: 'arc-gateway', transaction });
    // network は Gateway のエコーではなくローカルの CAIP-2 (台帳と応答の両方)。transaction は Gateway の UUID。
    recordSettleLedgerAfterResponse({
      at: new Date().toISOString(),
      source: 'usdc-dual-rail',
      network: arcAccept.network,
      resource: resource.url,
      payer: typeof judgment.payer === 'string' ? judgment.payer : null,
      payTo: arcAccept.payTo,
      amount: atomicToHuman(arcAccept.maxAmountRequired, 6),
      asset: 'USDC',
      tx: transaction,
    });
    return noStore(NextResponse.json({ ...judgment, network: arcAccept.network }));
  }
  // nonce_already_used は Gateway が「使用済み」を明言した確定シグナル。消すと、決済済みの印の書き込みが
  // 一度落ちただけで再送 → verify 通過 → 上流実行 → 印削除… が回り続ける。
  if (judgment.errorReason === 'nonce_already_used') {
    await markArcSettled(key);
  } else {
    await releaseArcPending(key);
  }
  return noStore(NextResponse.json(judgment));
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

  // Listing edits must not substitute money terms after the seller pins them. Display metadata
  // is excluded so description/URL edits do not break payment; all forwarded fields, including
  // the fixed USDC domain/timeout, still come from the registry/config, never this snapshot.
  // The pin is checked before decoding the payment; its shape names the rail it pins.
  let pinRail: FacilitatorRail | null = null;
  if ('paymentRequirements' in b) {
    pinRail = pinnedRail(b.paymentRequirements, accepts);
    if (pinRail === null) {
      logger.warn('x402.dualrail.requirements_mismatch', { resourceId: resource.id, action });
      return jsonError(409, 'requirements_mismatch');
    }
  }

  const v2Header =
    typeof b.paymentSignatureHeader === 'string' ? b.paymentSignatureHeader : null;
  const v1Header = typeof b.paymentHeader === 'string' ? b.paymentHeader : null;
  const decoded = decodeVanillaPaymentHeaderWithRail({ v2: v2Header, v1: v1Header }, accepts);
  if (!decoded) {
    return jsonError(400, 'invalid_payment_payload');
  }
  // A seller server that pinned one rail must not be charged on another: its terms for the
  // other rail were never checked (e.g. a stale face that does not know Arc yet). 409 makes it
  // refetch the requirements and ask the buyer again.
  if (pinRail !== null && decoded.rail !== pinRail) {
    logger.warn('x402.dualrail.requirements_mismatch', {
      resourceId: resource.id,
      action,
      reason: 'rail_mismatch',
    });
    return jsonError(409, 'requirements_mismatch');
  }
  if (decoded.rail === 'arc-gateway') {
    return relayArc(action, decoded.body, resolved.target);
  }
  const facilitatorBody = decoded.body;

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
      const transaction =
        typeof judgment.transaction === 'string' ? judgment.transaction : null;
      logger.info('x402.dualrail.settled', { resourceId: resource.id, transaction });
      // 運営台帳 (誰が・どの商品を・いくらで)。応答返却後・no-throw (掟 12/13)。
      recordSettleLedgerAfterResponse({
        at: new Date().toISOString(),
        source: 'usdc-dual-rail',
        network:
          typeof judgment.network === 'string' ? judgment.network : accepts.v1.network,
        resource: resource.url,
        payer: typeof judgment.payer === 'string' ? judgment.payer : null,
        payTo: accepts.v1.payTo,
        amount: atomicToHuman(accepts.v1.maxAmountRequired, 6),
        asset: 'USDC',
        tx: transaction,
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
