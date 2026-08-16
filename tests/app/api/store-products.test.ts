import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const OWNER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const FEE_RECEIVER = '0x3333333333333333333333333333333333333333';
const ID = `h_${'a'.repeat(32)}`;

const state = vi.hoisted(() => ({
  enabled: true,
}));
const requireSession = vi.hoisted(() => vi.fn());
const createHostedProduct = vi.hoisted(() => vi.fn());
const getHostedProduct = vi.hoisted(() => vi.fn());
const getHostedProductUpdateSnapshot = vi.hoisted(() => vi.fn());
const getHostedContent = vi.hoisted(() => vi.fn());
const listHostedForOwner = vi.hoisted(() => vi.fn());
const parseHostedInput = vi.hoisted(() => vi.fn());
const replaceHostedSellerProduct = vi.hoisted(() => vi.fn());
const sellerDisclosureComplete = vi.hoisted(() => vi.fn());
const getSellerDisclosure = vi.hoisted(() => vi.fn());
const parseSellerDisclosureInput = vi.hoisted(() => vi.fn());
const putSellerDisclosure = vi.hoisted(() => vi.fn());
const checkIpRateLimit = vi.hoisted(() => vi.fn());
const checkReadRateLimit = vi.hoisted(() => vi.fn());
const checkUsdcReachability = vi.hoisted(() => vi.fn());

// 掲載先 handle の所有検証 (2026-08-04) は handleStore を boundary mock で切る
// (実体は env 依存が深く、この route テストの env mock と衝突するため)。
const handleMocks = vi.hoisted(() => ({
  owned: ['cipherweb'] as string[] | null,
}));
vi.mock('@/lib/handleStore', () => ({
  listHandlesForOwner: async () => handleMocks.owned,
}));

vi.mock('@/lib/env', () => ({
  env: {
    get enableCreatorStore() {
      return state.enabled;
    },
  },
}));
vi.mock('@/app/api/auth/siwe/_session', () => ({
  requireSession,
}));
vi.mock('@/lib/net/ipHash', () => ({
  clientIp: () => '192.0.2.1',
  hashIp: () => 'hashed-ip',
}));
vi.mock('@/lib/relay/relayGuards', () => ({
  checkIpRateLimit,
  checkReadRateLimit,
}));
vi.mock('@/lib/x402/storeUsdcReachability', () => ({
  checkStoreUsdcPayToReachability: checkUsdcReachability,
}));
vi.mock('@/lib/x402/hostedStore', () => ({
  MAX_HOSTED_PER_OWNER: 12,
  createHostedProduct,
  getHostedProduct,
  getHostedProductUpdateSnapshot,
  getHostedContent,
  isHostedLabel: (value: unknown) =>
    ['download', 'pdf', 'zip', 'prompt', 'api', 'external'].includes(
      String(value),
    ),
  listHostedForOwner,
  parseHostedInput,
  replaceHostedSellerProduct,
  sellerDisclosureComplete,
  getSellerDisclosure,
  parseSellerDisclosureInput,
  putSellerDisclosure,
}));

import {
  GET as listProducts,
  POST as createProduct,
} from '@/app/api/store/products/route';
import {
  GET as getProduct,
  PATCH as patchProduct,
} from '@/app/api/store/products/[id]/route';
import {
  GET as getSeller,
  PUT as putSeller,
} from '@/app/api/store/seller/route';

const baseProduct = {
  id: ID,
  owner: OWNER,
  payTo: OWNER,
  title: 'Prompt',
  priceJpyc: '300',
  contentKind: 'text' as const,
  label: 'prompt' as const,
  contentRevision: 1,
  saleActive: false,
  contentAvailable: true,
  createdAt: 1,
};

