import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { readJsonBodyCapped } from '@/lib/httpBodyCap';
import {
  getHostedContent,
  getHostedProduct,
  getHostedProductUpdateSnapshot,
  isHostedLabel,
  parseHostedInput,
  replaceHostedSellerProduct,
  sellerDisclosureComplete,
  type HostedContent,
  type HostedProduct,
  type HostedProductUpdateSnapshot,
  type ReplaceHostedSellerProductResult,
} from '@/lib/x402/hostedStore';
import {
  hasOnlyKeys,
  objectValue,
  requireStoreSeller,
  STORE_BODY_MAX_BYTES,
  storePrivateJson,
} from '@/app/api/store/_shared';
import { touchStoreIndex } from '@/lib/x402/storeIndex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

const PRODUCT_PATCH_KEYS = new Set([
  'payTo',
  'title',
  'desc',
  'emoji',
  'imageUrl',
  'galleryUrls',
  'priceJpyc',
  'contentKind',
  'label',
  'category',
  'tags',
  'content',
  'saleActive',
]);

function notFound(): NextResponse {
  return storePrivateJson({ ok: false, error: 'not_found' }, 404);
}

function updateError(
  result: Extract<ReplaceHostedSellerProductResult, { ok: false }>,
) {
  switch (result.reason) {
    case 'not_found':
      return notFound();
    case 'forbidden':
      return storePrivateJson({ ok: false, error: 'forbidden' }, 403);
    case 'conflict':
      return storePrivateJson({ ok: false, error: 'edit_conflict' }, 409);
    case 'corrupt':
    case 'storage':
    default:
      return storePrivateJson(
        { ok: false, error: 'storage_unavailable' },
        503,
      );
  }
}

async function ownedProduct(
  id: string,
  owner: string,
): Promise<
  | { ok: true; product: HostedProduct }
  | { ok: false; response: NextResponse }
> {
  const product = await getHostedProduct(id);
  if (product === 'storage') {
    return {
      ok: false,
      response: storePrivateJson(
        { ok: false, error: 'storage_unavailable' },
        503,
      ),
    };
  }
  if (!product) return { ok: false, response: notFound() };
  if (product.owner.toLowerCase() !== owner.toLowerCase()) {
    return {
      ok: false,
      response: storePrivateJson({ ok: false, error: 'forbidden' }, 403),
    };
  }
  return { ok: true, product };
}

async function ownedProductSnapshot(
  id: string,
  owner: string,
): Promise<
  | { ok: true; snapshot: HostedProductUpdateSnapshot }
  | { ok: false; response: NextResponse }
> {
  const snapshot = await getHostedProductUpdateSnapshot(id);
  if (snapshot === 'storage') {
    return {
      ok: false,
      response: storePrivateJson(
        { ok: false, error: 'storage_unavailable' },
        503,
      ),
    };
  }
  if (!snapshot) return { ok: false, response: notFound() };
  if (snapshot.product.owner.toLowerCase() !== owner.toLowerCase()) {
    return {
      ok: false,
      response: storePrivateJson({ ok: false, error: 'forbidden' }, 403),
    };
  }
  return { ok: true, snapshot };
}

async function currentContent(
  product: HostedProduct,
): Promise<
  | { ok: true; content: HostedContent | null }
  | { ok: false; response: NextResponse }
> {
  const content = await getHostedContent(
    product.id,
    product.contentRevision,
  );
  if (content === 'storage' || (content === null && product.contentAvailable)) {
    return {
      ok: false,
      response: storePrivateJson(
        { ok: false, error: 'storage_unavailable' },
        503,
      ),
    };
  }
  return { ok: true, content };
}

export async function GET(
  req: Request,
  { params }: RouteContext,
): Promise<NextResponse> {
  if (!env.enableCreatorStore) return notFound();
  const auth = await requireStoreSeller(req, 'product-read');
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const owned = await ownedProduct(id, auth.address);
  if (!owned.ok) return owned.response;
  const content = await currentContent(owned.product);
  if (!content.ok) return content.response;
  return storePrivateJson({
    ok: true,
    product: owned.product,
    content: content.content,
  });
}

