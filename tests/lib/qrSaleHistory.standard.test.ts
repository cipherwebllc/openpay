// lib/qrSaleHistory.ts の通常決済の会計 (mode=standard・JPYC) の純関数: QR の会計を読む・Transfer を読む・tx の input の
// 印を数える・履歴の行を組む。見張りの回し方は tests/lib/qrSaleWatch.standard.test.ts、払った側の行と欄ごとに同じことは
// tests/components/qrSaleHistory.standardParity.test.tsx が確かめる。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getAddress, type Address, type Hex } from 'viem';

const hold = vi.hoisted(() => ({ forwarders: {} as Record<number, string> }));
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/forwarderConfig')>()),
  jpycForwarderFor: (chainId: number) => hold.forwarders[chainId] ?? null,
}));

import { env } from '@/lib/env';
import {
  buildQrStdSaleEntry,
  readQrBill,
  readQrStdBill,
  readTransferLog,
  stdCallsExceedTransfers,
  stdMarkCount,
  stdTransferCalldata,
  transferMatchesExpected,
  type QrStdBill,
  type TransferLog,
} from '@/lib/qrSaleHistory';
import { billKeyStdMark } from '@/lib/relay/billKeySalt';
import { deploymentForSlug } from '@/lib/tokens';
import { buildCheckoutUrl, buildPayUrl, type PayParams } from '@/lib/url';
import { markedTransfer, transferRpcLog } from '../_helpers/qrSale';

const ORIGIN = 'https://shop.test';
const FORWARDER: Address = '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4';
const SHOP: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CUSTOMER: Address = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const BK = 'Zm9vYmFyYmE';
const ONE = 10n ** 18n;
const POLYGON = deploymentForSlug('jpyc', 'polygon');
const KAIA = deploymentForSlug('jpyc', 'kaia');
const TX = `0x${'ab'.repeat(32)}`;
// tests/lib/billKeySalt.test.ts の golden (cast で計算した Zm9vYmFyYmE の通常決済の印)。
const MARK = '958ae5e2bac7dd1aa8fc9dec6e21f67bd131f20780d3992b9b873d6c4754a317';

const payUrl = (over: Partial<PayParams> = {}) =>
  buildPayUrl(ORIGIN, { to: SHOP, token: 'jpyc', chain: 'polygon', gas: 'customer', mode: 'standard', amount: '1000', ...over });
const stdBill = (over: Partial<PayParams> = {}, billKey = BK) =>
  readQrStdBill({ billKey, kind: 'pay', url: payUrl(over), itemName: 'お支払い' });
const transfer = (over: Partial<TransferLog> = {}): TransferLog => ({
  from: CUSTOMER, to: SHOP, value: 1_000n * ONE, ...over,
});

beforeEach(() => {
  hold.forwarders = { [POLYGON.chainId]: FORWARDER };
});

describe('readQrStdBill (通常決済の QR の会計)', () => {
  it('決済QR: 印・チェーン・JPYC の deployment・forwarder・受取先・期待値 (着金 = 請求額・利用料 0) と会計の写し', () => {
    const bill = stdBill({ productName: 'ランチ', receiptNo: 'R-1' })!;
    expect(bill).toMatchObject({
      billKey: BK,
      mark: `0x${MARK}`,
      chainId: POLYGON.chainId,
      chainSlug: 'polygon',
      forwarder: FORWARDER,
      merchant: getAddress(SHOP),
      expected: { value: 1_000n * ONE, feeAmount: 0n, saleAmount: 1_000n * ONE },
    });
    expect(bill.deployment.address).toBe(POLYGON.address);
    expect(bill.sale).toMatchObject({ kind: 'pay', itemName: 'お支払い', params: { productName: 'ランチ', receiptNo: 'R-1' } });
  });

  it('レジ: 請求額 = 明細の合計 − 値引き (払う側の calcCheckoutPayable と同じ)', () => {
    const url = buildCheckoutUrl(ORIGIN, {
      to: SHOP, token: 'jpyc', chain: 'kaia', gas: 'customer', mode: 'standard', discount: '80',
      items: [{ name: 'コーヒー', qty: 2, price: '500' }, { name: 'ケーキ', qty: 1, price: '480' }],
    });
    hold.forwarders = {};
    const bill = readQrStdBill({ billKey: BK, kind: 'checkout', url, itemName: '' })!;
    expect(bill).toMatchObject({
      chainId: KAIA.chainId,
      // forwarder の無いチェーンでも会計になる (払う人のウォレットが送る)。
      forwarder: null,
      expected: { value: 1_400n * ONE, feeAmount: 0n, saleAmount: 1_400n * ONE },
    });
  });

  it('ガスレスの会計 (readQrBill) とは mode で分かれる: 通常決済の URL は readQrBill が null・ガスレスの URL は readQrStdBill が null', () => {
    const standard = { billKey: BK, kind: 'pay' as const, url: payUrl(), itemName: '' };
    const gasless = { billKey: BK, kind: 'pay' as const, url: payUrl({ mode: 'gasless', gas: 'merchant' }), itemName: '' };
    expect(readQrBill(standard)).toBeNull();
    expect(readQrStdBill(standard)).not.toBeNull();
    expect(readQrBill(gasless)).not.toBeNull();
    expect(readQrStdBill(gasless)).toBeNull();
  });

  it.each([
    ['USDC', { token: 'usdc', chain: 'base' } as Partial<PayParams>, BK],
    ['金額なし', { amount: undefined }, BK],
    ['形の違う bill key', {}, 'short'],
    ['22 字の bill key (前の形)', {}, 'Zm9vYmFyYmF6cXV4MTIzNA'],
  ])('見張らない: %s → null', (_name, over, billKey) => {
    expect(stdBill(over, billKey)).toBeNull();
  });

  it('URL を読めない → null (throw しない)', () => {
    expect(readQrStdBill({ billKey: BK, kind: 'pay', url: 'not a url', itemName: '' })).toBeNull();
    expect(readQrStdBill({ billKey: BK, kind: 'checkout', url: `${ORIGIN}/checkout?to=${SHOP}`, itemName: '' })).toBeNull();
  });
});

