import { describe, it, expect, beforeEach, vi } from 'vitest';

// csvPass は kvGet/kvEval (lib/kv・timedGrant 経由) と entitlementBypass (lib/alphaBypass) に依存する。
// kvEval は GRANT_MAX_SCRIPT (Lua) を実行する想定なので、テストでは「Upstash の Lua 実行」を JS で
// 忠実にエミュレートする in-memory store を立て、atomic max + TTL 計算を実際に走らせる
// (proPlan.test と同方針)。status は csvpass:exp と pro:exp の両方を読む (Pro ⊃ CSV) ので両 key を持つ。

const hold = vi.hoisted(() => ({
  bypass: false,
  // KV in-memory store: key → {value, expireAtMs(絶対時刻・TTL の検証用)}
  store: new Map<string, { value: string; expireAtMs: number }>(),
  evalOk: true,
  // ここに入れた key の kvGet を ok:false にする ('*' = 全 key)。片側障害 (pass のみ/pro のみ) を
  // 独立に再現できる (Codex P3: 共通 boolean では片側失敗を表現できなかった)。
  getFailKeys: new Set<string>(),
}));

vi.mock('@/lib/alphaBypass', () => ({
  entitlementBypass: () => hold.bypass,
}));

vi.mock('@/lib/kv', () => ({
  kvGet: vi.fn(async (key: string) => {
    if (hold.getFailKeys.has('*') || hold.getFailKeys.has(key)) {
      return { ok: false, reason: 'network_error' };
    }
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
  grantCsvPass,
  getCsvPassStatus,
  csvPassPriceWei,
  CSV_PASS_PRICE_JPYC,
  CSV_PASS_GRANT_HOURS,
  CSV_PASS_GRANT_MS,
} from '@/lib/csvPass';

const WALLET = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const PASS_KEY = 'csvpass:exp:' + WALLET.toLowerCase();
const PRO_KEY = 'pro:exp:' + WALLET.toLowerCase();
const HOUR = 3_600_000;

beforeEach(() => {
  hold.bypass = false;
  hold.store = new Map();
  hold.evalOk = true;
  hold.getFailKeys = new Set();
});

describe('csvPass 定数', () => {
  it('価格 = 100 JPYC・csvPassPriceWei = 100e18・付与 24時間 (= 86_400_000ms)', () => {
    expect(CSV_PASS_PRICE_JPYC).toBe(100);
    expect(csvPassPriceWei).toBe(100n * 10n ** 18n);
    expect(CSV_PASS_GRANT_HOURS).toBe(24);
    expect(CSV_PASS_GRANT_MS).toBe(24 * HOUR);
    expect(CSV_PASS_GRANT_MS).toBe(86_400_000);
  });
});

describe('grantCsvPass (atomic max + 残り秒 TTL)', () => {
  const NOW = 1_750_000_000_000;

  it('初回付与 → target をそのまま格納し active=true', async () => {
    const target = NOW + CSV_PASS_GRANT_MS;
    const r = await grantCsvPass(WALLET, target, NOW);
    expect(r).toEqual({ ok: true, expiresAt: target });
    const st = await getCsvPassStatus(WALLET, NOW);
    expect(st.active).toBe(true);
    expect(st.expiresAt).toBe(target);
  });

  it('同一 target の再付与は冪等 (max が no-op・二重 extend しない)', async () => {
    const target = NOW + CSV_PASS_GRANT_MS;
    await grantCsvPass(WALLET, target, NOW);
    const r2 = await grantCsvPass(WALLET, target, NOW + 5_000); // crash 後 retry を模す
    expect(r2.expiresAt).toBe(target); // +24h を重ねない
  });

  it('より遠い target は延長する / 近い target は max で勝たない (合算しない)', async () => {
    const near = NOW + 10 * HOUR;
    const far = NOW + 40 * HOUR;
    await grantCsvPass(WALLET, far, NOW);
    const r = await grantCsvPass(WALLET, near, NOW); // 既存より近い → 勝たない
    expect(r.expiresAt).toBe(far);
  });

  it('過去 target (final<=now) でも TTL>=1 で書ける (clamp)', async () => {
    const past = NOW - 1000;
    const r = await grantCsvPass(WALLET, past, NOW);
    expect(r.ok).toBe(true);
    const e = hold.store.get(PASS_KEY);
    expect(e!.expireAtMs - NOW).toBeGreaterThanOrEqual(1000);
  });

  it('KV eval 失敗 → ok:false を伝播 (route が 503 へ)', async () => {
    hold.evalOk = false;
    const r = await grantCsvPass(WALLET, NOW + CSV_PASS_GRANT_MS, NOW);
    expect(r.ok).toBe(false);
  });
});

describe('getCsvPassStatus (csvpass:exp ∪ pro:exp の max・Pro ⊃ CSV)', () => {
  const NOW = 1_750_000_000_000;

  it('bypass (アルファ全開放) → KV 非依存で active=true・bypass=true', async () => {
    hold.bypass = true;
    const st = await getCsvPassStatus(WALLET, NOW);
    expect(st).toEqual({ active: true, expiresAt: null, bypass: true });
  });

  it('パスのみ有効 → active=true (csvpass:exp で判定)', async () => {
    const exp = NOW + CSV_PASS_GRANT_MS;
    hold.store.set(PASS_KEY, { value: String(exp), expireAtMs: exp });
    const st = await getCsvPassStatus(WALLET, NOW);
    expect(st).toEqual({ active: true, expiresAt: exp, bypass: false });
  });

  it('Pro のみ有効 (パス無し) → active=true (Pro ⊃ CSV・pro:exp で判定)', async () => {
    const proExp = NOW + 30 * 86_400_000;
    hold.store.set(PRO_KEY, { value: String(proExp), expireAtMs: proExp });
    const st = await getCsvPassStatus(WALLET, NOW);
    expect(st).toEqual({ active: true, expiresAt: proExp, bypass: false });
  });

  it('両方有効 → max を実効 expiry にする (Pro が遠ければ Pro 側)', async () => {
    const passExp = NOW + CSV_PASS_GRANT_MS; // +24h
    const proExp = NOW + 30 * 86_400_000; // +30d (より遠い)
    hold.store.set(PASS_KEY, { value: String(passExp), expireAtMs: passExp });
    hold.store.set(PRO_KEY, { value: String(proExp), expireAtMs: proExp });
    const st = await getCsvPassStatus(WALLET, NOW);
    expect(st.active).toBe(true);
    expect(st.expiresAt).toBe(proExp); // max
  });

  it('両方有効・パスが遠い → パス側を実効 expiry にする', async () => {
    const passExp = NOW + 100 * 86_400_000; // far (renew で延長された等)
    const proExp = NOW + 30 * 86_400_000;
    hold.store.set(PASS_KEY, { value: String(passExp), expireAtMs: passExp });
    hold.store.set(PRO_KEY, { value: String(proExp), expireAtMs: proExp });
    const st = await getCsvPassStatus(WALLET, NOW);
    expect(st.expiresAt).toBe(passExp); // max
  });

  it('両方期限切れ → active=false (max の expiry は返す)', async () => {
    const passExp = NOW - 1000;
    const proExp = NOW - 2000;
    hold.store.set(PASS_KEY, { value: String(passExp), expireAtMs: NOW + 1000 });
    hold.store.set(PRO_KEY, { value: String(proExp), expireAtMs: NOW + 1000 });
    const st = await getCsvPassStatus(WALLET, NOW);
    expect(st.active).toBe(false);
    expect(st.expiresAt).toBe(passExp); // max(過去) = より新しい過去
  });

  it('未付与 (両 key 無し・KV miss) → active=false・expiresAt=null', async () => {
    const st = await getCsvPassStatus(WALLET, NOW);
    expect(st).toEqual({ active: false, expiresAt: null, bypass: false });
  });

  it('片側 KV 読み失敗 (pass 障害)・pro 有効 → 判明分で active=true (expiresAt も返る)', async () => {
    hold.getFailKeys.add(PASS_KEY); // pass 側だけ実際に ok:false (片側障害)
    const proExp = NOW + 30 * 86_400_000;
    hold.store.set(PRO_KEY, { value: String(proExp), expireAtMs: proExp });
    const st = await getCsvPassStatus(WALLET, NOW);
    expect(st).toEqual({ active: true, expiresAt: proExp, bypass: false });
  });

  // fail-open (Codex P1): 読み失敗で active を証明できない場合に締めると、障害中に購入 CTA が出て
  // 既保持者へ不要な 100 JPYC を払わせうる (grant は max 非合算)。→ 開放に倒す。
  it('KV 読み全失敗 → active=true (fail-open・誤って paywall/購入 CTA を出さない)', async () => {
    hold.getFailKeys.add('*');
    const st = await getCsvPassStatus(WALLET, NOW);
    expect(st).toEqual({ active: true, expiresAt: null, bypass: false });
  });

  it('片側失敗 + 他方が期限切れ → fail-open (失敗側に有効権が眠っている可能性)', async () => {
    hold.getFailKeys.add(PRO_KEY); // pro 側障害 (有効な Pro があるかもしれない)
    hold.store.set(PASS_KEY, { value: String(NOW - 1000), expireAtMs: NOW + 1000 });
    const st = await getCsvPassStatus(WALLET, NOW);
    expect(st).toEqual({ active: true, expiresAt: null, bypass: false });
  });

  it('片側失敗 + 他方が miss (ok・value 無し) → fail-open', async () => {
    hold.getFailKeys.add(PASS_KEY);
    const st = await getCsvPassStatus(WALLET, NOW);
    expect(st).toEqual({ active: true, expiresAt: null, bypass: false });
  });

  it('malformed な格納値 → 候補に入れず active=false', async () => {
    hold.store.set(PASS_KEY, { value: 'not-a-number', expireAtMs: NOW + 1000 });
    const st = await getCsvPassStatus(WALLET, NOW);
    expect(st.active).toBe(false);
    expect(st.expiresAt).toBe(null);
  });
});
