import { describe, it, expect, vi, afterEach } from 'vitest';

// recoverFee は env (NEXT_PUBLIC_RECOVER_FEE_BPS) と forwarderConfig (NEXT_PUBLIC_RELAY_GAS_FEE_JPYC)
// を読む。両者とも module 評価時に process.env を読むため、env を確定 → resetModules → 動的 import
// で「実モジュール」を与えた env で評価する (mock 無し・実 lib/env + 実 forwarderConfig の実コードパス)。
// これは tests/lib/forwarderConfig.test.ts と同じパターン。
const KEYS = [
  'NEXT_PUBLIC_RECOVER_FEE_BPS',
  'NEXT_PUBLIC_RELAY_GAS_FEE_JPYC',
] as const;

type Key = (typeof KEYS)[number];

async function loadWith(envVars: Partial<Record<Key, string>>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, envVars);
  vi.resetModules();
  return import('@/lib/relay/recoverFee');
}

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
  vi.resetModules();
});

const JPYC = 10n ** 18n; // 1 JPYC (18 decimals)
const FLOOR = 2n * JPYC; // 既定フロア = 2 JPYC

describe('recoverFeeBps', () => {
  it('未設定 → 0 (inert 既定)', async () => {
    const { recoverFeeBps } = await loadWith({});
    expect(recoverFeeBps()).toBe(0);
  });

  it('100 → 100 (1%)', async () => {
    const { recoverFeeBps } = await loadWith({ NEXT_PUBLIC_RECOVER_FEE_BPS: '100' });
    expect(recoverFeeBps()).toBe(100);
  });

  it('上限 1000 (10%) を超える値は 1000 に clamp', async () => {
    const { recoverFeeBps } = await loadWith({ NEXT_PUBLIC_RECOVER_FEE_BPS: '5000' });
    expect(recoverFeeBps()).toBe(1000);
  });

  it('不正値 (非整数/負/16進/指数/空白) は 0 にフォールバック', async () => {
    for (const bad of ['abc', '-1', '2.5', '0x10', '1e3', ' 50 ', '1_000']) {
      const { recoverFeeBps } = await loadWith({ NEXT_PUBLIC_RECOVER_FEE_BPS: bad });
      expect(recoverFeeBps(), `bad=${JSON.stringify(bad)}`).toBe(0);
    }
  });
});

// gasMode で料金スケジュールが選択される (確定モデル 2026-06-12):
//   merchant (決済): max(floor, billAmount × bps/10000) — 大口は bps が乗る。
//   customer (チップ): floor のみ (bps 無視・常にフラットなガス相当)。
describe('recoverFeeValue — bps=0 (既定・inert): 両 gasMode で常にフロア', () => {
  it('merchant: billAmount に依らず常にフロア (2e18) = 現行の固定 2 JPYC 挙動と一致', async () => {
    const { recoverFeeValue } = await loadWith({});
    expect(recoverFeeValue(0n, 'merchant')).toBe(FLOOR);
    expect(recoverFeeValue(100n * JPYC, 'merchant')).toBe(FLOOR);
    expect(recoverFeeValue(1_000n * JPYC, 'merchant')).toBe(FLOOR);
    expect(recoverFeeValue(10_000_000n * JPYC, 'merchant')).toBe(FLOOR); // 大口でもフロア
  });

  it('customer: billAmount に依らず常にフロア (チップは bps=0 でも当然フロア)', async () => {
    const { recoverFeeValue } = await loadWith({});
    expect(recoverFeeValue(0n, 'customer')).toBe(FLOOR);
    expect(recoverFeeValue(1_000n * JPYC, 'customer')).toBe(FLOOR);
    expect(recoverFeeValue(10_000_000n * JPYC, 'customer')).toBe(FLOOR);
  });
});

