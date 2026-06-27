// x402 facilitator: 加盟店 resource 登録 (SIWE 認証・owner=接続ウォレット)。
//   POST → resource を登録し { resource, paywallSnippet } を返す。
//   GET  → owner の resource 一覧 { resources } を返す。
// flag OFF は 404。運営者 (OpenPay 自身) も同じ導線で自社 resource を seed 登録する (空 registry 回避)。

import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { requireSession } from '@/app/api/auth/siwe/_session';
import { logger } from '@/lib/logger';
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
  const parsed = parseResourceInput(raw, session.address);
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

  const id = crypto.randomUUID();
  const resource = await createResource(parsed.input, id, Date.now());
  if (!resource) {
    logger.warn('x402.facilitator.resource_create_failed', { merchant: session.address });
    return NextResponse.json({ error: 'storage_unavailable' }, { status: 503 });
  }

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
