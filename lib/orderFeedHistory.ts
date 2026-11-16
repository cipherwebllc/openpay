// モバイルオーダーの受注 (受注フィードの 1 件) から、お店の端末の取引履歴の 1 行を組む純関数。
// RPC も localStorage も触らない (読む・書くのは lib/orderFeedHistoryRecorder.ts)。
//
// 第一の約束は「誤った売上の行を作らない」。確かめられない注文は書かず、確かめられない欄は null にする。
//   - 書くのは、お客様のブラウザから払ったモバイル注文だけ (エージェント注文は書かない・isRecordableOrder)。
//   - 書くのは、tx の receipt を読めて、要求した tx の receipt で、成功していて、受取先 (SIWE の session のアドレス) への
//     入金がある注文だけ (readOrderSaleEvidence が null を返したら書かない)。
//   - 金額の欄 (着金・利用料・売上総額・ネットワーク手数料相当額・負担者・お客様) は、server がオンチェーンで確かめた
//     着金額 (order.amount) と、tx の receipt (forwarder の Settled・token の Transfer) と、build の定数だけから決める。
//     お客様の申告 (明細の合計・order.from) からは決めない。決められない欄は null (履歴の「内訳なし」と同じ扱い)。
//   - 説明の欄 (明細・メモ・管理番号・商品名) は、受注の画面に出ている注文の値をそのまま写す。
// 行は、払った側 (CheckoutForm → usePaymentHistory) が同じ注文で書く行と、同じ id・同じ値にそろえる。
//
// 経路ごとの対応 (M = 着金額・F = Settled の feeValue・G = M + F)。Settled の F が式にちょうど合うかで決める (settledSaleSplit):
//   forwarder の Settled あり (ガスレス・recover)・利用料の flag が ON の build (利用料の式を先に見る)
//     モバイル注文の利用料・お店が負担 (F = G の 1% か 3%)       gasMode merchant / fee F / 売上 G / 網 null
//     モバイル注文の利用料・お客様が負担 (F = M の 3%)           gasMode customer / fee F / 売上 M / 網 null
//     利用料の式の 2 つ以上に合う                               どの式でも同じ欄だけ (式で変わる欄は null)
//     利用料の式に合わず、回収の式 (F = max(フロア, G × 率)) に合う  gasMode merchant / fee 0 / 売上 G / 網 F
//     どれにも合わない                                         gasMode・fee・売上・網はすべて null
//     (限界: feeKind の無い手作りの /checkout の URL の回収が利用料の式にも合う額は、利用料として書く。払った側は fee 0・網 F)
//   forwarder の Settled あり・利用料の flag が OFF の build
//     回収の式に合う                                           gasMode merchant / fee 0 / 売上 G / 網 F
//     合わない                                                 gasMode・fee・売上・網はすべて null
//   Settled なし・relay (forwarder の無いチェーン)               gasMode customer / fee 0 / 売上 M / 網 0
//   Settled なし・通常決済 (unboundPayment)                      gasMode null     / 利用料の flag が OFF なら fee 0・売上 M、
//                                                                ON なら fee・売上は null (利用料は別の tx で、この receipt に無い)

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
import { recoverFeeValue } from './relay/recoverFee';
import { resolveDeployment } from './tokens';

/** 読んだ receipt のうち、行を組むのに使う部分。 */
export type OrderSaleReceipt = {
  transactionHash: string;
  status: 'success' | 'reverted';
  blockNumber: bigint;
  logs: readonly { address: string; topics: readonly string[]; data: string }[];
};

/** receipt で確かめた、この受取先への入金。 */
export type OrderSaleEvidence =
  | { kind: 'settled'; customer: Address; feeValue: bigint; blockNumber: bigint }
  | { kind: 'direct'; customer: Address | null; blockNumber: bigint };

// エージェント注文の受付番号の頭。server は x402 で払われたエージェント注文を、orderId = `agent-<nonce の頭>` で同じ受注リストに
// 保存する (lib/order/agentOrderFinalize.ts・app/api/agent-order/pay/route.ts)。受注の画面は人の注文と区別しない。
const AGENT_ORDER_ID_PREFIX = 'agent-';

/**
 * エージェント注文か。料金の式が人の注文と違い (お客様への上乗せ・x402 の料金)、同じ tx に複数の受注が載りうるので、
 * お店の履歴には書かない。お客様が `agent-` で始まる受付番号を名乗った注文も書かれないだけ (書かない側に倒れる)。
 */
export function isAgentOrder(order: StoredOrder): boolean {
  return typeof order.orderId === 'string' && order.orderId.startsWith(AGENT_ORDER_ID_PREFIX);
}

