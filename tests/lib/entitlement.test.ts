import { describe, it, expect, vi, afterEach } from 'vitest';

const kv = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('@/lib/kv', () => ({
  kvGet: (...args: unknown[]) => kv.get(...args),
  kvSet: (...args: unknown[]) => kv.set(...args),
}));

import {
  entitlementBypass,
  getEntitlement,
  isEntitled,
  grantEntitlement,
  tierAtLeast,
} from '@/lib/entitlement';

const WALLET = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const KEY = `entitlement:${WALLET.toLowerCase()}`;
const ORIG = process.env.ALPHA_ENTITLEMENT_BYPASS;

function setBypass(v: string | undefined) {
  if (v === undefined) delete process.env.ALPHA_ENTITLEMENT_BYPASS;
  else process.env.ALPHA_ENTITLEMENT_BYPASS = v;
}

afterEach(() => {
  setBypass(ORIG);
  vi.clearAllMocks();
});

describe('entitlementBypass', () => {
  it('未設定は既定 true (アルファ全開放)', () => {
    setBypass(undefined);
    expect(entitlementBypass()).toBe(true);
  });
  it("'0' / 'false' で false (利用権必須)", () => {
    setBypass('0');
    expect(entitlementBypass()).toBe(false);
    setBypass('false');
    expect(entitlementBypass()).toBe(false);
  });
  it("'1' は true", () => {
    setBypass('1');
    expect(entitlementBypass()).toBe(true);
  });
});

describe('tierAtLeast', () => {
  it('pro ⊃ basic / 同 tier OK / 下位 NG / null は常に false', () => {
    expect(tierAtLeast('basic', 'basic')).toBe(true);
    expect(tierAtLeast('pro', 'basic')).toBe(true);
    expect(tierAtLeast('pro', 'pro')).toBe(true);
    expect(tierAtLeast('basic', 'pro')).toBe(false);
    expect(tierAtLeast(null, 'basic')).toBe(false);
  });
});

describe('getEntitlement', () => {
  it('bypass on → entitled:true・tier:pro・KV を読まない', async () => {
    setBypass(undefined);
    const r = await getEntitlement(WALLET, 1_000);
    expect(r).toEqual({
      entitled: true,
      tier: 'pro',
      expiresAt: null,
      bypass: true,
    });
    expect(kv.get).not.toHaveBeenCalled();
  });

  it('bypass off + KV 無し → entitled:false・tier:null', async () => {
    setBypass('0');
    kv.get.mockResolvedValue({ ok: true, value: null });
    const r = await getEntitlement(WALLET, 1_000);
    expect(r).toEqual({
      entitled: false,
      tier: null,
      expiresAt: null,
      bypass: false,
    });
  });

  it('bypass off + JSON basic 未来満了 → entitled:true・tier:basic', async () => {
    setBypass('0');
    kv.get.mockResolvedValue({
      ok: true,
      value: JSON.stringify({ tier: 'basic', expiresAt: 10_000 }),
    });
    const r = await getEntitlement(WALLET, 1_000);
    expect(r).toEqual({
      entitled: true,
      tier: 'basic',
      expiresAt: 10_000,
      bypass: false,
    });
  });

  it('bypass off + JSON pro 未来満了 → tier:pro', async () => {
    setBypass('0');
    kv.get.mockResolvedValue({
      ok: true,
      value: JSON.stringify({ tier: 'pro', expiresAt: 10_000 }),
    });
    expect((await getEntitlement(WALLET, 1_000)).tier).toBe('pro');
  });

  it('bypass off + 過去満了 → entitled:false・tier:null (expiresAt は保持)', async () => {
    setBypass('0');
    kv.get.mockResolvedValue({
      ok: true,
      value: JSON.stringify({ tier: 'pro', expiresAt: 500 }),
    });
    const r = await getEntitlement(WALLET, 1_000);
    expect(r).toEqual({
      entitled: false,
      tier: null,
      expiresAt: 500,
      bypass: false,
    });
  });

  it('後方互換: 旧 bare ms-epoch 文字列は pro 利用権とみなす', async () => {
    setBypass('0');
    kv.get.mockResolvedValue({ ok: true, value: String(10_000) });
    const r = await getEntitlement(WALLET, 1_000);
    expect(r).toEqual({
      entitled: true,
      tier: 'pro',
      expiresAt: 10_000,
      bypass: false,
    });
  });

  it('不正 JSON は無効扱い (entitled:false)', async () => {
    setBypass('0');
    kv.get.mockResolvedValue({ ok: true, value: '{bad json' });
    expect((await getEntitlement(WALLET, 1_000)).entitled).toBe(false);
  });
});

