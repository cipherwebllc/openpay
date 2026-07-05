import { describe, it, expect } from 'vitest';
import {
  DISCLOSED_X402_FEE,
  x402FeeDisclosureDivergence,
} from '@/lib/legal';
import { x402FacilitatorConfig } from '@/lib/x402/facilitatorConfig';
import { x402FeeValue } from '@/lib/x402/fee';

const JPYC = (n: bigint): bigint => n * 10n ** 18n;

// 開示済み数値 (DISCLOSED_X402_FEE) ↔ 実装 (x402FacilitatorConfig / x402FeeValue) の乖離フェンス。
// env を変えて文書を改定し忘れた場合に CI で検出する (gas-recovery / モバイル注文と同型)。
describe('x402 開示フェンス', () => {
  it('既定 config が開示済みの bps / floor と一致 (乖離なし)', () => {
    expect(x402FacilitatorConfig.feeBps).toBe(DISCLOSED_X402_FEE.bps);
    expect(x402FacilitatorConfig.feeFloorWei).toBe(
      JPYC(BigInt(DISCLOSED_X402_FEE.floorJpyc)),
    );
    expect(
      x402FeeDisclosureDivergence(
        x402FacilitatorConfig.feeBps,
        x402FacilitatorConfig.feeFloorWei,
      ),
    ).toBeNull();
  });

  it('開示値 (1% / 最低 1 JPYC) が実 x402FeeValue の挙動と一致', () => {
    expect(DISCLOSED_X402_FEE.bps).toBe(100);
    expect(DISCLOSED_X402_FEE.floorJpyc).toBe(1);
    expect(x402FeeValue(JPYC(1000n))).toBe(JPYC(10n)); // 1%
    expect(x402FeeValue(JPYC(1n))).toBe(JPYC(1n)); // 下限 1 JPYC
  });

  it('乖離検知: bps / floor がずれると理由を返す', () => {
    expect(x402FeeDisclosureDivergence(50, JPYC(1n))).toMatch(/X402_FEE_BPS/);
    expect(x402FeeDisclosureDivergence(100, JPYC(5n))).toMatch(/floor/);
    expect(x402FeeDisclosureDivergence(100, JPYC(1n))).toBeNull();
  });
});
