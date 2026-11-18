// lib/qrSaleHistory.ts の readQrSwitchedStdBill: ガスレスの QR を、払う側で通常決済に切り替えて払ったときの期待値
// (同じ URL・同じ bill key から作る、通常決済の額と印)。Settled の期待値 (readQrBill) とは別の値。通常決済の QR の会計
// (readQrStdBill) の動きは変えない。見張りの回し方は tests/lib/qrSaleWatch.switched.test.ts が確かめる。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getAddress, type Address } from 'viem';

const hold = vi.hoisted(() => ({ forwarders: {} as Record<number, string> }));
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/forwarderConfig')>()),
  jpycForwarderFor: (chainId: number) => hold.forwarders[chainId] ?? null,
}));

import {
  buildQrStdSaleEntry,
  readQrBill,
  readQrStdBill,
  readQrSwitchedStdBill,
  stdMarkCount,
  transferMatchesExpected,
  type QrBillInput,
} from '@/lib/qrSaleHistory';
import { recoverFeeValue } from '@/lib/relay/recoverFee';
import { deploymentForSlug } from '@/lib/tokens';
import { buildCheckoutUrl, buildPayUrl, type PayParams } from '@/lib/url';
import { markedTransfer } from '../_helpers/qrSale';

const ORIGIN = 'https://shop.test';
const FORWARDER: Address = '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4';
const SHOP: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CUSTOMER: Address = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const BK = 'Zm9vYmFyYmE';
const ONE = 10n ** 18n;
const POLYGON = deploymentForSlug('jpyc', 'polygon');
const TX = `0x${'ab'.repeat(32)}`;
// tests/lib/billKeySalt.test.ts の golden (cast で計算した Zm9vYmFyYmE の通常決済の印)。
const MARK = '958ae5e2bac7dd1aa8fc9dec6e21f67bd131f20780d3992b9b873d6c4754a317';

const payUrl = (over: Partial<PayParams> = {}) =>
  buildPayUrl(ORIGIN, { to: SHOP, token: 'jpyc', chain: 'polygon', gas: 'merchant', mode: 'gasless', amount: '1000', ...over });
const input = (over: Partial<PayParams> = {}, billKey = BK): QrBillInput => ({
  billKey, kind: 'pay', url: payUrl(over), itemName: 'お支払い',
});

beforeEach(() => {
  hold.forwarders = { [POLYGON.chainId]: FORWARDER };
});

describe('readQrSwitchedStdBill (ガスレスの QR を、通常決済に切り替えて払ったときの期待値)', () => {
  it('ガスレスの決済QR: 額は請求額そのもの (回収の額を引かない)・印は通常決済の印。Settled の期待値とは別の値', () => {
    const fee = recoverFeeValue(1_000n * ONE, 'merchant', POLYGON.chainId);
    expect(fee > 0n).toBe(true);
    const settled = readQrBill(input({ productName: 'ランチ', receiptNo: 'G-1' }))!;
    const std = readQrSwitchedStdBill(input({ productName: 'ランチ', receiptNo: 'G-1' }))!;
    expect(settled.expected).toEqual({ merchantValue: 1_000n * ONE - fee, feeValue: fee });
    expect(std).toMatchObject({
      billKey: BK,
      mark: `0x${MARK}`,
      chainId: POLYGON.chainId,
      chainSlug: 'polygon',
      forwarder: FORWARDER,
      merchant: getAddress(SHOP),
      expected: { value: 1_000n * ONE, feeAmount: 0n, saleAmount: 1_000n * ONE },
    });
    expect(std.deployment.address).toBe(POLYGON.address);
    // 会計の写しは、ガスレスの会計と同じ (同じ URL を同じ parser で読む)。
    expect(std.sale).toEqual(settled.sale);
  });

  it('通常決済の QR の読み方 (readQrStdBill) は変えない: ガスレスの QR は null のまま・通常決済の QR は同じ会計', () => {
    expect(readQrStdBill(input())).toBeNull();
    expect(readQrStdBill(input({ mode: undefined }))).toBeNull();
    const standard = input({ mode: 'standard', gas: 'customer' });
    expect(readQrStdBill(standard)).not.toBeNull();
    // URL の mode の条件だけを外したもの: 通常決済の QR なら、同じ値。
    expect(readQrSwitchedStdBill(standard)).toEqual(readQrStdBill(standard));
  });

  it('レジのガスレスの QR: 額 = 明細の合計 − 値引き (払う側の calcCheckoutPayable と同じ)', () => {
    const url = buildCheckoutUrl(ORIGIN, {
      to: SHOP, token: 'jpyc', chain: 'polygon', gas: 'merchant', mode: 'gasless', discount: '80',
      items: [{ name: 'コーヒー', qty: 2, price: '500' }, { name: 'ケーキ', qty: 1, price: '480' }],
    });
    const std = readQrSwitchedStdBill({ billKey: BK, kind: 'checkout', url, itemName: '' })!;
    expect(std.expected).toEqual({ value: 1_400n * ONE, feeAmount: 0n, saleAmount: 1_400n * ONE });
  });

  it.each([
    ['USDC', { billKey: BK, kind: 'pay' as const, url: buildPayUrl(ORIGIN, { to: SHOP, token: 'usdc', chain: 'base', gas: 'customer', mode: 'gasless', amount: '5' }), itemName: '' }],
    ['金額なし', input({ amount: undefined })],
    ['形の違う bill key', input({}, 'short')],
    ['読めない URL', { billKey: BK, kind: 'pay' as const, url: `${ORIGIN}/pay`, itemName: '' }],
  ])('%s → null', (_name, bad) => {
    expect(readQrSwitchedStdBill(bad)).toBeNull();
  });

  it('照合と行は、通常決済の QR の会計と同じ関数で通る: 請求額の Transfer + 印 → 一致・回収の後の額は一致しない・行は通常決済の行', () => {
    const fee = recoverFeeValue(1_000n * ONE, 'merchant', POLYGON.chainId);
    const std = readQrSwitchedStdBill(input({ receiptNo: 'G-1' }))!;
    const transfer = { from: CUSTOMER, to: SHOP, value: 1_000n * ONE };
    expect(transferMatchesExpected(transfer, std)).toBe(true);
    expect(transferMatchesExpected({ ...transfer, value: 1_000n * ONE - fee }, std)).toBe(false);
    expect(transferMatchesExpected({ ...transfer, from: FORWARDER }, std)).toBe(false);
    const tx = { from: CUSTOMER, to: POLYGON.address, input: markedTransfer(BK, SHOP, 1_000n * ONE) };
    expect(stdMarkCount(tx, transfer, std)).toBe(1);
    expect(stdMarkCount({ ...tx, input: markedTransfer(BK, SHOP, 1_000n * ONE - fee) }, transfer, std)).toBe(0);
    expect(buildQrStdSaleEntry(std, transfer, TX, 995n, 1_700_000_000n, true)).toMatchObject({
      flow: 'standard-merchant', payMode: 'standard', gasMode: null, customer: getAddress(CUSTOMER),
      merchantAmount: (1_000n * ONE).toString(), saleAmount: (1_000n * ONE).toString(), feeAmount: '0',
      networkFeeEquivalent: null, receiptNo: 'G-1',
    });
  });
});
