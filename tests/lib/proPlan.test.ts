import { describe, it, expect, beforeEach, vi } from 'vitest';

// proPlan は kvGet/kvEval (lib/kv) と entitlementBypass (lib/entitlement) に依存する。
// kvEval は GRANT_MAX_SCRIPT (Lua) を実行する想定なので、テストでは「Upstash の Lua 実行」を
// JS で忠実にエミュレートする in-memory store を立て、atomic max + TTL 計算を実際に走らせる。

const hold = vi.hoisted(() => ({
  bypass: false,
  // KV in-memory store: key → {value, expireAtMs(絶対時刻・TTL の検証用)}
  store: new Map<string, { value: string; expireAtMs: number }>(),
  evalOk: true,
  getOk: true,
}));

vi.mock('@/lib/entitlement', () => ({
  entitlementBypass: () => hold.bypass,
}));

vi.mock('@/lib/kv', () => ({
  kvGet: vi.fn(async (key: string) => {
    if (!hold.getOk) return { ok: false, reason: 'network_error' };
    const e = hold.store.get(key);
    return { ok: true, value: e ? e.value : null };
  }),
  // GRANT_MAX_SCRIPT を JS でエミュレート: cur と target の max を SET し ttl(秒) を保存。
  kvEval: vi.fn(async (_script: string, keys: string[], args: string[]) => {
    if (!hold.evalOk) return { ok: false, reason: 'network_error' };
    const key = keys[0];
    const target = Number(args[0]);
    const now = Number(args[1]);
    const cur = hold.store.get(key);
    let final = target;
    if (cur) {
      const c = Number(cur.value);
      if (Number.isFinite(c) && c > final) final = c;
    }
    let ttl = Math.ceil((final - now) / 1000);
    if (ttl < 1) ttl = 1;
    hold.store.set(key, { value: String(final), expireAtMs: now + ttl * 1000 });
    return { ok: true, value: String(final) };
  }),
}));

import {
  grantPro,
  getProStatus,
  isPro,
  proPriceWei,
  PRO_PRICE_JPYC,
  PRO_GRANT_DAYS,
  PRO_GRANT_MS,
} from '@/lib/proPlan';

const WALLET = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const DAY = 86_400_000;

beforeEach(() => {
  hold.bypass = false;
  hold.store = new Map();
  hold.evalOk = true;
  hold.getOk = true;
});

describe('proPlan 定数', () => {
  it('価格 = 500 JPYC・proPriceWei = 500e18・付与 30日', () => {
    expect(PRO_PRICE_JPYC).toBe(500);
    expect(proPriceWei).toBe(500n * 10n ** 18n);
    expect(PRO_GRANT_DAYS).toBe(30);
    expect(PRO_GRANT_MS).toBe(30 * DAY);
  });
});

