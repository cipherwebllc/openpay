// /store 一覧の組み立て (P3) の単体テスト。
// フェンス: index はヒント・商品レコードが権威・handle 無し owner は掲載しない。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ids: [] as string[] | null,
  products: [] as unknown[] | 'storage',
  handles: new Map<string, string[] | null>(),
}));

vi.mock('@/lib/x402/storeIndex', () => ({
  listStoreIndexIds: async () => mocks.ids,
}));
vi.mock('@/lib/x402/hostedStore', () => ({
  getHostedProductsByIds: async () => mocks.products,
}));
vi.mock('@/lib/handleStore', () => ({
  listHandlesForOwner: async (owner: string) =>
    mocks.handles.get(owner.toLowerCase()) ?? null,
}));

const OWNER_A = '0x1111111111111111111111111111111111111111';
const OWNER_B = '0x2222222222222222222222222222222222222222';

function product(id: string, owner: string, over: Record<string, unknown> = {}) {
  return {
    id,
    owner,
    payTo: owner,
    title: `商品 ${id}`,
    priceJpyc: '100',
    contentKind: 'text',
    label: 'prompt',
    contentRevision: 1,
    saleActive: true,
    contentAvailable: true,
    createdAt: 1000,
    updatedAt: 2000,
    ...over,
  };
}

async function mod() {
  return import('@/lib/x402/storeListing');
}

beforeEach(() => {
  vi.resetModules();
  mocks.ids = [];
  mocks.products = [];
  mocks.handles = new Map();
});

describe('listStoreListings', () => {
  it('index 順を保ち、owner の先頭 handle を付けて返す (合計/手数料は単一ソース式)', async () => {
    const m = await mod();
    mocks.ids = ['h_1', 'h_2'];
    mocks.products = [product('h_1', OWNER_A), product('h_2', OWNER_B)];
    mocks.handles.set(OWNER_A.toLowerCase(), ['alice', 'alice2']);
    mocks.handles.set(OWNER_B.toLowerCase(), ['bob']);
    const out = await m.listStoreListings();
    expect(out?.map((l) => [l.id, l.handle])).toEqual([
      ['h_1', 'alice'],
      ['h_2', 'bob'],
    ]);
    // 100 JPYC → x402 手数料 max(1, 1%) = 1 JPYC → 合計 101
    expect(out?.[0].totalJpyc).toBe('101');
    expect(out?.[0].feeJpyc).toBe('1');
    // owner ウォレットは client へ渡さない
    expect(JSON.stringify(out)).not.toContain(OWNER_A);
  });

  it('handle を持たない owner の商品は掲載しない (契約: プロフィールで公開した商品のみ)', async () => {
    const m = await mod();
    mocks.ids = ['h_1', 'h_2'];
    mocks.products = [product('h_1', OWNER_A), product('h_2', OWNER_B)];
    mocks.handles.set(OWNER_A.toLowerCase(), ['alice']);
    mocks.handles.set(OWNER_B.toLowerCase(), []); // handle なし
    const out = await m.listStoreListings();
    expect(out?.map((l) => l.id)).toEqual(['h_1']);
  });

  it('handle 解決の KV 障害 (null) は該当 owner の商品だけ落とす (誤掲載より欠落)', async () => {
    const m = await mod();
    mocks.ids = ['h_1'];
    mocks.products = [product('h_1', OWNER_A)];
    mocks.handles.set(OWNER_A.toLowerCase(), null);
    expect(await m.listStoreListings()).toEqual([]);
  });

  it('index / 商品読み出しの KV 障害は null (空と区別して呼び出し側が 503 表示に倒す)', async () => {
    const m = await mod();
    mocks.ids = null;
    expect(await m.listStoreListings()).toBeNull();
    mocks.ids = ['h_1'];
    mocks.products = 'storage';
    expect(await m.listStoreListings()).toBeNull();
  });

  it('index 空は空配列 (エラーではない)', async () => {
    const m = await mod();
    mocks.ids = [];
    expect(await m.listStoreListings()).toEqual([]);
  });
});
