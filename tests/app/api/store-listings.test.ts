// GET /api/store/listings — Store の公開一覧 API。flag・KV 障害・絞り込み・購入リンクの形と、
// ホワイトリスト外の項目 (納品物・保護配布・ライセンス内訳・出品者ウォレット等) が出ないことのフェンス。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { storeProductPath } from '@/lib/storeProductLink';
import type { StoreListing } from '@/lib/x402/storeListing';

const cache = vi.hoisted(() => ({
  list: vi.fn<() => Promise<StoreListing[] | null>>(),
}));
vi.mock('@/lib/x402/storeListingCache', () => ({
  listStoreListingsCached: cache.list,
}));

type Route = { GET: (req: Request) => Promise<Response> };
type Item = Record<string, unknown>;

const ID_A = `h_${'a'.repeat(32)}`;
const ID_B = `h_${'b'.repeat(32)}`;
const ID_C = `h_${'c'.repeat(32)}`;
const OWNER = '0x1111111111111111111111111111111111111111';

// StoreListing に一覧カード以外の項目 (現行型にあるもの + 将来足され得る秘密寄りのもの) を混ぜた fixture。
const LISTINGS = [
  {
    id: ID_A,
    title: 'AI プロンプト集',
    desc: 'ChatGPT 用の業務プロンプト',
    emoji: '🤖',
    imageUrl: 'https://example.com/a.png',
    priceJpyc: '100',
    usdcEnabled: true,
    label: 'prompt',
    category: 'ai',
    tags: ['chatgpt', 'business'],
    handle: 'alice',
    updatedAt: 3000,
    totalJpyc: '101',
    feeJpyc: '1',
    protectedDelivery: true,
    // 型の外 (ホワイトリストで落ちること)
    owner: OWNER,
    payTo: OWNER,
    deliveryUrl: 'https://drive.example.com/secret-file',
    contentUrl: 'https://cdn.example.com/content',
    contentKind: 'url',
  },
  {
    id: ID_B,
    title: 'VRM アバター',
    priceJpyc: '500',
    label: 'download',
    category: '3d-game',
    tags: ['vrm'],
    handle: 'bob',
    updatedAt: 2000,
    totalJpyc: '505',
    feeJpyc: '5',
  },
  {
    id: ID_C,
    title: '商用ライセンス',
    priceJpyc: '1000',
    label: 'download',
    category: 'software',
    handle: 'alice',
    updatedAt: 1000,
    totalJpyc: '1010',
    feeJpyc: '10',
    productKind: 'license',
    sellerRole: 'creator',
    license: { termsHash: '0xdeadbeef', supply: 10, minted: 3 },
  },
] as unknown as StoreListing[];

function req(query = ''): Request {
  return new Request(`https://open-pay.jp/api/store/listings${query}`);
}

async function load(
  flags: Partial<{ store: string; licenseUi: string }> = {},
): Promise<Route> {
  vi.stubEnv('ENABLE_CREATOR_STORE', flags.store ?? '1');
  vi.stubEnv('NEXT_PUBLIC_ENABLE_CREATOR_STORE', flags.store ?? '1');
  vi.stubEnv('NEXT_PUBLIC_ENABLE_LICENSE_NFT', flags.licenseUi ?? '');
  vi.resetModules();
  return (await import('@/app/api/store/listings/route')) as Route;
}

async function items(res: Response): Promise<Item[]> {
  const body = (await res.json()) as { ok: boolean; items: Item[] };
  expect(body.ok).toBe(true);
  return body.items;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  cache.list.mockReset();
  cache.list.mockResolvedValue(LISTINGS);
});

