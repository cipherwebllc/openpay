// モバイルオーダーの受注 (受注フィードの 1 件) から、お店の端末の取引履歴の 1 行を組む純関数。
// RPC も localStorage も触らない (読む・書くのは lib/orderFeedHistoryRecorder.ts)。
//
// 行は、払った側 (CheckoutForm → usePaymentHistory) が同じ注文で書く行と、同じ id・同じ値にそろえる。
//   - 金額の欄 (着金・利用料・売上総額・ネットワーク手数料相当額・負担者・お客様) は、server がオンチェーンで確かめた
//     着金額 (order.amount) と、tx の receipt (forwarder の Settled・token の Transfer) と、build の定数だけから決める。
//     お客様の申告 (明細の合計・order.from) からは決めない。決められない欄は null (履歴の「内訳なし」と同じ扱い)。
//   - 説明の欄 (明細・メモ・管理番号・商品名) は、受注の画面に出ている注文の値をそのまま写す。
//
// 経路ごとの対応 (M = 着金額・F = Settled の feeValue):
//   forwarder の Settled あり (ガスレス・recover)
//     モバイル注文の利用料・お客様が負担 (F = M の 3%)        gasMode customer / fee F / 売上 M     / 網 null
//     モバイル注文の利用料・お店が負担 (F = (M+F) の 1% か 3%) gasMode merchant / fee F / 売上 M + F / 網 null
//     それ以外 (ガス相当額の回収)                             gasMode merchant / fee 0 / 売上 M + F / 網 F
//   Settled なし・relay (forwarder の無いチェーン)             gasMode customer / fee 0 / 売上 M     / 網 0
//   Settled なし・通常決済 (unboundPayment)                    gasMode null     / 利用料の flag が OFF なら fee 0・売上 M、
//                                                              ON なら fee・売上は null (利用料は別の tx で、この receipt に無い)
//   receipt を読めなかった                                     分かる欄 (着金額・明細など) だけ。ほかは null

import { formatUnits, getAddress, isAddressEqual, type Address } from 'viem';
import { buildCheckoutLineItems } from './checkoutLineItems';
import { slugForChain } from './chains';
import { env } from './env';
import type { GasMode } from './fee';
import { buildHistoryEntry, type HistoryEntry, type HistoryLineItem } from './history';
import { mobileOrderFeeValue } from './mobileOrderFee';
import { receiptSettlements, receiptTokenTransfers } from './order/agentOrderReceipt';
import { isTxHashLike, type StoredOrder } from './orderRelay';
import { configuredJpycForwarderFor } from './relay/forwarderConfig';
import { resolveDeployment } from './tokens';

/** 読んだ receipt のうち、行を組むのに使う部分。 */
export type OrderSaleReceipt = {
  status: 'success' | 'reverted';
  blockNumber: bigint;
  logs: readonly { address: string; topics: readonly string[]; data: string }[];
};

/** receipt から分かったこと。none = 読めなかった・どの入金か 1 つに決められなかった。 */
export type OrderSaleEvidence =
  | { kind: 'settled'; customer: Address; feeValue: bigint; blockNumber: bigint }
  | { kind: 'direct'; customer: Address | null; blockNumber: bigint }
  | { kind: 'none' };

/** 行を書いてよい注文か (txHash があり、着金額が数字で、明細が配列)。受注フィードの応答は型を確かめずに届く。 */
export function isRecordableOrder(order: StoredOrder): boolean {
  return (
    isTxHashLike(order.txHash) &&
    typeof order.amount === 'string' &&
    /^\d+$/.test(order.amount) &&
    Number.isInteger(order.chainId) &&
    Array.isArray(order.items)
  );
}

/** 払った側が同じ注文で書く行と同じ flow (履歴の id = `${flow}-${txHash}` の前半)。 */
export function orderSaleFlow(order: StoredOrder): 'batch' | 'standard-merchant' {
  return order.unboundPayment ? 'standard-merchant' : 'batch';
}

/**
 * receipt から、この注文の入金の証拠を読む。null = receipt がこの受取先への入金を示していない (行を書かない)。
 * 読み解きは server が受注を確かめたときと同じ関数 (lib/order/agentOrderReceipt.ts)。
 */