function request(
  path: string,
  method = 'GET',
  body?: Record<string, unknown>,
): Request {
  return new Request(`https://open-pay.jp${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

function validBody(over: Record<string, unknown> = {}) {
  return {
    title: 'Prompt',
    desc: '',
    emoji: '🧠',
    priceJpyc: '300',
    contentKind: 'text',
    label: 'prompt',
    content: 'secret body',
    saleActive: false,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.enabled = true;
  requireSession.mockResolvedValue({ ok: true, address: OWNER });
  checkIpRateLimit.mockResolvedValue(true);
  checkReadRateLimit.mockResolvedValue(true);
  checkUsdcReachability.mockResolvedValue({ ok: true, payTo: OWNER });
  listHostedForOwner.mockResolvedValue([baseProduct]);
  getHostedProduct.mockResolvedValue(baseProduct);
  getHostedProductUpdateSnapshot.mockResolvedValue({
    product: baseProduct,
    token: JSON.stringify(baseProduct),
  });
  getHostedContent.mockResolvedValue({
    kind: 'text',
    value: 'secret body',
  });
  sellerDisclosureComplete.mockResolvedValue(true);
  createHostedProduct.mockResolvedValue({
    ok: true,
    product: baseProduct,
  });
  replaceHostedSellerProduct.mockImplementation(
    async ({
      metadata,
      content,
    }: {
      metadata: Record<string, unknown>;
      content?: unknown;
    }) => ({
      ok: true,
      product: {
        ...baseProduct,
        ...metadata,
        ...(content ? { contentRevision: 2 } : {}),
      },
    }),
  );
  parseHostedInput.mockImplementation(
    (input: Record<string, unknown>) => {
      if (input.payTo === FEE_RECEIVER) {
        return {
          ok: false,
          error: 'payTo must not be the fee receiver',
        };
      }
      const contentKind = input.contentKind === 'url' ? 'url' : 'text';
      return {
        ok: true,
        product: {
          ...baseProduct,
          owner: input.owner,
          payTo: input.payTo ?? input.owner,
          title: input.title,
          ...(typeof input.desc === 'string' ? { desc: input.desc } : {}),
          ...(typeof input.emoji === 'string'
            ? { emoji: input.emoji }
            : {}),
          ...(typeof input.imageUrl === 'string'
            ? { imageUrl: input.imageUrl }
            : {}),
          ...(Array.isArray(input.galleryUrls) && input.galleryUrls.length > 0
            ? { galleryUrls: input.galleryUrls }
            : {}),
          ...(input.usdcEnabled === true ? { usdcEnabled: true } : {}),
          priceJpyc: input.priceJpyc,
          contentKind,
          label: input.label ?? 'prompt',
          saleActive: true,
        },
        content: { kind: contentKind, value: input.content },
      };
    },
  );
  getSellerDisclosure.mockResolvedValue(null);
  parseSellerDisclosureInput.mockReturnValue({
    ok: true,
    value: { name: 'Alice', contact: 'alice@example.com' },
  });
  putSellerDisclosure.mockResolvedValue(true);
});

describe('creator store seller routes', () => {
  it('server flag OFF は全 seller route で auth/rate limit より先に 404', async () => {
    state.enabled = false;

    const responses = await Promise.all([
      listProducts(request('/api/store/products')),
      createProduct(request('/api/store/products', 'POST', validBody())),
      getProduct(request(`/api/store/products/${ID}`), {
        params: Promise.resolve({ id: ID }),
      }),
      patchProduct(
        request(`/api/store/products/${ID}`, 'PATCH', {
          saleActive: false,
        }),
        { params: Promise.resolve({ id: ID }) },
      ),
      getSeller(request('/api/store/seller')),
      putSeller(
        request('/api/store/seller', 'PUT', {
          name: 'Alice',
          contact: 'alice@example.com',
        }),
      ),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      404, 404, 404, 404, 404, 404,
    ]);
    expect(requireSession).not.toHaveBeenCalled();
    expect(checkIpRateLimit).not.toHaveBeenCalled();
    for (const response of responses) {
      expect(response.headers.get('Cache-Control')).toBe(
        'private, no-store',
      );
    }
  });

  it('SIWE session 無しは全 seller route で 401', async () => {
    requireSession.mockImplementation(async () => ({
      ok: false,
      response: NextResponse.json(
        { ok: false, error: 'unauthenticated' },
        { status: 401 },
      ),
    }));

    const responses = await Promise.all([
      listProducts(request('/api/store/products')),
      createProduct(request('/api/store/products', 'POST', validBody())),
      getProduct(request(`/api/store/products/${ID}`), {
        params: Promise.resolve({ id: ID }),
      }),
      patchProduct(
        request(`/api/store/products/${ID}`, 'PATCH', {
          saleActive: false,
        }),
        { params: Promise.resolve({ id: ID }) },
      ),
      getSeller(request('/api/store/seller')),
      putSeller(
        request('/api/store/seller', 'PUT', {
          name: 'Alice',
          contact: 'alice@example.com',
        }),
      ),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      401, 401, 401, 401, 401, 401,
    ]);
    for (const response of responses) {
      expect(response.headers.get('Cache-Control')).toBe(
        'private, no-store',
      );
    }
    expect(listHostedForOwner).not.toHaveBeenCalled();
  });

  it('IP と SIWE address を別の O(1) limiter で制限する', async () => {
    checkIpRateLimit.mockResolvedValueOnce(false);
    const ipLimited = await listProducts(request('/api/store/products'));
    expect(ipLimited.status).toBe(429);
    expect(requireSession).not.toHaveBeenCalled();

    checkIpRateLimit.mockResolvedValue(true);
    checkReadRateLimit.mockResolvedValueOnce(false);
    const addressLimited = await listProducts(
      request('/api/store/products'),
    );
    expect(addressLimited.status).toBe(429);
    expect(checkReadRateLimit).toHaveBeenCalledWith(
      `creator-store:products-read:${OWNER.toLowerCase()}`,
      60,
      60,
    );
    expect(listHostedForOwner).not.toHaveBeenCalled();
  });

  it('13 個目は atomic cap 結果を 409 にする', async () => {
    createHostedProduct.mockResolvedValue({
      ok: false,
      reason: 'too_many',
    });

    const response = await createProduct(
      request('/api/store/products', 'POST', validBody()),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'too_many_products',
      max: 12,
    });
  });

  it('payTo=feeReceiver は保存前に 400 で拒否する', async () => {
    const response = await createProduct(
      request(
        '/api/store/products',
        'POST',
        validBody({ payTo: FEE_RECEIVER }),
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: 'invalid_product',
    });
    expect(parseHostedInput).toHaveBeenCalledWith(
      expect.objectContaining({ owner: OWNER, payTo: FEE_RECEIVER }),
    );
    expect(createHostedProduct).not.toHaveBeenCalled();
  });

  it('商品画像 URL と追加ギャラリーを新規作成の server 検証へ渡す', async () => {
    const imageUrl = 'https://cdn.example.com/product.png';
    const galleryUrls = [
      'https://cdn.example.com/gallery-1.png',
      'https://cdn.example.com/gallery-2.png',
    ];
    const response = await createProduct(
      request(
        '/api/store/products',
        'POST',
        validBody({ imageUrl, galleryUrls }),
      ),
    );

    expect(response.status).toBe(201);
    expect(parseHostedInput).toHaveBeenCalledWith(
      expect.objectContaining({ owner: OWNER, imageUrl, galleryUrls }),
    );
    expect(createHostedProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        product: expect.objectContaining({ imageUrl, galleryUrls }),
      }),
    );
  });

  it('販売者情報未登録では新規 saleActive=true を拒否する', async () => {
    sellerDisclosureComplete.mockResolvedValue(false);

    const response = await createProduct(
      request(
        '/api/store/products',
        'POST',
        validBody({ saleActive: true }),
      ),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'seller_disclosure_required',
    });
    expect(createHostedProduct).not.toHaveBeenCalled();
  });

  it('販売者情報 storage 障害は販売開始へ波及させず 503', async () => {
    sellerDisclosureComplete.mockResolvedValue('storage');

    const response = await createProduct(
      request(
        '/api/store/products',
        'POST',
        validBody({ saleActive: true }),
      ),
    );

    expect(response.status).toBe(503);
    expect(createHostedProduct).not.toHaveBeenCalled();
  });

  it('新規作成は明示 usdcEnabled=true だけを ON にし、公開時に Polygon payTo を検査する', async () => {
    const enabled = await createProduct(
      request(
        '/api/store/products',
        'POST',
        validBody({ usdcEnabled: true, saleActive: true }),
      ),
    );
    expect(enabled.status).toBe(201);
    expect(checkUsdcReachability).toHaveBeenCalledWith(OWNER);
    expect(createHostedProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        product: expect.objectContaining({
          usdcEnabled: true,
          saleActive: true,
        }),
      }),
    );

    vi.clearAllMocks();
    parseHostedInput.mockReturnValue({
      ok: true,
      product: baseProduct,
      content: { kind: 'text', value: 'secret body' },
    });
    sellerDisclosureComplete.mockResolvedValue(true);
    createHostedProduct.mockResolvedValue({ ok: true, product: baseProduct });
    const omitted = await createProduct(
      request('/api/store/products', 'POST', validBody({ saleActive: true })),
    );
    expect(omitted.status).toBe(201);
    expect(checkUsdcReachability).not.toHaveBeenCalled();
    expect(createHostedProduct.mock.calls[0]?.[0].product).not.toHaveProperty(
      'usdcEnabled',
    );
  });

  it.each([
    [{ ok: false, reason: 'contract_wallet' }, 409, 'usdc_pay_to_contract_wallet'],
    [{ ok: false, reason: 'rpc_unavailable' }, 503, 'payment_facility_unavailable'],
  ])(
    'USDC 公開時の payTo 到達性 %j は status=%s',
    async (reachability, status, error) => {
      checkUsdcReachability.mockResolvedValue(reachability);
      const response = await createProduct(
        request(
          '/api/store/products',
          'POST',
          validBody({ usdcEnabled: true, saleActive: true }),
        ),
      );
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({ ok: false, error });
      expect(createHostedProduct).not.toHaveBeenCalled();
    },
  );

  it('他人の商品は GET/PATCH とも本文・更新へ進む前に 403', async () => {
    getHostedProduct.mockResolvedValue({
      ...baseProduct,
      owner: OTHER,
    });

    const response = await getProduct(
      request(`/api/store/products/${ID}`),
      { params: Promise.resolve({ id: ID }) },
    );

    expect(response.status).toBe(403);
    expect(getHostedContent).not.toHaveBeenCalled();

    getHostedProductUpdateSnapshot.mockResolvedValue({
      product: { ...baseProduct, owner: OTHER },
      token: 'other-owner-snapshot',
    });
    const patched = await patchProduct(
      request(`/api/store/products/${ID}`, 'PATCH', {
        saleActive: false,
      }),
      { params: Promise.resolve({ id: ID }) },
    );
    expect(patched.status).toBe(403);
    expect(replaceHostedSellerProduct).not.toHaveBeenCalled();
  });

  it('停止中→販売中 toggle は disclosure を検査し、保存後 product を返す', async () => {
    const productWithImage = {
      ...baseProduct,
      imageUrl: 'https://cdn.example.com/product.png',
      galleryUrls: [
        'https://cdn.example.com/gallery-1.png',
        'https://cdn.example.com/gallery-2.png',
      ],
    };
    getHostedProductUpdateSnapshot.mockResolvedValueOnce({
      product: productWithImage,
      token: JSON.stringify(productWithImage),
    });

    const response = await patchProduct(
      request(`/api/store/products/${ID}`, 'PATCH', {
        saleActive: true,
      }),
      { params: Promise.resolve({ id: ID }) },
    );

    expect(response.status).toBe(200);
    expect(sellerDisclosureComplete).toHaveBeenCalledWith(OWNER);
    expect(replaceHostedSellerProduct).toHaveBeenCalledWith({
      snapshot: {
        product: productWithImage,
        token: JSON.stringify(productWithImage),
      },
      owner: OWNER,
      metadata: {
        title: 'Prompt',
        imageUrl: 'https://cdn.example.com/product.png',
        galleryUrls: [
          'https://cdn.example.com/gallery-1.png',
          'https://cdn.example.com/gallery-2.png',
        ],
        priceJpyc: '300',
        label: 'prompt',
        saleActive: true,
      },
    });
    expect(getHostedContent).not.toHaveBeenCalled();
  });

  it('停止中→販売中 PATCH は disclosure 未登録なら 409 で拒否する', async () => {
    sellerDisclosureComplete.mockResolvedValue(false);

    const response = await patchProduct(
      request(`/api/store/products/${ID}`, 'PATCH', {
        saleActive: true,
      }),
      { params: Promise.resolve({ id: ID }) },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'seller_disclosure_required',
    });
    expect(replaceHostedSellerProduct).not.toHaveBeenCalled();
  });

  it('通常 PATCH 省略と saleActiveOnly は usdcEnabled=true を保持する', async () => {
    const current = { ...baseProduct, usdcEnabled: true } as const;
    getHostedProductUpdateSnapshot.mockResolvedValue({
      product: current,
      token: JSON.stringify(current),
    });

    const normal = await patchProduct(
      request(`/api/store/products/${ID}`, 'PATCH', { title: 'Updated' }),
      { params: Promise.resolve({ id: ID }) },
    );
    expect(normal.status).toBe(200);
    expect(parseHostedInput).toHaveBeenCalledWith(
      expect.objectContaining({ usdcEnabled: true }),
    );
    expect(replaceHostedSellerProduct).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ usdcEnabled: true }),
      }),
    );

    const toggled = await patchProduct(
      request(`/api/store/products/${ID}`, 'PATCH', { saleActive: true }),
      { params: Promise.resolve({ id: ID }) },
    );
    expect(toggled.status).toBe(200);
    expect(checkUsdcReachability).toHaveBeenCalledWith(OWNER);
    expect(replaceHostedSellerProduct).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          usdcEnabled: true,
          saleActive: true,
        }),
      }),
    );
  });

  it('USDC の OFF→ON は停止中商品の明示再公開だけ許可する', async () => {
    const active = { ...baseProduct, saleActive: true };
    getHostedProductUpdateSnapshot.mockResolvedValue({
      product: active,
      token: JSON.stringify(active),
    });
    const normalEdit = await patchProduct(
      request(`/api/store/products/${ID}`, 'PATCH', { usdcEnabled: true }),
      { params: Promise.resolve({ id: ID }) },
    );
    expect(normalEdit.status).toBe(409);
    await expect(normalEdit.json()).resolves.toEqual({
      ok: false,
      error: 'usdc_enable_requires_republish',
    });
    expect(replaceHostedSellerProduct).not.toHaveBeenCalled();

    getHostedProductUpdateSnapshot.mockResolvedValue({
      product: baseProduct,
      token: JSON.stringify(baseProduct),
    });
    const republished = await patchProduct(
      request(`/api/store/products/${ID}`, 'PATCH', {
        ...validBody(),
        usdcEnabled: true,
        saleActive: true,
      }),
      { params: Promise.resolve({ id: ID }) },
    );
    expect(republished.status).toBe(200);
    expect(checkUsdcReachability).toHaveBeenCalledWith(OWNER);
    expect(replaceHostedSellerProduct).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ usdcEnabled: true }),
      }),
    );
  });

  it('提供終了の商品は残存本文があっても full edit を拒否する', async () => {
    getHostedProductUpdateSnapshot.mockResolvedValue({
      product: { ...baseProduct, contentAvailable: false },
      token: 'unavailable-snapshot',
    });

    const response = await patchProduct(
      request(
        `/api/store/products/${ID}`,
        'PATCH',
        validBody({ title: '編集してはいけない' }),
      ),
      { params: Promise.resolve({ id: ID }) },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'content_unavailable',
    });
    expect(getHostedContent).not.toHaveBeenCalled();
    expect(replaceHostedSellerProduct).not.toHaveBeenCalled();
  });

  it('本文変更は新 revision と公開メタを 1 atomic helper で保存する', async () => {
    const imageUrl = 'https://cdn.example.com/product-v2.png';
    const galleryUrls = [
      'https://cdn.example.com/gallery-v2-1.png',
      'https://cdn.example.com/gallery-v2-2.png',
    ];
    const response = await patchProduct(
      request(
        `/api/store/products/${ID}`,
        'PATCH',
        validBody({ content: 'version two', imageUrl, galleryUrls }),
      ),
      { params: Promise.resolve({ id: ID }) },
    );

    expect(response.status).toBe(200);
    expect(replaceHostedSellerProduct).toHaveBeenCalledWith({
      snapshot: {
        product: baseProduct,
        token: JSON.stringify(baseProduct),
      },
      owner: OWNER,
      metadata: {
        title: 'Prompt',
        emoji: '🧠',
        imageUrl,
        galleryUrls,
        priceJpyc: '300',
        label: 'prompt',
        saleActive: false,
      },
      content: { kind: 'text', value: 'version two' },
    });
  });

  it('full edit は追加ギャラリー未指定なら既存値を保存し、空配列なら削除する', async () => {
    const galleryUrls = ['https://cdn.example.com/gallery.png'];
    const productWithGallery = { ...baseProduct, galleryUrls };
    const snapshot = {
      product: productWithGallery,
      token: JSON.stringify(productWithGallery),
    };
    getHostedProductUpdateSnapshot.mockResolvedValue(snapshot);

    const preserved = await patchProduct(
      request(
        `/api/store/products/${ID}`,
        'PATCH',
        validBody({ content: 'version two' }),
      ),
      { params: Promise.resolve({ id: ID }) },
    );

    expect(preserved.status).toBe(200);
    expect(parseHostedInput).toHaveBeenLastCalledWith(
      expect.objectContaining({ galleryUrls }),
    );
    expect(replaceHostedSellerProduct).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ galleryUrls }),
      }),
    );

    const removed = await patchProduct(
      request(
        `/api/store/products/${ID}`,
        'PATCH',
        validBody({ content: 'version three', galleryUrls: [] }),
      ),
      { params: Promise.resolve({ id: ID }) },
    );

    expect(removed.status).toBe(200);
    expect(parseHostedInput).toHaveBeenLastCalledWith(
      expect.objectContaining({ galleryUrls: [] }),
    );
    const lastReplace = replaceHostedSellerProduct.mock.calls.at(-1)?.[0] as {
      metadata: Record<string, unknown>;
    };
    expect(lastReplace.metadata).not.toHaveProperty('galleryUrls');
  });

  it('並行更新 conflict は 409 にし、成功として扱わない', async () => {
    replaceHostedSellerProduct.mockResolvedValue({
      ok: false,
      reason: 'conflict',
    });

    const response = await patchProduct(
      request(`/api/store/products/${ID}`, 'PATCH', {
        saleActive: false,
      }),
      { params: Promise.resolve({ id: ID }) },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'edit_conflict',
    });
  });

  it('seller GET は未登録 null、PUT は保存後の再読込値を返す', async () => {
    const empty = await getSeller(request('/api/store/seller'));
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ ok: true, seller: null });

    getSellerDisclosure.mockResolvedValue({
      name: 'Alice',
      contact: 'alice@example.com',
      updatedAt: 100,
    });
    const saved = await putSeller(
      request('/api/store/seller', 'PUT', {
        name: 'Alice',
        contact: 'alice@example.com',
      }),
    );
    expect(saved.status).toBe(200);
    expect(putSellerDisclosure).toHaveBeenCalledWith(OWNER, {
      name: 'Alice',
      contact: 'alice@example.com',
    });
    expect(await saved.json()).toMatchObject({
      ok: true,
      seller: { name: 'Alice' },
    });
  });
});
