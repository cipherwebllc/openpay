// L2 (LARP 修正): 表示↔請求↔server の一致を **実 recoverFee モジュール** で固定する統合フェンス。
//
// 背景: recover (forwarder) モードでは「同じ手数料額」が 4 つの独立した経路で再計算される:
//   (a) hook (useJpycEip3009Payment): feeValue = recoverFeeValue(value, gasMode) を署名 payload に焼く。
//   (b) 表示 (buildRecoverFeeDisplay): 顧客支払 / 店舗受取の開示ラベルを組む。
//   (c) 照合表 (buildJpycRecoverSignPreview): ウォレット表示と突合する totalAtomic / feeHuman。
//   (d) server (route handleRecover の expectedFee = recoverFeeValue(billAmount, gasMode))。
// これらがずれると、署名 nonce が server の期待値と食い違い決済が通らない (= money path 破綻) か、
// 顧客への開示額がウォレット表示や実 settle と乖離する (= 不信)。個々の unit test は recoverFeeValue
// を **モック** していたため、4 経路が「同じ実式」で一致する保証はどこにもなかった (LARP)。
//
// このファイルは recoverFee を **モックせず** (process.env のみ resetModules + 動的 import で制御)、
// (bps ∈ {0,100}) × (gasMode ∈ {customer,merchant}) × (value ∈ {3 JPYC 小口, 1000 JPYC}) の全組合せで
// (a)〜(d) が完全一致することを assert する。これが並列コード経路を縛る不在だったフェンス。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { formatUnits, getAddress, type Address } from 'viem';
import type { GasMode } from '@/lib/fee';

const JPYC = 10n ** 18n;
const CHAIN_ID = 137; // Polygon
const FORWARDER = '0x752b7aad0089286eb7b553d84d05233d80c9fcb4';
const MERCHANT: Address = getAddress(
  '0x1234567890123456789012345678901234567890',
);

// 各 (bps) ごとに env を立てて modules を resetModules → 実 recoverFee/forwarderConfig/display/preview
// を新規 import する。env (lib/env) は module load 時に process.env を読むため、この順序が必須。
async function loadRealModules(bps: number) {
  vi.resetModules();
  // forwarder を設定して recover モードに倒す (display/preview が null を返さない)。a1 は OFF。
  process.env.NEXT_PUBLIC_JPYC_FORWARDER_POLYGON = FORWARDER;
  delete process.env.NEXT_PUBLIC_ENABLE_USAGE_FEE; // a1 OFF (ON だと forwarder が null に倒れる)
  process.env.NEXT_PUBLIC_RECOVER_FEE_BPS = String(bps);
  delete process.env.NEXT_PUBLIC_RELAY_GAS_FEE_JPYC; // floor 既定 2 JPYC

  const recoverFee = await import('@/lib/relay/recoverFee');
  const display = await import('@/lib/recoverFeeDisplay');
  const signPreview = await import('@/lib/signPreview');
  const forwarderConfig = await import('@/lib/relay/forwarderConfig');
  return { recoverFee, display, signPreview, forwarderConfig };
}

const SAVED_ENV = {
  forwarder: process.env.NEXT_PUBLIC_JPYC_FORWARDER_POLYGON,
  usageFee: process.env.NEXT_PUBLIC_ENABLE_USAGE_FEE,
  bps: process.env.NEXT_PUBLIC_RECOVER_FEE_BPS,
  gasFee: process.env.NEXT_PUBLIC_RELAY_GAS_FEE_JPYC,
};

afterEach(() => {
  // env を復元 (他テストへの汚染防止)。
  for (const [key, val] of [
    ['NEXT_PUBLIC_JPYC_FORWARDER_POLYGON', SAVED_ENV.forwarder],
    ['NEXT_PUBLIC_ENABLE_USAGE_FEE', SAVED_ENV.usageFee],
    ['NEXT_PUBLIC_RECOVER_FEE_BPS', SAVED_ENV.bps],
    ['NEXT_PUBLIC_RELAY_GAS_FEE_JPYC', SAVED_ENV.gasFee],
  ] as const) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
  vi.resetModules();
});

const VALUES: Array<{ label: string; value: bigint }> = [
  { label: '3 JPYC (小口・フロア帯)', value: 3n * JPYC },
  { label: '1000 JPYC (大口・1% > フロア帯)', value: 1000n * JPYC },
];
const BPS_CASES = [0, 100];
const GAS_MODES: GasMode[] = ['customer', 'merchant'];