export async function PATCH(
  req: Request,
  { params }: RouteContext,
): Promise<NextResponse> {
  if (!env.enableCreatorStore) return notFound();
  const auth = await requireStoreSeller(req, 'products-write');
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const owned = await ownedProductSnapshot(id, auth.address);
  if (!owned.ok) return owned.response;
  const product = owned.snapshot.product;

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
  if (!raw || Object.keys(raw).length === 0) {
    return storePrivateJson({ ok: false, error: 'invalid_body' }, 400);
  }
  if (!hasOnlyKeys(raw, PRODUCT_PATCH_KEYS)) {
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

  const saleActiveOnly =
    Object.keys(raw).length === 1 && typeof raw.saleActive === 'boolean';
  if (saleActiveOnly) {
    const nextSaleActive = raw.saleActive === true;
    if (nextSaleActive && !product.contentAvailable) {
      return storePrivateJson(
        { ok: false, error: 'content_unavailable' },
        409,
      );
    }
    if (!product.saleActive && nextSaleActive) {
      const disclosure = await sellerDisclosureComplete(auth.address);
      if (disclosure === 'storage') {
        // 販売者情報 KV の障害を「登録済み」に倒すと法定表示なしの商品が販売開始するため、
        // seller metadata の更新へ偽成功を波及させず fail-closed の 503 にする。
        return storePrivateJson(
          { ok: false, error: 'storage_unavailable' },
          503,
        );
      }
      if (!disclosure) {
        return storePrivateJson(
          { ok: false, error: 'seller_disclosure_required' },
          409,
        );
      }
    }
    const toggled = await replaceHostedSellerProduct({
      snapshot: owned.snapshot,
      owner: auth.address,
      metadata: {
        title: product.title,
        ...(product.desc ? { desc: product.desc } : {}),
        ...(product.emoji ? { emoji: product.emoji } : {}),
        ...(product.imageUrl ? { imageUrl: product.imageUrl } : {}),
        ...(product.galleryUrls
          ? { galleryUrls: product.galleryUrls }
          : {}),
        priceJpyc: product.priceJpyc,
        label: product.label,
        ...(product.category ? { category: product.category } : {}),
        ...(product.tags ? { tags: product.tags } : {}),
        saleActive: nextSaleActive,
      },
    });
    if (!toggled.ok) return updateError(toggled);
    // Store 掲載インデックス (P2)。no-throw (掲載遅延のみ・本体へ波及させない)。
    await touchStoreIndex(
      toggled.product.id,
      toggled.product.updatedAt ?? toggled.product.createdAt,
    );
    return storePrivateJson({ ok: true, product: toggled.product });
  }

  if (!product.contentAvailable) {
    return storePrivateJson(
      { ok: false, error: 'content_unavailable' },
      409,
    );
  }
  const content = await currentContent(product);
  if (!content.ok) return content.response;
  if (!content.content) {
    return storePrivateJson(
      { ok: false, error: 'storage_unavailable' },
      503,
    );
  }

  const candidateContent =
    raw.content !== undefined ? raw.content : content.content.value;
  const parsed = parseHostedInput({
    owner: auth.address,
    payTo: raw.payTo !== undefined ? raw.payTo : product.payTo,
    title:
      raw.title !== undefined ? raw.title : product.title,
    desc:
      raw.desc === ''
        ? undefined
        : raw.desc !== undefined
          ? raw.desc
          : product.desc,
    emoji: raw.emoji !== undefined ? raw.emoji : product.emoji,
    imageUrl:
      raw.imageUrl !== undefined ? raw.imageUrl : product.imageUrl,
    galleryUrls:
      raw.galleryUrls !== undefined
        ? raw.galleryUrls
        : product.galleryUrls,
    priceJpyc:
      raw.priceJpyc !== undefined
        ? raw.priceJpyc
        : product.priceJpyc,
    contentKind:
      raw.contentKind !== undefined
        ? raw.contentKind
        : product.contentKind,
    label:
      raw.label !== undefined ? raw.label : product.label,
    category:
      raw.category !== undefined ? raw.category : product.category,
    tags: raw.tags !== undefined ? raw.tags : product.tags,
    content: candidateContent,
  });
  if (!parsed.ok) {
    return storePrivateJson(
      { ok: false, error: 'invalid_product', detail: parsed.error },
      400,
    );
  }
  if (
    raw.payTo !== undefined &&
    parsed.product.payTo.toLowerCase() !== product.payTo.toLowerCase()
  ) {
    return storePrivateJson(
      { ok: false, error: 'pay_to_immutable' },
      400,
    );
  }

  const saleActive =
    typeof raw.saleActive === 'boolean'
      ? raw.saleActive
      : product.saleActive;
  if (saleActive && !product.contentAvailable) {
    return storePrivateJson(
      { ok: false, error: 'content_unavailable' },
      409,
    );
  }
  if (!product.saleActive && saleActive) {
    const disclosure = await sellerDisclosureComplete(auth.address);
    if (disclosure === 'storage') {
      // 販売者情報 KV の障害を「登録済み」に倒すと法定表示なしの商品が販売開始するため、
      // seller metadata の更新へ偽成功を波及させず fail-closed の 503 にする。
      return storePrivateJson(
        { ok: false, error: 'storage_unavailable' },
        503,
      );
    }
    if (!disclosure) {
      return storePrivateJson(
        { ok: false, error: 'seller_disclosure_required' },
        409,
      );
    }
  }

  const contentChanged =
    parsed.content.kind !== content.content.kind ||
    parsed.content.value !== content.content.value;
  const updated = await replaceHostedSellerProduct({
    snapshot: owned.snapshot,
    owner: auth.address,
    metadata: {
      title: parsed.product.title,
      ...(parsed.product.desc ? { desc: parsed.product.desc } : {}),
      ...(parsed.product.emoji ? { emoji: parsed.product.emoji } : {}),
      ...(parsed.product.imageUrl
        ? { imageUrl: parsed.product.imageUrl }
        : {}),
      ...(parsed.product.galleryUrls
        ? { galleryUrls: parsed.product.galleryUrls }
        : {}),
      priceJpyc: parsed.product.priceJpyc,
      label: parsed.product.label,
      ...(parsed.product.category
        ? { category: parsed.product.category }
        : {}),
      ...(parsed.product.tags ? { tags: parsed.product.tags } : {}),
      saleActive,
    },
    ...(contentChanged ? { content: parsed.content } : {}),
  });
  if (!updated.ok) return updateError(updated);
  // Store 掲載インデックス (P2)。no-throw (掲載遅延のみ・本体へ波及させない)。
  await touchStoreIndex(
    updated.product.id,
    updated.product.updatedAt ?? updated.product.createdAt,
  );
  return storePrivateJson({ ok: true, product: updated.product });
}
