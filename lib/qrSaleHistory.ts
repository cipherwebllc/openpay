// QR の会計の入金を、会計ごとの印 (bill key) で確かめて、お店の端末の取引履歴の 1 行を組む純関数。
// RPC も localStorage も触らない (読む・書くのは lib/qrSaleWatch.ts)。
//
// 確かめ方: お店は QR を出すたびに乱数の bill key を作って画面の QR の URL (`bk`) に載せ、払う側 (hooks/useJpycEip3009Payment)
// は intentSalt = billKeySalt(bill key) で署名する。forwarder の nonce (lib/relay/forwarderIntent の buildForwarderNonce) は
// 払った人・受取先・着金額・利用料・有効期限・intentSalt・チェーン・forwarder の全部の hash なので、チェーンの `Settled` の
// nonce が、同じ式で計算し直した値と一致すれば「この bill key の QR から作られた、この受取先への支払い」と分かる。
// 一致しない `Settled` (bill key を使わない支払い・ほかの端末の会計・古い画面) は、何の行にもしない。
//   - nonce は log の値 (from・merchant・merchantValue・feeValue) で計算する。会計の期待値と比べるのは一致した後。
//   - 有効期限 (validBefore) は log に無いので、取り込まれた block の時刻 T から T+1 … T+AUTHORIZATION_LOOKUP_WINDOW_SEC を
//     1 秒ずつ試す (署名は block の時刻より後まで有効・relay の server は受付時刻 + 20 分より先の有効期限を受けない)。
//   - salt と nonce の式は、払う側と同じ関数を import して使う (再実装しない)。
//
// 行の欄は、払った側 (/pay の PaymentForm・/checkout の CheckoutForm → hooks/usePaymentHistory.ts) が同じ支払いで書く行に
// 合わせる (tests/components/qrSaleHistory.parity.test.tsx が両方を実際に作って欄ごとに比べる)。違うのは時刻 (ts) だけで、
// お店の行は block の時刻。金額・お客様は log の値、明細・管理番号などは QR を出した時点の会計の写し (QR の URL と
// 同じ中身を、払う側と同じ parser で読んだ値)。

import { formatUnits, getAddress, isAddressEqual, parseUnits, type Address, type Hex } from 'viem';
import { chainForSlug } from './chains';
import { buildCheckoutLineItems } from './checkoutLineItems';
import { env } from './env';
import { buildHistoryEntry, type HistoryEntry } from './history';
import { receiptSettlements } from './order/agentOrderReceipt';
import { billKeySalt } from './relay/billKeySalt';
import { jpycForwarderFor } from './relay/forwarderConfig';
import { buildForwarderNonce } from './relay/forwarderIntent';
import { recoverFeeValue } from './relay/recoverFee';
import { AUTHORIZATION_LOOKUP_WINDOW_SEC } from './relay/validityWindow';
import { counterpartSymbol, DEFAULT_CHAIN_FOR_SYMBOL, deploymentForSlug, type TokenDeployment } from './tokens';
import {
  calcCheckoutPayable,
  parseCheckoutParams,
  parsePayParams,
  type CheckoutParams,
  type PayParams,
} from './url';
import type { ChainSlug } from './chains';

/** お店の画面が QR を出したときに渡す会計 (memory だけに持つ・保存しない)。 */
export type QrBillInput = {
  /** 会計ごとの印 (画面の QR の URL の `bk`)。 */
  billKey: string;
  /** 決済QR (/pay) か、レジ (/checkout) か。 */
  kind: 'pay' | 'checkout';
  /** QR の URL (bill key を足す前)。会計の写し = 払う側が読むのと同じ中身。 */
  url: string;
  /** /pay の値引きの行の名前 (商品名も店名も無いとき・払う側の PaymentForm の discountItemName と同じ言葉)。 */
  itemName: string;
};

/** 見張る会計 (QR の URL を、払う側と同じ parser で読んだもの)。 */
export type QrBill = {
  billKey: string;
  intentSalt: Hex;
  chainId: number;
  chainSlug: ChainSlug;
  deployment: TokenDeployment;
  forwarder: Address;
  merchant: Address;
  /** 払う側が同じ URL から計算する、Settled の着金額と利用料 (利用料は recoverFeeValue の式・お店が負担)。 */
  expected: { merchantValue: bigint; feeValue: bigint };
  sale:
    | { kind: 'pay'; params: PayParams; itemName: string }
    | { kind: 'checkout'; params: CheckoutParams };
};

/**
 * QR の URL を読んで、見張る会計にする。null = この QR は見張らない (bill key の形が違う・URL を読めない・JPYC の
 * ガスレスでない・forwarder の無いチェーン・金額が無い・利用料を引くと着金額が残らない)。
 */
