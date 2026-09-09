// /store 一覧の組み立て (P3) の単体テスト。
// フェンス: index はヒント・商品レコードが権威・handle 無し owner は掲載しない。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ids: [] as string[] | null,
  products: [] as unknown[] | 'storage',
  handles: new Map<string, string[] | null>(),
  licenseEnabled: true,
  stocks: vi.fn(),
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, feeReceiver: `0x${'1'.repeat(40)}`, get enableLicenseNftUi() { return mocks.licenseEnabled; } } };
});
vi.mock('@/lib/kv', () => ({ kvMget: mocks.stocks }));

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
  mocks.licenseEnabled = true;
  mocks.stocks.mockReset();
  mocks.stocks.mockResolvedValue({ ok: true, value: [JSON.stringify({ supply: 10, sold: 3, reserved: 2, gen: 'private-to-card' })] });
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

  it('product.handle が owner の所有なら帰属はそれを最優先・非所有なら先頭へ fallback', async () => {
    const m = await mod();
    mocks.ids = ['h_1', 'h_2'];
    mocks.products = [
      product('h_1', OWNER_A, { handle: 'alice2' }),
      product('h_2', OWNER_A, { handle: 'gone' }),
    ];
    mocks.handles.set(OWNER_A.toLowerCase(), ['alice', 'alice2']);
    const out = await m.listStoreListings();
    expect(out?.map((l) => [l.id, l.handle])).toEqual([
      ['h_1', 'alice2'],
      ['h_2', 'alice'],
    ]);
  });

  it('Store index DTO は usdcEnabled=true だけを伝播し、OFF/旧商品へ既定値を足さない', async () => {
    const m = await mod();
    mocks.ids = ['h_1', 'h_2'];
    mocks.products = [
      product('h_1', OWNER_A, { usdcEnabled: true }),
      product('h_2', OWNER_A),
    ];
    mocks.handles.set(OWNER_A.toLowerCase(), ['alice']);
    const out = await m.listStoreListings();
    expect(out?.[0]).toMatchObject({ id: 'h_1', usdcEnabled: true });
    expect(out?.[1]).not.toHaveProperty('usdcEnabled');
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

it('license 公開メタは既読の定義から必要な項目だけを投影する', async () => {
  const m = await mod();
  mocks.ids = ['h_license', 'h_digital'];
  const publicLicense = { supply: 10, transferable: true, termsUrl: 'https://example.com/terms', termsVersion: '1', tokenChainId: 137 };
  mocks.products = [product('h_license', OWNER_A, { productKind: 'license', license: { ...publicLicense, contract: OWNER_B, tokenId: '123', definitionHash: 'private-to-card' } }), product('h_digital', OWNER_A)];
  mocks.handles.set(OWNER_A, ['alice']);
  const out = await m.listStoreListings();
  expect(out?.[0].license).toEqual({ ...publicLicense, remaining: 5 });
  expect(out?.[0].sellerRole).toBe('operator');
  expect(out?.[1]).not.toHaveProperty('license');
  expect(out?.[1]).not.toHaveProperty('productKind');
  expect(out?.[1]).not.toHaveProperty('sellerRole');
  expect(JSON.stringify(out)).not.toMatch(/definitionHash|tokenId|contract|private-to-card/);
});

it('販売者区分は表示名・受取先ではなく owner から返し、OFF は在庫を取得しない', async () => {
  mocks.licenseEnabled = false;
  mocks.ids = ['h_license'];
  mocks.products = [product('h_license', OWNER_B, { title: 'OpenPay', payTo: OWNER_A, productKind: 'license', license: { supply: 10 } })];
  mocks.handles.set(OWNER_B, ['seller']);
  const out = await (await mod()).listStoreListings();
  expect(out?.[0].sellerRole).toBe('third_party');
  expect(mocks.stocks).not.toHaveBeenCalled();
});

it.each([undefined, 'https://files.example/private-gate', 'https://127.1/gate'])('public listing omits URL and exposes only valid configuration boolean: %s', async (deliveryUrl) => {
  mocks.ids = ['h_1']; mocks.products = [product('h_1', OWNER_A, { deliveryUrl })];
  mocks.handles.set(OWNER_A, ['alice']);
  const out = await (await mod()).listStoreListings();
  expect(out?.[0].protectedDelivery).toBe(deliveryUrl === 'https://files.example/private-gate');
  expect(out?.[0]).not.toHaveProperty('deliveryUrl'); expect(JSON.stringify(out)).not.toContain('private-gate');
});