describe('払う側が送る calldata と、tx の input の印', () => {
  it('stdTransferCalldata = transfer(受取先, 額) の selector と 2 つの word + 印 (literal で固定)', () => {
    const bill = stdBill()!;
    expect(stdTransferCalldata(bill)).toBe(
      `0xa9059cbb${'0'.repeat(24)}${SHOP.slice(2).toLowerCase()}${(1_000n * ONE).toString(16).padStart(64, '0')}${MARK}`,
    );
    expect(stdTransferCalldata(bill)).toBe(markedTransfer(BK, SHOP, 1_000n * ONE));
    expect(billKeyStdMark(BK)).toBe(`0x${MARK}`);
  });

  it('EOA が JPYC へ直接送った tx: 送り手が Transfer の from と同じで、input がちょうど同じときだけ 1 (大文字小文字は問わない)', () => {
    const bill = stdBill()!;
    const input = stdTransferCalldata(bill);
    expect(stdMarkCount({ from: CUSTOMER, to: POLYGON.address, input }, transfer(), bill)).toBe(1);
    expect(stdMarkCount({ from: CUSTOMER.toLowerCase(), to: POLYGON.address.toUpperCase().replace('0X', '0x'), input: input.toUpperCase().replace('0X', '0x') }, transfer(), bill)).toBe(1);
    expect(stdMarkCount({ from: SHOP, to: POLYGON.address, input }, transfer(), bill)).toBe(0);
    expect(stdMarkCount({ from: CUSTOMER, to: POLYGON.address, input: `${input}${MARK}` }, transfer(), bill)).toBe(0);
  });

  it('それ以外の tx: 「transfer + 印」の 100 byte が byte の境界から現れる回数 (半 byte ずれは数えない・宛先が無い tx も同じ)', () => {
    const bill = stdBill()!;
    const seq = stdTransferCalldata(bill).slice(2);
    const other = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
    expect(stdMarkCount({ from: CUSTOMER, to: other, input: `0x1234${seq}` }, transfer(), bill)).toBe(1);
    expect(stdMarkCount({ from: CUSTOMER, to: other, input: `0x${seq}00${seq}` }, transfer(), bill)).toBe(2);
    expect(stdMarkCount({ from: CUSTOMER, to: other, input: `0x0${seq}0` }, transfer(), bill)).toBe(0);
    expect(stdMarkCount({ from: CUSTOMER, to: null, input: `0xff${seq}` }, transfer(), bill)).toBe(1);
    // 印だけ (transfer の calldata が前に無い) は数えない。
    expect(stdMarkCount({ from: CUSTOMER, to: other, input: `0x${'00'.repeat(36)}${MARK}` }, transfer(), bill)).toBe(0);
  });
});