export function readQrBill(input: QrBillInput): QrBill | null {
  const intentSalt = billKeySalt(input.billKey);
  if (!intentSalt) return null;
  const query = input.url.indexOf('?');
  if (query < 0) return null;
  const search = new URLSearchParams(input.url.slice(query + 1));
  let sale: QrBill['sale'];
  if (input.kind === 'pay') {
    const parsed = parsePayParams(search);
    if (!parsed.ok) return null;
    sale = { kind: 'pay', params: parsed.params, itemName: input.itemName };
  } else {
    const parsed = parseCheckoutParams(search);
    if (!parsed.ok) return null;
    sale = { kind: 'checkout', params: parsed.params };
  }
  const { to, token, chain, mode } = sale.params;
  if (token !== 'jpyc' || mode === 'standard') return null;
  const chainSlug = chain ?? DEFAULT_CHAIN_FOR_SYMBOL.jpyc;
  const chainId = chainForSlug(chainSlug).id;
  const deployment = deploymentForSlug('jpyc', chainSlug);
  const forwarder = jpycForwarderFor(chainId);
  if (!forwarder) return null;
  // 請求額: 払う側が同じ URL から relay に渡す額 (/pay は amount・/checkout は明細の合計 − 値引き)。
  let bill: bigint;
  if (sale.kind === 'pay') {
    if (!sale.params.amount) return null;
    bill = parseUnits(sale.params.amount, deployment.decimals);
  } else {
    bill = calcCheckoutPayable(sale.params, deployment.decimals);
  }
  // 払う側 (hooks/useJpycEip3009Payment の recover の分岐・お店が負担) と同じ式。
  const feeValue = recoverFeeValue(bill, 'merchant', chainId);
  const merchantValue = bill - feeValue;
  if (merchantValue <= 0n) return null;
  return {
    billKey: input.billKey,
    intentSalt,
    chainId,
    chainSlug,
    deployment,
    forwarder,
    merchant: getAddress(to),
    expected: { merchantValue, feeValue },
    sale,
  };
}

/** forwarder の `Settled` 1 つ (log の値)。 */
export type SettledLog = {
  from: Address;
  nonce: Hex;
  merchant: Address;
  merchantValue: bigint;
  feeValue: bigint;
};

/** RPC が返した log 1 つを `Settled` として読む。forwarder が出した `Settled` でなければ null (server と同じ読み解き)。 */
export function readSettledLog(
  log: { address: string; topics: readonly string[]; data: string },
  forwarder: Address,
): SettledLog | null {
  const [args] = receiptSettlements([log], forwarder);
  if (!args) return null;
  return {
    from: args.from,
    nonce: args.nonce,
    merchant: args.merchant,
    merchantValue: args.merchantValue,
    feeValue: args.feeValue,
  };
}

// 試す有効期限の順 (block の時刻からの秒)。払う側は「端末の時刻 + 300 秒」で署名するので、取り込みが早い支払いは
// +300 の少し手前で見つかる。+300 から外へ広げる (+300・+299・+301・+298 …)。範囲は +1 から上限まで全部。
const VALID_BEFORE_OFFSETS: readonly bigint[] = (() => {
  const center = 300;
  const out: bigint[] = [BigInt(center)];
  for (let step = 1; center - step >= 1 || center + step <= AUTHORIZATION_LOOKUP_WINDOW_SEC; step += 1) {
    if (center - step >= 1) out.push(BigInt(center - step));
    if (center + step <= AUTHORIZATION_LOOKUP_WINDOW_SEC) out.push(BigInt(center + step));
  }
  return out;
})();

/**
 * この `Settled` が、この会計の bill key で署名された支払いか。一致したら、その署名の有効期限 (validBefore) を返す。
 * blockTime = この `Settled` が取り込まれた block の時刻 (unix 秒)。
 */
export function matchSettledToBill(settled: SettledLog, blockTime: bigint, bill: QrBill): bigint | null {
  if (!isAddressEqual(settled.merchant, bill.merchant)) return null;
  const nonce = settled.nonce.toLowerCase();
  for (const offset of VALID_BEFORE_OFFSETS) {
    const validBefore = blockTime + offset;
    const candidate = buildForwarderNonce(
      {
        from: settled.from,
        merchant: settled.merchant,
        merchantValue: settled.merchantValue,
        feeReceiver: env.feeReceiver as Address,
        feeValue: settled.feeValue,
        validAfter: 0n,
        validBefore,
        intentSalt: bill.intentSalt,
      },
      bill.chainId,
      bill.forwarder,
    );
    if (candidate.toLowerCase() === nonce) return validBefore;
  }
  return null;
}

/** 一致した `Settled` の着金額と利用料が、この会計の期待値とちょうど同じか (明細を付けてよいか)。 */
export function settledMatchesExpected(settled: SettledLog, bill: QrBill): boolean {
  return (
    settled.merchantValue === bill.expected.merchantValue && settled.feeValue === bill.expected.feeValue
  );
}

