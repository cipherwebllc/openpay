import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rateLimitMocks = vi.hoisted(() => ({
  allowed: true,
  check: vi.fn(async () => rateLimitMocks.allowed),
}));

const verificationMocks = vi.hoisted(() => ({
  snapshot: {} as Record<string, { checkedAt: string; ok: boolean; sourceUrl: string }> | null,
  read: vi.fn(),
}));

vi.mock('@/lib/directory/verification', () => ({
  readDirectoryVerificationSnapshot: async () => {
    verificationMocks.read();
    return verificationMocks.snapshot;
  },
}));

vi.mock('@/lib/net/ipHash', () => ({
  clientIp: vi.fn(() => '203.0.113.10'),
  hashIp: vi.fn(() => null),
}));

vi.mock('@/lib/relay/relayGuards', () => ({
  checkIpRateLimit: rateLimitMocks.check,
}));

type Route = { GET: (req: Request) => Promise<Response> };
type StaticRoute = { GET: () => Promise<Response> };

async function load(flag = '1'): Promise<{
  directory: Route;
  categories: Route;
  tags: Route;
  openapi: StaticRoute;
}> {
  vi.stubEnv('NEXT_PUBLIC_ENABLE_WEB3_DIRECTORY', flag);
  vi.resetModules();
  return {
    directory: (await import('@/app/api/directory/route')) as Route,
    categories: (await import('@/app/api/directory/categories/route')) as Route,
    tags: (await import('@/app/api/directory/tags/route')) as Route,
    openapi: (await import('@/app/api/openapi.json/route')) as StaticRoute,
  };
}

function req(path: string): Request {
  return new Request(`https://open-pay.jp${path}`);
}