describe('grantPro (atomic max + 残り秒 TTL)', () => {
  const NOW = 1_750_000_000_000;

  it('初回付与 → target をそのまま格納し pro=true', async () => {
    const target = NOW + PRO_GRANT_MS;
    const r = await grantPro(WALLET, target, NOW);
    expect(r).toEqual({ ok: true, expiresAt: target });
    const st = await getProStatus(WALLET, NOW);
    expect(st.pro).toBe(true);
    expect(st.expiresAt).toBe(target);
  });

  it('同一 target の再付与は冪等 (max が no-op・二重 extend しない)', async () => {
    const target = NOW + PRO_GRANT_MS;
    await grantPro(WALLET, target, NOW);
    const r2 = await grantPro(WALLET, target, NOW + 5_000); // crash 後 retry を模す
    expect(r2.expiresAt).toBe(target); // +30日 を重ねない
  });

  it('より遠い target は延長する / 近い target は max で勝たない', async () => {
    const near = NOW + 10 * DAY;
    const far = NOW + 40 * DAY;
    await grantPro(WALLET, far, NOW);
    const r = await grantPro(WALLET, near, NOW); // 既存より近い → 勝たない
    expect(r.expiresAt).toBe(far);
  });

  it('並行 grant 競合: 短い方が長い方を clobber しない (atomic max)', async () => {
    const shortTarget = NOW + 15 * DAY;
    const longTarget = NOW + 45 * DAY;
    // 2 つの支払いをほぼ同時に適用 (どちらの順序でも最終は long であるべき)。
    await Promise.all([
      grantPro(WALLET, shortTarget, NOW),
      grantPro(WALLET, longTarget, NOW),
    ]);
    const st = await getProStatus(WALLET, NOW);
    expect(st.expiresAt).toBe(longTarget);
  });

  it('早期更新の TTL は固定 30d でなく残り秒 (60日 expiry に 60日相当 TTL)', async () => {
    // 既存 30日 → さらに 30日後に 30日付与 (実質 60日 expiry)。TTL は now から 60日相当のはず。
    const first = NOW + 30 * DAY;
    await grantPro(WALLET, first, NOW);
    const second = NOW + 60 * DAY; // 「最新支払いから 30日」= now+60日 (renewal が 30日後の想定)
    await grantPro(WALLET, second, NOW);
    const e = hold.store.get('pro:exp:' + WALLET.toLowerCase());
    expect(e).toBeDefined();
    // TTL 由来の絶対失効時刻 ≈ now + 60日 (固定 30d だと now+30日 で entitlement より先に消える)。
    const ttlMs = e!.expireAtMs - NOW;
    expect(ttlMs).toBeGreaterThan(59 * DAY);
    expect(ttlMs).toBeLessThanOrEqual(60 * DAY + 1000);
  });

  it('過去 target (final<=now) でも TTL>=1 で書ける (clamp)', async () => {
    const past = NOW - 1000;
    const r = await grantPro(WALLET, past, NOW);
    expect(r.ok).toBe(true);
    const e = hold.store.get('pro:exp:' + WALLET.toLowerCase());
    expect(e!.expireAtMs - NOW).toBeGreaterThanOrEqual(1000);
  });

  it('KV eval 失敗 → ok:false を伝播 (route が 503 へ)', async () => {
    hold.evalOk = false;
    const r = await grantPro(WALLET, NOW + PRO_GRANT_MS, NOW);
    expect(r.ok).toBe(false);
  });
});

describe('getProStatus / isPro', () => {
  const NOW = 1_750_000_000_000;

  it('未付与 → pro=false・expiresAt=null', async () => {
    const st = await getProStatus(WALLET, NOW);
    expect(st).toEqual({ pro: false, expiresAt: null, bypass: false });
    expect(await isPro(WALLET, NOW)).toBe(false);
  });

  it('期限切れ → pro=false (expiresAt は返す)', async () => {
    const past = NOW - 1000;
    hold.store.set('pro:exp:' + WALLET.toLowerCase(), {
      value: String(past),
      expireAtMs: NOW + 1000,
    });
    const st = await getProStatus(WALLET, NOW);
    expect(st.pro).toBe(false);
    expect(st.expiresAt).toBe(past);
  });

  it('bypass (アルファ全開放) → KV 非依存で pro=true・bypass=true', async () => {
    hold.bypass = true;
    const st = await getProStatus(WALLET, NOW);
    expect(st).toEqual({ pro: true, expiresAt: null, bypass: true });
    expect(await isPro(WALLET, NOW)).toBe(true);
  });

  it('KV 読み失敗 → pro=false (fail-closed・課金 gate なので締める)', async () => {
    hold.getOk = false;
    const st = await getProStatus(WALLET, NOW);
    expect(st).toEqual({ pro: false, expiresAt: null, bypass: false });
  });

  it('malformed な格納値 → pro=false', async () => {
    hold.store.set('pro:exp:' + WALLET.toLowerCase(), {
      value: 'not-a-number',
      expireAtMs: NOW + 1000,
    });
    const st = await getProStatus(WALLET, NOW);
    expect(st.pro).toBe(false);
    expect(st.expiresAt).toBe(null);
  });
});
