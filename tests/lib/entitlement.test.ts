// 旧「利用権 tier ストア」は a1 OpenPay 利用料への一本化で退役 (2026-06-09)。
// 残ったのは a1 が流用する `entitlementBypass` (ALPHA_ENTITLEMENT_BYPASS) のみ。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('entitlementBypass (アルファ全開放スイッチ)', () => {
  // module-level の _warnedUnrecognized フラグをリセットするため、
  // 各テストでモジュールキャッシュを捨てて動的 import する。
  beforeEach(() => {
    vi.resetModules();
    delete process.env.ALPHA_ENTITLEMENT_BYPASS;
  });

  afterEach(() => {
    delete process.env.ALPHA_ENTITLEMENT_BYPASS;
  });

  async function bypass(): Promise<boolean> {
    const mod = await import('@/lib/entitlement');
    return mod.entitlementBypass();
  }

  // ── 既定 ON ──────────────────────────────────────────────────────
  it('未設定 → true (既定 = 全開放)', async () => {
    expect(await bypass()).toBe(true);
  });

  it("'' (空文字) → true (既定 ON)", async () => {
    process.env.ALPHA_ENTITLEMENT_BYPASS = '';
    expect(await bypass()).toBe(true);
  });

  // ── OFF 集合 ──────────────────────────────────────────────────────
  it.each([['0'], ['false'], ['no'], ['off'], ['FALSE'], ['False'], [' 0 '], ['OFF']])(
    "'%s' → false (課金運用)",
    async (val) => {
      process.env.ALPHA_ENTITLEMENT_BYPASS = val;
      expect(await bypass()).toBe(false);
    },
  );

  // ── ON 集合 ───────────────────────────────────────────────────────
  it.each([['1'], ['true'], ['yes'], ['on'], ['TRUE']])(
    "'%s' → true (全開放)",
    async (val) => {
      process.env.ALPHA_ENTITLEMENT_BYPASS = val;
      expect(await bypass()).toBe(true);
    },
  );

  // ── 認識不能 → fail-closed + warn ────────────────────────────────
  it("'garbage' → false + logger.warn が呼ばれる", async () => {
    // logger をスパイするため先にモジュールをロード
    const loggerMod = await import('@/lib/logger');
    const warnSpy = vi.spyOn(loggerMod.logger, 'warn');

    process.env.ALPHA_ENTITLEMENT_BYPASS = 'garbage';
    const mod = await import('@/lib/entitlement');
    expect(mod.entitlementBypass()).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('billing.bypass.unrecognized', { value: 'garbage' });

    warnSpy.mockRestore();
  });

  it("'2' → false + logger.warn が呼ばれる", async () => {
    const loggerMod = await import('@/lib/logger');
    const warnSpy = vi.spyOn(loggerMod.logger, 'warn');

    process.env.ALPHA_ENTITLEMENT_BYPASS = '2';
    const mod = await import('@/lib/entitlement');
    expect(mod.entitlementBypass()).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('billing.bypass.unrecognized', { value: '2' });

    warnSpy.mockRestore();
  });

  it('認識不能値で 2 回呼んでも warn は 1 回だけ', async () => {
    const loggerMod = await import('@/lib/logger');
    const warnSpy = vi.spyOn(loggerMod.logger, 'warn');

    process.env.ALPHA_ENTITLEMENT_BYPASS = 'garbage';
    const mod = await import('@/lib/entitlement');
    mod.entitlementBypass(); // 1 回目
    mod.entitlementBypass(); // 2 回目
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });
});
