// lib/orderFeedHistory.ts (受注 → 履歴の 1 行) の純関数。払った側の行との欄ごとの比較は
// tests/components/orderFeedHistory.parity.test.tsx。ここは receipt の読み方の端と、注文の形の端を固定する。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Address, Hex } from 'viem';
import { directReceipt, recoverReceipt, settledLog, transferLog } from '../_helpers/orderSaleReceipt';

const FORWARDER: Address = '0x1111111111111111111111111111111111111111';
const forwarderHold = vi.hoisted(() => ({ on: true }));
vi.mock('@/lib/relay/forwarderConfig', async () => {
  const actual = await vi.importActual<typeof import('@/lib/relay/forwarderConfig')>('@/lib/relay/forwarderConfig');
  return {
    ...actual,
    configuredJpycForwarderFor: vi.fn(() => (forwarderHold.on ? '0x1111111111111111111111111111111111111111' : null)),
  };
});
const feeFlags = vi.hoisted(() => ({ enableMobileOrderFee: true }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableMobileOrderFee() {
        return feeFlags.enableMobileOrderFee;
      },
    },
  };
});

import { env } from '@/lib/env';
import { appendHistory, loadHistory } from '@/lib/history';
import {
  buildOrderSaleEntry,
  isRecordableOrder,
  orderSaleFlow,
  readOrderSaleEvidence,
} from '@/lib/orderFeedHistory';
import type { StoredOrder } from '@/lib/orderRelay';
import { deploymentForSlug } from '@/lib/tokens';

const MERCHANT: Address = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const OTHER_MERCHANT: Address = '0x2222222222222222222222222222222222222222';
const CUSTOMER: Address = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const CUSTOMER_2: Address = '0x3333333333333333333333333333333333333333';
const JPYC = deploymentForSlug('jpyc', 'polygon');
const ONE = 10n ** 18n;
const TX = `0x${'a'.repeat(64)}` as Hex;

function order(over: Partial<StoredOrder> = {}): StoredOrder {
  return {
    orderId: '7K3Q',
    items: [{ name: '水', qty: 2, price: '500' }],
    table: 'テーブル 3',
    amount: (990n * ONE).toString(),
    txHash: TX,
    chainId: JPYC.chainId,
    from: '',
    ts: 1_763_000_000_000,
    fulfilled: false,
    ...over,
  };
}

const settle = (over: Partial<Parameters<typeof recoverReceipt>[0]> = {}) =>
  recoverReceipt({
    token: JPYC.address, forwarder: FORWARDER, customer: CUSTOMER, merchant: MERCHANT,
    merchantValue: 990n * ONE, feeReceiver: env.feeReceiver, feeValue: 10n * ONE, ...over,
  });

beforeEach(() => {
  forwarderHold.on = true;
  feeFlags.enableMobileOrderFee = true;
});

describe('isRecordableOrder — 行を書いてよい注文か', () => {
  it('txHash が無い・形が違う注文は書かない', () => {
    expect(isRecordableOrder(order())).toBe(true);
    expect(isRecordableOrder(order({ txHash: '' }))).toBe(false);
    expect(isRecordableOrder(order({ txHash: '0x1234' }))).toBe(false);
    expect(isRecordableOrder({ ...order(), txHash: undefined } as unknown as StoredOrder)).toBe(false);
  });

  it('着金額が数字でない・明細が配列でない注文は書かない', () => {
    expect(isRecordableOrder(order({ amount: '' }))).toBe(false);
    expect(isRecordableOrder(order({ amount: '1e21' }))).toBe(false);
    expect(isRecordableOrder({ ...order(), items: undefined } as unknown as StoredOrder)).toBe(false);
  });
});

describe('orderSaleFlow — 払った側の行と同じ id の前半', () => {
  it('束縛の無い経路 (通常決済) は standard-merchant、それ以外は batch', () => {
    expect(orderSaleFlow(order())).toBe('batch');
    expect(orderSaleFlow(order({ unboundPayment: true }))).toBe('standard-merchant');
  });
});

