// x402 facilitator: 登録済み resource の **編集 (PATCH)** + **無効化 (DELETE)**。
//   PATCH  → owner が url/description/priceJpyc/category/payTo を更新 → { resource }。
//   DELETE → owner が soft-delete (active:false) → { ok:true }。公開カタログ + owner 一覧から消えるが
//            データは KV に残す (settlement の resourceId 参照・監査)。
// **owner 認可が要**: SIWE セッション === resource.merchant のときだけ更新/削除を許可する (registry が
// forbidden で弾く)。特に payTo (送金先) を他人に書き換えさせない。flag OFF は 404。

import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { requireSession } from '@/app/api/auth/siwe/_session';
import { logger } from '@/lib/logger';
import { parseResourceInput, updateResource, deactivateResource } from '@/lib/x402/registry';

export const runtime = 'nodejs';
export const maxDuration = 15;

function notFound() {
  return NextResponse.json({ error: 'not_found' }, { status: 404 });
}
function forbidden() {
  return NextResponse.json({ error: 'forbidden' }, { status: 403 });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!env.enableX402Facilitator) return notFound();
  const session = await requireSession();
  if (!session.ok) return session.response;
  const { id } = await params;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = parseResourceInput(raw, session.address);
  if (!parsed.ok) return NextResponse.json({ error: parsed.reason }, { status: 400 });

  const result = await updateResource(id, session.address, parsed.input);
  if (!result.ok) {
    if (result.reason === 'not_found') return notFound();
    if (result.reason === 'forbidden') return forbidden();
    logger.warn('x402.facilitator.resource_update_failed', { id, merchant: session.address });
    return NextResponse.json({ error: 'storage_unavailable' }, { status: 503 });
  }
  return NextResponse.json({ resource: result.resource });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!env.enableX402Facilitator) return notFound();
  const session = await requireSession();
  if (!session.ok) return session.response;
  const { id } = await params;

  const result = await deactivateResource(id, session.address);
  if (!result.ok) {
    if (result.reason === 'not_found') return notFound();
    if (result.reason === 'forbidden') return forbidden();
    logger.warn('x402.facilitator.resource_deactivate_failed', { id, merchant: session.address });
    return NextResponse.json({ error: 'storage_unavailable' }, { status: 503 });
  }
  return NextResponse.json({ ok: true });
}
