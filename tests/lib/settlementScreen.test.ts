// 復元した支払いの確定の判定 (lib/paymentFlowGuards/restoredSettlement・第 10 回レビュー H-S) に渡す「画面の形」のうち、
// 鍵を付けない画面 (/pay・/tip) の形と、3 画面で共通の「別の token の address の組」(lib/paymentFlowGuards/settlementScreen)。
// token の表はモジュールの読み込み時に決まるので、env を変えたら読み直す (tests/lib/restoredSettlement.envDrift.test.ts と
// 同じ形)。
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';

const hold = vi.hoisted(() => ({ usdcOverrides: {} as Record<string, string> }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  const withUsdc = (overrides: typeof actual.env.testnetTokenOverrides) => ({
    ...overrides,
    usdc: { ...overrides.usdc, ...hold.usdcOverrides },
  });
  return {
    ...actual,
    env: {
      ...actual.env,
      get testnetTokenOverrides() {
        return withUsdc(actual.env.testnetTokenOverrides);
      },
      get mainnetTokenOverrides() {
        return withUsdc(actual.env.mainnetTokenOverrides);
      },
    },
  };
});

const MERCHANT: Address = '0x2222222222222222222222222222222222222222';
const PAID = 300n * 10n ** 18n;

// 同じ mock module を同じ tick に並べて読み込むと 2 本目以降が実物になる (vitest 5) ので、1 つずつ読む。
async function load() {
  vi.resetModules();
  const screens = await import('@/lib/paymentFlowGuards/settlementScreen');
  const settlement = await import('@/lib/paymentFlowGuards/restoredSettlement');
  const lookup = await import('@/lib/orderPaidLookup');
  const tokens = await import('@/lib/tokens');
  return { screens, settlement, lookup, tokens };
}

afterEach(() => {
  hold.usdcOverrides = {};
});

describe('unkeyedSettlementScreen — 鍵を付けない画面 (/pay・/tip) の形', () => {
  it('金額ありの QR: 受取先・URL の額・上乗せの形なし・別の token の address・鍵を付けない', async () => {
    const m = await load();
    expect(m.screens.unkeyedSettlementScreen(MERCHANT, 'jpyc', PAID)).toEqual({
      merchant: MERCHANT,
      amount: PAID,
      customerFeeOnTop: false,
      otherTokenAddresses: m.tokens.deploymentsForSymbol('usdc').map((deployment) => deployment.address),
      contextKeyed: false,
    });
  });

  it('額を入力で決める画面 (/pay の金額なしの QR・/tip): 額は null のまま渡る (比べない)', async () => {
    const m = await load();
    const screen = m.screens.unkeyedSettlementScreen(MERCHANT, 'usdc', null);
    expect(screen.amount).toBeNull();
    expect(screen.otherTokenAddresses).toEqual(m.tokens.deploymentsForSymbol('jpyc').map((deployment) => deployment.address));
    expect(screen.contextKeyed).toBe(false);
    expect(screen.customerFeeOnTop).toBe(false);
  });

  // @handle のページのチップ: 受取先は handle の設定で決まり、払った後に変えられるので渡さない (null = 比べない)。
  it('受取先が設定で決まる画面: 受取先は null のまま渡る。受取先だけが違う記録は一致のまま・別の token と鍵は不一致', async () => {
    const m = await load();
    const screen = m.screens.unkeyedSettlementScreen(null, 'jpyc', null);
    expect(screen).toEqual({
      merchant: null,
      amount: null,
      customerFeeOnTop: false,
      otherTokenAddresses: m.tokens.deploymentsForSymbol('usdc').map((deployment) => deployment.address),
      contextKeyed: false,
    });
    const jpyc = m.tokens.deploymentsForSymbol('jpyc')[0];
    const usdc = m.tokens.deploymentsForSymbol('usdc')[0];
    const relayRecord = { merchant: MERCHANT, merchantValue: PAID.toString(), feeValue: '0' };
    expect(m.settlement.isForeignSettlement(screen, { kind: 'relay', bound: false, record: relayRecord })).toBe(false);
    expect(
      m.settlement.isForeignSettlement(screen, { kind: 'relay', bound: false, record: { ...relayRecord, orderLinkKey: `0x${'7'.repeat(64)}` } }),
    ).toBe(true);
    expect(
      m.settlement.isForeignSettlement(screen, { kind: 'gasless', record: { tokenAddress: jpyc.address, merchant: MERCHANT, saleAmount: PAID } }),
    ).toBe(false);
    expect(
      m.settlement.isForeignSettlement(screen, { kind: 'gasless', record: { tokenAddress: usdc.address, merchant: MERCHANT, saleAmount: PAID } }),
    ).toBe(true);
  });

  it('別の token の address の組は /checkout の画面の形と同じ作り方 (同じ値)', async () => {
    const m = await load();
    for (const token of ['jpyc', 'usdc'] as const) {
      const checkout = m.lookup.checkoutSettlementScreen({
        to: MERCHANT,
        token,
        gas: 'customer',
        items: [{ name: 'チケット', qty: 1, price: '300' }],
      });
      expect(m.screens.unkeyedSettlementScreen(MERCHANT, token, null).otherTokenAddresses).toEqual(checkout.otherTokenAddresses);
      expect(m.screens.otherTokenAddresses(token)).toEqual(checkout.otherTokenAddresses);
    }
  });
});

