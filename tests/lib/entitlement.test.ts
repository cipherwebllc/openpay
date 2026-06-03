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
} from '@/lib/entitlement';

const WALLET = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
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

describe('getEntitlement', () => {
  it('bypass on → entitled:true・KV を読まない', async () => {
    setBypass(undefined);
    const r = await getEntitlement(WALLET, 1_000);
    expect(r).toEqual({ entitled: true, expiresAt: null, bypass: true });
    expect(kv.get).not.toHaveBeenCalled();
  });

  it('bypass off + KV 無し → entitled:false', async () => {
    setBypass('0');
    kv.get.mockResolvedValue({ ok: true, value: null });
    const r = await getEntitlement(WALLET, 1_000);
    expect(r).toMatchObject({ entitled: false, bypass: false });
  });

  it('bypass off + 未来満了 → entitled:true', async () => {
    setBypass('0');
    kv.get.mockResolvedValue({ ok: true, value: String(10_000) });
    const r = await getEntitlement(WALLET, 1_000);
    expect(r).toEqual({ entitled: true, expiresAt: 10_000, bypass: false });
  });

  it('bypass off + 過去満了 → entitled:false', async () => {
    setBypass('0');
    kv.get.mockResolvedValue({ ok: true, value: String(500) });
    const r = await getEntitlement(WALLET, 1_000);
    expect(r).toEqual({ entitled: false, expiresAt: 500, bypass: false });
  });

  it('isEntitled は getEntitlement.entitled を返す', async () => {
    setBypass('0');
    kv.get.mockResolvedValue({ ok: true, value: String(10_000) });
    expect(await isEntitled(WALLET, 1_000)).toBe(true);
  });
});

describe('grantEntitlement', () => {
  it('満了 ms を KV に TTL 付きで保存し返す', async () => {
    kv.set.mockResolvedValue({ ok: true, value: 'OK' });
    const now = 1_000_000;
    const expiresAt = await grantEntitlement(WALLET, 30, now);
    expect(expiresAt).toBe(now + 30 * 86_400_000);
    expect(kv.set).toHaveBeenCalledWith(
      `entitlement:${WALLET.toLowerCase()}`,
      String(expiresAt),
      { ttlSec: 30 * 86_400 },
    );
  });
});
