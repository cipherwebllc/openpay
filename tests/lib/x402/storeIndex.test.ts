// Store 掲載インデックス (P2) の単体テスト。
// 設計フェンス: index はヒント・真実は商品レコード側 (読出側の再検証が前提)。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const kvMocks = vi.hoisted(() => ({
  evalCalls: [] as Array<{ script: string; keys: string[]; args: string[] }>,
  evalImpl: (async () => ({ ok: true as const, value: 1 })) as (
    script: string,
    keys: string[],
    args: string[],
  ) => Promise<{ ok: boolean; value?: unknown }>,
}));

vi.mock('@/lib/kv', () => ({
  kvEval: async (script: string, keys: string[], args: string[]) => {
    kvMocks.evalCalls.push({ script, keys, args });
    return kvMocks.evalImpl(script, keys, args);
  },
}));

const ID = `h_${'a'.repeat(32)}`;

async function mod() {
  return import('@/lib/x402/storeIndex');
}

beforeEach(() => {
  vi.resetModules();
  kvMocks.evalCalls.length = 0;
  kvMocks.evalImpl = async () => ({ ok: true, value: 1 });
});

describe('storeIndex', () => {
  it('touchStoreIndex: ZADD (score=updatedAt) を index key に対して発行する', async () => {
    const m = await mod();
    await m.touchStoreIndex(ID, 1234);
    expect(kvMocks.evalCalls).toHaveLength(1);
    const call = kvMocks.evalCalls[0];
    expect(call.script).toContain('ZADD');
    expect(call.keys).toEqual([m.STORE_INDEX_KEY]);
    expect(call.args).toEqual([ID, '1234']);
  });

  it('touchStoreIndex: 不正 id は KV に触れない・KV 例外/失敗でも throw しない (no-throw 契約)', async () => {
    const m = await mod();
    await m.touchStoreIndex('not-an-id', 1);
    expect(kvMocks.evalCalls).toHaveLength(0);
    kvMocks.evalImpl = async () => {
      throw new Error('kv down');
    };
    await expect(m.touchStoreIndex(ID, 1)).resolves.toBeUndefined();
    kvMocks.evalImpl = async () => ({ ok: false });
    await expect(m.touchStoreIndex(ID, 2)).resolves.toBeUndefined();
  });

  it('listStoreIndexIds: ZREVRANGE + ブロックリスト SISMEMBER を Lua 内で適用し、不正 id を落とす', async () => {
    const m = await mod();
    kvMocks.evalImpl = async () => ({
      ok: true,
      value: [ID, 'garbage', `h_${'b'.repeat(32)}`],
    });
    const ids = await m.listStoreIndexIds(10);
    expect(ids).toEqual([ID, `h_${'b'.repeat(32)}`]);
    const call = kvMocks.evalCalls[0];
    expect(call.script).toContain('ZREVRANGE');
    expect(call.script).toContain('SISMEMBER');
    expect(call.keys).toEqual([m.STORE_INDEX_KEY, m.STORE_BLOCKLIST_KEY]);
    expect(call.args).toEqual(['10']);
  });

  it('listStoreIndexIds: KV 障害は null (空配列と区別し呼び出し側が 503 に倒せる)', async () => {
    const m = await mod();
    kvMocks.evalImpl = async () => ({ ok: false });
    expect(await m.listStoreIndexIds()).toBeNull();
  });

  it('listStoreIndexIds: limit は上限 (STORE_INDEX_MAX_IDS) と下限 1 に clamp される', async () => {
    const m = await mod();
    kvMocks.evalImpl = async () => ({ ok: true, value: [] });
    await m.listStoreIndexIds(99999);
    expect(kvMocks.evalCalls[0].args).toEqual([String(m.STORE_INDEX_MAX_IDS)]);
    await m.listStoreIndexIds(0);
    expect(kvMocks.evalCalls[1].args).toEqual(['1']);
  });
});
