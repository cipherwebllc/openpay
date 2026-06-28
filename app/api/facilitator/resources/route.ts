// x402 facilitator: 加盟店 resource 登録 (SIWE 認証・owner=接続ウォレット)。
//   POST → resource を登録し { resource, paywallSnippet } を返す。
//   GET  → owner の resource 一覧 { resources } を返す。
// flag OFF は 404。運営者 (OpenPay 自身) も同じ導線で自社 resource を seed 登録する (空 registry 回避)。

import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { requireSession } from '@/app/api/auth/siwe/_session';
import { logger } from '@/lib/logger';
import { isFreelyAccessible } from '@/lib/x402/moderation';
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
  return NextResponse.json({ resources });
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!env.enableX402Facilitator) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const session = await requireSession();
  if (!session.ok) return session.response;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  // 新規登録は出品の正当性表明 (attested:true) を必須にする (権利 + 支払いゲートの実装)。
  const parsed = parseResourceInput(raw, session.address, { requireAttestation: true });
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
    logger.warn('x402.facilitator.resource_not_gated', {
      merchant: session.address,
      url: parsed.input.url,
    });
    return NextResponse.json({ error: 'resource_not_gated' }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const created = await createResource(parsed.input, id, Date.now());
  if (!created.ok) {
    // 上の soft cap pre-check 通過後に並列 POST が cap に達したレースは createResource (原子的 cap) が
    // too_many で弾く。それ以外は KV エラー。
    if (created.reason === 'too_many') {
      return NextResponse.json({ error: 'too_many_resources' }, { status: 429 });
    }
    logger.warn('x402.facilitator.resource_create_failed', { merchant: session.address });
    return NextResponse.json({ error: 'storage_unavailable' }, { status: 503 });
  }
  const resource = created.resource;

  // paywall スニペット例 (resource server が 402 で返す accepts の作り方)。
  const amount = (BigInt(resource.priceJpyc) * 10n ** 18n).toString();
  const paywallSnippet = [
    '// OpenPay x402 paywall (例): 未払いリクエストに 402 + 下記 accepts を返し、',
    '// X-PAYMENT を /api/facilitator/{verify,settle} へ転送する。',
    "import { createJpycPaymentRequirements } from '@/lib/x402/requirements';",
    'const accepts = createJpycPaymentRequirements({',
    `  amount: ${amount}n, // ${resource.priceJpyc} JPYC`,
    `  payTo: '${resource.payTo}',`,
    `  resource: '${resource.url}',`,
    `  description: ${JSON.stringify(resource.description)},`,
    '});',
  ].join('\n');

  return NextResponse.json({ resource, paywallSnippet }, { status: 201 });
}
