import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const PAYER = '0x1111111111111111111111111111111111111111';
const RESOURCE_ID = `h_${'a'.repeat(32)}`;
const INTENT_SALT = `0x${'b'.repeat(64)}`;
const OLD_INTENT_SALT = `0x${'c'.repeat(64)}`;

const state = vi.hoisted(() => ({
  enabled: true,
  calls: [] as string[],
}));
const requireSession = vi.hoisted(() => vi.fn());
const checkIpRateLimit = vi.hoisted(() => vi.fn());
const checkReadRateLimit = vi.hoisted(() => vi.fn());
const listStoreLibraryPage = vi.hoisted(() => vi.fn());
const readStoreOwnership = vi.hoisted(() => vi.fn());
const selectStorePurchaseGrant = vi.hoisted(() => vi.fn());
const getHostedProduct = vi.hoisted(() => vi.fn());
const getHostedContent = vi.hoisted(() => vi.fn());

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
vi.mock('@/lib/x402/storeEntitlement', () => ({
  listStoreLibraryPage,
  readStoreOwnership,
  selectStorePurchaseGrant,
}));
vi.mock('@/lib/x402/hostedStore', () => ({
  getHostedProduct,
  getHostedContent,
}));

import { GET as getLibrary } from '@/app/api/store/library/route';
import { GET as getContent } from '@/app/api/store/content/[resourceId]/route';

const grant = {
  intentSalt: INTENT_SALT,
  contentRevision: 3,
  metadata: {
    title: 'Purchased prompt',
    priceJpyc: '300',
    contentKind: 'text' as const,
    label: 'prompt' as const,
  },
  purchasedAt: 1_700_000_000_000,
  txHash: `0x${'ab'.repeat(32)}`,
};
const oldGrant = {
  ...grant,
  intentSalt: OLD_INTENT_SALT,
  contentRevision: 1,
  metadata: {
    ...grant.metadata,
    title: 'Older purchased prompt',
  },
  purchasedAt: grant.purchasedAt - 1_000,
};
const ownership = {
  resourceId: RESOURCE_ID,
  grants: [oldGrant, grant],
  latestGrant: grant,
};
const product = {
  id: RESOURCE_ID,
  contentRevision: 99,
  contentAvailable: true,
};

function request(path: string): Request {
  return new Request(`https://open-pay.jp${path}`);
}

function contentContext(resourceId = RESOURCE_ID) {
  return { params: Promise.resolve({ resourceId }) };
}

async function expectPrivate(response: Response): Promise<void> {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('Vary')).toBe('Cookie');
}

beforeEach(() => {
  vi.clearAllMocks();
  state.enabled = true;
  state.calls = [];
  requireSession.mockResolvedValue({ ok: true, address: PAYER });
  checkIpRateLimit.mockResolvedValue(true);
  checkReadRateLimit.mockResolvedValue(true);
  listStoreLibraryPage.mockResolvedValue({
    ok: true,
    page: { items: [], nextCursor: null },
  });
  readStoreOwnership.mockImplementation(async () => {
    state.calls.push('own');
    return { ok: true, ownership };
  });
  selectStorePurchaseGrant.mockImplementation(
    (
      current: typeof ownership,
      selector: { revision: number | null; intentSalt: string | null },
    ) => {
      if (selector.intentSalt !== null) {
        const exact = current.grants.find(
          (candidate) => candidate.intentSalt === selector.intentSalt,
        );
        return exact &&
          (selector.revision === null ||
            selector.revision === exact.contentRevision)
          ? exact
          : null;
      }
      if (selector.revision === null) return current.latestGrant;
      return (
        current.grants.find(
          (candidate) =>
            candidate.contentRevision === selector.revision,
        ) ?? null
      );
    },
  );
  getHostedProduct.mockImplementation(async () => {
    state.calls.push('product');
    return product;
  });
  getHostedContent.mockImplementation(async () => {
    state.calls.push('content');
    return { kind: 'text', value: 'secret body' };
  });
});