describe('readOrderSaleEvidence — receipt の読み方', () => {
  it('forwarder の Settled (この受取先・着金額と同じ額) から、お客様と利用料を読む', () => {
    expect(readOrderSaleEvidence(order(), MERCHANT, settle())).toEqual({
      kind: 'settled', customer: CUSTOMER, feeValue: 10n * ONE, blockNumber: 777n,
    });
  });

  it('revert した receipt は入金の証拠にしない (null = 書かない)', () => {
    expect(readOrderSaleEvidence(order(), MERCHANT, { ...settle(), status: 'reverted' })).toBeNull();
  });

  it('この受取先への Transfer が無い receipt (別の受取先の注文) は null = 書かない', () => {
    expect(readOrderSaleEvidence(order(), MERCHANT, settle({ merchant: OTHER_MERCHANT }))).toBeNull();
    expect(
      readOrderSaleEvidence(order({ unboundPayment: true }), MERCHANT,
        directReceipt({ token: JPYC.address, customer: CUSTOMER, merchant: OTHER_MERCHANT, value: 990n * ONE })),
    ).toBeNull();
  });

  it('JPYC でない token の Transfer は、この受取先への入金に数えない', () => {
    const other = '0x4444444444444444444444444444444444444444' as Address;
    expect(
      readOrderSaleEvidence(order(), MERCHANT,
        directReceipt({ token: other, customer: CUSTOMER, merchant: MERCHANT, value: 990n * ONE })),
    ).toBeNull();
  });

  it('同じ tx に別の受取先の Settled が混ざっていても、この受取先の 1 つを読む', () => {
    const mine = settle();
    const theirs = settle({ merchant: OTHER_MERCHANT, customer: CUSTOMER_2, feeValue: 30n * ONE });
    expect(readOrderSaleEvidence(order(), MERCHANT, { ...mine, logs: [...theirs.logs, ...mine.logs] })).toEqual({
      kind: 'settled', customer: CUSTOMER, feeValue: 10n * ONE, blockNumber: 777n,
    });
  });

  it('同じ受取先・同じ額の Settled が 2 つある tx は、どちらか決めない (none)', () => {
    const a = settle();
    const b = settle({ customer: CUSTOMER_2, feeValue: 30n * ONE });
    expect(readOrderSaleEvidence(order(), MERCHANT, { ...a, logs: [...a.logs, ...b.logs] })).toEqual({ kind: 'none' });
  });

  it('Settled の額が着金額と違うときは使わない (none)', () => {
    expect(readOrderSaleEvidence(order({ amount: (991n * ONE).toString() }), MERCHANT, settle())).toEqual({ kind: 'none' });
  });

  it('forwarder でないコントラクトが出した Settled は読まない (直接の Transfer として扱う)', () => {
    const fake = '0x5555555555555555555555555555555555555555' as Address;
    const receipt = {
      status: 'success' as const,
      blockNumber: 5n,
      logs: [
        transferLog(JPYC.address, CUSTOMER, MERCHANT, 990n * ONE),
        settledLog(fake, { from: CUSTOMER_2, merchant: MERCHANT, merchantValue: 990n * ONE, feeReceiver: env.feeReceiver, feeValue: 1n }),
      ],
    };
    expect(readOrderSaleEvidence(order(), MERCHANT, receipt)).toEqual({ kind: 'direct', customer: CUSTOMER, blockNumber: 5n });
  });

  it('Settled が無い receipt: 受取先への Transfer がちょうど 1 本・同じ額のときだけ、送り主をお客様にする', () => {
    const one = directReceipt({ token: JPYC.address, customer: CUSTOMER, merchant: MERCHANT, value: 990n * ONE, blockNumber: 9n });
    expect(readOrderSaleEvidence(order(), MERCHANT, one)).toEqual({ kind: 'direct', customer: CUSTOMER, blockNumber: 9n });
    // 2 本に分かれた入金 (server は合計で確かめる): お客様は決めない。
    const two = { ...one, logs: [transferLog(JPYC.address, CUSTOMER, MERCHANT, 400n * ONE), transferLog(JPYC.address, CUSTOMER_2, MERCHANT, 590n * ONE)] };
    expect(readOrderSaleEvidence(order(), MERCHANT, two)).toEqual({ kind: 'direct', customer: null, blockNumber: 9n });
    // 額が違う 1 本: お客様は決めない。
    const off = directReceipt({ token: JPYC.address, customer: CUSTOMER, merchant: MERCHANT, value: 989n * ONE, blockNumber: 9n });
    expect(readOrderSaleEvidence(order(), MERCHANT, off)).toEqual({ kind: 'direct', customer: null, blockNumber: 9n });
  });

  it('Settled の無い forwarder からの Transfer は、forwarder をお客様にしない', () => {
    const receipt = directReceipt({ token: JPYC.address, customer: FORWARDER, merchant: MERCHANT, value: 990n * ONE });
    expect(readOrderSaleEvidence(order(), MERCHANT, receipt)).toMatchObject({ kind: 'direct', customer: null });
  });
});