/**
 * 行を書いてよい注文か (txHash があり、着金額が数字で、明細が配列で、chain・token の表にあり、エージェント注文でない)。
 * 受注フィードの応答は型を確かめずに届く。
 */
export function isRecordableOrder(order: StoredOrder): boolean {
  return (
    isTxHashLike(order.txHash) &&
    typeof order.amount === 'string' &&
    /^\d+$/.test(order.amount) &&
    Number.isInteger(order.chainId) &&
    Array.isArray(order.items) &&
    resolveDeployment('jpyc', order.chainId) !== undefined &&
    slugForChain(order.chainId) !== undefined &&
    !isAgentOrder(order)
  );
}

/** 払った側が同じ注文で書く行と同じ flow (履歴の id = `${flow}-${txHash}` の前半)。 */
export function orderSaleFlow(order: StoredOrder): 'batch' | 'standard-merchant' {
  return order.unboundPayment ? 'standard-merchant' : 'batch';
}

/**
 * receipt から、この受取先への入金を読む。null = 行を書かない (要求した tx の receipt でない・成功していない・この受取先への
 * 入金が無い・どの入金か 1 つに決められない)。読み解きは server が受注を確かめたときと同じ関数 (lib/order/agentOrderReceipt.ts)。
 */
export function readOrderSaleEvidence(
  order: StoredOrder,
  merchant: Address,
  receipt: OrderSaleReceipt,
): OrderSaleEvidence | null {
  // RPC が別の tx の receipt を返したら、その tx のお客様・利用料をこの注文の行に写さない。
  if (
    typeof receipt.transactionHash !== 'string' ||
    receipt.transactionHash.toLowerCase() !== order.txHash.toLowerCase()
  ) {
    return null;
  }
  if (receipt.status !== 'success') return null;
  const deployment = resolveDeployment('jpyc', order.chainId);
  if (!deployment) return null;
  const amount = BigInt(order.amount);
  const forwarder = configuredJpycForwarderFor(order.chainId);
  const settlements = forwarder ? receiptSettlements(receipt.logs, forwarder) : [];
  // 受注フィードの応答は、その時の cookie の session で決まる。別のタブで別の店主にサインインした後に届いた注文
  // (別の受取先への入金) を、この受取先の売上として書かないよう、この受取先への入金が receipt に無い注文は書かない。
  if (settlements.length > 0) {
    const mine = settlements.filter(
      (s) => isAddressEqual(s.merchant, merchant) && s.merchantValue === amount,
    );
    // この受取先・この額の Settled が無い、または 2 つ以上 (どちらのお客様・利用料か決められない) なら書かない。
    if (mine.length !== 1) return null;
    return {
      kind: 'settled',
      customer: getAddress(mine[0].from),
      feeValue: mine[0].feeValue,
      blockNumber: receipt.blockNumber,
    };
  }
  const toMerchant = receiptTokenTransfers(receipt.logs, deployment.address).filter((t) =>
    isAddressEqual(t.to, merchant),
  );
  if (toMerchant.length === 0) return null;
  // Settled が無い = お客様から受取先への直接の Transfer (通常決済・forwarder を通らない relay)。受取先への Transfer が
  // ちょうど 1 本で、額が着金額と同じときだけ、その送り主をお客様とする。
  const only = toMerchant.length === 1 && toMerchant[0].value === amount ? toMerchant[0] : null;
  const customer =
    only && !(forwarder && isAddressEqual(only.from, forwarder)) ? getAddress(only.from) : null;
  return { kind: 'direct', customer, blockNumber: receipt.blockNumber };
}

/** 経路で変わる欄 (負担者・利用料・売上総額・ネットワーク手数料相当額)。 */
export type OrderSaleSplit = {
  gasMode: GasMode | null;
  feeAmount: bigint | null;
  saleAmount: bigint | null;
  networkFeeEquivalent: bigint | null;
};

const UNKNOWN_SPLIT: OrderSaleSplit = {
  gasMode: null,
  feeAmount: null,
  saleAmount: null,
  networkFeeEquivalent: null,
};

/** 経路の候補が 2 つ以上あるとき: どの候補でも同じ欄だけを残し、候補で変わる欄は null にする。 */
function sharedSplit([first, ...rest]: readonly [OrderSaleSplit, ...OrderSaleSplit[]]): OrderSaleSplit {
  const shared = <K extends keyof OrderSaleSplit>(key: K): OrderSaleSplit[K] | null =>
    rest.every((s) => s[key] === first[key]) ? first[key] : null;
  return {
    gasMode: shared('gasMode'),
    feeAmount: shared('feeAmount'),
    saleAmount: shared('saleAmount'),
    networkFeeEquivalent: shared('networkFeeEquivalent'),
  };
}

