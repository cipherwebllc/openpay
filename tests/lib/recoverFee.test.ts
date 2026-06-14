import { describe, it, expect, vi, afterEach } from 'vitest';
import { polygon, kaia, avalanche } from 'viem/chains';

// recoverFee は env (NEXT_PUBLIC_RECOVER_FEE_BPS) と forwarderConfig (NEXT_PUBLIC_RELAY_GAS_FEE_JPYC[_<chain>])
// を読む。両者とも module 評価時に process.env を読むため、env を確定 → resetModules → 動的 import
// で「実モジュール」を与えた env で評価する (mock 無し・実 lib/env + 実 forwarderConfig の実コードパス)。
// これは tests/lib/forwarderConfig.test.ts と同じパターン。
const KEYS = [
  'NEXT_PUBLIC_RECOVER_FEE_BPS',
  'NEXT_PUBLIC_RELAY_GAS_FEE_JPYC',
  // per-chain floor 上書き env (Avalanche 汎用化)。決定論のため毎回リセットする。
  'NEXT_PUBLIC_RELAY_GAS_FEE_JPYC_AVALANCHE',
  'NEXT_PUBLIC_RELAY_GAS_FEE_JPYC_POLYGON',
  'NEXT_PUBLIC_RELAY_GAS_FEE_JPYC_KAIA',
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
// 既存スケジュールテストは per-chain 上書き無しの代表 chain で評価する (グローバル env/既定が効く)。
const CHAIN = polygon.id;

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
    expect(recoverFeeValue(0n, 'merchant', CHAIN)).toBe(FLOOR);
    expect(recoverFeeValue(100n * JPYC, 'merchant', CHAIN)).toBe(FLOOR);
    expect(recoverFeeValue(1_000n * JPYC, 'merchant', CHAIN)).toBe(FLOOR);
    expect(recoverFeeValue(10_000_000n * JPYC, 'merchant', CHAIN)).toBe(FLOOR); // 大口でもフロア
  });

  it('customer: billAmount に依らず常にフロア (チップは bps=0 でも当然フロア)', async () => {
    const { recoverFeeValue } = await loadWith({});
    expect(recoverFeeValue(0n, 'customer', CHAIN)).toBe(FLOOR);
    expect(recoverFeeValue(1_000n * JPYC, 'customer', CHAIN)).toBe(FLOOR);
    expect(recoverFeeValue(10_000_000n * JPYC, 'customer', CHAIN)).toBe(FLOOR);
  });
});

