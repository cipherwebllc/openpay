// 料金ページ (/pricing) の計算例のフェンス (plans/pricing-page.md §7.1 ① ③)。
//
// ① 三面一致 (legal-check 5): 計算例 (lib/pricingExamples.ts) が、実際の分配の関数
//    (recoverFeeValue + feeSplit・mobileOrderBreakdown・x402FeeBreakdown・STORE_DEVICE_FEE_WEI) と同じ値になる。
//    recoverFee と x402 の設定は module の評価時に process.env を読むので、関係する env を全部消して
//    開示値だけを立て直し → resetModules → 動的 import で本物の module を評価する。チェーン別の最低額の
//    env (NEXT_PUBLIC_RELAY_GAS_FEE_JPYC_<CHAIN>) が手元や CI に残っていると、そちらが勝つので必ず消す
//    (tests/lib/recoverFee.test.ts の KEYS と同じ 5 つ)。
// ③ 網羅: lib/legal.ts の DISCLOSED_* をすべて料金ページが使うか、除外の理由を書いてあること。
//    CSV 24時間パスが本番で点灯したら、料金ページにも載せること。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { avalanche, kaia, polygon } from 'viem/chains';
import {
  DISCLOSED_RECOVER_FEE,
  DISCLOSED_STORE_GAS_WALLET,
  DISCLOSED_X402_FEE,
} from '@/lib/legal';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const RECOVER_ENV_KEYS = [
  'NEXT_PUBLIC_RECOVER_FEE_BPS',
  'NEXT_PUBLIC_RELAY_GAS_FEE_JPYC',
  'NEXT_PUBLIC_RELAY_GAS_FEE_JPYC_POLYGON',
  'NEXT_PUBLIC_RELAY_GAS_FEE_JPYC_KAIA',
  'NEXT_PUBLIC_RELAY_GAS_FEE_JPYC_AVALANCHE',
] as const;
const X402_ENV_KEYS = ['X402_FEE_BPS', 'X402_FEE_FLOOR_JPYC'] as const;
const ALL_KEYS = [...RECOVER_ENV_KEYS, ...X402_ENV_KEYS];

// 開示した最低額を約束した 3 チェーン (lib/legal.ts の DISCLOSED_FLOOR_CHAINS と同じ)。
const CHAINS = [polygon.id, kaia.id, avalanche.id];

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ALL_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  // 開示値だけを立てる (CI の既定は bps 0 なので、立てないと 1% がかからない)。
  process.env.NEXT_PUBLIC_RECOVER_FEE_BPS = String(DISCLOSED_RECOVER_FEE.percentFromJulyBps);
  process.env.NEXT_PUBLIC_RELAY_GAS_FEE_JPYC = String(DISCLOSED_RECOVER_FEE.floorJpyc);
  vi.resetModules();
});

