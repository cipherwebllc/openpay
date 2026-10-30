// @vitest-environment node
// vanilla x402 の resource 束縛 claim の解放 (RELEASE_VANILLA_CLAIM) を本物の Lua で実行する (第 7 回レビュー F10)。
// claim (SET NX EX GET) と解放 (Lua) を lib/kv.ts の実装ごと fake Upstash に繋ぎ、1 通の署名済み支払いが
// 別 resource で二重解錠されない束縛と、遅れて届いた解放が後の束縛を消さないことを確かめる。
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeRedisLuaEngine, createFakeRedisStore, fakeUpstashFetch, type FakeRedisStore } from '@/tests/_helpers/redisLua';
import {
  claimVanillaResource,
  markVanillaResourceSpent,
  releaseVanillaResource,
  vanillaPaymentIdentity,
  VANILLA_CLAIM_TTL_SEC,
} from '@/lib/x402/vanillaResourceClaim';

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

function identity(signatureByte = '11') {
  const id = vanillaPaymentIdentity({
    network: 'eip155:8453',
    payload: {
      authorization: { from: '0x1234567890123456789012345678901234567890', nonce: `0x${'ab'.repeat(32)}` },
      signature: `0x${signatureByte.repeat(32)}${'22'.repeat(32)}1b`,
    },
  });
  if (!id) throw new Error('identity');
  return id;
}

const A = 'https://seller.example/paid/a?q=1';
const B = 'https://seller.example/paid/b';
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

describe('RELEASE_VANILLA_CLAIM (real Lua)', () => {
  it('claim → 自分の束縛の解放で消える (TTL は 30 分)', async () => {
    const id = identity();
    expect(await claimVanillaResource({ identity: id, binding: A })).toEqual({ kind: 'claimed' });
    expect(store.getTtl(id.key)).toBe(VANILLA_CLAIM_TTL_SEC);
    expect(await releaseVanillaResource({ identity: id, binding: A })).toEqual({ kind: 'released' });
    expect(store.strings.has(id.key)).toBe(false);
  });

  it('冪等: 同じ束縛の再 claim は match、解放済みの再解放は missing', async () => {
    const id = identity();
    await claimVanillaResource({ identity: id, binding: A });
    expect(await claimVanillaResource({ identity: id, binding: A })).toEqual({ kind: 'match' });
    expect(await releaseVanillaResource({ identity: id, binding: A })).toEqual({ kind: 'released' });
    expect(await releaseVanillaResource({ identity: id, binding: A })).toEqual({ kind: 'missing' });
  });

  it('競合: 別束縛・別署名の解放は not-owner で消さない。遅れて届いた古い解放は後の束縛を残す', async () => {
    const id = identity();
    await claimVanillaResource({ identity: id, binding: A });
    expect(await claimVanillaResource({ identity: id, binding: B })).toEqual({ kind: 'conflict' });
    expect(await releaseVanillaResource({ identity: id, binding: B })).toEqual({ kind: 'not-owner' });
    expect(await releaseVanillaResource({ identity: identity('33'), binding: A })).toEqual({ kind: 'not-owner' });
    expect(store.strings.has(id.key)).toBe(true);

    await releaseVanillaResource({ identity: id, binding: A });
    expect(await claimVanillaResource({ identity: id, binding: B })).toEqual({ kind: 'claimed' });
    expect(await releaseVanillaResource({ identity: id, binding: A })).toEqual({ kind: 'not-owner' });
    expect(await claimVanillaResource({ identity: id, binding: B })).toEqual({ kind: 'match' });
  });

  it('壊れた record (JSON でない・version 違い) は not-owner で消さない', async () => {
    const id = identity();
    for (const raw of ['not-json', JSON.stringify({ version: 2, bindingHash: 'x', credential: id.credential })]) {
      store.strings.set(id.key, raw);
      expect(await releaseVanillaResource({ identity: id, binding: A })).toEqual({ kind: 'not-owner' });
      expect(store.strings.get(id.key)).toBe(raw);
    }
  });
});

// 第 8 回レビュー B-1: settle に進む前の印 (MARK_VANILLA_CLAIM_SPENT) を本物の Lua で。自分の束縛にだけ spent を足し、
// TTL は変えない。印の付いた束縛への再送は claim が match + spent を返す (vanillaGate が content を動かさない根拠)。
describe('markVanillaResourceSpent (本物の Lua)', () => {
  it('自分の束縛に spent を足し、TTL はそのまま・再送の claim は match + spent', async () => {
    const id = identity();
    expect(await claimVanillaResource({ identity: id, binding: A, ttlSec: 604_900 })).toEqual({ kind: 'claimed' });
    const ttlBefore = store.getPttl(id.key);
    expect(await markVanillaResourceSpent({ identity: id, binding: A })).toEqual({ kind: 'marked' });
    expect(store.getPttl(id.key)).toBe(ttlBefore);
    expect(await claimVanillaResource({ identity: id, binding: A, ttlSec: 604_900 })).toEqual({ kind: 'match', spent: true });
  });

  it('印の無い同じ束縛の再送は従来どおり match (spent なし)', async () => {
    const id = identity();
    await claimVanillaResource({ identity: id, binding: A });
    expect(await claimVanillaResource({ identity: id, binding: A })).toEqual({ kind: 'match' });
  });

  it('別の束縛・別の署名の record には印を付けない (not-owner)・record が無ければ missing', async () => {
    const id = identity();
    await claimVanillaResource({ identity: id, binding: A });
    expect(await markVanillaResourceSpent({ identity: id, binding: B })).toEqual({ kind: 'not-owner' });
    // 同じ (from, nonce) のキーに別の署名で印を付けようとしても付かない。
    expect(await markVanillaResourceSpent({ identity: identity('33'), binding: A })).toEqual({ kind: 'not-owner' });
    expect(await claimVanillaResource({ identity: id, binding: A })).toEqual({ kind: 'match' });
    await releaseVanillaResource({ identity: id, binding: A });
    expect(await markVanillaResourceSpent({ identity: id, binding: A })).toEqual({ kind: 'missing' });
  });
});
