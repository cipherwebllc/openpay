// @vitest-environment node
// 用途横断の支払い claim (FEE_RECEIVER 宛 tx を Pro / CSV / 月次清算 / 注文手数料 / 登録料で二重利用させない) の
// Lua を本物の Lua で実行する (第 7 回レビュー F10)。呼び出し側 (entitlementPayment・registerFeeClaim・
// billing/settle) と同じ KEYS/ARGV の並びで、正常系・冪等・競合を確かめる。
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeRedisLuaEngine, createFakeRedisStore, runRedisLua, type FakeRedisStore } from '@/tests/_helpers/redisLua';
import {
  CLAIM_PAYMENT_UNLESS_LEGACY_BILLING,
  legacyBillingPaymentKey,
  paymentClaimKey,
  paymentClaimPendingValue,
  paymentClaimResultValue,
  RELEASE_PAYMENT_CLAIM_IF_OWNED,
} from '@/lib/paymentClaim';

const TX = `0x${'AB'.repeat(32)}`;
const CLAIM = paymentClaimKey(137, TX);
const LEGACY = legacyBillingPaymentKey(137, TX);

let store: FakeRedisStore;
const claim = (value: string) => runRedisLua(CLAIM_PAYMENT_UNLESS_LEGACY_BILLING, [CLAIM, LEGACY], [value], store);
const release = (value: string) => runRedisLua(RELEASE_PAYMENT_CLAIM_IF_OWNED, [CLAIM], [value], store);

beforeEach(() => {
  store = createFakeRedisStore(1_790_000_000_000);
});
afterAll(closeRedisLuaEngine);

describe('CLAIM_PAYMENT_UNLESS_LEGACY_BILLING (real Lua)', () => {
  it('未使用の tx は 1 で恒久 claim (TTL なし) を置く', async () => {
    expect(await claim(paymentClaimResultValue('register'))).toBe(1);
    expect(store.strings.get(CLAIM)).toBe('r:register');
    expect(store.getTtl(CLAIM)).toBe(-1);
  });

  it('冪等: 既に claim 済みなら 0 で、先に置かれた値を上書きしない', async () => {
    await claim(paymentClaimResultValue('order'));
    expect(await claim(paymentClaimResultValue('order'))).toBe(0);
    expect(await claim(paymentClaimPendingValue('pro', 'other-owner'))).toBe(0);
    expect(store.strings.get(CLAIM)).toBe('r:order');
  });

  it('global claim 導入前の billing 清算 (legacy key) があれば -1 で、claim を作らない', async () => {
    store.strings.set(LEGACY, '1');
    expect(await claim(paymentClaimResultValue('csvpass'))).toBe(-1);
    expect(store.strings.has(CLAIM)).toBe(false);
  });

  it('競合: 同じ tx を 2 用途が同時に claim しても取れるのは 1 本だけ', async () => {
    const pro = paymentClaimPendingValue('pro', 'owner-a');
    const csv = paymentClaimPendingValue('csvpass', 'owner-b');
    const results = await Promise.all([claim(pro), claim(csv)]);
    expect([...results].sort()).toEqual([0, 1]);
    expect(store.strings.get(CLAIM)).toBe(results[0] === 1 ? pro : csv);
  });
});

describe('RELEASE_PAYMENT_CLAIM_IF_OWNED (real Lua)', () => {
  it('自分が置いた pending だけを消し (1)、他の用途が置いた claim は残す (0)', async () => {
    const mine = paymentClaimPendingValue('pro', 'owner-a');
    await claim(mine);
    expect(await release(paymentClaimPendingValue('pro', 'owner-b'))).toBe(0);
    expect(store.strings.get(CLAIM)).toBe(mine);
    expect(await release(mine)).toBe(1);
    expect(store.strings.has(CLAIM)).toBe(false);
  });

  it('冪等・競合: 消えた後の解放は 0、遅れて届いた古い owner の解放は後から取った claim を消さない', async () => {
    const stale = paymentClaimPendingValue('pro', 'owner-a');
    await claim(stale);
    expect(await release(stale)).toBe(1);
    expect(await release(stale)).toBe(0);
    const next = paymentClaimResultValue('billing');
    expect(await claim(next)).toBe(1);
    expect(await release(stale)).toBe(0);
    expect(store.strings.get(CLAIM)).toBe(next);
  });
});
