// @vitest-environment node
// ライセンス保有者の一覧 (listHeldLicenses) が恒久登録 index を走査する Lua (PAGE: TYPE 検査・ZREVRANK の stable member cursor・
// 8 件の ZREVRANGE) を本物の Lua で実行する (Lua 登録表の計画 PR-C)。これまで holders の Lua を実行するテストは無く、
// 「cursor は位置でなく member で続きを取る (間に新商品が入っても重複・抜けが出ない)」「知らない cursor・型の違う index を
// 区別して返す」は CI で一度も実行されていなかった。lib/kv.ts の実装ごと fake Upstash に繋ぎ、商品の読込と権利照合 (RPC) だけを mock する。
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';
import { closeRedisLuaEngine, createFakeRedisStore, fakeUpstashFetch, type FakeRedisStore } from '@/tests/_helpers/redisLua';
import { createLicenseDefinition } from '@/lib/license/definition';

const h = vi.hoisted(() => ({ products: new Map<string, unknown>(), rightsCalls: [] as string[] }));
vi.mock('@/lib/license/config', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/license/config')>(),
  licenseNftEnabled: () => true,
}));
vi.mock('@/lib/x402/hostedStore', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/x402/hostedStore')>(),
  getHostedProduct: async (id: string) => h.products.get(id) ?? null,
}));
vi.mock('@/lib/license/rights', () => ({
  resolveLicenseRights: async ({ productId }: { productId: string }) => {
    h.rightsCalls.push(productId);
    return { entitled: true, basis: 'holder', nft: { status: 'held' } };
  },
}));

import { listHeldLicenses } from '@/lib/license/holders';
import { LICENSE_REGISTRATION_INDEX } from '@/lib/license/product';

const HOLDER = getAddress('0x52d4901142e2b5680027da5eb47c86cb02a3ca81');
const CONTRACT = '0x3333333333333333333333333333333333333333';
const id = (n: number) => `h_${n.toString(16).padStart(32, '0')}`;
let store: FakeRedisStore;

function register(n: number) {
  const productId = id(n);
  h.products.set(productId, {
    id: productId, productKind: 'license', title: `License ${n}`, contentAvailable: true,
    license: createLicenseDefinition(productId, { supply: 10, transferable: true, termsUrl: 'https://seller.example/terms', termsVersion: '1' }, 80002, CONTRACT),
    registration: { status: 'registered', attempts: 1 },
  });
  const index = store.zsets.get(LICENSE_REGISTRATION_INDEX) ?? new Map<string, number>();
  index.set(productId, n);
  store.zsets.set(LICENSE_REGISTRATION_INDEX, index);
}
const ids = (page: Awaited<ReturnType<typeof listHeldLicenses>>) => (page.ok ? page.page.items.map((item) => item.resourceId) : page);

beforeEach(() => {
  h.products.clear();
  h.rightsCalls = [];
  store = createFakeRedisStore(1_790_000_000_000);
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'test-only');
  vi.stubGlobal('fetch', vi.fn(fakeUpstashFetch(store)));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(closeRedisLuaEngine);

describe('holders PAGE (real Lua)', () => {
  it('新しい登録順に 8 件ずつ返し、cursor (最後の member) の次から続ける。最後のページは nextCursor null', async () => {
    for (let n = 1; n <= 10; n += 1) register(n);
    const first = await listHeldLicenses(HOLDER, null);
    expect(ids(first)).toEqual([10, 9, 8, 7, 6, 5, 4, 3].map(id));
    expect(first.ok && first.page.nextCursor).toBe(id(3));
    const second = await listHeldLicenses(HOLDER, id(3));
    expect(ids(second)).toEqual([id(2), id(1)]);
    expect(second.ok && second.page.nextCursor).toBeNull();
  });

  it('cursor は位置でなく member で続きを取る: ページの間に新しい登録が入っても重複も抜けも出ない', async () => {
    for (let n = 1; n <= 10; n += 1) register(n);
    const first = await listHeldLicenses(HOLDER, null);
    register(11);
    register(12);
    const second = await listHeldLicenses(HOLDER, first.ok ? first.page.nextCursor : null);
    expect(ids(second)).toEqual([id(2), id(1)]);
  });

  it('index に無い cursor は invalid_cursor (先頭から返し直さない)', async () => {
    register(1);
    expect(await listHeldLicenses(HOLDER, id(99))).toEqual({ ok: false, reason: 'invalid_cursor' });
    expect(h.rightsCalls).toEqual([]);
  });

  it('index が sorted set でなければ storage_unavailable (空の一覧と取り違えない)・index が無ければ空のページ', async () => {
    expect(await listHeldLicenses(HOLDER, null)).toEqual({ ok: true, page: { items: [], nextCursor: null } });
    store.strings.set(LICENSE_REGISTRATION_INDEX, 'wrong-type');
    expect(await listHeldLicenses(HOLDER, null)).toEqual({ ok: false, reason: 'storage_unavailable' });
    expect(h.rightsCalls).toEqual([]);
  });

  it('ちょうど 8 件なら nextCursor を返し、次のページは空で終わる', async () => {
    for (let n = 1; n <= 8; n += 1) register(n);
    const first = await listHeldLicenses(HOLDER, null);
    expect(first.ok && first.page.nextCursor).toBe(id(1));
    expect(await listHeldLicenses(HOLDER, id(1))).toEqual({ ok: true, page: { items: [], nextCursor: null } });
  });
});