describe('buildOrderSaleEntry — 注文の形の端', () => {
  const settled = { kind: 'settled', customer: CUSTOMER, feeValue: 10n * ONE, blockNumber: 777n } as const;

  it('chain・token の表に無い chainId の注文は書けない (null)', () => {
    expect(buildOrderSaleEntry(order({ chainId: 999_999 }), MERCHANT, { kind: 'none' })).toBeNull();
    expect(readOrderSaleEvidence(order({ chainId: 999_999 }), MERCHANT, settle())).toEqual({ kind: 'none' });
  });

  it('時刻は server が受注を受け取った時刻。無い注文は今の時刻', () => {
    expect(buildOrderSaleEntry(order(), MERCHANT, settled)?.ts).toBe(1_763_000_000_000);
    const before = Date.now();
    const ts = buildOrderSaleEntry(order({ ts: 0 }), MERCHANT, settled)!.ts;
    expect(ts).toBeGreaterThanOrEqual(before);
  });

  it('受付番号が無い会計 (server が txHash を番号の代わりに入れた注文) は、管理番号もメモも空', () => {
    const entry = buildOrderSaleEntry(order({ orderId: TX, table: null }), MERCHANT, settled)!;
    expect(entry).toMatchObject({ receiptNo: null, note: '', memo: null });
  });

  it('利用料の flag が ON でも、利用料の式に合わない回収額はネットワーク手数料相当額に入れる', () => {
    // 998 + 2: 2 は 1,000 の 1% (10) でも 3% (30) でも、998 の 3% (29.94) でもない = ガス相当額の回収。
    const entry = buildOrderSaleEntry(
      order({ amount: (998n * ONE).toString() }), MERCHANT, { ...settled, feeValue: 2n * ONE },
    )!;
    expect(entry).toMatchObject({ gasMode: 'merchant', feeAmount: '0', networkFeeEquivalent: (2n * ONE).toString(), saleAmount: (1_000n * ONE).toString() });
  });

  it('通常決済の注文に Settled の証拠が付いても、通常決済の行のまま (利用料を Settled から入れない)', () => {
    feeFlags.enableMobileOrderFee = false;
    const entry = buildOrderSaleEntry(order({ unboundPayment: true }), MERCHANT, settled)!;
    expect(entry).toMatchObject({ flow: 'standard-merchant', payMode: 'standard', gasMode: null, feeAmount: '0', networkFeeEquivalent: null, customer: CUSTOMER, blockNumber: '777' });
  });

  it('明細が空の注文: 明細も商品名も null (着金額の行は書く)', () => {
    const entry = buildOrderSaleEntry(order({ items: [] }), MERCHANT, settled)!;
    expect(entry).toMatchObject({ lineItems: null, productName: null, merchantAmount: (990n * ONE).toString() });
  });

  it('単価が数字でない申告の明細: 受注の画面と同じ品名と数量だけを残し、着金額の行は書く', () => {
    const entry = buildOrderSaleEntry(
      order({ unboundPayment: true, items: [{ name: '水', qty: 2, price: '' }, { name: 'パン', qty: 1, price: 'abc' }] }),
      MERCHANT,
      { kind: 'none' },
    )!;
    expect(entry.lineItems).toEqual([
      { id: '0', name: '水', quantity: 2, unitPrice: '', amount: '', taxRate: null, taxCategory: null, memo: null },
      { id: '1', name: 'パン', quantity: 1, unitPrice: 'abc', amount: '', taxRate: null, taxCategory: null, memo: null },
    ]);
    expect(entry.merchantAmount).toBe((990n * ONE).toString());
  });

  it('組んだ行は、履歴に保存して読み直しても同じ (読み込みの検査を通る形)', () => {
    const rows = [
      buildOrderSaleEntry(order(), MERCHANT, settled)!,
      buildOrderSaleEntry(order({ txHash: `0x${'b'.repeat(64)}`, unboundPayment: true }), MERCHANT, { kind: 'none' })!,
      buildOrderSaleEntry(order({ txHash: `0x${'c'.repeat(64)}`, items: [{ name: '水', qty: 2, price: '' }] }), MERCHANT, { kind: 'none' })!,
      buildOrderSaleEntry(order({ txHash: `0x${'d'.repeat(64)}`, discount: (100n * ONE).toString(), amount: (891n * ONE).toString() }), MERCHANT, { ...settled, feeValue: 9n * ONE })!,
    ];
    for (const row of rows) appendHistory(row);
    expect(loadHistory()).toEqual([...rows].reverse());
  });
});
