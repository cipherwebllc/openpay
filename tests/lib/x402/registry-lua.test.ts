// @vitest-environment node
// registry の CAS スクリプトを **本物の Lua** で実行する (wasmoon 経由・tests/_helpers/redisLua.ts)。
//
// tests/lib/x402/registry.test.ts の kv モックは failEval / failLrange / failGet の障害注入と
// 仮想時計を抱えた大きな in-memory 実装で、registry の全テスト (parse/列挙/カウント/storage 枝) が
// 依存している。そこへ Lua ランナーを差し込むと障害注入の枝まで巻き込むため、Lua を実際に走らせる
// ケースだけを本ファイルに分離した (旧ファイルはそのまま)。
//
// ここで検出できるようになるもの: CAS_CREATE / CAS_UPDATE / CAS_DEACTIVATE_WITH_LEDGER の
// 構文誤り・KEYS/ARGV の添字ズレ (公開関数経由で呼ぶので呼び出し側とのズレも出る)・
// redis.call の綴り。
// ⚠️ node 環境が必須 (wasmoon の WASM 初期化が jsdom では失敗する)。
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';

import {
  closeRedisLuaEngine,
  createFakeRedisStore,
  runRedisLua,
  type FakeRedisStore,
} from '../../_helpers/redisLua';

const holder = vi.hoisted(() => ({ store: null as FakeRedisStore | null }));

vi.mock('@/lib/kv', () => ({
  kvGet: async (key: string) => ({
    ok: true as const,
    value: holder.store!.strings.get(key) ?? null,
  }),
  kvSet: async (key: string, value: string) => {
    holder.store!.strings.set(key, value);
    return { ok: true as const, value: 'OK' as const };
  },
  kvLpush: async (key: string, value: string) => {
    const list = holder.store!.lists.get(key) ?? [];
    list.unshift(value);
    holder.store!.lists.set(key, list);
    return { ok: true as const, value: list.length };
  },
  kvLrange: async (key: string, start: number, stop: number) => {
    const list = holder.store!.lists.get(key) ?? [];
    const end = stop < 0 ? list.length : stop + 1;
    return { ok: true as const, value: list.slice(start, end) };
  },
  // 受け取った script 文字列をそのまま Lua VM で実行する。
  kvEval: async (script: string, keys: string[], args: string[]) => ({
    ok: true as const,
    value: await runRedisLua(script, keys, args, holder.store!),
  }),
}));

import {
  createResource,
  deactivateResource,
  merchantResourcesKey,
  resourceKey,
  updateResource,
  CAS_CREATE,
  CAS_DEACTIVATE_WITH_LEDGER,
  CAS_OWNER_GUARD,
  CAS_UPDATE,
  MAX_RESOURCES_PER_MERCHANT,
  RESOURCES_INDEX,
  type X402Resource,
  type X402ResourceInput,
} from '@/lib/x402/registry';
import {
  hiddenUrlLedgerKey,
  HIDDEN_URL_LEDGER_TTL_SEC,
} from '@/lib/x402/hiddenUrlLedger';

const OWNER = getAddress('0x1111111111111111111111111111111111111111');
const STRANGER = getAddress('0x9999999999999999999999999999999999999999');

let store: FakeRedisStore;

function input(over: Partial<X402ResourceInput> = {}): X402ResourceInput {
  return {
    merchant: OWNER,
    url: 'https://a.jp/x',
    description: 'd',
    priceJpyc: '100',
    category: 'api',
    payTo: OWNER,
    ...over,
  };
}

function seedResource(id: string, over: Partial<X402Resource> = {}) {
  store.strings.set(
    resourceKey(id),
    JSON.stringify({
      id,
      merchant: OWNER,
      url: `https://a.jp/${id}`,
      description: 'd',
      priceJpyc: '1',
      category: 'api',
      payTo: OWNER,
      network: 'eip155:80002',
      active: true,
      createdAt: 1,
      ...over,
    }),
  );
  const index = store.lists.get(RESOURCES_INDEX) ?? [];
  index.unshift(id);
  store.lists.set(RESOURCES_INDEX, index);
}

function stored(id: string): Record<string, unknown> {
  return JSON.parse(store.strings.get(resourceKey(id))!) as Record<string, unknown>;
}

beforeEach(() => {
  store = createFakeRedisStore(1_700_000_000_000);
  holder.store = store;
});

afterAll(async () => {
  await closeRedisLuaEngine();
});

describe('CAS スクリプトの合成', () => {
  it('CAS_UPDATE / CAS_DEACTIVATE_WITH_LEDGER は owner ガード断片を前置している', () => {
    expect(CAS_UPDATE.startsWith(CAS_OWNER_GUARD)).toBe(true);
    expect(CAS_DEACTIVATE_WITH_LEDGER.startsWith(CAS_OWNER_GUARD)).toBe(true);
  });
});