afterEach(() => {
  for (const key of ALL_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.resetModules();
});

async function loadReal() {
  const [recoverFee, mobileOrderFee, x402Fee, x402Config, storeDevice, examples] = await Promise.all([
    import('@/lib/relay/recoverFee'),
    import('@/lib/mobileOrderFee'),
    import('@/lib/x402/fee'),
    import('@/lib/x402/facilitatorConfig'),
    import('@/lib/storeDevicePayment'),
    import('@/lib/pricingExamples'),
  ]);
  return { recoverFee, mobileOrderFee, x402Fee, x402Config, storeDevice, examples };
}

describe('① 計算例 = 実際の分配の計算 (三面一致)', () => {
  it('ガスレス決済 (決済QR・レジ・JPYC): recoverFeeValue (merchant) と feeSplit に 3 チェーンとも一致する', async () => {
    const { recoverFee, mobileOrderFee, examples } = await loadReal();
    expect(recoverFee.recoverFeeBps()).toBe(DISCLOSED_RECOVER_FEE.percentFromJulyBps);
    for (const amount of examples.PRICING_EXAMPLE_AMOUNTS.gasless) {
      const e = examples.gaslessExample(amount);
      for (const chainId of CHAINS) {
        const fee = recoverFee.recoverFeeValue(e.amountWei, 'merchant', chainId);
        expect(e.feeWei, `${amount} JPYC on ${chainId}`).toBe(fee);
        const split = mobileOrderFee.feeSplit(e.amountWei, fee, 'merchant');
        expect(e.payerPaysWei).toBe(split.customerPays);
        expect(e.receiverGetsWei).toBe(split.merchantReceives);
      }
    }
  });

  it('ガスレス決済を使えない境界 = 最低額 (決済額 ≤ 利用料で、お店の受け取りが 0 になる)', async () => {
    const { recoverFee, mobileOrderFee, examples } = await loadReal();
    const edge = examples.gaslessUnavailableUpToWei();
    expect(edge).toBe(BigInt(DISCLOSED_RECOVER_FEE.floorJpyc) * 10n ** 18n);
    for (const chainId of CHAINS) {
      const atEdge = recoverFee.recoverFeeValue(edge, 'merchant', chainId);
      // buildRecoverFeeDisplay の tooSmall (= 決済額 ≤ 利用料) と同じ条件。
      expect(edge <= atEdge).toBe(true);
      expect(mobileOrderFee.feeSplit(edge, atEdge, 'merchant').merchantReceives).toBe(0n);
      const above = edge + 1n;
      expect(above <= recoverFee.recoverFeeValue(above, 'merchant', chainId)).toBe(false);
    }
  });

  it('モバイル注文: mobileOrderBreakdown と全項目一致する (店内・券売機 / 事前注文のお店払い・お客様の上乗せ)', async () => {
    const { mobileOrderFee, examples } = await loadReal();
    for (const amount of examples.PRICING_EXAMPLE_AMOUNTS.mobile) {
      const { storefront, preorder } = examples.mobileExample(amount);
      const realStorefront = mobileOrderFee.mobileOrderBreakdown(storefront.amountWei, 'storefront', undefined);
      expect([storefront.payerPaysWei, storefront.receiverGetsWei, storefront.feeWei]).toEqual([
        realStorefront.customerPays,
        realStorefront.merchantReceives,
        realStorefront.feeAmount,
      ]);
      const realPreorder = mobileOrderFee.mobileOrderBreakdown(preorder.amountWei, 'preorder', 'merchant');
      expect([preorder.payerPaysWei, preorder.receiverGetsWei, preorder.feeWei]).toEqual([
        realPreorder.customerPays,
        realPreorder.merchantReceives,
        realPreorder.feeAmount,
      ]);
      expect(storefront.floorApplied || preorder.floorApplied).toBe(false);
    }
    const split = examples.preorderSplit(examples.PRICING_EXAMPLE_AMOUNTS.preorderSplit);
    for (const [example, feePayer] of [
      [split.customerAdds, 'customer'],
      [split.shopPays, 'merchant'],
    ] as const) {
      const real = mobileOrderFee.mobileOrderBreakdown(example.amountWei, 'preorder', feePayer);
      expect([example.payerPaysWei, example.receiverGetsWei, example.feeWei]).toEqual([
        real.customerPays,
        real.merchantReceives,
        real.feeAmount,
      ]);
    }
  });

  it('デジタル商品 (x402・JPYC): x402FeeBreakdown と一致し、設定の既定が開示どおり', async () => {
    const { x402Fee, x402Config, examples } = await loadReal();
    expect(x402Config.x402FacilitatorConfig.feeBps).toBe(DISCLOSED_X402_FEE.bps);
    expect(x402Config.x402FacilitatorConfig.feeFloorWei).toBe(BigInt(DISCLOSED_X402_FEE.floorJpyc) * 10n ** 18n);
    for (const amount of examples.PRICING_EXAMPLE_AMOUNTS.digital) {
      const e = examples.digitalExample(amount);
      const real = x402Fee.x402FeeBreakdown(e.amountWei);
      expect([e.receiverGetsWei, e.feeWei, e.payerPaysWei]).toEqual([real.merchantValue, real.feeValue, real.total]);
    }
  });

  it('お店がガス代を肩代わりして送る: お客様 = 額 + STORE_DEVICE_FEE_WEI・お店 = 額', async () => {
    const { storeDevice, examples } = await loadReal();
    expect(storeDevice.STORE_DEVICE_FEE_WEI).toBe(BigInt(DISCLOSED_STORE_GAS_WALLET.feeWei));
    const e = examples.storeGasExample(examples.PRICING_EXAMPLE_AMOUNTS.storeGas);
    expect(e.feeWei).toBe(storeDevice.STORE_DEVICE_FEE_WEI);
    expect(e.payerPaysWei).toBe(e.amountWei + storeDevice.STORE_DEVICE_FEE_WEI);
    expect(e.receiverGetsWei).toBe(e.amountWei);
    // 例の額は受け渡しできる最低額以上 (それ未満の額は、この方法では送れない)。
    expect(e.amountWei >= storeDevice.STORE_DEVICE_MIN_AMOUNT_WEI).toBe(true);
  });

  it('表 A・C は「最低額が効く例」(先頭) と「効かない例」(2 つ目) を持つ (正本が変わって例が意味を失ったら落ちる)', async () => {
    const { examples } = await loadReal();
    const gasless = examples.PRICING_EXAMPLE_AMOUNTS.gasless.map(examples.gaslessExample);
    const digital = examples.PRICING_EXAMPLE_AMOUNTS.digital.map(examples.digitalExample);
    for (const rows of [gasless, digital]) {
      expect(rows[0].floorApplied).toBe(true);
      expect(rows[1].floorApplied).toBe(false);
    }
  });

  it('今の正本での値 (計画 §3.2 / レビュー R4 の実測と同じ)', async () => {
    const { examples } = await loadReal();
    const j = (wei: bigint) => examples.formatJpycWei(wei);
    expect(examples.PRICING_EXAMPLE_AMOUNTS.gasless.map(examples.gaslessExample).map((e) => [j(e.feeWei), j(e.receiverGetsWei)])).toEqual([
      ['2', '98'],
      ['10', '990'],
      ['100', '9,900'],
    ]);
    expect(examples.PRICING_EXAMPLE_AMOUNTS.mobile.map(examples.mobileExample).map((e) => [j(e.storefront.feeWei), j(e.preorder.feeWei)])).toEqual([
      ['1', '3'],
      ['10', '30'],
      ['100', '300'],
    ]);
    const split = examples.preorderSplit(1_000);
    expect([j(split.customerAdds.payerPaysWei), j(split.customerAdds.receiverGetsWei)]).toEqual(['1,030', '1,000']);
    expect([j(split.shopPays.payerPaysWei), j(split.shopPays.receiverGetsWei)]).toEqual(['1,000', '970']);
    expect(examples.PRICING_EXAMPLE_AMOUNTS.digital.map(examples.digitalExample).map((e) => [j(e.feeWei), j(e.payerPaysWei)])).toEqual([
      ['1', '51'],
      ['10', '1,010'],
      ['100', '10,100'],
    ]);
    expect(j(1n)).toBe('0.000000000000000001');
  });
});

describe('③ 網羅', () => {
  // 料金ページに載せない DISCLOSED_* と、その理由。新しい DISCLOSED_* を足したら、料金ページに載せるか、ここに理由を書く。
  const EXCLUDED: Record<string, string> = {
    DISCLOSED_LICENSE_NFT:
      '料金ではなく商品ポリシー (販売数・最低価格)。購入はデジタル商品の x402 (DISCLOSED_X402_FEE) に含まれる',
  };

  it('lib/legal.ts の DISCLOSED_* をすべて料金ページが使うか、除外の理由がある', async () => {
    const legal = await import('@/lib/legal');
    const names = Object.keys(legal).filter((key) => key.startsWith('DISCLOSED_'));
    expect(names.length).toBeGreaterThan(0);
    const source = ['lib/pricing.ts', 'lib/pricingExamples.ts']
      .map((file) => readFileSync(path.join(REPO_ROOT, file), 'utf8'))
      .join('\n');
    for (const name of names) {
      const used = new RegExp(`\\b${name}\\b`).test(source);
      expect(used || name in EXCLUDED, `${name} を料金ページに載せるか、除外の理由を書く`).toBe(true);
      if (name in EXCLUDED) expect(used, `${name} は除外としたのに使っている`).toBe(false);
    }
  });

  it('CSV 24時間パスが本番で点灯したら、料金ページにも載せる (今は未点灯なので載せない)', () => {
    const prodFlags = readFileSync(path.join(REPO_ROOT, 'e2e', 'prodFlags.env'), 'utf8');
    const csvPassLive = /^NEXT_PUBLIC_ENABLE_CSV_PASS=(1|true)\s*$/m.test(prodFlags);
    const source = readFileSync(path.join(REPO_ROOT, 'lib', 'pricing.ts'), 'utf8');
    expect(
      !csvPassLive || source.includes('CSV_PASS_PRICE_JPYC'),
      'CSV パスを点灯したら、料金ページに CSV_PASS_PRICE_JPYC から価格を載せる',
    ).toBe(true);
  });
});