// 会計の写しから作る欄 (払った側の historyCtx と同じ組み方)。
type SaleDetail = Pick<
  Parameters<typeof buildHistoryEntry>[0],
  | 'storeName'
  | 'note'
  | 'anchorAmount'
  | 'anchorSymbol'
  | 'fxRateUsdcJpy'
  | 'productName'
  | 'memo'
  | 'taxRate'
  | 'taxCategory'
  | 'receiptNo'
  | 'lineItems'
>;

const NO_DETAIL: SaleDetail = { storeName: '', note: '' };

// 決済QR (/pay): components/PaymentForm.tsx の historyCtx と同じ。
function payDetail(params: PayParams, itemName: string, decimals: number): SaleDetail {
  const amount = params.amount ?? '';
  const discountWei = params.discount ? parseUnits(params.discount, decimals) : 0n;
  // 値引き前の額 (= 支払額 + 値引き)。
  const listAmount =
    discountWei > 0n ? formatUnits(parseUnits(amount, decimals) + discountWei, decimals) : null;
  return {
    storeName: params.storeName ?? '',
    note: '',
    anchorAmount: params.priceRefAmount ?? null,
    anchorSymbol: params.priceRefAmount ? counterpartSymbol(params.token) : null,
    fxRateUsdcJpy: params.fxRate ?? null,
    productName: params.productName ?? null,
    memo: params.memo ?? null,
    taxRate: params.taxRate ?? null,
    taxCategory: params.taxCategory ?? null,
    receiptNo: params.receiptNo ?? null,
    lineItems:
      listAmount && params.discount
        ? buildCheckoutLineItems({
            items: [
              {
                name: params.productName || params.storeName || itemName,
                qty: 1,
                price: listAmount,
                ...(params.memo ? { memo: params.memo } : {}),
              },
            ],
            discount: params.discount,
            token: params.token,
            decimals,
            taxRate: params.taxRate ?? null,
            taxCategory: params.taxCategory ?? null,
          })
        : params.productName
          ? [
              {
                name: params.productName,
                quantity: 1,
                unitPrice: amount,
                amount,
                taxRate: params.taxRate ?? null,
                taxCategory: params.taxCategory ?? null,
                memo: params.memo ?? null,
              },
            ]
          : null,
  };
}

// レジ (/checkout): components/CheckoutForm.tsx の historyCtx と同じ (店名は行に入れない = 払った側も空)。
function checkoutDetail(params: CheckoutParams, decimals: number): SaleDetail {
  return {
    storeName: '',
    note: params.description ?? params.orderId ?? '',
    productName: params.items.map((it) => it.name).join(', '),
    memo: params.description ?? null,
    taxRate: params.taxRate ?? null,
    taxCategory: params.taxCategory ?? null,
    receiptNo: params.receiptNo ?? null,
    lineItems: buildCheckoutLineItems({
      items: params.items,
      discount: params.discount,
      token: params.token,
      decimals,
      taxRate: params.taxRate,
      taxCategory: params.taxCategory,
    }),
  };
}

/**
 * 一致した `Settled` → 履歴の 1 行。金額・お客様は log の値・時刻は block の時刻。withDetail = この会計の写しの明細・
 * 管理番号などを付けるか (その会計の 1 件目で、金額も期待値と同じときだけ・決めるのは lib/qrSaleWatch.ts)。
 */
export function buildQrSaleEntry(
  bill: QrBill,
  settled: SettledLog,
  txHash: string,
  blockTime: bigint,
  withDetail: boolean,
): HistoryEntry {
  const detail = !withDetail
    ? NO_DETAIL
    : bill.sale.kind === 'pay'
      ? payDetail(bill.sale.params, bill.sale.itemName, bill.deployment.decimals)
      : checkoutDetail(bill.sale.params, bill.deployment.decimals);
  return buildHistoryEntry({
    ts: Number(blockTime) * 1000,
    flow: 'batch',
    status: 'success',
    chainId: bill.chainId,
    chainSlug: bill.chainSlug,
    asset: 'jpyc',
    tokenAddress: bill.deployment.address,
    payMode: 'gasless',
    // 回収 (forwarder) の決済は、お店が利用料を負担する固定 (lib/paymentMoney.ts の effectiveGasMode)。
    gasMode: 'merchant',
    merchant: bill.merchant,
    merchantAmount: settled.merchantValue,
    customer: settled.from,
    feeReceiver: env.feeReceiver,
    // 払った側と同じ欄の分け方 (hooks/useRelayGaslessSnapshot.ts): 利用料の欄は 0・回収した額はネットワーク手数料相当額。
    feeAmount: 0n,
    saleAmount: settled.merchantValue + settled.feeValue,
    networkFeeEquivalent: settled.feeValue,
    txHash,
    userOpHash: null,
    blockNumber: null,
    errorMessage: null,
    ...detail,
  });
}