describe('CAS_CREATE (本物の Lua)', () => {
  it('作成すると resource を SET し、discovery / merchant 両 index に LPUSH する', async () => {
    const created = await createResource(input(), 'r1', 1_000);
    expect(created).toMatchObject({ ok: true });
    expect(stored('r1')).toMatchObject({ id: 'r1', active: true });
    expect(stored('r1')).not.toHaveProperty('hidden');
    expect(store.lists.get(RESOURCES_INDEX)).toEqual(['r1']);
    expect(store.lists.get(merchantResourcesKey(OWNER))).toEqual(['r1']);
  });

  it('merchant index が cap に達していたら作成しない (LLEN 判定)', async () => {
    store.lists.set(
      merchantResourcesKey(OWNER),
      Array.from({ length: MAX_RESOURCES_PER_MERCHANT }, (_, i) => `old${i}`),
    );
    expect(await createResource(input(), 'r1', 1_000)).toEqual({
      ok: false,
      reason: 'too_many',
    });
    expect(store.strings.has(resourceKey('r1'))).toBe(false);
    expect(store.lists.get(RESOURCES_INDEX)).toBeUndefined();
  });

  // N-5: 台帳 (KEYS[4]) に生きた印がある URL は hidden 済 JSON (ARGV[4]) で作成する。
  it('hidden URL 台帳に載っている URL は hidden を継承して作成する', async () => {
    const url = 'https://a.jp/x';
    store.strings.set(hiddenUrlLedgerKey(url), '1');
    store.setTtl(hiddenUrlLedgerKey(url), HIDDEN_URL_LEDGER_TTL_SEC);

    const created = await createResource(input({ url }), 'r1', 1_000);
    expect(created).toMatchObject({ ok: true, resource: { hidden: true } });
    expect(stored('r1')).toMatchObject({ hidden: true });
  });

  it('台帳が TTL 切れなら hidden を継承しない (EXISTS が 0)', async () => {
    const url = 'https://a.jp/x';
    store.strings.set(hiddenUrlLedgerKey(url), '1');
    store.setTtl(hiddenUrlLedgerKey(url), 10);
    store.advance(11_000);

    const created = await createResource(input({ url }), 'r1', 1_000);
    expect(created).toMatchObject({ ok: true });
    expect(stored('r1')).not.toHaveProperty('hidden');
  });
});

describe('CAS_UPDATE (本物の Lua)', () => {
  it('owner 一致で編集可能フィールドだけ書き換え、不変フィールドは Lua が保持する', async () => {
    seedResource('r1', { createdAt: 42 });
    const result = await updateResource(
      'r1',
      OWNER,
      input({
        url: 'https://a.jp/r1',
        description: 'new',
        priceJpyc: '200',
        category: 'data',
        payTo: STRANGER,
        docsUrl: 'https://docs.example.jp',
        license: 'CC0',
      }),
      9_999,
    );
    expect(result).toMatchObject({ ok: true });
    expect(stored('r1')).toMatchObject({
      id: 'r1',
      merchant: OWNER,
      network: 'eip155:80002',
      createdAt: 42,
      active: true,
      description: 'new',
      priceJpyc: '200',
      category: 'data',
      payTo: STRANGER,
      docsUrl: 'https://docs.example.jp',
      license: 'CC0',
      updatedAt: 9_999,
    });
  });

  it('owner 不一致は forbidden (string.lower 比較・大小文字は無視)', async () => {
    seedResource('r1', { merchant: OWNER.toLowerCase() });
    expect(await updateResource('r1', STRANGER, input(), 1)).toEqual({
      ok: false,
      reason: 'forbidden',
    });
    // 同一 owner の小文字表記は通る。
    expect(await updateResource('r1', OWNER, input({ url: 'https://a.jp/r1' }), 1)).toMatchObject({
      ok: true,
    });
  });

  it('未存在は not_found・削除済 (active:false) も not_found・壊れた JSON は storage', async () => {
    expect(await updateResource('missing', OWNER, input(), 1)).toEqual({
      ok: false,
      reason: 'not_found',
    });
    seedResource('r1', { active: false });
    expect(await updateResource('r1', OWNER, input(), 1)).toEqual({
      ok: false,
      reason: 'not_found',
    });
    store.strings.set(resourceKey('r2'), '{broken');
    expect(await updateResource('r2', OWNER, input(), 1)).toEqual({
      ok: false,
      reason: 'storage',
    });
  });

  // B6: URL 変更でリセットするのは verification (連続失敗カウンタ) だけ。hidden は残す。
  it('URL 変更で verification は消えるが hidden は引き継ぐ', async () => {
    seedResource('r1', {
      url: 'https://a.jp/old',
      hidden: true,
      verification: {
        lastCheckedAt: 'old',
        failures: 2,
        lastRunId: 'run1',
        probedUrl: 'https://a.jp/old',
      },
    } as Partial<X402Resource>);

    await updateResource('r1', OWNER, input({ url: 'https://a.jp/new' }), 5);
    expect(stored('r1')).not.toHaveProperty('verification');
    expect(stored('r1')).toMatchObject({ hidden: true, url: 'https://a.jp/new' });
  });

  it('URL 据え置きなら verification を残す', async () => {
    seedResource('r1', {
      url: 'https://a.jp/same',
      verification: {
        lastCheckedAt: 'old',
        failures: 2,
        lastRunId: 'run1',
        probedUrl: 'https://a.jp/same',
      },
    } as Partial<X402Resource>);

    await updateResource('r1', OWNER, input({ url: 'https://a.jp/same' }), 5);
    expect(stored('r1')).toMatchObject({ verification: { failures: 2 } });
  });

  it('docsUrl / license / usdc は空文字で消え、値ありで置き換わる', async () => {
    seedResource('r1', {
      docsUrl: 'https://old.example.jp',
      license: 'MIT',
      usdc: { payTo: STRANGER, priceUsd: '0.001' },
    } as Partial<X402Resource>);

    await updateResource('r1', OWNER, input({ url: 'https://a.jp/r1' }), 5);
    const cleared = stored('r1');
    expect(cleared).not.toHaveProperty('docsUrl');
    expect(cleared).not.toHaveProperty('license');
    expect(cleared).not.toHaveProperty('usdc');

    await updateResource(
      'r1',
      OWNER,
      input({
        url: 'https://a.jp/r1',
        usdc: { payTo: STRANGER, priceUsd: '0.005', serviceName: 'demo' },
      }),
      6,
    );
    // usdc は cjson.decode(ARGV[10]) で table として入る (文字列のままにならない)。
    expect(stored('r1')).toMatchObject({
      usdc: { payTo: STRANGER, priceUsd: '0.005', serviceName: 'demo' },
    });
  });
});