describe('GET /api/store/listings', () => {
  it('enableCreatorStore が OFF なら 404 (/store と同じ)・一覧は読まない', async () => {
    const { GET } = await load({ store: '' });
    const res = await GET(req());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'not_found' });
    expect(cache.list).not.toHaveBeenCalled();
  });

  it('KV 障害 (null) は 503 + no-store・空の一覧 ([]) は 200 で区別する', async () => {
    const { GET } = await load();
    cache.list.mockResolvedValueOnce(null);
    const down = await GET(req());
    expect(down.status).toBe(503);
    expect(down.headers.get('Cache-Control')).toBe('no-store');
    expect(await down.json()).toEqual({ ok: false, error: 'storage_unavailable' });

    cache.list.mockResolvedValueOnce([]);
    const empty = await GET(req());
    expect(empty.status).toBe(200);
    expect(await items(empty)).toEqual([]);
  });

  it('正常時は共有キャッシュ経由で読み、edge キャッシュ可・新着順のまま返す', async () => {
    const { GET } = await load();
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe(
      'public, s-maxage=60, stale-while-revalidate=120',
    );
    expect(cache.list).toHaveBeenCalledTimes(1);
    // ライセンス UI が OFF の間はライセンス商品を出さない (/store と同じ)
    expect((await items(res)).map((item) => item.id)).toEqual([ID_A, ID_B]);
  });

  it('ホワイトリストの項目だけを返す (納品物・保護配布・ライセンス内訳・ウォレット等は出ない)', async () => {
    const { GET } = await load({ licenseUi: '1' });
    const [full, minimal, license] = await items(await GET(req()));
    expect(full).toEqual({
      id: ID_A,
      title: 'AI プロンプト集',
      desc: 'ChatGPT 用の業務プロンプト',
      emoji: '🤖',
      imageUrl: 'https://example.com/a.png',
      priceJpyc: '100',
      feeJpyc: '1',
      totalJpyc: '101',
      usdcEnabled: true,
      category: 'ai',
      tags: ['chatgpt', 'business'],
      handle: 'alice',
      updatedAt: 3000,
      url: `https://open-pay.jp${storeProductPath('alice', ID_A, 'ja')}&from=agent`,
    });
    // 任意項目は無ければ省き、usdcEnabled と tags は常に持つ
    expect(minimal).toEqual({
      id: ID_B,
      title: 'VRM アバター',
      priceJpyc: '500',
      feeJpyc: '5',
      totalJpyc: '505',
      usdcEnabled: false,
      category: '3d-game',
      tags: ['vrm'],
      handle: 'bob',
      updatedAt: 2000,
      url: `https://open-pay.jp${storeProductPath('bob', ID_B, 'ja')}&from=agent`,
    });
    expect(license).toEqual({
      id: ID_C,
      title: '商用ライセンス',
      priceJpyc: '1000',
      feeJpyc: '10',
      totalJpyc: '1010',
      usdcEnabled: false,
      category: 'software',
      tags: [],
      handle: 'alice',
      productKind: 'license',
      updatedAt: 1000,
      url: `https://open-pay.jp${storeProductPath('alice', ID_C, 'ja')}&from=agent`,
    });
    const serialized = JSON.stringify([full, minimal, license]);
    for (const leaked of [
      OWNER,
      'secret-file',
      'cdn.example.com',
      'protectedDelivery',
      'deliveryUrl',
      'termsHash',
      'sellerRole',
      'label',
      'contentKind',
    ]) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it('url は storeProductPath の絶対 URL + from=agent (locale で言語を選ぶ・既定 ja)', async () => {
    const { GET } = await load();
    const [ja] = await items(await GET(req()));
    expect(ja.url).toBe(`https://open-pay.jp/ja/@alice?product=${ID_A}&from=agent`);
    const [en] = await items(await GET(req('?locale=en')));
    expect(en.url).toBe(
      `https://open-pay.jp${storeProductPath('alice', ID_A, 'en')}&from=agent`,
    );
  });

  it('handle は @ の有無と大文字小文字を問わず、その出品者の商品だけに完全一致で絞る', async () => {
    const { GET } = await load({ licenseUi: '1' });
    for (const handle of ['alice', '%40alice', '@Alice']) {
      expect((await items(await GET(req(`?handle=${handle}`)))).map((item) => item.id)).toEqual([
        ID_A,
        ID_C,
      ]);
    }
    // 部分一致にはしない
    expect(await items(await GET(req('?handle=ali')))).toEqual([]);
  });

  it('q は StoreBrowser と同じ対象 (タイトル/説明/タグ/@handle)・大文字小文字を区別しない', async () => {
    const { GET } = await load();
    const ids = async (q: string) =>
      (await items(await GET(req(`?q=${encodeURIComponent(q)}`)))).map((item) => item.id);
    expect(await ids('プロンプト集')).toEqual([ID_A]); // タイトル
    expect(await ids('業務')).toEqual([ID_A]); // 説明
    expect(await ids('BUSINESS')).toEqual([ID_A]); // タグ (大文字で引いても当たる)
    expect(await ids('@bob')).toEqual([ID_B]); // @handle
    expect(await ids('  ')).toEqual([ID_A, ID_B]); // 空白だけは絞らない
    expect(await ids('存在しない')).toEqual([]);
  });

  it('category で絞り込む・q や handle と組み合わせられる', async () => {
    const { GET } = await load({ licenseUi: '1' });
    expect((await items(await GET(req('?category=3d-game')))).map((item) => item.id)).toEqual([
      ID_B,
    ]);
    expect(
      (await items(await GET(req('?category=software&handle=alice')))).map((item) => item.id),
    ).toEqual([ID_C]);
    expect(await items(await GET(req('?category=ai&q=vrm')))).toEqual([]);
  });

  it('limit は既定 20・上限 100 に丸める (新着順の先頭から)', async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({
      ...LISTINGS[1],
      id: `h_${i.toString(16).padStart(32, '0')}`,
      updatedAt: 1000 - i,
    })) as StoreListing[];
    cache.list.mockResolvedValue(many);
    const { GET } = await load();
    const defaults = await items(await GET(req()));
    expect(defaults).toHaveLength(20);
    expect(defaults[0].id).toBe(many[0].id);
    expect(await items(await GET(req('?limit=2')))).toHaveLength(2);
    expect(await items(await GET(req('?limit=100')))).toHaveLength(100);
    expect(await items(await GET(req('?limit=1000')))).toHaveLength(100);
  });

  it.each([
    ['limit=0'],
    ['limit=-1'],
    ['limit=abc'],
    ['limit=1.5'],
    ['category=unknown'],
    ['locale=fr'],
    ['handle=a'],
    ['handle=bad-handle!'],
    [`q=${'x'.repeat(101)}`],
    ['offset=20'],
  ])('不正なクエリ (%s) は 400・一覧は読まない', async (query) => {
    const { GET } = await load();
    const res = await GET(req(`?${query}`));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_query' });
    expect(cache.list).not.toHaveBeenCalled();
  });
});
