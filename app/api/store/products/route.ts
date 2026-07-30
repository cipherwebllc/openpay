import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { readJsonBodyCapped } from '@/lib/httpBodyCap';
import {
  createHostedProduct,
  isHostedLabel,
  listHostedForOwner,
  MAX_HOSTED_PER_OWNER,
  parseHostedInput,
  sellerDisclosureComplete,
} from '@/lib/x402/hostedStore';
import {
  hasOnlyKeys,
  objectValue,
  requireStoreSeller,
  STORE_BODY_MAX_BYTES,
  storePrivateJson,
} from '@/app/api/store/_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PRODUCT_INPUT_KEYS = new Set([
  'payTo',
  'title',
  'desc',
  'emoji',
  'priceJpyc',
  'contentKind',
  'label',
  'content',
  'saleActive',
]);

function notFound(): NextResponse {
  return storePrivateJson({ ok: false, error: 'not_found' }, 404);
}

async function disclosureAllowsSale(
  owner: string,
): Promise<NextResponse | null> {
  const complete = await sellerDisclosureComplete(owner);
  if (complete === 'storage') {
    // 販売者情報 KV の障害を「登録済み」に倒すと法定表示なしの商品が販売開始するため、
    // 出品 metadata 側へ偽成功を波及させず fail-closed の 503 にする。
    return storePrivateJson(
      { ok: false, error: 'storage_unavailable' },
      503,
    );
  }
  return complete
    ? null
    : storePrivateJson(
        { ok: false, error: 'seller_disclosure_required' },
        409,
      );
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!env.enableCreatorStore) return notFound();
  const auth = await requireStoreSeller(req, 'products-read');
  if (!auth.ok) return auth.response;

  const products = await listHostedForOwner(auth.address);
  if (products === null) {
    return storePrivateJson(
      { ok: false, error: 'storage_unavailable' },
      503,
    );
  }
  return storePrivateJson({
    ok: true,
    products,
    max: MAX_HOSTED_PER_OWNER,
  });
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!env.enableCreatorStore) return notFound();
  const auth = await requireStoreSeller(req, 'products-write');
  if (!auth.ok) return auth.response;

  const body = await readJsonBodyCapped(req, STORE_BODY_MAX_BYTES);
  if (!body.ok) {
    return storePrivateJson(
      {
        ok: false,
        error:
          body.reason === 'too_large' ? 'payload_too_large' : 'invalid_json',
      },
      body.reason === 'too_large' ? 413 : 400,
    );
  }
  const raw = objectValue(body.value);
  if (!raw) {
    return storePrivateJson({ ok: false, error: 'invalid_body' }, 400);
  }
  if (!hasOnlyKeys(raw, PRODUCT_INPUT_KEYS)) {
    return storePrivateJson({ ok: false, error: 'invalid_body' }, 400);
  }
  if (
    raw.saleActive !== undefined &&
    typeof raw.saleActive !== 'boolean'
  ) {
    return storePrivateJson(
      { ok: false, error: 'invalid_sale_active' },
      400,
    );
  }
  if (raw.payTo !== undefined && typeof raw.payTo !== 'string') {
    return storePrivateJson(
      { ok: false, error: 'invalid_product', detail: 'invalid payTo' },
      400,
    );
  }
  if (raw.label !== undefined && !isHostedLabel(raw.label)) {
    return storePrivateJson(
      { ok: false, error: 'invalid_product', detail: 'invalid label' },
      400,
    );
  }

  const parsed = parseHostedInput({
    owner: auth.address,
    payTo: raw.payTo,
    title: raw.title,
    desc: raw.desc === '' ? undefined : raw.desc,
    emoji: raw.emoji,
    priceJpyc: raw.priceJpyc,
    contentKind: raw.contentKind,
    label: raw.label,
    content: raw.content,
  });
  if (!parsed.ok) {
    return storePrivateJson(
      { ok: false, error: 'invalid_product', detail: parsed.error },
      400,
    );
  }

  const saleActive = raw.saleActive === true;
  if (saleActive) {
    const denied = await disclosureAllowsSale(auth.address);
    if (denied) return denied;
  }
  const created = await createHostedProduct({
    ...parsed,
    product: { ...parsed.product, saleActive },
  });
  if (!created.ok) {
    if (created.reason === 'too_many') {
      return storePrivateJson(
        {
          ok: false,
          error: 'too_many_products',
          max: MAX_HOSTED_PER_OWNER,
        },
        409,
      );
    }
    if (created.reason === 'conflict') {
      return storePrivateJson({ ok: false, error: 'conflict' }, 409);
    }
    return storePrivateJson(
      { ok: false, error: 'storage_unavailable' },
      503,
    );
  }
  return storePrivateJson(
    { ok: true, product: created.product },
    201,
  );
}
