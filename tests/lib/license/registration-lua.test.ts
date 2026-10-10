// @vitest-environment node
// ライセンスの on-chain 登録確認を保存する Lua (CONFIRM: 型の検査・読込時の生文字列との完全一致・SET) を本物の Lua で実行する
// (Lua 登録表の計画 PR-C)。registration.test.ts は kvEval を mock しているため、「確認の途中で出品者が商品を更新していたら
// registered を書かない (売り出しの署名を開かない)」ことは CI で一度も実行されていなかった。lib/kv.ts の実装ごと fake Upstash に
// 繋ぎ、RPC と商品 snapshot の読込だけを fake にする (snapshot の token は fake store の生文字列そのもの)。
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Hex } from 'viem';
import { closeRedisLuaEngine, createFakeRedisStore, fakeUpstashFetch, type FakeRedisStore } from '@/tests/_helpers/redisLua';
import { createLicenseDefinition } from '@/lib/license/definition';

const h = vi.hoisted(() => ({
  store: null as FakeRedisStore | null,
  // getHostedProductUpdateSnapshot の直後 (= RPC の確認中) に 1 回だけ実行する (出品者の同時更新を差し込む)。
  afterSnapshot: null as (() => void) | null,
}));
vi.mock('@/lib/license/config', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/license/config')>(),
  licenseNftEnabled: () => true,
}));
vi.mock('@/lib/chains', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/chains')>(),
  chainObjectForId: () => ({}),
  transportForChain: () => ({}),
}));
vi.mock('@/lib/x402/hostedStore', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/x402/hostedStore')>(),
  // 本物と同じく、KV の生文字列を token として返す (商品の検証は本物の parse に任せず JSON.parse だけにする)。
  getHostedProductUpdateSnapshot: async (productId: string) => {
    const token = h.store!.strings.get(`x402:hosted:${productId}`);
    if (token === undefined) return null;
    const snapshot = { product: JSON.parse(token) as unknown, token };
    const hook = h.afterSnapshot;
    h.afterSnapshot = null;
    hook?.();
    return snapshot;
  },
}));

import { confirmLicenseRegistration } from '@/lib/license/registration';

const ID = `h_${'a'.repeat(32)}`;
const KEY = `x402:hosted:${ID}`;
const CONTRACT = '0x3333333333333333333333333333333333333333';
const HASH = `0x${'a'.repeat(64)}` as Hex;
const definition = createLicenseDefinition(ID, { supply: 10, transferable: false, termsUrl: 'https://seller.example', termsVersion: '1' }, 80002, CONTRACT);
const ABI = parseAbi(['event LicenseRegistered(uint256 indexed id,uint64 maxSupply,bool transferable,bytes32 definitionHash)']);
const PENDING = JSON.stringify({ id: ID, productKind: 'license', title: 'License', license: definition, saleActive: false, registration: { status: 'pending', attempts: 2 }, updatedAt: 1 });

// 登録 tx が finalized で、定義が on-chain と一致する RPC (registration.test.ts と同じ形)。
const rpc = {
  getBlock: async () => ({ number: 10n, hash: HASH, timestamp: 100n }),
  readContract: async () => ({ exists: true, maxSupply: 10n, transferable: false, definitionHash: definition.definitionHash }),
  getTransactionReceipt: async () => ({
    status: 'success', transactionHash: HASH, blockNumber: 10n, blockHash: HASH,
    logs: [{
      address: CONTRACT,
      topics: encodeEventTopics({ abi: ABI, eventName: 'LicenseRegistered', args: { id: BigInt(definition.tokenId) } }),
      data: encodeAbiParameters([{ type: 'uint64' }, { type: 'bool' }, { type: 'bytes32' }], [10n, false, definition.definitionHash]),
    }],
  }),
} as unknown as Parameters<typeof confirmLicenseRegistration>[2];

let store: FakeRedisStore;

beforeEach(() => {
  store = createFakeRedisStore(1_790_000_000_000);
  h.store = store;
  h.afterSnapshot = null;
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'test-only');
  vi.stubGlobal('fetch', vi.fn(fakeUpstashFetch(store)));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(closeRedisLuaEngine);

describe('license registration CONFIRM (real Lua)', () => {
  it('読込時の生文字列のままなら registered (tx と attempts を保持) を保存し、販売は止めたまま', async () => {
    store.strings.set(KEY, PENDING);
    expect(await confirmLicenseRegistration(ID, HASH, rpc)).toBe('registered');
    const saved = JSON.parse(store.strings.get(KEY)!) as Record<string, unknown>;
    expect(saved.registration).toEqual({ status: 'registered', txHash: HASH, attempts: 2 });
    expect(saved.saleActive).toBe(false);
    expect(saved.license).toEqual(definition);
  });

  it('競合: 確認の途中で出品者が商品を更新していたら 0 → conflict で、相手の更新を上書きしない', async () => {
    store.strings.set(KEY, PENDING);
    const edited = PENDING.replace('"title":"License"', '"title":"Edited"');
    h.afterSnapshot = () => store.strings.set(KEY, edited);
    expect(await confirmLicenseRegistration(ID, HASH, rpc)).toBe('conflict');
    expect(store.strings.get(KEY)).toBe(edited);
  });

  // ⚠️ この fake の GET は型違いのキーで WRONGTYPE を出さず nil を返すので、ここでは Lua の TYPE 検査だけを外しても
  // (直後の GET の一致検査が 0 を返すため) 落ちない。本物の Redis では TYPE 検査が無いと EVAL が WRONGTYPE で失敗する。
  it('競合: 確認の途中で商品のキーが文字列でなくなったら conflict で、キーを書き換えない', async () => {
    store.strings.set(KEY, PENDING);
    h.afterSnapshot = () => {
      store.delete(KEY);
      store.lists.set(KEY, [PENDING]);
    };
    expect(await confirmLicenseRegistration(ID, HASH, rpc)).toBe('conflict');
    expect(store.lists.get(KEY)).toEqual([PENDING]);
    expect(store.strings.has(KEY)).toBe(false);
  });

  it('競合: 確認の途中で商品が消えたら conflict で、キーを作り直さない', async () => {
    store.strings.set(KEY, PENDING);
    h.afterSnapshot = () => store.delete(KEY);
    expect(await confirmLicenseRegistration(ID, HASH, rpc)).toBe('conflict');
    expect(store.keys()).toEqual([]);
  });
});
