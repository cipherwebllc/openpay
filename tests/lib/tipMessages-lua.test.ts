// @vitest-environment node
// 質問箱 (チップに添えた非公開メッセージ) の保存 Lua (STORE_TIP_MESSAGE) を本物の Lua で実行する (Lua 登録表の計画 PR-C)。
// tipMessages.test.ts は kvEval を JS で模倣しているため、「同じ chain・同じ tx のメッセージは 1 通だけ」(tx hash は大文字小文字を
// 問わない)・200 通での切り詰め・180 日の TTL・Lua が書いた行を読み手 (parseStoredTipMessage) が読めることは CI で一度も
// 実行されていなかった。lib/tipMessages.ts を lib/kv.ts の実装ごと fake Upstash に繋ぐ (mock なし)。
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeRedisLuaEngine, createFakeRedisStore, fakeUpstashFetch, type FakeRedisStore } from '@/tests/_helpers/redisLua';
import {
  listTipMessages,
  storeTipMessage,
  tipMessageInboxKey,
  TIP_MESSAGE_LIST_MAX,
  TIP_MESSAGE_TTL_SEC,
} from '@/lib/tipMessages';

const FROM = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const TO = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const INBOX = tipMessageInboxKey(TO);
const TX = `0x${'ab'.repeat(32)}`;
let store: FakeRedisStore;

beforeEach(() => {
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

const tip = (over: { txHash?: string; chainId?: number; message?: string; ts?: number } = {}) => storeTipMessage({
  from: FROM, to: TO, amountWei: 5n * 10n ** 18n, chainId: over.chainId ?? 137,
  txHash: over.txHash ?? TX, message: over.message ?? '応援しています', ts: over.ts ?? 1_790_000_000_123,
});

describe('STORE_TIP_MESSAGE (real Lua)', () => {
  it('新しいメッセージを受信箱の先頭に積み、180 日の TTL を付け、読み手がそのまま読める形で書く', async () => {
    expect(await tip()).toBe(true);
    expect(store.getTtl(INBOX)).toBe(TIP_MESSAGE_TTL_SEC);
    expect(JSON.parse(store.lists.get(INBOX)![0])).toEqual({
      from: FROM, to: TO, amountWei: '5000000000000000000', chainId: 137, txHash: TX, message: '応援しています', ts: 1_790_000_000_123,
    });
    expect(await listTipMessages(TO)).toEqual([{
      from: FROM, to: TO, amountWei: '5000000000000000000', chainId: 137, txHash: TX, message: '応援しています', ts: 1_790_000_000_123,
    }]);
  });

  it('冪等: 同じ chain の同じ tx (hash の大文字小文字は問わない) は 0 → false で 2 通目を積まない', async () => {
    expect(await tip()).toBe(true);
    expect(await tip({ message: '別の文面' })).toBe(false);
    expect(await tip({ txHash: TX.toUpperCase().replace('0X', '0x') })).toBe(false);
    expect(store.lists.get(INBOX)).toHaveLength(1);
    // 別 chain の同じ hash は別の支払いなので受け付ける。
    expect(await tip({ chainId: 80002 })).toBe(true);
    expect((await listTipMessages(TO))!.map((m) => m.chainId)).toEqual([80002, 137]);
  });

  it('壊れた行や形の違う行があっても重複判定を止めず、読めない行は飛ばす', async () => {
    store.lists.set(INBOX, ['not-json', JSON.stringify({ chainId: 137 }), JSON.stringify({ chainId: '137', txHash: TX })]);
    // 文字列の chainId も数値として比べる (tonumber)。
    expect(await tip()).toBe(false);
    expect(await tip({ txHash: `0x${'cd'.repeat(32)}` })).toBe(true);
    expect(store.lists.get(INBOX)).toHaveLength(4);
  });

  it(`受信箱は新しい順に ${TIP_MESSAGE_LIST_MAX} 通で切り詰め、積むたびに TTL を張り直す`, async () => {
    const old = Array.from({ length: TIP_MESSAGE_LIST_MAX }, (_, i) => JSON.stringify({ chainId: 1, txHash: `old-${i}` }));
    store.lists.set(INBOX, [...old]);
    store.setTtl(INBOX, 60);
    expect(await tip()).toBe(true);
    const rows = store.lists.get(INBOX)!;
    expect(rows).toHaveLength(TIP_MESSAGE_LIST_MAX);
    expect(JSON.parse(rows[0])).toMatchObject({ txHash: TX });
    expect(rows.slice(1)).toEqual(old.slice(0, -1));
    expect(store.getTtl(INBOX)).toBe(TIP_MESSAGE_TTL_SEC);
  });

  it('競合: 同じ tx の同時保存は 1 通だけ入る', async () => {
    const results = await Promise.all([tip(), tip({ message: '二重送信' }), tip()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(store.lists.get(INBOX)).toHaveLength(1);
  });
});