/**
 * forwarder の Settled (着金額 amount・利用料 feeValue) から、経路で変わる欄を決める。feeValue が、払った側の式
 * (hooks/useRelayGaslessSnapshot.ts: feeKind ありはモバイル注文の利用料・無しは回収) にちょうど合うかで経路を決める。
 *   - 利用料の flag が ON の build: 受注フィードの注文はモバイル注文の画面を通り、画面は必ず feeKind を付ける (払った側の行は
 *     利用料の欄に F)。よって利用料の式を先に見て、1 つでも合えば回収の式は候補にしない。利用料の式の 2 つ以上に合うとき
 *     (事前 3% のお店が負担とお客様が負担が、1,100 wei 以下の額で重なる) は、どちらでも同じ欄だけを埋める。利用料の式に
 *     合わず回収の式に合えば回収。どれにも合わなければ 4 欄とも null (推測で売上総額を作らない)。
 *     限界: feeKind の無い手作りの /checkout の URL の回収が、利用料の式にも合う額 (回収 1% の build の店頭 1%・回収 3% の
 *     build の事前 3%・額がフロアと同じ) だと、利用料として書く (払った側は利用料 0・ネットワーク手数料相当額 F)。
 *   - 利用料の flag が OFF の build: 回収の式に合えば回収・合わなければ 4 欄とも null。
 */
export function settledSaleSplit(amount: bigint, feeValue: bigint, chainId: number): OrderSaleSplit {
  const gross = amount + feeValue;
  // ガス相当額の回収 (feeKind の無い会計・利用料の flag が OFF の build)。/checkout の回収はお店の負担に固定
  // (lib/paymentMoney.ts の effectiveGasMode)。払った側はネットワーク手数料相当額の欄に入れ、利用料は 0。
  const recover: OrderSaleSplit | null =
    feeValue === recoverFeeValue(gross, 'merchant', chainId)
      ? { gasMode: 'merchant', feeAmount: 0n, saleAmount: gross, networkFeeEquivalent: feeValue }
      : null;
  if (!env.enableMobileOrderFee) return recover ?? UNKNOWN_SPLIT;
  // モバイル注文の利用料 (lib/mobileOrderFee.ts・払う額の一律 %)。
  const mobile: OrderSaleSplit[] = [];
  // お店が負担 (storefront 1%・preorder 3%): 利用料 = 注文額 (= 着金額 + 利用料) の %。
  for (const kind of ['storefront', 'preorder'] as const) {
    if (feeValue === mobileOrderFeeValue(gross, kind)) {
      mobile.push({ gasMode: 'merchant', feeAmount: feeValue, saleAmount: gross, networkFeeEquivalent: null });
    }
  }
  // お客様が負担 (preorder・feePayer=customer): 利用料 = 注文額 (= 着金額) の 3%。
  if (feeValue === mobileOrderFeeValue(amount, 'preorder')) {
    mobile.push({ gasMode: 'customer', feeAmount: feeValue, saleAmount: amount, networkFeeEquivalent: null });
  }
  const [first, ...rest] = mobile;
  if (first) return sharedSplit([first, ...rest]);
  return recover ?? UNKNOWN_SPLIT;
}

type SaleMoney = OrderSaleSplit & { customer: Address | null; blockNumber: bigint | null };

function saleMoney(order: StoredOrder, amount: bigint, evidence: OrderSaleEvidence): SaleMoney {
  const customer = evidence.customer;
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
      blockNumber: evidence.blockNumber,
    };
  }
  // ここから relay (払った側の行は block を持たない)。
  if (evidence.kind === 'settled') {
    return { ...settledSaleSplit(amount, evidence.feeValue, order.chainId), customer, blockNumber: null };
  }
  // forwarder を通らない relay (利用料なし・ガスは OpenPay が負担)。モバイル注文の画面は gas=customer で会計を作る。
  return { gasMode: 'customer', customer, feeAmount: 0n, saleAmount: amount, networkFeeEquivalent: 0n, blockNumber: null };
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
 * 受注 1 件 + receipt で確かめた入金 → 履歴の 1 行。null = この注文は書けない (chain・token の表に無い = chainSlug と
 * tokenAddress を埋められない)。merchant は受注フィードを読んだ SIWE の session のアドレス (注文は受取先を持たない)。
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