describe('CAS_DEACTIVATE_WITH_LEDGER (本物の Lua)', () => {
  it('soft-delete して discovery index から LREM する (merchant index は残す)', async () => {
    seedResource('r1');
    store.lists.set(merchantResourcesKey(OWNER), ['r1']);

    expect(await deactivateResource('r1', OWNER)).toEqual({ ok: true });
    expect(stored('r1')).toMatchObject({ active: false });
    expect(store.lists.get(RESOURCES_INDEX)).toBeUndefined();
    expect(store.lists.get(merchantResourcesKey(OWNER))).toEqual(['r1']);
  });

  it('既に無効なら冪等に ok (2) で、index からの LREM だけ実行する', async () => {
    seedResource('r1', { active: false });
    expect(await deactivateResource('r1', OWNER)).toEqual({ ok: true });
    expect(store.lists.get(RESOURCES_INDEX)).toBeUndefined();
  });

  it('owner 不一致は forbidden・未存在は not_found', async () => {
    seedResource('r1');
    expect(await deactivateResource('r1', STRANGER)).toEqual({
      ok: false,
      reason: 'forbidden',
    });
    expect(stored('r1')).toMatchObject({ active: true });
    expect(await deactivateResource('missing', OWNER)).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  // N-5: hidden 済の削除だけ URL 台帳に TTL つきで印を残す (再登録で洗い流させない)。
  it('hidden 済の削除は URL 台帳に TTL つきで印を残す', async () => {
    seedResource('r1', { url: 'https://a.jp/hidden', hidden: true } as Partial<X402Resource>);
    const ledgerKey = hiddenUrlLedgerKey('https://a.jp/hidden');

    expect(await deactivateResource('r1', OWNER)).toEqual({ ok: true });
    expect(store.strings.get(ledgerKey)).toBe('1');
    expect(store.getTtl(ledgerKey)).toBe(HIDDEN_URL_LEDGER_TTL_SEC);
  });

  it('hidden でない削除は台帳に印を残さない', async () => {
    seedResource('r1', { url: 'https://a.jp/plain' });
    expect(await deactivateResource('r1', OWNER)).toEqual({ ok: true });
    expect(store.keys().filter((k) => k.startsWith('x402:hidden-url:'))).toEqual([]);
  });
});

describe('script を直接実行したときの戻り値 (Lua → RESP)', () => {
  it('CAS_CREATE は 1 / 3 / -2 を integer で返す', async () => {
    const keys = [
      resourceKey('r9'),
      RESOURCES_INDEX,
      merchantResourcesKey(OWNER),
      hiddenUrlLedgerKey('https://a.jp/x'),
    ];
    const argv = ['{"id":"r9"}', 'r9', '2', '{"id":"r9","hidden":true}'];
    expect(await runRedisLua(CAS_CREATE, keys, argv, store)).toBe(1);
    store.strings.set(keys[3], '1');
    expect(await runRedisLua(CAS_CREATE, keys, argv, store)).toBe(3);
    // merchant index が cap (2) に達した 3 回目は -2。
    expect(await runRedisLua(CAS_CREATE, keys, argv, store)).toBe(-2);
  });
});