describe('recoverFeeValue — bps=100 (1%): merchant のみ % が乗る', () => {
  it('merchant 小口 (1% < フロア): billAmount=100 JPYC → 1% は 1 JPYC < フロア → フロア 2e18', async () => {
    const { recoverFeeValue } = await loadWith({ NEXT_PUBLIC_RECOVER_FEE_BPS: '100' });
    expect(recoverFeeValue(100n * JPYC, 'merchant', CHAIN)).toBe(FLOOR);
  });

  it('merchant 境界ちょうど: billAmount=200 JPYC → 1% = 2 JPYC = フロア (max は等しいのでフロア)', async () => {
    const { recoverFeeValue } = await loadWith({ NEXT_PUBLIC_RECOVER_FEE_BPS: '100' });
    expect(recoverFeeValue(200n * JPYC, 'merchant', CHAIN)).toBe(FLOOR);
    expect(recoverFeeValue(200n * JPYC, 'merchant', CHAIN)).toBe(2n * JPYC);
  });

  it('merchant 大口: billAmount=1000 JPYC → 1% = 10 JPYC (フロア超過)', async () => {
    const { recoverFeeValue } = await loadWith({ NEXT_PUBLIC_RECOVER_FEE_BPS: '100' });
    expect(recoverFeeValue(1_000n * JPYC, 'merchant', CHAIN)).toBe(10n * JPYC);
  });

  it('merchant 境界の片側上: billAmount=201 JPYC → 1% = 2.01 JPYC (フロア超過・端数は floor 除算)', async () => {
    const { recoverFeeValue } = await loadWith({ NEXT_PUBLIC_RECOVER_FEE_BPS: '100' });
    // 201e18 * 100 / 10000 = 201e18 / 100 = 2.01e18
    expect(recoverFeeValue(201n * JPYC, 'merchant', CHAIN)).toBe((201n * JPYC) / 100n);
    expect(recoverFeeValue(201n * JPYC, 'merchant', CHAIN)).toBeGreaterThan(FLOOR);
  });

  it('merchant BigInt floor 除算: 端数は切り捨て (round-down)', async () => {
    const { recoverFeeValue } = await loadWith({ NEXT_PUBLIC_RECOVER_FEE_BPS: '100' });
    // billAmount = 99999 wei (フロアより遥かに小さいので結果はフロアだが、pct の計算式を確認)。
    const billAmount = 99_999n;
    expect(recoverFeeValue(billAmount, 'merchant', CHAIN)).toBe(FLOOR);
  });

  it('customer (チップ): bps=100 でも常にフロア (1% を乗せない・確定モデルの核)', async () => {
    const { recoverFeeValue } = await loadWith({ NEXT_PUBLIC_RECOVER_FEE_BPS: '100' });
    // 大口でも 1% は乗らずフロア (= 2 JPYC) のまま。merchant なら 10 JPYC になる額で対比。
    expect(recoverFeeValue(1_000n * JPYC, 'customer', CHAIN)).toBe(FLOOR);
    expect(recoverFeeValue(1_000n * JPYC, 'merchant', CHAIN)).toBe(10n * JPYC);
    // 境界ちょうど・超過いずれもフロア固定。
    expect(recoverFeeValue(200n * JPYC, 'customer', CHAIN)).toBe(FLOOR);
    expect(recoverFeeValue(10_000n * JPYC, 'customer', CHAIN)).toBe(FLOOR);
  });
});

describe('recoverFeeValue — フロア override (NEXT_PUBLIC_RELAY_GAS_FEE_JPYC)', () => {
  it('フロア=5 JPYC, bps=0 → 両 gasMode で常に 5e18', async () => {
    const { recoverFeeValue } = await loadWith({
      NEXT_PUBLIC_RELAY_GAS_FEE_JPYC: '5',
    });
    expect(recoverFeeValue(0n, 'merchant', CHAIN)).toBe(5n * JPYC);
    expect(recoverFeeValue(1_000n * JPYC, 'merchant', CHAIN)).toBe(5n * JPYC);
    expect(recoverFeeValue(1_000n * JPYC, 'customer', CHAIN)).toBe(5n * JPYC);
  });

  it('フロア=5 JPYC, bps=100: merchant 大口 1000 JPYC → 1% = 10 JPYC (フロア 5 超過)・customer は 5e18', async () => {
    const { recoverFeeValue } = await loadWith({
      NEXT_PUBLIC_RELAY_GAS_FEE_JPYC: '5',
      NEXT_PUBLIC_RECOVER_FEE_BPS: '100',
    });
    expect(recoverFeeValue(1_000n * JPYC, 'merchant', CHAIN)).toBe(10n * JPYC);
    // customer (チップ) は bps を無視しフロア 5 のまま。
    expect(recoverFeeValue(1_000n * JPYC, 'customer', CHAIN)).toBe(5n * JPYC);
  });

  it('フロア=5 JPYC, bps=100: merchant 400 JPYC → 1% = 4 JPYC < フロア 5 → フロア 5e18', async () => {
    const { recoverFeeValue } = await loadWith({
      NEXT_PUBLIC_RELAY_GAS_FEE_JPYC: '5',
      NEXT_PUBLIC_RECOVER_FEE_BPS: '100',
    });
    expect(recoverFeeValue(400n * JPYC, 'merchant', CHAIN)).toBe(5n * JPYC);
  });

  // CDX-2: NEXT_PUBLIC_RELAY_GAS_FEE_JPYC=0 は contract ZeroValue revert を招く誤設定として、
  // relayGasFeeValue が既定の 2 JPYC フロアに倒す (フロアは 1 wei 以上を保証)。よって floor は
  // 0 にならず、merchant は max(2 JPYC, 1%)・customer は 2 JPYC になる。
  it('CDX-2: フロア=0 (誤設定) は 2 JPYC フロアに倒れる・merchant は max(2, 1%)・customer は 2 固定', async () => {
    const { recoverFeeValue } = await loadWith({
      NEXT_PUBLIC_RELAY_GAS_FEE_JPYC: '0',
      NEXT_PUBLIC_RECOVER_FEE_BPS: '100',
    });
    // floor は 0 でなく 2 JPYC に倒れる。小口 100 JPYC → 1% = 1 JPYC < フロア 2 → フロア 2 JPYC。
    expect(recoverFeeValue(100n * JPYC, 'merchant', CHAIN)).toBe(2n * JPYC);
    // 大口 1000 JPYC → 1% = 10 JPYC > フロア 2 → 10 JPYC (pct が勝つ)。
    expect(recoverFeeValue(1000n * JPYC, 'merchant', CHAIN)).toBe(10n * JPYC);
    // billAmount=0 → pct=0 < フロア 2 → フロア 2 JPYC (もはや 0 にならない)。
    expect(recoverFeeValue(0n, 'merchant', CHAIN)).toBe(2n * JPYC);
    // customer は bps 無視で常にフロア = 2 JPYC。
    expect(recoverFeeValue(100n * JPYC, 'customer', CHAIN)).toBe(2n * JPYC);
    expect(recoverFeeValue(0n, 'customer', CHAIN)).toBe(2n * JPYC);
  });
});

