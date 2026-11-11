// 復元した支払いの確定の判定 (lib/paymentFlowGuards/restoredSettlement・第 10 回レビュー H-S) は、受け付ける chain の組を
// 証明に使わない (Codex 第 2 回 MUST 2)。複数 chain の注文リンクの組は URL を読むときに env (chain の flag) で絞られるので、
// 払った後の deploy で chain を止めると、同じリンクの同じ支払いの記録がその組から外れる。chain の一覧はモジュールの読み込み
// 時に決まるので、flag を変えたら読み直す (tests/lib/storeDeviceChains.test.ts と同じ形)。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';

const hold = vi.hoisted(() => ({ enableJpycAvalanche: true }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableJpycAvalanche() {
        return hold.enableJpycAvalanche;
      },
    },
  };
});

const MERCHANT: Address = '0x2222222222222222222222222222222222222222';
const OTHER_MERCHANT: Address = '0x3333333333333333333333333333333333333333';
const PAYER: Address = '0x9999999999999999999999999999999999999999';
const FEE_RECEIVER: Address = '0x4444444444444444444444444444444444444444';
const TOTAL = 3000n * 10n ** 18n;

// 同じ mock module を同じ tick に並べて読み込むと 2 本目以降が実物になる (vitest 5) ので、1 つずつ読む。
async function load() {
  vi.resetModules();
  const url = await import('@/lib/url/checkout');
  const lookup = await import('@/lib/orderPaidLookup');
  const context = await import('@/lib/checkoutIntentContext');
  const storage = await import('@/lib/paymentIntentStorage');
  const settlement = await import('@/lib/paymentFlowGuards/restoredSettlement');
  const tokens = await import('@/lib/tokens');
  return { url, lookup, context, storage, settlement, tokens };
}

afterEach(() => {
  hold.enableJpycAvalanche = true;
  window.sessionStorage.clear();
});

describe('受け付ける chain を env で止めた後の、同じ注文リンクの通常決済の記録', () => {
  it('Polygon + Avalanche のリンクを Avalanche で払い、未解決のまま Avalanche を止めて同じリンクを開くと、一致 (別の支払いとしない)', async () => {
    // (1) Avalanche を受け付けていた時: 番号つきの注文リンク (3,000 JPYC・通常決済) を Avalanche で払う。
    const before = await load();
    const path = before.url.buildCheckoutPath({
      to: MERCHANT,
      token: 'jpyc',
      gas: 'customer',
      mode: 'standard',
      orderId: 'ord-1',
      items: [{ name: 'チケット', qty: 1, price: '3000' }],
      chains: ['polygon', 'avalanche'],
    });
    const parsedBefore = before.url.parseCheckoutParams(new URL(path, 'https://test.local').searchParams);
    if (!parsedBefore.ok) throw new Error(parsedBefore.error);
    expect(parsedBefore.params.chains).toEqual(['polygon', 'avalanche']);
    const avalanche = before.tokens.deploymentForSlug('jpyc', 'avalanche');
    const paidKey = before.lookup.orderPaymentContextKey(parsedBefore.params, 'avalanche') as Hex;
    window.sessionStorage.setItem(
      before.storage.STANDARD_INTENT_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        chainId: avalanche.chainId,
        from: PAYER,
        tokenAddress: avalanche.address,
        merchant: MERCHANT,
        merchantValue: TOTAL.toString(),
        feeReceiver: FEE_RECEIVER,
        feeValue: '0',
        saleValue: TOTAL.toString(),
        stage: 'merchant',
        merchantTxHash: `0x${'2'.repeat(64)}`,
        contextKey: paidKey,
        orderLinkKey: before.context.orderLinkContextFingerprint(paidKey, parsedBefore.params),
        issuedAt: Date.UTC(2026, 10, 11),
      }),
    );

    // (2) Avalanche を止めて deploy した後: 同じリンクは Polygon だけの会計として読まれる (選ぶ画面なし)。
    hold.enableJpycAvalanche = false;
    const after = await load();
    const parsedAfter = after.url.parseCheckoutParams(new URL(path, 'https://test.local').searchParams);
    if (!parsedAfter.ok) throw new Error(parsedAfter.error);
    expect(parsedAfter.params.chains).toBeUndefined();
    expect(parsedAfter.params.pickChain).toBeUndefined();
    expect(after.lookup.orderPaymentContextKey(parsedAfter.params, 'polygon')).not.toBe(paidKey);

    // 記録は今の parser で読め、chain は止めた Avalanche のまま。
    const intent = after.storage.loadStandardIntent();
    expect(intent).not.toBeNull();
    expect(intent!.chainId).toBe(avalanche.chainId);
    const record = after.storage.standardParamsFromIntent(intent!);
    const screen = after.lookup.checkoutSettlementScreen(parsedAfter.params);
    expect(after.settlement.isForeignSettlement(screen, { kind: 'standard', record })).toBe(false);
    // 受取先が違えば、今までどおり別の支払い。
    expect(
      after.settlement.isForeignSettlement(screen, { kind: 'standard', record: { ...record, merchant: OTHER_MERCHANT } }),
    ).toBe(true);
  });
});