describe('1 つの入金で複数の会計を確かめたことにしない (stdCallsExceedTransfers)', () => {
  const other = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
  it('スマートアカウント等の tx: input の transfer(受取先, 額) の数が、同じ tx の合う Transfer の数を超えたら true', () => {
    const bill = stdBill()!;
    const seq = stdTransferCalldata(bill).slice(2);
    const plain = seq.slice(0, -64);
    const markB = billKeyStdMark('AAAAAAAAAAA')!.slice(2);
    // Transfer 1 つ + 「transfer + 印 A」と「transfer + 印 B」(別の端末の 2 つの会計) → 超える。
    expect(stdCallsExceedTransfers({ from: CUSTOMER, to: other, input: `0x${seq}${plain}${markB}` }, bill, 1)).toBe(true);
    // Transfer 1 つ + 印つきと印なしの transfer → 超える。
    expect(stdCallsExceedTransfers({ from: CUSTOMER, to: other, input: `0x${seq}${plain}` }, bill, 1)).toBe(true);
    // Transfer 2 つ + transfer 2 つ → 超えない (同じ額の 2 件の入金が 1 つの bundle に入った)。
    expect(stdCallsExceedTransfers({ from: CUSTOMER, to: other, input: `0x${seq}${plain}${markB}` }, bill, 2)).toBe(false);
    // Transfer 1 つ + transfer 1 つ → 超えない。半 byte ずれた並びは数えない。
    expect(stdCallsExceedTransfers({ from: CUSTOMER, to: other, input: `0x1234${seq}` }, bill, 1)).toBe(false);
    expect(stdCallsExceedTransfers({ from: CUSTOMER, to: other, input: `0x${seq}0${plain}0` }, bill, 1)).toBe(false);
  });

  it('宛先が JPYC の直接の送金は数えない (stdMarkCount がちょうどの一致を見る)', () => {
    const bill = stdBill()!;
    const input = stdTransferCalldata(bill);
    expect(stdCallsExceedTransfers({ from: CUSTOMER, to: POLYGON.address, input }, bill, 0)).toBe(false);
  });
});

describe('Transfer の読み方とふるい', () => {
  it('readTransferLog: token が出した Transfer だけを読む (別の address・形の違う log は null)', () => {
    const log = transferRpcLog({ token: POLYGON.address, from: CUSTOMER, to: SHOP, value: 5n, txHash: TX, blockNumber: 1n });
    expect(readTransferLog(log, POLYGON.address)).toEqual({ from: getAddress(CUSTOMER), to: getAddress(SHOP), value: 5n });
    expect(readTransferLog(log, FORWARDER)).toBeNull();
    expect(readTransferLog({ ...log, data: '0x' }, POLYGON.address)).toBeNull();
    expect(readTransferLog({ ...log, topics: log.topics.slice(0, 2) }, POLYGON.address)).toBeNull();
  });

  it('transferMatchesExpected: 受取先・額がちょうど同じで、送り手が forwarder でないときだけ', () => {
    const bill = stdBill()!;
    expect(transferMatchesExpected(transfer(), bill)).toBe(true);
    expect(transferMatchesExpected(transfer({ value: 1_000n * ONE - 1n }), bill)).toBe(false);
    expect(transferMatchesExpected(transfer({ value: 1_000n * ONE + 1n }), bill)).toBe(false);
    expect(transferMatchesExpected(transfer({ to: CUSTOMER }), bill)).toBe(false);
    expect(transferMatchesExpected(transfer({ from: FORWARDER }), bill)).toBe(false);
    // forwarder の無いチェーンの会計は、送り手を問わない。
    const noForwarder: QrStdBill = { ...bill, forwarder: null };
    expect(transferMatchesExpected(transfer({ from: FORWARDER }), noForwarder)).toBe(true);
  });
});

describe('buildQrStdSaleEntry (行)', () => {
  it('払った側の通常決済の行の欄 (flow standard-merchant・gasMode null・利用料 0・ネットワーク手数料相当額なし・block の番号)。2 件目以降は明細なし', () => {
    const bill = stdBill({ productName: 'ランチ', receiptNo: 'R-1', storeName: 'OpenPay Cafe' })!;
    const row = buildQrStdSaleEntry(bill, transfer(), TX, 995n, 1_790_000_000n, true);
    expect(row).toMatchObject({
      id: `standard-merchant-${TX}`, ts: 1_790_000_000_000, flow: 'standard-merchant', status: 'success',
      payMode: 'standard', gasMode: null, merchant: getAddress(SHOP), customer: getAddress(CUSTOMER),
      merchantAmount: (1_000n * ONE).toString(), feeAmount: '0', saleAmount: (1_000n * ONE).toString(),
      networkFeeEquivalent: null, feeReceiver: env.feeReceiver, txHash: TX, userOpHash: null, blockNumber: '995',
      storeName: 'OpenPay Cafe', productName: 'ランチ', receiptNo: 'R-1',
    });
    const second = buildQrStdSaleEntry(bill, transfer(), TX, 995n, 1_790_000_000n, false);
    expect(second).toMatchObject({ storeName: '', productName: null, receiptNo: null, lineItems: null });
  });
});