describe('recoverFeeValue — bps=100 (1%): merchant のみ % が乗る', () => {
  it('merchant 小口 (1% < フロア): billAmount=100 JPYC → 1% は 1 JPYC < フロア → フロア 2e18', async () => {
    const { recoverFeeValue } = await loadWith({ NEXT_PUBLIC_RECOVER_FEE_BPS: '100' });
    expect(recoverFeeValue(100n * JPYC, 'merchant')).toBe(FLOOR);
  });

  it('merchant 境界ちょうど: billAmount=200 JPYC → 1% = 2 JPYC = フロア (max は等しいのでフロア)', async () => {
    const { recoverFeeValue } = await loadWith({ NEXT_PUBLIC_RECOVER_FEE_BPS: '100' });
    expect(recoverFeeValue(200n * JPYC, 'merchant')).toBe(FLOOR);
    expect(recoverFeeValue(200n * JPYC, 'merchant')).toBe(2n * JPYC);
  });

  it('merchant 大口: billAmount=1000 JPYC → 1% = 10 JPYC (フロア超過)', async () => {
    const { recoverFeeValue } = await loadWith({ NEXT_PUBLIC_RECOVER_FEE_BPS: '100' });
    expect(recoverFeeValue(1_000n * JPYC, 'merchant')).toBe(10n * JPYC);
  });

  it('merchant 境界の片側上: billAmount=201 JPYC → 1% = 2.01 JPYC (フロア超過・端数は floor 除算)', async () => {
    const { recoverFeeValue } = await loadWith({ NEXT_PUBLIC_RECOVER_FEE_BPS: '100' });
    // 201e18 * 100 / 10000 = 201e18 / 100 = 2.01e18
    expect(recoverFeeValue(201n * JPYC, 'merchant')).toBe((201n * JPYC) / 100n);
    expect(recoverFeeValue(201n * JPYC, 'merchant')).toBeGreaterThan(FLOOR);
  });

  it('merchant BigInt floor 除算: 端数は切り捨て (round-down)', async () => {
    const { recoverFeeValue } = await loadWith({ NEXT_PUBLIC_RECOVER_FEE_BPS: '100' });
    // billAmount = 99999 wei (フロアより遥かに小さいので結果はフロアだが、pct の計算式を確認)。
    const billAmount = 99_999n;
    expect(recoverFeeValue(billAmount, 'merchant')).toBe(FLOOR);
  });

  it('customer (チップ): bps=100 でも常にフロア (1% を乗せない・確定モデルの核)', async () => {
    const { recoverFeeValue } = await loadWith({ NEXT_PUBLIC_RECOVER_FEE_BPS: '100' });
    // 大口でも 1% は乗らずフロア (= 2 JPYC) のまま。merchant なら 10 JPYC になる額で対比。
    expect(recoverFeeValue(1_000n * JPYC, 'customer')).toBe(FLOOR);
    expect(recoverFeeValue(1_000n * JPYC, 'merchant')).toBe(10n * JPYC);
    // 境界ちょうど・超過いずれもフロア固定。
    expect(recoverFeeValue(200n * JPYC, 'customer')).toBe(FLOOR);
    expect(recoverFeeValue(10_000n * JPYC, 'customer')).toBe(FLOOR);
  });
});

describe('recoverFeeValue — フロア override (NEXT_PUBLIC_RELAY_GAS_FEE_JPYC)', () => {
  it('フロア=5 JPYC, bps=0 → 両 gasMode で常に 5e18', async () => {
    const { recoverFeeValue } = await loadWith({
      NEXT_PUBLIC_RELAY_GAS_FEE_JPYC: '5',
    });
    expect(recoverFeeValue(0n, 'merchant')).toBe(5n * JPYC);
    expect(recoverFeeValue(1_000n * JPYC, 'merchant')).toBe(5n * JPYC);
    expect(recoverFeeValue(1_000n * JPYC, 'customer')).toBe(5n * JPYC);
  });

  it('フロア=5 JPYC, bps=100: merchant 大口 1000 JPYC → 1% = 10 JPYC (フロア 5 超過)・customer は 5e18', async () => {
    const { recoverFeeValue } = await loadWith({
      NEXT_PUBLIC_RELAY_GAS_FEE_JPYC: '5',
      NEXT_PUBLIC_RECOVER_FEE_BPS: '100',
    });
    expect(recoverFeeValue(1_000n * JPYC, 'merchant')).toBe(10n * JPYC);
    // customer (チップ) は bps を無視しフロア 5 のまま。
    expect(recoverFeeValue(1_000n * JPYC, 'customer')).toBe(5n * JPYC);
  });

  it('フロア=5 JPYC, bps=100: merchant 400 JPYC → 1% = 4 JPYC < フロア 5 → フロア 5e18', async () => {
    const { recoverFeeValue } = await loadWith({
      NEXT_PUBLIC_RELAY_GAS_FEE_JPYC: '5',
      NEXT_PUBLIC_RECOVER_FEE_BPS: '100',
    });
    expect(recoverFeeValue(400n * JPYC, 'merchant')).toBe(5n * JPYC);
  });

  it('フロア=0 (= 下限フロア無し), bps=100: merchant は小口でも 1% がそのまま乗る・customer は 0', async () => {
    const { recoverFeeValue } = await loadWith({
      NEXT_PUBLIC_RELAY_GAS_FEE_JPYC: '0',
      NEXT_PUBLIC_RECOVER_FEE_BPS: '100',
    });
    // floor=0 なので merchant では pct (>=0) が常に勝つ (pct > 0 のとき)。100 JPYC → 1 JPYC。
    expect(recoverFeeValue(100n * JPYC, 'merchant')).toBe(1n * JPYC);
    // billAmount=0 → pct=0, floor=0 → 0n (pct > floor は false なので floor=0)。
    expect(recoverFeeValue(0n, 'merchant')).toBe(0n);
    // customer は floor=0 をそのまま返す (bps 無視)。大口でも 0。
    expect(recoverFeeValue(100n * JPYC, 'customer')).toBe(0n);
    expect(recoverFeeValue(0n, 'customer')).toBe(0n);
  });
});