describe('isEntitled (min tier)', () => {
  it('basic 利用権: min=basic → true / min=pro → false', async () => {
    setBypass('0');
    kv.get.mockResolvedValue({
      ok: true,
      value: JSON.stringify({ tier: 'basic', expiresAt: 10_000 }),
    });
    expect(await isEntitled(WALLET, 'basic', 1_000)).toBe(true);
    expect(await isEntitled(WALLET, 'pro', 1_000)).toBe(false);
  });

  it('pro 利用権: min=basic も min=pro も true', async () => {
    setBypass('0');
    kv.get.mockResolvedValue({
      ok: true,
      value: JSON.stringify({ tier: 'pro', expiresAt: 10_000 }),
    });
    expect(await isEntitled(WALLET, 'basic', 1_000)).toBe(true);
    expect(await isEntitled(WALLET, 'pro', 1_000)).toBe(true);
  });

  it('失効済 → false', async () => {
    setBypass('0');
    kv.get.mockResolvedValue({
      ok: true,
      value: JSON.stringify({ tier: 'pro', expiresAt: 500 }),
    });
    expect(await isEntitled(WALLET, 'basic', 1_000)).toBe(false);
  });

  it('既定 min は basic', async () => {
    setBypass('0');
    kv.get.mockResolvedValue({
      ok: true,
      value: JSON.stringify({ tier: 'basic', expiresAt: 10_000 }),
    });
    expect(await isEntitled(WALLET, undefined, 1_000)).toBe(true);
  });
});

describe('grantEntitlement', () => {
  const now = 1_000_000;
  const dayMs = 86_400_000;

  it('新規付与: JSON {tier,expiresAt} を TTL 付きで保存し確定値を返す', async () => {
    setBypass('0');
    kv.get.mockResolvedValue({ ok: true, value: null }); // 既存なし
    kv.set.mockResolvedValue({ ok: true, value: 'OK' });
    const r = await grantEntitlement(WALLET, 'basic', 30, now);
    const expiresAt = now + 30 * dayMs;
    expect(r).toEqual({ tier: 'basic', expiresAt });
    expect(kv.set).toHaveBeenCalledWith(
      KEY,
      JSON.stringify({ tier: 'basic', expiresAt }),
      { ttlSec: 30 * 86_400 },
    );
  });

  it('アップグレード: 既存 basic 有効中に pro 付与 → pro へ昇格・expiry は max', async () => {
    setBypass('0');
    const curExpiry = now + 20 * dayMs;
    kv.get.mockResolvedValue({
      ok: true,
      value: JSON.stringify({ tier: 'basic', expiresAt: curExpiry }),
    });
    kv.set.mockResolvedValue({ ok: true, value: 'OK' });
    const r = await grantEntitlement(WALLET, 'pro', 30, now);
    const fresh = now + 30 * dayMs;
    expect(r).toEqual({ tier: 'pro', expiresAt: fresh }); // fresh > curExpiry
  });

  it('ダウングレード防止: 既存 pro 有効中に basic 付与 → pro 維持・expiry max', async () => {
    setBypass('0');
    const curExpiry = now + 40 * dayMs; // 既存 pro が新規 basic(30d) より長い
    kv.get.mockResolvedValue({
      ok: true,
      value: JSON.stringify({ tier: 'pro', expiresAt: curExpiry }),
    });
    kv.set.mockResolvedValue({ ok: true, value: 'OK' });
    const r = await grantEntitlement(WALLET, 'basic', 30, now);
    expect(r).toEqual({ tier: 'pro', expiresAt: curExpiry }); // 維持・延長(max)
  });

  it('同 tier 再付与: expiry を max で延長', async () => {
    setBypass('0');
    const curExpiry = now + 5 * dayMs; // 残り 5 日
    kv.get.mockResolvedValue({
      ok: true,
      value: JSON.stringify({ tier: 'basic', expiresAt: curExpiry }),
    });
    kv.set.mockResolvedValue({ ok: true, value: 'OK' });
    const r = await grantEntitlement(WALLET, 'basic', 30, now);
    expect(r).toEqual({ tier: 'basic', expiresAt: now + 30 * dayMs });
  });
});
