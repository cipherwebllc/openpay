// x402 facilitator: 加盟店 resource 登録 (SIWE 認証・owner=接続ウォレット)。
//   POST → resource を登録し { resource, paywallSnippet } を返す。
//   GET  → owner の resource 一覧 { resources } を返す。
// flag OFF は 404。OpenPay 自身の resource は registry を経由せず discovery が生成する。

import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { requireSession } from '@/app/api/auth/siwe/_session';
import { readJsonBodyCapped } from '@/lib/httpBodyCap';
import { logger } from '@/lib/logger';
import { clientIp, hashIp } from '@/lib/net/ipHash';
import { checkIpRateLimit } from '@/lib/relay/relayGuards';
import { redactUrlForTelemetry } from '@/lib/telemetryRedaction';
import { isFreelyAccessible, probeGate } from '@/lib/x402/moderation';
import { buildPaywallSnippet } from '@/lib/x402/paywallSnippet';
import {
  checkResourceWalletRateLimit,
  RESOURCE_BODY_MAX_BYTES,
  RESOURCE_RATE_LIMIT_WINDOW_SEC,
} from '@/lib/x402/resourceRequestGuards';
import {
  parseResourceInput,
  createResource,
  listResourcesForMerchant,
  countMerchantResources,
  MAX_RESOURCES_PER_MERCHANT,
} from '@/lib/x402/registry';

export const runtime = 'nodejs';
export const maxDuration = 15;

export async function GET(): Promise<NextResponse> {
  if (!env.enableX402Facilitator) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const session = await requireSession();
  if (!session.ok) return session.response;
  const resources = await listResourcesForMerchant(session.address);
  if (resources === null) {
    logger.warn('x402.facilitator.resource_list_failed', { merchant: session.address });
    return NextResponse.json({ error: 'storage_unavailable' }, { status: 503 });
  }
  // スニペットは URL から決定的に再生成できる。登録時 1 回きりだった表示を owner 一覧から
  // いつでも再取得できるようにする (加盟店の実組み込みで「もう一度見たい」が発生)。
  return NextResponse.json({
    resources: resources.map((r) => ({
      ...r,
      paywallSnippet: buildPaywallSnippet(r.url, { usdcResourceId: r.usdc ? r.id : undefined }),
    })),
  });
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!env.enableX402Facilitator) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (
    !(await checkIpRateLimit(
      'x402-resource-write',
      hashIp(clientIp(req)),
      30,
      60,
    ))
  ) {
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }
  const session = await requireSession();
  if (!session.ok) return session.response;

  if (!(await checkResourceWalletRateLimit(session.address))) {
    return NextResponse.json(
      { error: 'rate_limited' },
      {
        status: 429,
        headers: { 'Retry-After': String(RESOURCE_RATE_LIMIT_WINDOW_SEC) },
      },
    );
  }

  const body = await readJsonBodyCapped(req, RESOURCE_BODY_MAX_BYTES);
  if (!body.ok) {
    if (body.reason === 'too_large') {
      return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
    }
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  // 新規登録は出品の正当性表明 (attested:true) を必須にする (権利 + 支払いゲートの実装)。
  const parsed = parseResourceInput(body.value, session.address, {
    requireAttestation: true,
  });
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.reason }, { status: 400 });
  }

  // owner ごとの登録数 soft cap (濫用ガード)。soft-delete 済も数える (create→delete 反復で KV を
  // 無制限に増やさせない)。KV エラーは null → 0 件と誤認して cap を bypass させず 503。
  const count = await countMerchantResources(session.address);
  if (count === null) {
    logger.warn('x402.facilitator.resource_count_failed', { merchant: session.address });
    return NextResponse.json({ error: 'storage_unavailable' }, { status: 503 });
  }
  if (count >= MAX_RESOURCES_PER_MERCHANT) {
    return NextResponse.json({ error: 'too_many_resources' }, { status: 429 });
  }

  // モデレーション: 無料で公開されている URL の価格付き登録を弾く (probe で 200 を確認したら拒否)。
  // 402/401/403/エラー/タイムアウトは通す (fail-open)。private/loopback は parseResourceInput で既に排除。
  if (await isFreelyAccessible(parsed.input.url)) {
    const redacted = await redactUrlForTelemetry(parsed.input.url);
    logger.warn('x402.facilitator.resource_not_gated', {
      merchant: session.address,
      resourceOrigin: redacted.origin,
      resourceHash: redacted.hash,
    });
    return NextResponse.json({ error: 'resource_not_gated' }, { status: 400 });
  }

  // ゲート方式の検証: 402 は返すが accepts が OpenPay (forwarder-split/JPYC) でない URL は、
  // 「JPYC で払える」というカタログの約束を守れないため掲載しない (他 facilitator ゲートの
  // ミスマッチ掲載を防ぐ・実加盟店の USDC ゲート登録で発覚)。スニペットを同梱して返すので、
  // 設置 → 再登録で解決できる (判定不能 'unknown' は従来どおり fail-open)。
  if ((await probeGate(parsed.input.url)) === 'foreign') {
    return NextResponse.json(
      {
        error: 'gate_not_openpay',
        paywallSnippet: buildPaywallSnippet(parsed.input.url),
      },
      { status: 422 },
    );
  }

  const id = crypto.randomUUID();
  const created = await createResource(parsed.input, id, Date.now());
  if (!created.ok) {
    // 上の soft cap pre-check 通過後に並列 POST が cap に達したレースは createResource (原子的 cap) が
    // too_many で弾く。invalid_url は保存層でも予約 origin を守る invariant、それ以外は KV エラー。
    if (created.reason === 'invalid_url') {
      return NextResponse.json({ error: 'invalid_url' }, { status: 400 });
    }
    if (created.reason === 'too_many') {
      return NextResponse.json({ error: 'too_many_resources' }, { status: 429 });
    }
    logger.warn('x402.facilitator.resource_create_failed', { merchant: session.address });
    return NextResponse.json({ error: 'storage_unavailable' }, { status: 503 });
  }
  const resource = created.resource;

  // paywall スニペット: 外部サーバーがコピペで動く自己完結ゲート (旧: リポ内 import 前提の
  // 骨子例 → 実加盟店で動かず差し替え)。
  const paywallSnippet = buildPaywallSnippet(resource.url, {
    usdcResourceId: resource.usdc ? resource.id : undefined,
  });

  return NextResponse.json({ resource, paywallSnippet }, { status: 201 });
}