export function readOrderSaleEvidence(
  order: StoredOrder,
  merchant: Address,
  receipt: OrderSaleReceipt,
): OrderSaleEvidence | null {
  const deployment = resolveDeployment('jpyc', order.chainId);
  if (!deployment) return { kind: 'none' };
  if (receipt.status !== 'success') return null;
  const toMerchant = receiptTokenTransfers(receipt.logs, deployment.address).filter((t) =>
    isAddressEqual(t.to, merchant),
  );
  // 受注フィードの応答は server の session で決まる。別のウォレットへ切り替えた直後に、前のウォレットの名義で
  // 別の受取先の注文を売上として書かないよう、この受取先への入金が receipt に無い注文は書かない。
  if (toMerchant.length === 0) return null;
  const amount = BigInt(order.amount);
  const forwarder = configuredJpycForwarderFor(order.chainId);
  const settlements = forwarder ? receiptSettlements(receipt.logs, forwarder) : [];
  if (settlements.length > 0) {
    const mine = settlements.filter(
      (s) => isAddressEqual(s.merchant, merchant) && s.merchantValue === amount,
    );
    // 同じ tx に、同じ受取先・同じ額の Settled が 2 つ以上あると、どちらのお客様・利用料か決められない。
    if (mine.length !== 1) return { kind: 'none' };
    return {
      kind: 'settled',
      customer: getAddress(mine[0].from),
      feeValue: mine[0].feeValue,
      blockNumber: receipt.blockNumber,
    };
  }
  // Settled が無い = お客様から受取先への直接の Transfer (通常決済・forwarder を通らない relay)。受取先への Transfer が
  // ちょうど 1 本で、額が着金額と同じときだけ、その送り主をお客様とする。
  const only = toMerchant.length === 1 && toMerchant[0].value === amount ? toMerchant[0] : null;
  const customer =
    only && !(forwarder && isAddressEqual(only.from, forwarder)) ? getAddress(only.from) : null;
  return { kind: 'direct', customer, blockNumber: receipt.blockNumber };
}

type SaleMoney = {
  gasMode: GasMode | null;
  customer: Address | null;
  feeAmount: bigint | null;
  saleAmount: bigint | null;
  networkFeeEquivalent: bigint | null;
  blockNumber: bigint | null;
};

function saleMoney(order: StoredOrder, amount: bigint, evidence: OrderSaleEvidence): SaleMoney {
  const customer = evidence.kind === 'none' ? null : evidence.customer;
  if (order.unboundPayment) {
    // 通常決済: モバイル注文の利用料は別の tx (お店は hash を知らない)。利用料の flag が OFF の build では利用料 0・売上 = 着金額。
    // ON では、お店が負担 (売上 = 着金額 + 利用料) かお客様が負担 (売上 = 着金額) かが receipt から分からない。
    const noFee = !env.enableMobileOrderFee;
    return {
      gasMode: null,
      customer,
      feeAmount: noFee ? 0n : null,
      saleAmount: noFee ? amount : null,
      networkFeeEquivalent: null,
      // 払った側の通常決済の行は、店舗への送金の block を持つ。
      blockNumber: evidence.kind === 'none' ? null : evidence.blockNumber,
    };
  }
  // ここから relay (払った側の行は block を持たない)。
  if (evidence.kind === 'settled') {
    const fee = evidence.feeValue;
    const gross = amount + fee;
    if (env.enableMobileOrderFee) {
      // モバイル注文の利用料は、払う額の一律 % (lib/mobileOrderFee.ts)。チェーンに載った額が式とちょうど合うかで見分ける。
      if (fee === mobileOrderFeeValue(amount, 'preorder')) {
        return { gasMode: 'customer', customer, feeAmount: fee, saleAmount: amount, networkFeeEquivalent: null, blockNumber: null };
      }
      if (
        fee === mobileOrderFeeValue(gross, 'storefront') ||
        fee === mobileOrderFeeValue(gross, 'preorder')
      ) {
        return { gasMode: 'merchant', customer, feeAmount: fee, saleAmount: gross, networkFeeEquivalent: null, blockNumber: null };
      }
    }
    // モバイル注文の利用料でない recover = ガス相当額の回収 (お店が負担)。
    return { gasMode: 'merchant', customer, feeAmount: 0n, saleAmount: gross, networkFeeEquivalent: fee, blockNumber: null };
  }
  if (evidence.kind === 'direct') {
    // forwarder を通らない relay (利用料なし・ガスは OpenPay が負担)。モバイル注文の画面は gas=customer で会計を作る。
    return { gasMode: 'customer', customer, feeAmount: 0n, saleAmount: amount, networkFeeEquivalent: 0n, blockNumber: null };
  }
  return { gasMode: null, customer: null, feeAmount: null, saleAmount: null, networkFeeEquivalent: null, blockNumber: null };
}

