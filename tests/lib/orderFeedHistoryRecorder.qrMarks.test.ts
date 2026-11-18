// 受注の書き手 (lib/orderFeedHistoryRecorder.ts) は、QR の会計の書き手 (lib/qrSaleWatch.ts) の印も読む:
// 向こうが書いて店主が消した tx を、受注フィードから書き戻さない。読むだけで、向こうの key には書かない。
// (逆向き = QR の会計の書き手が受注の書き手の印を読むことは tests/lib/qrSaleWatch.test.ts。)
// receipt の読み取り (lib/orderFeedReceipt.ts) だけを差し替え、履歴と印 (localStorage) は実物。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Address, Hex } from 'viem';
import { recoverReceipt } from '../_helpers/orderSaleReceipt';

const read = vi.hoisted(() => vi.fn());
vi.mock('@/lib/orderFeedReceipt', () => ({
  ORDER_RECEIPT_TIMEOUT_MS: 6_000,
  readOrderReceipt: read,
}));
vi.mock('@/lib/relay/forwarderConfig', async () => {
  const actual = await vi.importActual<typeof import('@/lib/relay/forwarderConfig')>('@/lib/relay/forwarderConfig');
  return { ...actual, configuredJpycForwarderFor: vi.fn(() => '0x1111111111111111111111111111111111111111') };
});
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, enableMobileOrderFee: true, recoverFeeBps: 0 } };
});
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { env } from '@/lib/env';
import { loadHistory } from '@/lib/history';
import { ORDER_SALE_MARKS_KEY, createOrderSaleRecorder } from '@/lib/orderFeedHistoryRecorder';
import type { StoredOrder } from '@/lib/orderRelay';
import { ORDER_FEED_MARKS_KEY, QR_SALE_MARKS_KEY, addQrSaleMark, putQrSaleMark, readTxMarks } from '@/lib/qrSaleMarks';
import { deploymentForSlug } from '@/lib/tokens';

const FORWARDER: Address = '0x1111111111111111111111111111111111111111';
const MERCHANT: Address = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const CUSTOMER: Address = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const JPYC = deploymentForSlug('jpyc', 'polygon');
const ONE = 10n ** 18n;
const tx = (n: number) => `0x${'ab'.repeat(24)}${n.toString(16).padStart(16, '0')}` as Hex;

function order(n: number): StoredOrder {
  return {
    orderId: `N${n}`,
    items: [{ name: '水', qty: 1, price: '1000' }],
    table: null,
    amount: (990n * ONE).toString(),
    txHash: tx(n),
    chainId: JPYC.chainId,
    from: '',
    ts: 1_763_000_000_000 + n * 1_000,
    fulfilled: false,
  };
}
const receipt = (hash: string) =>
  recoverReceipt({
    token: JPYC.address, forwarder: FORWARDER, customer: CUSTOMER, merchant: MERCHANT,
    merchantValue: 990n * ONE, feeReceiver: env.feeReceiver, feeValue: 10n * ONE, txHash: hash,
  });
const stored = (key: string) => window.localStorage.getItem(key);

beforeEach(() => {
  read.mockReset();
  read.mockImplementation(async (_chainId: number, hash: string) => receipt(hash));
});

describe('2 つの書き手の印の key', () => {
  it('QR の会計の印は、受注の印と別の key。QR の側が読む「受注の印の key」は、受注の書き手の key と同じ値', () => {
    expect(QR_SALE_MARKS_KEY).toBe('openpay:qr-sale-recorded:v1');
    expect(QR_SALE_MARKS_KEY).not.toBe(ORDER_SALE_MARKS_KEY);
    expect(ORDER_FEED_MARKS_KEY).toBe(ORDER_SALE_MARKS_KEY);
  });

  it('2 つの印は同じ形 ([txHash (小文字), 時刻] の配列) で、同じ読み手で読める', async () => {
    await createOrderSaleRecorder()([order(1)], MERCHANT);
    expect(addQrSaleMark(tx(2))).toBe(true);
    expect([...readTxMarks(ORDER_SALE_MARKS_KEY)!.keys()]).toEqual([tx(1)]);
    expect([...readTxMarks(QR_SALE_MARKS_KEY)!.keys()]).toEqual([tx(2)]);
  });
});