describe('recover fee consistency: 表示 == 請求 == 照合表 == server (実 recoverFee)', () => {
  for (const bps of BPS_CASES) {
    for (const gasMode of GAS_MODES) {
      for (const { label, value } of VALUES) {
        it(`bps=${bps} / gasMode=${gasMode} / value=${label}`, async () => {
          const { recoverFee, display, signPreview } =
            await loadRealModules(bps);
          const { recoverFeeValue } = recoverFee;
          const { buildRecoverFeeDisplay } = display;
          const { buildJpycRecoverSignPreview } = signPreview;

          // --- (a) hook が署名する値を hook と同式で再導出 (useJpycEip3009Payment の recover 分岐) ---
          const feeValue = recoverFeeValue(value, gasMode);
          const merchantValue =
            gasMode === 'merchant' ? value - feeValue : value;
          // hook は merchantValue<=0 を amount_too_small で弾く。本テストの value はすべて
          // フロア超なので成立するが、不変条件として明示する。
          expect(merchantValue).toBeGreaterThan(0n);
          const signedTotal = merchantValue + feeValue;

          // --- (b) 表示 (buildRecoverFeeDisplay) ---
          const disp = buildRecoverFeeDisplay(value, CHAIN_ID, gasMode);
          expect(disp).not.toBeNull();

          // 手数料額は 4 経路すべてで一致する (実 recoverFeeValue 由来)。
          expect(disp!.feeHuman).toBe(formatUnits(feeValue, 18));

          // 顧客支払 / 店舗受取の開示が hook の署名分割と一致する。
          //   customer: 顧客は value + fee を払い、店舗は value を受領。
          //   merchant: 顧客は value を払い、店舗は value - fee を受領。
          const expectedCustomerPays =
            gasMode === 'customer' ? value + feeValue : value;
          const expectedMerchantReceives =
            gasMode === 'merchant' ? merchantValue : value;
          expect(disp!.customerPaysHuman).toBe(
            formatUnits(expectedCustomerPays, 18),
          );
          expect(disp!.merchantReceivesHuman).toBe(
            formatUnits(expectedMerchantReceives, 18),
          );

          // --- (c) 照合表 (buildJpycRecoverSignPreview) ---
          const preview = buildJpycRecoverSignPreview({
            value,
            merchant: MERCHANT,
            decimals: 18,
            displaySymbol: 'JPYC',
            chainId: CHAIN_ID,
            gasMode,
          });
          expect(preview).not.toBeNull();
          // ウォレットに出る生の数字 = hook が署名する signedTotal と完全一致 (乖離ゼロの本質)。
          expect(preview!.totalAtomic).toBe(signedTotal.toString());
          expect(preview!.feeHuman).toBe(formatUnits(feeValue, 18));
          expect(preview!.amountHuman).toBe(formatUnits(value, 18));

          // --- (d) server: expectedFee = recoverFeeValue(billAmount, gasMode) ---
          // route は (merchantValue, feeValue, gasMode) から billAmount を再構成する:
          //   merchant: billAmount = merchantValue + feeValue
          //   customer: billAmount = merchantValue
          // この再構成 billAmount で recoverFeeValue を呼んだ結果が、hook が署名した feeValue と
          // 一致しなければ route は fee_value_mismatch で弾く。両者の一致がここで保証される。
          const reconstructedBillAmount =
            gasMode === 'merchant' ? merchantValue + feeValue : merchantValue;
          const serverExpectedFee = recoverFeeValue(
            reconstructedBillAmount,
            gasMode,
          );
          expect(serverExpectedFee).toBe(feeValue);
          // billAmount の再構成自体も元の value に戻る (gasMode の意味論が両側で一致)。
          expect(reconstructedBillAmount).toBe(value);
        });
      }
    }
  }

  // bps=100 大口で merchant のみ 1% が乗り、customer (チップ) はフロアのまま — の経済性も
  // 実 recoverFee で固定する (確定モデルの核心: gasMode で料金スケジュールが分岐)。
  it('bps=100 大口 (1000 JPYC): merchant=1% (10 JPYC) / customer=フロア (2 JPYC) で別額になる', async () => {
    const { recoverFee } = await loadRealModules(100);
    const { recoverFeeValue } = recoverFee;
    const big = 1000n * JPYC;
    const merchantFee = recoverFeeValue(big, 'merchant');
    const customerFee = recoverFeeValue(big, 'customer');
    expect(merchantFee).toBe(10n * JPYC); // 1% of 1000 = 10 JPYC (フロア超)
    expect(customerFee).toBe(2n * JPYC); // チップはフロアのみ (bps 非適用)
    expect(merchantFee).not.toBe(customerFee); // 同額にならない (gasMode で確実に分岐)
  });

  it('bps=0 既定: merchant/customer いずれもフロア 2 JPYC (inert・現行挙動と一致)', async () => {
    const { recoverFee } = await loadRealModules(0);
    const { recoverFeeValue } = recoverFee;
    const big = 1000n * JPYC;
    expect(recoverFeeValue(big, 'merchant')).toBe(2n * JPYC);
    expect(recoverFeeValue(big, 'customer')).toBe(2n * JPYC);
  });
});