function orderLineItems(order: StoredOrder, decimals: number): HistoryLineItem[] | null {
  if (order.items.length === 0) return null;
  try {
    // 払った側と同じ関数。値引きは受注に付いた額 (server が公開設定から出した額) を、払った側と同じく 10 進の文字列で渡す。
    return buildCheckoutLineItems({
      items: order.items.map(({ name, qty, price }) => ({ name, qty, price })),
      ...(order.discount ? { discount: formatUnits(BigInt(order.discount), decimals) } : {}),
      token: 'jpyc',
      decimals,
    });
  } catch {
    // 束縛の無い注文の明細はお客様の申告で、単価が数字でないことがある (受注の画面は品名と数量だけを出す)。
    // 申告の形の崩れが、確かめ済みの入金の行を書けないことへ波及しないよう、画面と同じ品名と数量だけの明細にする。
    return order.items.map((it, i) => ({
      id: String(i),
      name: it.name,
      quantity: it.qty,
      unitPrice: typeof it.price === 'string' ? it.price : '',
      amount: '',
      taxRate: null,
      taxCategory: null,
      memo: null,
    }));
  }
}

/**
 * 受注 1 件 → 履歴の 1 行。null = この注文は書けない (chain・token の表に無い = chainSlug と tokenAddress を埋められない)。
 * merchant は受注フィードを読んだ SIWE の session のアドレス (注文は受取先を持たない)。
 */
export function buildOrderSaleEntry(
  order: StoredOrder,
  merchant: Address,
  evidence: OrderSaleEvidence,
): HistoryEntry | null {
  const deployment = resolveDeployment('jpyc', order.chainId);
  const chainSlug = slugForChain(order.chainId);
  if (!deployment || !chainSlug) return null;
  const amount = BigInt(order.amount);
  const money = saleMoney(order, amount, evidence);
  // 受付番号が無い会計は、server が txHash を番号の代わりに入れる。払った側の行は番号なし。
  const orderNo = order.orderId && order.orderId !== order.txHash ? order.orderId : null;
  const standard = order.unboundPayment === true;
  return buildHistoryEntry({
    // 払った側の行の時刻は、払った端末の時計。お店の行は、server が受注を受け取った時刻。
    ...(order.ts > 0 ? { ts: order.ts } : {}),
    flow: orderSaleFlow(order),
    status: 'success',
    chainId: order.chainId,
    chainSlug,
    asset: 'jpyc',
    tokenAddress: deployment.address,
    payMode: standard ? 'standard' : 'gasless',
    gasMode: money.gasMode,
    merchant,
    merchantAmount: amount,
    customer: money.customer,
    feeReceiver: env.feeReceiver,
    feeAmount: money.feeAmount,
    saleAmount: money.saleAmount,
    networkFeeEquivalent: money.networkFeeEquivalent,
    txHash: order.txHash,
    userOpHash: null,
    blockNumber: money.blockNumber,
    errorMessage: null,
    storeName: '',
    // 払った側: note = description ?? orderId・memo = description・receiptNo = 受付番号 (モバイル注文の画面が付ける)。
    note: order.table ?? orderNo ?? '',
    productName: order.items.map((it) => it.name).join(', '),
    memo: order.table,
    receiptNo: orderNo,
    lineItems: orderLineItems(order, deployment.decimals),
  });
}