describe('QR の会計の印を足す (addQrSaleMark の値は今までと同じ・putQrSaleMark は書いたかを返す)', () => {
  it('印が無い → 書く: addQrSaleMark は true・putQrSaleMark は added', () => {
    expect(addQrSaleMark(tx(1))).toBe(true);
    expect(putQrSaleMark(tx(2))).toBe('added');
    expect([...readTxMarks(QR_SALE_MARKS_KEY)!.keys()].sort()).toEqual([tx(1), tx(2)]);
  });

  it('印がもうある → 書かない: addQrSaleMark は true のまま・putQrSaleMark は present (印は書き換えない)', () => {
    const before = JSON.stringify([[tx(1), 1]]);
    window.localStorage.setItem(QR_SALE_MARKS_KEY, before);
    expect(addQrSaleMark(tx(1))).toBe(true);
    expect(putQrSaleMark(tx(1))).toBe('present');
    expect(stored(QR_SALE_MARKS_KEY)).toBe(before);
  });

  it('印を読めない・書けない → addQrSaleMark は false・putQrSaleMark は null', () => {
    window.localStorage.setItem(QR_SALE_MARKS_KEY, '{broken');
    expect(addQrSaleMark(tx(1))).toBe(false);
    expect(putQrSaleMark(tx(1))).toBeNull();
    window.localStorage.removeItem(QR_SALE_MARKS_KEY);
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(addQrSaleMark(tx(1))).toBe(false);
    expect(putQrSaleMark(tx(1))).toBeNull();
    setItem.mockRestore();
  });
});

describe('受注の書き手は、QR の会計の印がある tx を書かない', () => {
  it('QR の会計の印がある注文は書かない (receipt も読まない)。印の無い注文は今までどおり書く', async () => {
    window.localStorage.setItem(QR_SALE_MARKS_KEY, JSON.stringify([[tx(1), 5]]));
    await createOrderSaleRecorder()([order(2), order(1)], MERCHANT);
    expect(loadHistory().map((e) => e.id)).toEqual([`batch-${tx(2)}`]);
    expect(read.mock.calls.map(([, hash]) => hash)).toEqual([tx(2)]);
    // 向こうの key には書かない (読むだけ)。自分の印は、自分が書いた注文にだけ付ける。
    expect(stored(QR_SALE_MARKS_KEY)).toBe(JSON.stringify([[tx(1), 5]]));
    expect([...readTxMarks(ORDER_SALE_MARKS_KEY)!.keys()]).toEqual([tx(2)]);
  });

  it('QR の会計の印の hash が大文字でも同じ tx として扱う', async () => {
    window.localStorage.setItem(QR_SALE_MARKS_KEY, JSON.stringify([[tx(1).toUpperCase().replace('0X', '0x'), 5]]));
    await createOrderSaleRecorder()([order(1)], MERCHANT);
    expect(loadHistory()).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it('QR の会計の印の key が無ければ、今までどおり書く (key も作らない)', async () => {
    await createOrderSaleRecorder()([order(1)], MERCHANT);
    expect(loadHistory().map((e) => e.id)).toEqual([`batch-${tx(1)}`]);
    expect(stored(QR_SALE_MARKS_KEY)).toBeNull();
  });

  it.each([
    ['JSON として読めない', '{broken'],
    ['配列でない', '{"a":1}'],
    ['形の違う要素がある', JSON.stringify([[tx(9), 1], ['not-a-hash', 2]])],
  ])('QR の会計の印が読めない (%s) 端末では書かない (receipt も読まず、印も作り直さない)', async (_name, value) => {
    window.localStorage.setItem(QR_SALE_MARKS_KEY, value);
    const record = createOrderSaleRecorder();
    await record([order(1)], MERCHANT);
    await record([order(1)], MERCHANT);
    expect(loadHistory()).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    expect(stored(QR_SALE_MARKS_KEY)).toBe(value);
    expect(stored(ORDER_SALE_MARKS_KEY)).toBeNull();
    // 読めるようになったら書く。
    window.localStorage.removeItem(QR_SALE_MARKS_KEY);
    await record([order(1)], MERCHANT);
    expect(loadHistory().map((e) => e.id)).toEqual([`batch-${tx(1)}`]);
  });

  it('receipt を待っている間に、QR の会計の書き手が同じ tx に印を付けた → 保存の直前の確認で止まる', async () => {
    let release!: () => void;
    read.mockImplementationOnce(
      (_chainId: number, hash: string) => new Promise((resolve) => { release = () => resolve(receipt(hash)); }),
    );
    const done = createOrderSaleRecorder()([order(1)], MERCHANT);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(addQrSaleMark(tx(1))).toBe(true);
    release();
    await done;
    expect(loadHistory()).toEqual([]);
    expect(stored(ORDER_SALE_MARKS_KEY)).toBeNull();
  });

  it('receipt を待っている間に、QR の会計の印が読めなくなった → 書かない', async () => {
    let release!: () => void;
    read.mockImplementationOnce(
      (_chainId: number, hash: string) => new Promise((resolve) => { release = () => resolve(receipt(hash)); }),
    );
    const done = createOrderSaleRecorder()([order(1)], MERCHANT);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    window.localStorage.setItem(QR_SALE_MARKS_KEY, 'broken');
    release();
    await done;
    expect(loadHistory()).toEqual([]);
    expect(stored(ORDER_SALE_MARKS_KEY)).toBeNull();
  });
});