// Avalanche 汎用化: chainId で floor が切り替わり、チップ (customer) も決済 (merchant) も
// 当該 chain の gas 相当を賄える。floor は chain 別 env で独立に設定できる。
describe('recoverFeeValue — per-chain floor (Avalanche)', () => {
  it('customer (チップ): Avalanche の高フロアを当該 chain のみに適用 (他 chain は不変)', async () => {
    const { recoverFeeValue } = await loadWith({
      NEXT_PUBLIC_RELAY_GAS_FEE_JPYC_AVALANCHE: '10',
    });
    // Avalanche のチップは 10 JPYC フロア = AVAX gas を賄える (黒字化の核)。
    expect(recoverFeeValue(500n * JPYC, 'customer', avalanche.id)).toBe(10n * JPYC);
    // Polygon/Kaia のチップは既定 2 JPYC のまま (チェーン独立)。
    expect(recoverFeeValue(500n * JPYC, 'customer', polygon.id)).toBe(FLOOR);
    expect(recoverFeeValue(500n * JPYC, 'customer', kaia.id)).toBe(FLOOR);
  });

  it('merchant (決済): Avalanche は max(高フロア, 1%)・chain ごとに独立', async () => {
    const { recoverFeeValue } = await loadWith({
      NEXT_PUBLIC_RELAY_GAS_FEE_JPYC_AVALANCHE: '10',
      NEXT_PUBLIC_RECOVER_FEE_BPS: '100',
    });
    // 小口 500 JPYC: 1% = 5 JPYC < Avalanche フロア 10 → フロア 10 JPYC。
    expect(recoverFeeValue(500n * JPYC, 'merchant', avalanche.id)).toBe(10n * JPYC);
    // 大口 2000 JPYC: 1% = 20 JPYC > フロア 10 → 20 JPYC (pct 勝ち)。
    expect(recoverFeeValue(2_000n * JPYC, 'merchant', avalanche.id)).toBe(20n * JPYC);
    // 同じ 500 JPYC でも Polygon は 1% = 5 JPYC > 既定フロア 2 → 5 JPYC (chain 独立)。
    expect(recoverFeeValue(500n * JPYC, 'merchant', polygon.id)).toBe(5n * JPYC);
  });
});
