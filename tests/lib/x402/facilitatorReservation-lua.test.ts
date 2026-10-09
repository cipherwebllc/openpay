// @vitest-environment node
// facilitator の補助 reservation (CONSUME_RESERVATION) を本物の Lua で実行する (第 7 回レビュー F10)。
// /api/facilitator/settle が使う money-path の Lua だが、これまでの test (facilitatorReservation.test.ts) は
// kvEval を JS で模倣していた。ここでは lib/kv.ts の実装ごと fake Upstash (tests/_helpers/redisLua) に繋ぐ。
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress, type Hex } from 'viem';
import { closeRedisLuaEngine, createFakeRedisStore, fakeUpstashFetch, type FakeRedisStore } from '@/tests/_helpers/redisLua';
import { consumeFacilitatorPayment, reserveFacilitatorPayment } from '@/lib/x402/facilitatorReservation';

const NOW_SEC = 1_790_000_000;
const FROM = getAddress('0x1234567890123456789012345678901234567890');
const NONCE = `0x${'AB'.repeat(32)}` as Hex;
const IDENTITY = { chainId: 80002, from: FROM, nonce: NONCE };
const KEY = `x402fac:reservation:v1:80002:${FROM.toLowerCase()}:${NONCE.toLowerCase()}`;
const RESOURCE = 'https://seller.example/paid/report';

function rawPayment(resource = RESOURCE): Record<string, unknown> {
  return {
    x402Version: 1,
    paymentPayload: {
      scheme: 'exact',
      network: 'eip155:80002',
      payload: {
        authorization: { from: FROM, validAfter: '0', validBefore: String(NOW_SEC + 600), intentSalt: `0x${'12'.repeat(32)}` },
        signature: `0x${'34'.repeat(65)}`,
      },
    },
    paymentRequirements: { resource, network: 'eip155:80002', maxAmountRequired: '100' },
    reservation: { maxUpstreamSeconds: 60, settlementGraceSeconds: 30 },
  };
}

let store: FakeRedisStore;

async function reserve(): Promise<string> {
  const reserved = await reserveFacilitatorPayment({
    ...IDENTITY,
    raw: rawPayment(),
    validBefore: BigInt(NOW_SEC + 600),
    nowSec: NOW_SEC,
    nowMs: () => store.now(),
  });
  if (!reserved.ok) throw new Error(`reserve failed: ${reserved.reason}`);
  return reserved.token;
}

const record = () => JSON.parse(store.strings.get(KEY)!) as Record<string, unknown>;

beforeEach(() => {
  store = createFakeRedisStore(NOW_SEC * 1000);
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'test-only');
  vi.stubGlobal('fetch', vi.fn(fakeUpstashFetch(store)));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(closeRedisLuaEngine);

describe('CONSUME_RESERVATION (real Lua)', () => {
  it('reserve → consume: 予約を consumed にし、残り TTL と束縛 (resource・token・paymentHash) を保つ', async () => {
    const token = await reserve();
    expect(record()).toMatchObject({ version: 1, state: 'reserved', resource: RESOURCE, token });
    expect(store.getTtl(KEY)).toBe(600);
    const reserved = record();
    store.advance(40_000);

    expect(await consumeFacilitatorPayment({ ...IDENTITY, raw: rawPayment(), reservationToken: token }))
      .toEqual({ status: 'consumed' });
    expect(record()).toEqual({ ...reserved, state: 'consumed' });
    expect(store.getTtl(KEY)).toBe(560);
  });

  it('冪等: 同じ予約の 2 回目は replay で何も書かない (token 無しの互換経路も同じ resource なら replay)', async () => {
    const token = await reserve();
    await consumeFacilitatorPayment({ ...IDENTITY, raw: rawPayment(), reservationToken: token });
    const consumed = store.strings.get(KEY);

    expect(await consumeFacilitatorPayment({ ...IDENTITY, raw: rawPayment(), reservationToken: token }))
      .toEqual({ status: 'replay' });
    expect(await consumeFacilitatorPayment({ ...IDENTITY, raw: rawPayment() })).toEqual({ status: 'replay' });
    expect(store.strings.get(KEY)).toBe(consumed);
  });

  it('競合: 同時に 2 本の settle が consume しても consumed は 1 本だけ (もう 1 本は replay)', async () => {
    const token = await reserve();
    const results = await Promise.all([
      consumeFacilitatorPayment({ ...IDENTITY, raw: rawPayment(), reservationToken: token }),
      consumeFacilitatorPayment({ ...IDENTITY, raw: rawPayment(), reservationToken: token }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['consumed', 'replay']);
    expect(record().state).toBe('consumed');
  });

  it('別 resource・別 token・token の型違いは invalid で、予約を書き換えない', async () => {
    const token = await reserve();
    const before = store.strings.get(KEY);
    expect(await consumeFacilitatorPayment({ ...IDENTITY, raw: rawPayment('https://seller.example/other'), reservationToken: token }))
      .toEqual({ status: 'invalid' });
    expect(await consumeFacilitatorPayment({ ...IDENTITY, raw: rawPayment(), reservationToken: 'x402r1_other' }))
      .toEqual({ status: 'invalid' });
    expect(await consumeFacilitatorPayment({ ...IDENTITY, raw: rawPayment(), reservationToken: 42 }))
      .toEqual({ status: 'invalid' });
    expect(store.strings.get(KEY)).toBe(before);
  });

  it('同じ authorization の 2 本目の reserve は NX で弾かれ、最初の token だけが consume できる', async () => {
    const token = await reserve();
    expect(await reserveFacilitatorPayment({
      ...IDENTITY, raw: rawPayment(), validBefore: BigInt(NOW_SEC + 600), nowSec: NOW_SEC, nowMs: () => store.now(),
    })).toEqual({ ok: false, reason: 'authorization_reserved' });
    expect(record().token).toBe(token);
  });

  it('予約が無い・期限切れ・TTL の無い record は missing (消費を記録しない)', async () => {
    expect(await consumeFacilitatorPayment({ ...IDENTITY, raw: rawPayment(), reservationToken: 'x402r1_none' }))
      .toEqual({ status: 'missing' });

    const token = await reserve();
    store.advance(600_000);
    expect(await consumeFacilitatorPayment({ ...IDENTITY, raw: rawPayment(), reservationToken: token }))
      .toEqual({ status: 'missing' });
    expect(store.strings.has(KEY)).toBe(false);

    const again = await reserve();
    store.persist(KEY);
    expect(await consumeFacilitatorPayment({ ...IDENTITY, raw: rawPayment(), reservationToken: again }))
      .toEqual({ status: 'missing' });
    expect(record().state).toBe('reserved');
  });

  it('壊れた record (JSON でない・version 違い・未知の state) は unavailable で上書きしない', async () => {
    for (const raw of ['not-json', JSON.stringify({ version: 2, state: 'reserved', resource: RESOURCE, token: 't' }),
      JSON.stringify({ version: 1, state: 'settling', resource: RESOURCE, token: 't' })]) {
      store.strings.set(KEY, raw);
      store.setTtl(KEY, 600);
      expect(await consumeFacilitatorPayment({ ...IDENTITY, raw: rawPayment(), reservationToken: 't' }))
        .toEqual({ status: 'unavailable' });
      expect(store.strings.get(KEY)).toBe(raw);
    }
  });
});