beforeEach(() => {
  rateLimitMocks.allowed = true;
  rateLimitMocks.check.mockClear();
  verificationMocks.snapshot = {};
  verificationMocks.read.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('free Japan Web3 Directory APIs', () => {
  it('flag OFF は全 route 404 で rate limit より先に弾く', async () => {
    const routes = await load('');
    expect((await routes.directory.GET(req('/api/directory'))).status).toBe(404);
    expect(
      (await routes.categories.GET(req('/api/directory/categories'))).status,
    ).toBe(404);
    expect((await routes.tags.GET(req('/api/directory/tags'))).status).toBe(404);
    expect((await routes.openapi.GET()).status).toBe(404);
    expect(rateLimitMocks.check).not.toHaveBeenCalled();
  });

  it('一覧は封筒付き・full fields・最大5件・draftなし・edge cache', async () => {
    const { directory } = await load();
    const res = await directory.GET(req('/api/directory?limit=50'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('s-maxage=60');
    const body = (await res.json()) as {
      schemaVersion: string;
      query: { limit: number; offset: number };
      items: Array<{
        slug: string;
        sourceUrl: string;
        attribution: string;
        facts: { description: string };
        editorial: { summaryJa: string; summaryEn: string };
        sourceCheckedAt: string | null;
        sourceOk: boolean | null;
      }>;
      total: number;
      generatedAt: string;
      dataFreshness: {
        oldest: string;
        newestVerifiedAt: string;
        oldestSourceCheckedAt: string | null;
      };
      licenseNotice: string;
      attribution: string[];
    };
    expect(body.schemaVersion).toBe('1.0');
    expect(body.query).toMatchObject({ limit: 5, offset: 0 });
    expect((body as { teaser?: boolean }).teaser).toBe(true);
    expect(body.items).toHaveLength(5);
    expect(body.total).toBeGreaterThan(body.items.length);
    expect(Date.parse(body.generatedAt)).not.toBeNaN();
    expect(body.dataFreshness).toEqual({
      oldest: '2026-07-13',
      newestVerifiedAt: '2026-09-04', // 週次更新 (2026-09-04 第 2 回) で再検証したエントリの日付
      oldestSourceCheckedAt: null,
    });
    expect(body.licenseNotice).toBeTruthy();
    expect(new Set(body.attribution).size).toBe(body.attribution.length);
    expect(body.items.every((item) => item.sourceOk === null && item.sourceCheckedAt === null)).toBe(true);
    expect(
      body.items.every(
        (item) =>
          item.slug !== 'directory-draft-fixture' &&
          item.sourceUrl.startsWith('https://') &&
          item.attribution.length > 0 &&
          item.facts.description.length > 0 &&
          item.editorial.summaryJa.length > 0 &&
          item.editorial.summaryEn.length > 0,
      ),
    ).toBe(true);
    expect(rateLimitMocks.check).toHaveBeenCalledWith(
      'directory',
      null,
      30,
      60,
    );
  });

  it('current sourceUrl の snapshot だけを sourceOk に反映し、KV 障害は503', async () => {
    verificationMocks.snapshot = {
      metamask: {
        checkedAt: '2026-07-14T00:00:00.000Z',
        ok: false,
        sourceUrl: 'https://stale.example/metamask',
      },
    };
    const { directory } = await load();
    const staleBody = await (
      await directory.GET(req('/api/directory?keyword=MetaMask'))
    ).json();
    expect(staleBody.items[0]).toMatchObject({
      sourceCheckedAt: null,
      sourceOk: null,
    });

    verificationMocks.snapshot = null;
    const failed = await directory.GET(req('/api/directory'));
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ ok: false, error: 'storage_unavailable' });
  });

  it('keyword / category / JPYC filter / offset を共通 validator で処理する', async () => {
    const { directory } = await load();

    const keywordBody = await (
      await directory.GET(req('/api/directory?keyword=MetaMask'))
    ).json();
    expect(keywordBody.items.map((item: { slug: string }) => item.slug)).toEqual([
      'metamask',
    ]);

    const categoryBody = await (
      await directory.GET(req('/api/directory?category=wallet'))
    ).json();
    expect(
      categoryBody.items.every(
        (item: { facts: { category: string } }) =>
          item.facts.category === 'wallet',
      ),
    ).toBe(true);

    // E5: offset は無料 teaser では常に 0 に固定する — 指定しても無視される
    // (limit だけ絞っても offset を進める複数リクエストで有料枠を素通りできてしまうため)。
    const jpycBody = await (
      await directory.GET(
        req('/api/directory?token=JPYC&supportsJpyc=true&limit=2&offset=1'),
      )
    ).json();
    expect(jpycBody.query).toMatchObject({
      token: 'jpyc',
      supportsJpyc: true,
      limit: 2,
      offset: 0,
    });
    expect(
      jpycBody.items.every(
        (item: { facts: { tokens: string[]; supportsJpyc: boolean } }) =>
          item.facts.tokens.includes('jpyc') && item.facts.supportsJpyc,
      ),
    ).toBe(true);
  });

  it('E5: offset を進めても常に先頭 5 件しか返らない (limit のみを絞る回避策を塞ぐ)', async () => {
    const { directory } = await load();
    const first = await (await directory.GET(req('/api/directory'))).json();
    for (const offset of [1, 5, 100, 1000]) {
      const body = await (
        await directory.GET(req(`/api/directory?offset=${offset}`))
      ).json();
      expect(body.query.offset).toBe(0);
      expect(body.items.map((i: { slug: string }) => i.slug)).toEqual(
        first.items.map((i: { slug: string }) => i.slug),
      );
    }
  });

  it('不正 query は内部情報なしの400を返す', async () => {
    const { directory } = await load();
    const res = await directory.GET(req('/api/directory?category=nope'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_query' });
  });

  it('rate limit 超過は429を返す', async () => {
    rateLimitMocks.allowed = false;
    const { directory } = await load();
    const res = await directory.GET(req('/api/directory'));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(await res.json()).toEqual({ ok: false, error: 'rate_limited' });
  });

  it('categories / tags は件数を返し、draftを集計しない', async () => {
    const { categories, tags } = await load();
    const categoryRes = await categories.GET(req('/api/directory/categories'));
    const categoryBody = (await categoryRes.json()) as {
      items: Array<{ category: string; count: number }>;
    };
    expect(categoryRes.headers.get('cache-control')).toContain('s-maxage=60');
    expect(categoryBody.items.find((item) => item.category === 'wallet')?.count).toBe(
      3,
    );

    const tagBody = (await (
      await tags.GET(req('/api/directory/tags'))
    ).json()) as { items: Array<{ tag: string; count: number }> };
    expect(tagBody.items.find((item) => item.tag === 'x402')?.count).toBeGreaterThan(
      0,
    );
  });

  it('OpenAPI 3.1 は無料/有料 route、価格、402、出典と鮮度を定義する', async () => {
    const { openapi } = await load();
    const res = await openapi.GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      openapi: string;
      paths: Record<
        string,
        { get: { responses: Record<string, unknown>; 'x-price-jpyc'?: number } }
      >;
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
    };
    expect(body.openapi).toBe('3.1.0');
    expect(Object.keys(body.paths)).toEqual(
      expect.arrayContaining([
        '/api/directory',
        '/api/directory/categories',
        '/api/directory/tags',
        '/api/paid/japan-web3-directory',
        '/api/paid/japan-web3-directory/search',
        '/api/paid/japan-web3-directory/{slug}',
      ]),
    );
    expect(
      body.paths['/api/paid/japan-web3-directory'].get['x-price-jpyc'],
    ).toBe(2);
    expect(
      body.paths['/api/paid/japan-web3-directory/{slug}'].get[
        'x-price-jpyc'
      ],
    ).toBe(1);
    expect(
      body.paths['/api/paid/japan-web3-directory'].get.responses,
    ).toHaveProperty('402');
    expect(body.components.schemas.DirectoryEntry.properties).toHaveProperty(
      'attribution',
    );
    expect(body.components.schemas.DirectoryEnvelope.properties).toHaveProperty(
      'dataFreshness',
    );
  });
});