describe('otherTokenAddresses — 別の token (USDC) の address の上書きが、この token (JPYC) の address と重なったとき', () => {
  it('重なる address は「どちらの token か決められない」ので除く: 同じ JPYC の支払いは /pay でも /tip でも一致のまま', async () => {
    const before = await load();
    const jpyc = before.tokens.deploymentsForSymbol('jpyc')[0];
    const record = { tokenAddress: jpyc.address, merchant: MERCHANT, saleAmount: PAID };
    expect(before.screens.otherTokenAddresses('jpyc')).not.toContain(jpyc.address);

    // 無関係な USDC (Base) の上書きを、払った JPYC の address にする。
    hold.usdcOverrides = { base: jpyc.address };
    const after = await load();
    expect(after.tokens.deploymentsForSymbol('usdc').map((deployment) => deployment.address)).toContain(jpyc.address);
    expect(after.screens.otherTokenAddresses('jpyc')).not.toContain(jpyc.address);
    // USDC の画面から見ても、重なった address は JPYC と決められない = 除く。
    expect(after.screens.otherTokenAddresses('usdc')).not.toContain(jpyc.address);
    for (const amount of [PAID, null]) {
      const screen = after.screens.unkeyedSettlementScreen(MERCHANT, 'jpyc', amount);
      expect(after.settlement.isForeignSettlement(screen, { kind: 'standard', record })).toBe(false);
      expect(after.settlement.isForeignSettlement(screen, { kind: 'gasless', record })).toBe(false);
    }
  });

  it('重ならない別の token の address (本当に USDC) の記録は、額を比べない画面でも不一致', async () => {
    hold.usdcOverrides = { base: '0x5555555555555555555555555555555555555555' };
    const m = await load();
    const screen = m.screens.unkeyedSettlementScreen(MERCHANT, 'jpyc', null);
    expect(screen.otherTokenAddresses).toContain('0x5555555555555555555555555555555555555555');
    for (const kind of ['standard', 'gasless'] as const) {
      expect(
        m.settlement.isForeignSettlement(screen, {
          kind,
          record: { tokenAddress: '0x5555555555555555555555555555555555555555', merchant: MERCHANT, saleAmount: PAID },
        }),
      ).toBe(true);
    }
  });
});

describe('settlementScreen.ts は /pay・/tip・@handle の First Load JS に載る', () => {
  it('実行時の import は lib/tokens だけ (どの画面も既に読んでいる)・viem を読まない', () => {
    const source = readFileSync('lib/paymentFlowGuards/settlementScreen.ts', 'utf8');
    const runtimeImports = source
      .split('\n')
      .filter((line) => /^import\b/.test(line) && !/^import type\b/.test(line));
    expect(runtimeImports).toHaveLength(1);
    expect(runtimeImports[0]).toMatch(/from '@\/lib\/tokens';$/);
    expect(source).not.toMatch(/from 'viem'/);
  });
});
