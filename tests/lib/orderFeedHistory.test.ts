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
const feeFlags = vi.hoisted(() => ({ enableMobileOrderFee: true, recoverFeeBps: 0 }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableMobileOrderFee() {
        return feeFlags.enableMobileOrderFee;
      },
      // hermetic: 回収の率は手元の NEXT_PUBLIC_RECOVER_FEE_BPS に頼らずテストが決める (既定はフロア 2 JPYC だけ)。
      get recoverFeeBps() {
        return feeFlags.recoverFeeBps;
      },
    },
  };
});

import { env } from '@/lib/env';
import { appendHistory, loadHistory } from '@/lib/history';
import {
  buildOrderSaleEntry,
  isAgentOrder,
  isRecordableOrder,
  orderSaleFlow,
  readOrderSaleEvidence,
  settledSaleSplit,
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
  feeFlags.recoverFeeBps = 0;
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

  it('chain・token の表に無い chainId の注文は書かない', () => {
    expect(isRecordableOrder(order({ chainId: 999_999 }))).toBe(false);
  });

  it('エージェント注文 (server が orderId = agent-<nonce> で保存する) は書かない', () => {
    // lib/order/agentOrderFinalize.ts の orderId の形。
    const agent = order({ orderId: `agent-0x${'1'.repeat(16)}` });
    expect(isAgentOrder(agent)).toBe(true);
    expect(isRecordableOrder(agent)).toBe(false);
    // お客様が agent- で始まる番号を名乗った注文も書かれない (書かない側に倒れる)。
    expect(isRecordableOrder(order({ orderId: 'agent-7K3Q' }))).toBe(false);
    // 途中に agent を含むだけの番号・大文字の番号は人の注文。
    expect(isAgentOrder(order({ orderId: 'my-agent-1' }))).toBe(false);
    expect(isAgentOrder(order({ orderId: 'AGENT-1' }))).toBe(false);
    expect(isRecordableOrder(order({ orderId: 'my-agent-1' }))).toBe(true);
    // 受注フィードの応答は型を確かめずに届く: orderId が文字列でなくても投げない。
    expect(isAgentOrder({ ...order(), orderId: undefined } as unknown as StoredOrder)).toBe(false);
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

  it('要求した tx でない receipt (RPC が別の tx の receipt を返した) は null = 書かない。大文字小文字の違いは同じ tx', () => {
    expect(readOrderSaleEvidence(order(), MERCHANT, settle({ txHash: `0x${'b'.repeat(64)}` }))).toBeNull();
    expect(readOrderSaleEvidence(order(), MERCHANT, { ...settle(), transactionHash: undefined } as unknown as ReturnType<typeof settle>)).toBeNull();
    expect(readOrderSaleEvidence(order(), MERCHANT, settle({ txHash: `0x${'A'.repeat(64)}` }))).toMatchObject({ kind: 'settled' });
    expect(readOrderSaleEvidence(order({ txHash: `0x${'A'.repeat(64)}` }), MERCHANT, settle())).toMatchObject({ kind: 'settled' });
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

  it('同じ受取先・同じ額の Settled が 2 つある tx は、どちらか決めないので書かない (null)', () => {
    const a = settle();
    const b = settle({ customer: CUSTOMER_2, feeValue: 30n * ONE });
    expect(readOrderSaleEvidence(order(), MERCHANT, { ...a, logs: [...a.logs, ...b.logs] })).toBeNull();
  });

  it('Settled の額が着金額と違うときは書かない (null)', () => {
    expect(readOrderSaleEvidence(order({ amount: (991n * ONE).toString() }), MERCHANT, settle())).toBeNull();
  });

  it('Settled のある tx で、この受取先への Settled が無ければ、受取先への Transfer があっても書かない', () => {
    const theirs = settle({ merchant: OTHER_MERCHANT });
    const receipt = { ...theirs, logs: [...theirs.logs, transferLog(JPYC.address, CUSTOMER, MERCHANT, 990n * ONE)] };
    expect(readOrderSaleEvidence(order(), MERCHANT, receipt)).toBeNull();
  });

  it('forwarder でないコントラクトが出した Settled は読まない (直接の Transfer として扱う)', () => {
    const fake = '0x5555555555555555555555555555555555555555' as Address;
    const receipt = {
      transactionHash: TX,
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
    expect(buildOrderSaleEntry(order({ chainId: 999_999 }), MERCHANT, settled)).toBeNull();
    expect(readOrderSaleEvidence(order({ chainId: 999_999 }), MERCHANT, settle())).toBeNull();
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

  it('利用料の flag が ON でも、回収の式 (フロア) にだけ合う額はネットワーク手数料相当額に入れる', () => {
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
      { kind: 'direct', customer: CUSTOMER, blockNumber: 5n },
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
      buildOrderSaleEntry(order({ txHash: `0x${'b'.repeat(64)}`, unboundPayment: true }), MERCHANT, { kind: 'direct', customer: null, blockNumber: 5n })!,
      buildOrderSaleEntry(order({ txHash: `0x${'c'.repeat(64)}`, items: [{ name: '水', qty: 2, price: '' }] }), MERCHANT, { kind: 'direct', customer: CUSTOMER, blockNumber: 5n })!,
      // 経路を決められない (4 欄 null) 行も、保存の検査を通る。
      buildOrderSaleEntry(order({ txHash: `0x${'e'.repeat(64)}` }), MERCHANT, { ...settled, feeValue: 7n * ONE })!,
      buildOrderSaleEntry(order({ txHash: `0x${'d'.repeat(64)}`, discount: (100n * ONE).toString(), amount: (891n * ONE).toString() }), MERCHANT, { ...settled, feeValue: 9n * ONE })!,
    ];
    for (const row of rows) appendHistory(row);
    expect(loadHistory()).toEqual([...rows].reverse());
  });
});

describe('settledSaleSplit — Settled の利用料が式にちょうど合う経路で欄を埋める', () => {
  const M = (n: bigint) => n * ONE;
  const UNKNOWN = { gasMode: null, feeAmount: null, saleAmount: null, networkFeeEquivalent: null };
  const storefront = (amount: bigint, fee: bigint) => ({ gasMode: 'merchant', feeAmount: fee, saleAmount: amount + fee, networkFeeEquivalent: null });
  const customerPays = (amount: bigint, fee: bigint) => ({ gasMode: 'customer', feeAmount: fee, saleAmount: amount, networkFeeEquivalent: null });
  const recovered = (amount: bigint, fee: bigint) => ({ gasMode: 'merchant', feeAmount: 0n, saleAmount: amount + fee, networkFeeEquivalent: fee });

  it('モバイル注文の利用料・お店が負担 (店頭 1%・事前 3%): 利用料の欄・売上 = 着金額 + 利用料', () => {
    // 店頭 1%: 1,500 → 15。
    expect(settledSaleSplit(M(1_485n), M(15n), JPYC.chainId)).toEqual(storefront(M(1_485n), M(15n)));
    // 事前 3%・お店が負担: 1,500 → 45。
    expect(settledSaleSplit(M(1_455n), M(45n), JPYC.chainId)).toEqual(storefront(M(1_455n), M(45n)));
  });

  it('モバイル注文の利用料・お客様が負担 (事前 3%): 利用料の欄・売上 = 着金額', () => {
    expect(settledSaleSplit(M(1_500n), M(45n), JPYC.chainId)).toEqual(customerPays(M(1_500n), M(45n)));
  });

  it('利用料の flag が ON で、利用料の式に合わず回収の式 (フロア) に合う額: 回収 (ネットワーク手数料相当額の欄・利用料 0)', () => {
    expect(settledSaleSplit(M(1_498n), M(2n), JPYC.chainId)).toEqual(recovered(M(1_498n), M(2n)));
  });

  it('利用料の flag が ON で、どの式にも合わない額は、4 欄とも null (推測で売上総額を作らない)', () => {
    expect(settledSaleSplit(M(990n), M(7n), JPYC.chainId)).toEqual(UNKNOWN);
    // 1 wei ずれた利用料も合わない。
    expect(settledSaleSplit(M(1_485n), M(15n) + 1n, JPYC.chainId)).toEqual(UNKNOWN);
  });

  it('本番の設定 (利用料の flag が ON・回収 1%): 店頭 1% の注文は、売上が 200 JPYC 未満・ちょうど・以上のどれでも利用料 (お店が負担)', () => {
    feeFlags.recoverFeeBps = 100;
    // 200 以上: 1,500 の 1% = 15 = max(2, 15) で回収の式にも合うが、利用料の式を先に見る。
    expect(settledSaleSplit(M(1_485n), M(15n), JPYC.chainId)).toEqual(storefront(M(1_485n), M(15n)));
    // ちょうど 200: 1% = 2 = フロア。
    expect(settledSaleSplit(M(198n), M(2n), JPYC.chainId)).toEqual(storefront(M(198n), M(2n)));
    // 200 未満: 199 の 1% = 1.99 (フロア 2 と違う)。
    const fee199 = M(1n) + (ONE * 99n) / 100n;
    expect(settledSaleSplit(M(199n) - fee199, fee199, JPYC.chainId)).toEqual(storefront(M(199n) - fee199, fee199));
    // 事前 3% (お店が負担・お客様が負担) も利用料のまま。
    expect(settledSaleSplit(M(1_455n), M(45n), JPYC.chainId)).toEqual(storefront(M(1_455n), M(45n)));
    expect(settledSaleSplit(M(1_500n), M(45n), JPYC.chainId)).toEqual(customerPays(M(1_500n), M(45n)));
    // 利用料の式に合わない回収: 150 の回収はフロアの 2 (1% は 1.5・3% は 4.5 と 4.44)。
    expect(settledSaleSplit(M(148n), M(2n), JPYC.chainId)).toEqual(recovered(M(148n), M(2n)));
  });

  it('利用料の額がフロア (2 JPYC) と同じ注文: お客様が負担の 3% で利用料が 2 になる着金額も、利用料として埋める', () => {
    // floor(M × 3%) = 2 JPYC になる最小の着金額 (約 66.67 JPYC)。回収 (フロア 2) の式にも合う。
    const amount = (2n * ONE * 100n + 2n) / 3n;
    expect((amount * 300n) / 10_000n).toBe(M(2n));
    expect(settledSaleSplit(amount, M(2n), JPYC.chainId)).toEqual(customerPays(amount, M(2n)));
    // 1 wei 少ない着金額は 3% が 2 JPYC に届かないので、回収だけに合う。
    expect(settledSaleSplit(amount - 1n, M(2n), JPYC.chainId)).toEqual(recovered(amount - 1n, M(2n)));
  });

  it('回収が 3% の build でも、事前 3%・お店が負担の注文は利用料として埋める (feeKind の無い 3% の回収も利用料になる限界)', () => {
    feeFlags.recoverFeeBps = 300;
    expect(settledSaleSplit(M(1_455n), M(45n), JPYC.chainId)).toEqual(storefront(M(1_455n), M(45n)));
  });

  it('利用料の式の 2 つ以上に合う額 (事前 3% のお店が負担とお客様が負担・1,100 wei 以下だけ): どちらでも同じ欄だけを埋める', () => {
    // 着金額 34 wei・利用料 1 wei: floor(35 × 3%) = 1 (お店が負担) と floor(34 × 3%) = 1 (お客様が負担) の両方に合う。
    // 負担者と売上総額は式で変わるので null・利用料とネットワーク手数料相当額 (どちらも null) はそのまま。
    expect(settledSaleSplit(34n, 1n, JPYC.chainId)).toEqual({ gasMode: null, feeAmount: 1n, saleAmount: null, networkFeeEquivalent: null });
    // 着金額 1,100 wei・利用料 33 wei も両方に合う。
    expect(settledSaleSplit(1_100n, 33n, JPYC.chainId)).toEqual({ gasMode: null, feeAmount: 33n, saleAmount: null, networkFeeEquivalent: null });
  });

  it('利用料の flag が OFF の build: 回収の式に合えば回収・合わなければ 4 欄とも null', () => {
    feeFlags.enableMobileOrderFee = false;
    expect(settledSaleSplit(M(1_498n), M(2n), JPYC.chainId)).toEqual(recovered(M(1_498n), M(2n)));
    // 店頭 1% の額は、回収 (フロア 2) に合わない = null。
    expect(settledSaleSplit(M(1_485n), M(15n), JPYC.chainId)).toEqual(UNKNOWN);
    // 回収が 1% の build では、同じ額が回収に合う。
    feeFlags.recoverFeeBps = 100;
    expect(settledSaleSplit(M(1_485n), M(15n), JPYC.chainId)).toEqual(recovered(M(1_485n), M(15n)));
  });

  it('行に写すと: どの式にも合わない注文は 4 欄が null・着金額・お客様・tx は入る', () => {
    const entry = buildOrderSaleEntry(
      order({ amount: M(990n).toString() }),
      MERCHANT,
      { kind: 'settled', customer: CUSTOMER, feeValue: M(7n), blockNumber: 777n },
    )!;
    expect(entry).toMatchObject({
      id: `batch-${TX}`, flow: 'batch', payMode: 'gasless', merchantAmount: M(990n).toString(), customer: CUSTOMER,
      gasMode: null, feeAmount: null, saleAmount: null, networkFeeEquivalent: null, blockNumber: null,
    });
  });
});