describe('creator store entitlement routes', () => {
  it('flag OFF は auth/KV より先に同じ private 404', async () => {
    state.enabled = false;

    const [library, content] = await Promise.all([
      getLibrary(request('/api/store/library')),
      getContent(
        request(`/api/store/content/${RESOURCE_ID}`),
        contentContext(),
      ),
    ]);

    expect(library.status).toBe(404);
    expect(content.status).toBe(404);
    expect(await library.json()).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(await content.json()).toEqual({
      ok: false,
      error: 'not_found',
    });
    await expectPrivate(library);
    await expectPrivate(content);
    expect(requireSession).not.toHaveBeenCalled();
    expect(listStoreLibraryPage).not.toHaveBeenCalled();
    expect(readStoreOwnership).not.toHaveBeenCalled();
  });

  it('SIWE session 必須で、失敗応答にも private headers を付ける', async () => {
    requireSession.mockResolvedValue({
      ok: false,
      response: NextResponse.json(
        { ok: false, error: 'unauthenticated' },
        { status: 401 },
      ),
    });

    const response = await getLibrary(request('/api/store/library'));

    expect(response.status).toBe(401);
    await expectPrivate(response);
    expect(listStoreLibraryPage).not.toHaveBeenCalled();
  });

  it('IP + session address の O(1) limiter を scope ごとに通す', async () => {
    await getLibrary(request('/api/store/library'));
    await getContent(
      request(`/api/store/content/${RESOURCE_ID}`),
      contentContext(),
    );

    expect(checkIpRateLimit).toHaveBeenNthCalledWith(
      1,
      'creator-store:library',
      'hashed-ip',
      60,
      60,
    );
    expect(checkReadRateLimit).toHaveBeenNthCalledWith(
      1,
      `creator-store:library:${PAYER.toLowerCase()}`,
      60,
      60,
    );
    expect(checkIpRateLimit).toHaveBeenNthCalledWith(
      2,
      'creator-store:content',
      'hashed-ip',
      60,
      60,
    );
    expect(checkReadRateLimit).toHaveBeenNthCalledWith(
      2,
      `creator-store:content:${PAYER.toLowerCase()}`,
      60,
      60,
    );
  });

  it('rate limit 超過は private 429 で entitlement KV を読まない', async () => {
    checkReadRateLimit.mockResolvedValueOnce(false);

    const response = await getLibrary(request('/api/store/library'));

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(await response.json()).toEqual({
      ok: false,
      error: 'rate_limited',
    });
    await expectPrivate(response);
    expect(listStoreLibraryPage).not.toHaveBeenCalled();
  });

  it('library は session payer と opaque cursor で page を返す', async () => {
    const item = {
      resourceId: RESOURCE_ID,
      title: 'Purchased prompt',
      priceJpyc: '300',
      contentKind: 'text',
      label: 'prompt',
      purchasedAt: 1_700_000_000_000,
      contentRevision: 3,
      revisions: [
        {
          contentRevision: 3,
          title: 'Purchased prompt',
          priceJpyc: '300',
          contentKind: 'text',
          label: 'prompt',
          purchasedAt: 1_700_000_000_000,
        },
      ],
    };
    listStoreLibraryPage.mockResolvedValue({
      ok: true,
      page: { items: [item], nextCursor: 'next-page' },
    });

    const response = await getLibrary(
      request('/api/store/library?cursor=current-page'),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      items: [item],
      nextCursor: 'next-page',
    });
    expect(listStoreLibraryPage).toHaveBeenCalledWith({
      payer: PAYER,
      cursor: 'current-page',
    });
    await expectPrivate(response);
  });

  it.each([
    {
      result: { ok: false, reason: 'invalid_cursor' },
      status: 400,
      error: 'invalid_cursor',
    },
    {
      result: { ok: false, reason: 'storage' },
      status: 503,
      error: 'storage_unavailable',
    },
    {
      result: { ok: false, reason: 'corrupt' },
      status: 503,
      error: 'storage_unavailable',
    },
  ])('library failure $result.reason を偽成功にしない', async ({
    result,
    status,
    error,
  }) => {
    listStoreLibraryPage.mockResolvedValue(result);

    const response = await getLibrary(request('/api/store/library'));

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ ok: false, error });
    await expectPrivate(response);
  });

  it('未所有・未保有 selector・商品不在は body/status が同じ 404', async () => {
    readStoreOwnership.mockImplementationOnce(async () => {
      state.calls.push('own');
      return { ok: true, ownership: null };
    });
    const unowned = await getContent(
      request(`/api/store/content/${RESOURCE_ID}`),
      contentContext(),
    );
    const unownedBody = await unowned.json();
    expect(state.calls).toEqual(['own']);

    state.calls = [];
    const missingRevision = await getContent(
      request(`/api/store/content/${RESOURCE_ID}?revision=99`),
      contentContext(),
    );
    expect(state.calls).toEqual(['own']);

    state.calls = [];
    const missingIntent = await getContent(
      request(
        `/api/store/content/${RESOURCE_ID}?intentSalt=0x${'d'.repeat(64)}`,
      ),
      contentContext(),
    );
    expect(state.calls).toEqual(['own']);

    state.calls = [];
    const mismatchedSelectors = await getContent(
      request(
        `/api/store/content/${RESOURCE_ID}?revision=3&intentSalt=${OLD_INTENT_SALT}`,
      ),
      contentContext(),
    );
    expect(state.calls).toEqual(['own']);

    state.calls = [];
    getHostedProduct.mockImplementationOnce(async () => {
      state.calls.push('product');
      return null;
    });
    const absent = await getContent(
      request(`/api/store/content/${RESOURCE_ID}`),
      contentContext(),
    );

    expect(state.calls).toEqual(['own', 'product']);
    for (const response of [
      missingRevision,
      missingIntent,
      mismatchedSelectors,
      absent,
    ]) {
      expect(response.status).toBe(unowned.status);
      expect(await response.json()).toEqual(unownedBody);
      await expectPrivate(response);
    }
    expect(unownedBody).toEqual({ ok: false, error: 'not_found' });
    await expectPrivate(unowned);
  });

  it('own read 後、ownership.latestGrant の revision だけを読む', async () => {
    const response = await getContent(
      request(`/api/store/content/${RESOURCE_ID}`),
      contentContext(),
    );

    expect(state.calls).toEqual(['own', 'product', 'content']);
    expect(getHostedContent).toHaveBeenCalledWith(RESOURCE_ID, 3);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      state: 'ready',
      resourceId: RESOURCE_ID,
      title: 'Purchased prompt',
      contentRevision: 3,
      intentSalt: INTENT_SALT,
      purchasedAt: 1_700_000_000_000,
      txHash: '0xabababababababababababababababababababababababababababababababab',
      kind: 'text',
      value: 'secret body',
    });
    await expectPrivate(response);
  });

  it.each([
    {
      query: 'revision=1',
      selector: { revision: 1, intentSalt: null },
    },
    {
      query: `intentSalt=${OLD_INTENT_SALT}`,
      selector: { revision: null, intentSalt: OLD_INTENT_SALT },
    },
    {
      query: `revision=1&intentSalt=${OLD_INTENT_SALT}`,
      selector: { revision: 1, intentSalt: OLD_INTENT_SALT },
    },
  ])(
    'own read 後に $query で ownership grant を選び exact intentSalt を返す',
    async ({ query, selector }) => {
      const response = await getContent(
        request(`/api/store/content/${RESOURCE_ID}?${query}`),
        contentContext(),
      );

      expect(state.calls).toEqual(['own', 'product', 'content']);
      expect(selectStorePurchaseGrant).toHaveBeenCalledWith(
        ownership,
        selector,
      );
      expect(getHostedContent).toHaveBeenCalledWith(RESOURCE_ID, 1);
      expect(await response.json()).toEqual({
        ok: true,
        state: 'ready',
        resourceId: RESOURCE_ID,
        title: 'Older purchased prompt',
        contentRevision: 1,
        intentSalt: OLD_INTENT_SALT,
        purchasedAt: 1_699_999_999_000,
        txHash: '0xabababababababababababababababababababababababababababababababab',
        kind: 'text',
        value: 'secret body',
      });
      await expectPrivate(response);
    },
  );

  it.each([
    'revision=0',
    'revision=01',
    'revision=9007199254740992',
    'revision=1&revision=2',
    'intentSalt=0x1234',
    `intentSalt=${INTENT_SALT}&intentSalt=${OLD_INTENT_SALT}`,
  ])('selector 形式不正 $query は private 400', async (query) => {
    const response = await getContent(
      request(`/api/store/content/${RESOURCE_ID}?${query}`),
      contentContext(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'invalid_selector',
    });
    await expectPrivate(response);
    expect(readStoreOwnership).not.toHaveBeenCalled();
    expect(getHostedProduct).not.toHaveBeenCalled();
  });

  it('contentAvailable=false は本文を読まず明示 provided-ended', async () => {
    getHostedProduct.mockImplementationOnce(async () => {
      state.calls.push('product');
      return { ...product, contentAvailable: false };
    });

    const response = await getContent(
      request(`/api/store/content/${RESOURCE_ID}`),
      contentContext(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      state: 'provided-ended',
      resourceId: RESOURCE_ID,
      title: 'Purchased prompt',
      contentRevision: 3,
      intentSalt: INTENT_SALT,
      purchasedAt: 1_700_000_000_000,
      txHash: '0xabababababababababababababababababababababababababababababababab',
    });
    expect(state.calls).toEqual(['own', 'product']);
    expect(getHostedContent).not.toHaveBeenCalled();
  });

  it('購入 revision 欠損も 404 にせず provided-ended', async () => {
    getHostedContent.mockImplementationOnce(async () => {
      state.calls.push('content');
      return null;
    });

    const response = await getContent(
      request(`/api/store/content/${RESOURCE_ID}`),
      contentContext(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      state: 'provided-ended',
      contentRevision: 3,
      intentSalt: INTENT_SALT,
    });
  });

  it.each(['ownership', 'product', 'content'])(
    '%s KV 障害は 404 に潰さず 503',
    async (failureAt) => {
      if (failureAt === 'ownership') {
        readStoreOwnership.mockResolvedValueOnce({
          ok: false,
          reason: 'storage',
        });
      } else if (failureAt === 'product') {
        getHostedProduct.mockResolvedValueOnce('storage');
      } else {
        getHostedContent.mockResolvedValueOnce('storage');
      }

      const response = await getContent(
        request(`/api/store/content/${RESOURCE_ID}`),
        contentContext(),
      );

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        ok: false,
        error: 'storage_unavailable',
      });
      await expectPrivate(response);
    },
  );
});
