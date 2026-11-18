// QR の会計の入金を、会計ごとの印 (bill key) で確かめて、お店の端末の取引履歴の 1 行を組む純関数。
// RPC も localStorage も触らない (読む・書くのは lib/qrSaleWatch.ts)。
//
// 確かめ方: お店は QR を出すたびに乱数の bill key を作って画面の QR の URL (`bk`) に載せ、払う側 (hooks/useJpycEip3009Payment)
// は intentSalt = billKeySalt(bill key) で署名する。forwarder の nonce (lib/relay/forwarderIntent の buildForwarderNonce) は
// 払った人・受取先・着金額・利用料・有効期限・intentSalt・チェーン・forwarder の全部の hash。
// この会計の支払いとして扱うのは、次の 2 つが両方とも成り立つ `Settled` だけ (matchSettledToBill):
//   1. 受取先・着金額・利用料が、この会計の期待値 (利用料は払う側と同じ recoverFeeValue の式) とちょうど同じ。
//   2. nonce が、この会計の bill key の intentSalt と log の値 (from・merchant・merchantValue・feeValue) で計算し直した値と
//      ちょうど一致する。
// nonce の一致が保証するのは「log にある金額が、この bill key を使った署名で、この受取先へ実際に払われたこと」。金額は
// 署名する人が決めるので、bill key を知った人は別の額でも署名できる。そこで 1 で、金額が会計の期待値と同じ入金だけを
// この会計の支払いとして扱う。bill key を知った人にできるのは、その金額をその受取先へ実際に払うことだけ。
// 1 に当たらない `Settled` (bill key は合うが金額が違う支払いを含む) は nonce を 1 回も計算しない。2 に当たらない `Settled`
// (bill key を使わない支払い・ほかの端末の会計・古い画面) も、何の行にもしない。
//   - 有効期限 (validBefore) は log に無いので、取り込まれた block の時刻 T から T+1 … T+AUTHORIZATION_LOOKUP_WINDOW_SEC を
//     1 秒ずつ試す (署名は block の時刻より後まで有効・relay の server は受付時刻 + 20 分より先の有効期限を受けない)。
//     計算の量 = 1 に当たる (log, 会計) の組 1 つにつき最大 1,230 回 (一致した所で止める)。1 回に照合する組の数の上限は
//     lib/qrSaleWatch.ts が持つ。
//   - salt と nonce の式は、払う側と同じ関数を import して使う (再実装しない)。
//
// 行の欄は、払った側 (/pay の PaymentForm・/checkout の CheckoutForm → hooks/usePaymentHistory.ts) が同じ支払いで書く行に
// 合わせる (tests/components/qrSaleHistory.parity.test.tsx が両方を実際に作って欄ごとに比べる)。違うのは時刻 (ts) だけで、
// お店の行は block の時刻。金額・お客様は log の値、明細・管理番号などは QR を出した時点の会計の写し (QR の URL と
// 同じ中身を、払う側と同じ parser で読んだ値)。
//
// 通常決済 (URL の mode=standard・JPYC) の会計 (readQrStdBill): 払う人のウォレットが JPYC の transfer(受取先, 額) を送る。
// 払う側は transfer の calldata の後ろに、bill key から作った 32 byte の印 (lib/relay/billKeySalt の billKeyStdMark) を足す
// (払う側が印を付けるのは別の変更から。それまでは、この会計に一致する入金は無い)。この会計の支払いとして扱うのは、次の
// 全部が成り立つ JPYC の `Transfer` だけ (lib/qrSaleWatch.ts が順に確かめる):
//   1. log を出したのが、この会計のチェーンの JPYC の deployment (readTransferLog)。
//   2. 受取先・額が、この会計の期待値 (払う側と同じ calcBreakdown の通常決済の着金額 = 今は請求額そのもの) とちょうど同じで、
//      送り手が forwarder でない (forwarder から出た Transfer はガスレスの決済の分け前・transferMatchesExpected)。
//   3. その tx の input に、この会計の印の付いた transfer がある (stdMarkCount の注記)。
// 印が保証するのは「その tx を送った人 (または、その人のスマートアカウント) が、この bill key の印を付けた transfer を
// この受取先へこの額で送ろうとしたこと」。bill key を知った人にできるのは、ほぼ、その金額をその受取先へ実際に払うことだけ。
// ただしスマートアカウント等の tx (宛先が JPYC でない) では、forwarder を通らない第三者の EIP-3009 の authorization を
// mempool で先取りして自分の tx に包むと、その人の入金を自分の会計に見せられる (同じ受取先・同じ額・会計の窓の中・頻度は
// 低いと見る・受け入れた限界)。1 回の入金で 2 つの会計を確かめたことにする順は stdCallsExceedTransfers で断つ。
// 行の欄は、払った側が通常決済で書く行 (hooks/usePaymentHistory の standard の成功・flow standard-merchant) に合わせる。

import {
  concatHex,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  isAddressEqual,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';
import { chainForSlug } from './chains';
import { buildCheckoutLineItems } from './checkoutLineItems';
import { env } from './env';
import { calcBreakdown } from './fee';
import { buildHistoryEntry, type HistoryEntry } from './history';
import { receiptSettlements, receiptTokenTransfers } from './order/agentOrderReceipt';
import { billKeySalt, billKeyStdMark } from './relay/billKeySalt';
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

/** 会計の写し (QR の URL を、払う側と同じ parser で読んだもの)。 */
export type QrSale =
  | { kind: 'pay'; params: PayParams; itemName: string }
  | { kind: 'checkout'; params: CheckoutParams };

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
  sale: QrSale;
};

// QR の URL を、払う側と同じ parser で読む (読めなければ null)。
function readSale(input: QrBillInput): QrSale | null {
  const query = input.url.indexOf('?');
  if (query < 0) return null;
  const search = new URLSearchParams(input.url.slice(query + 1));
  if (input.kind === 'pay') {
    const parsed = parsePayParams(search);
    if (!parsed.ok) return null;
    return { kind: 'pay', params: parsed.params, itemName: input.itemName };
  }
  const parsed = parseCheckoutParams(search);
  if (!parsed.ok) return null;
  return { kind: 'checkout', params: parsed.params };
}

// 請求額: 払う側が同じ URL から払う額 (/pay は amount・/checkout は明細の合計 − 値引き)。/pay の金額なしは null。
function billAmountOf(sale: QrSale, decimals: number): bigint | null {
  if (sale.kind === 'pay') {
    if (!sale.params.amount) return null;
    return parseUnits(sale.params.amount, decimals);
  }
  return calcCheckoutPayable(sale.params, decimals);
}

/**
 * QR の URL を読んで、見張る会計にする。null = この QR は見張らない (bill key の形が違う・URL を読めない・JPYC の
 * ガスレスでない・forwarder の無いチェーン・金額が無い・利用料を引くと着金額が残らない)。
 */
export function readQrBill(input: QrBillInput): QrBill | null {
  const intentSalt = billKeySalt(input.billKey);
  if (!intentSalt) return null;
  const sale = readSale(input);
  if (!sale) return null;
  const { to, token, chain, mode } = sale.params;
  if (token !== 'jpyc' || mode === 'standard') return null;
  const chainSlug = chain ?? DEFAULT_CHAIN_FOR_SYMBOL.jpyc;
  const chainId = chainForSlug(chainSlug).id;
  const deployment = deploymentForSlug('jpyc', chainSlug);
  const forwarder = jpycForwarderFor(chainId);
  if (!forwarder) return null;
  // 請求額: 払う側が同じ URL から relay に渡す額 (/pay は amount・/checkout は明細の合計 − 値引き)。
  const bill = billAmountOf(sale, deployment.decimals);
  if (bill === null) return null;
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

/** この `Settled` の受取先・着金額・利用料が、この会計の期待値とちょうど同じか (nonce を探すのは、同じときだけ)。 */
export function settledMatchesExpected(settled: SettledLog, bill: QrBill): boolean {
  return (
    isAddressEqual(settled.merchant, bill.merchant) &&
    settled.merchantValue === bill.expected.merchantValue &&
    settled.feeValue === bill.expected.feeValue
  );
}

/**
 * この `Settled` が、この会計の支払いか (受取先・金額が期待値と同じで、nonce がこの会計の bill key の署名と一致する)。
 * 一致したら、その署名の有効期限 (validBefore) を返す。blockTime = この `Settled` が取り込まれた block の時刻 (unix 秒)。
 */
export function matchSettledToBill(settled: SettledLog, blockTime: bigint, bill: QrBill): bigint | null {
  if (!settledMatchesExpected(settled, bill)) return null;
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

/** 見張る通常決済の会計 (QR の URL の mode=standard・JPYC)。 */
export type QrStdBill = {
  billKey: string;
  /** 払う側が transfer の calldata の後ろに足す 32 byte の印 (lib/relay/billKeySalt の billKeyStdMark)。 */
  mark: Hex;
  chainId: number;
  chainSlug: ChainSlug;
  deployment: TokenDeployment;
  /** このチェーンの forwarder (無ければ null)。forwarder から出た Transfer は候補にしない。 */
  forwarder: Address | null;
  merchant: Address;
  /**
   * 払う側が同じ URL から計算する額 (components/PaymentForm・CheckoutForm の通常決済の standard.mutate と同じ calcBreakdown):
   * value = 受取先への transfer の額 (着金額)・feeAmount = 利用料 (今は 0)・saleAmount = 請求額。
   */
  expected: { value: bigint; feeAmount: bigint; saleAmount: bigint };
  sale: QrSale;
};

/**
 * 通常決済の QR の URL を読んで、見張る会計にする。null = この QR は通常決済の会計として見張らない (bill key の形が違う・
 * URL を読めない・JPYC の通常決済でない・金額が無い・着金額が残らない)。forwarder の有無は問わない (払う人の
 * ウォレットが送る)。
 */
export function readQrStdBill(input: QrBillInput): QrStdBill | null {
  const mark = billKeyStdMark(input.billKey);
  if (!mark) return null;
  const sale = readSale(input);
  if (!sale) return null;
  const { to, token, chain, mode } = sale.params;
  if (token !== 'jpyc' || mode !== 'standard') return null;
  const chainSlug = chain ?? DEFAULT_CHAIN_FOR_SYMBOL.jpyc;
  const chainId = chainForSlug(chainSlug).id;
  const deployment = deploymentForSlug('jpyc', chainSlug);
  const bill = billAmountOf(sale, deployment.decimals);
  if (bill === null) return null;
  // 払う側 (PaymentForm・CheckoutForm の通常決済) と同じ式: transfer(受取先, merchantReceives) と、利用料の transfer (0 なら無い)。
  const { merchantReceives, feeAmount } = calcBreakdown(bill, 'jpyc', 'standard');
  if (merchantReceives <= 0n) return null;
  return {
    billKey: input.billKey,
    mark,
    chainId,
    chainSlug,
    deployment,
    forwarder: jpycForwarderFor(chainId),
    merchant: getAddress(to),
    expected: { value: merchantReceives, feeAmount, saleAmount: bill },
    sale,
  };
}

/** JPYC の `Transfer` 1 つ (log の値)。 */
export type TransferLog = { from: Address; to: Address; value: bigint };

/** RPC が返した log 1 つを、token が出した `Transfer` として読む。token が出した `Transfer` でなければ null。 */
export function readTransferLog(
  log: { address: string; topics: readonly string[]; data: string },
  token: Address,
): TransferLog | null {
  const [args] = receiptTokenTransfers([log], token);
  if (!args) return null;
  return { from: args.from, to: args.to, value: args.value };
}

/**
 * この `Transfer` の受取先・額が、この会計の期待値とちょうど同じで、送り手が forwarder でないか (tx を読む前のふるい)。
 * forwarder から出た Transfer は、ガスレスの決済 (settle) の分け前 (照合は Settled の側)。
 */
export function transferMatchesExpected(transfer: TransferLog, bill: QrStdBill): boolean {
  return (
    isAddressEqual(transfer.to, bill.merchant) &&
    transfer.value === bill.expected.value &&
    !(bill.forwarder !== null && isAddressEqual(transfer.from, bill.forwarder))
  );
}

/** 払う側が送る calldata = transfer(受取先, 額) の calldata (4 + 64 byte) + 印 (32 byte)。 */
export function stdTransferCalldata(bill: QrStdBill): Hex {
  const transfer = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [bill.merchant, bill.expected.value],
  });
  return concatHex([transfer, bill.mark]);
}

/** 読んだ tx のうち、照合に使う部分 (見張りが形を確かめた値: from・to は address・input は hex)。 */
export type StdTx = { from: string; to: string | null; input: string };

/**
 * この tx の input に、この会計の印の付いた transfer がいくつあるか (0 = この会計の入金ではない)。transfer = その tx の
 * JPYC の `Transfer` の log (transferMatchesExpected が true のもの)。
 *   - tx の宛先が JPYC (EOA が直接 transfer を送った): 送り手が Transfer の from と同じで、input が
 *     「transfer(受取先, 額) + 印」とちょうど同じときだけ 1。余計な byte がある・別の関数・別の送り手は 0。
 *   - それ以外 (ERC-4337 の bundler・7702 の委任・Safe 等のスマートアカウントが中で transfer を呼んだ): input の中に
 *     「transfer(受取先, 額) + 印」の 100 byte が、byte の境界から連続して現れる回数。印は transfer の引数の word の並び
 *     (selector の後ろの 3 つ目の 32 byte = ABI の word の位置) にあるものだけを数える: 印だけが input のどこかにある・
 *     transfer の calldata と印の間に byte がある・半 byte ずれた位置にある、は数えない。input の先頭から数えた 32 byte の
 *     境界では見ない (ERC-4337 の handleOps → execute → transfer では、包む関数の selector の 4 byte が重なるので、印は
 *     input の先頭から 32 byte の倍数の位置に来ない・Kernel や Safe の multiSend は包む形が詰めた encode)。
 */
export function stdMarkCount(tx: StdTx, transfer: TransferLog, bill: QrStdBill): number {
  const expected = stdTransferCalldata(bill).toLowerCase();
  const input = tx.input.toLowerCase();
  if (tx.to !== null && tx.to.toLowerCase() === bill.deployment.address.toLowerCase()) {
    return tx.from.toLowerCase() === transfer.from.toLowerCase() && input === expected ? 1 : 0;
  }
  const hay = input.slice(2);
  const needle = expected.slice(2);
  let count = 0;
  // hex の 2 字が 1 byte。奇数の位置 (半 byte ずれ) から始まる一致は数えない。
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
    if (at % 2 === 0) count += 1;
  }
  return count;
}

/**
 * スマートアカウント等の tx (宛先が JPYC でない) で、input の中の「transfer(受取先, 額)」の calldata (4 + 64 byte・印の有無を
 * 問わない・byte の境界) の数が、同じ tx の中の、この会計の期待値に合う `Transfer` の log の数 (sameTxTransfers) を超えるか。
 * 超えるなら、その tx は 1 つの入金に対して複数の会計の印を並べている (例: 自作の contract が Transfer 1 つの tx の input に、
 * 別の端末の会計 A と B の「transfer + 印」を両方入れる) ので、どの会計の入金ともしない (確かめた数 ≤ 入金の数にする)。
 * 宛先が JPYC の直接の送金は stdMarkCount が input のちょうどの一致を見るので、ここでは数えない (false)。
 *
 * 数えるのは「transfer の calldata + 直後の 32 byte」の**違う並び**の数 (同じ並びが何度あっても 1 つ)。ウォレットの中継の tx
 * (MetaMask がガス代を USDC で払う 7702 の中継: 署名した中身と実行する中身に、同じ「transfer + 印」が 2 回入る) は、
 * Transfer 1 つで同じ並びが 2 回現れる (2026-11-18 の実機・Polygon)。同じ並び = 同じ会計の同じ呼び出しなので 1 つと数える。
 * 別の会計の印 (直後の 32 byte が違う)・印つきと印なしの並びは、今までどおり別に数えて超えたら断る。
 */
export function stdCallsExceedTransfers(tx: StdTx, bill: QrStdBill, sameTxTransfers: number): boolean {
  if (tx.to !== null && tx.to.toLowerCase() === bill.deployment.address.toLowerCase()) return false;
  const call = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [bill.merchant, bill.expected.value],
  })
    .slice(2)
    .toLowerCase();
  const hay = tx.input.slice(2).toLowerCase();
  // 「transfer の calldata + 直後の 32 byte (64 字・input の終わりなら残り全部)」の違う並び。
  const calls = new Set<string>();
  // hex の 2 字が 1 byte。奇数の位置 (半 byte ずれ) から始まる一致は数えない (stdMarkCount と同じ)。
  for (let at = hay.indexOf(call); at >= 0; at = hay.indexOf(call, at + 1)) {
    if (at % 2 === 0) calls.add(hay.slice(at, at + call.length + 64));
  }
  return calls.size > sameTxTransfers;
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
 * 管理番号などを付けるか (その会計の 1 件目の一致だけ・決めるのは lib/qrSaleWatch.ts)。
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

// 会計の 1 件目なら写しの明細・管理番号など、2 件目以降なら空 (buildQrSaleEntry と同じ決まり)。
function saleDetailOf(sale: QrSale, decimals: number, withDetail: boolean): SaleDetail {
  if (!withDetail) return NO_DETAIL;
  return sale.kind === 'pay' ? payDetail(sale.params, sale.itemName, decimals) : checkoutDetail(sale.params, decimals);
}

/**
 * 印の付いた通常決済の `Transfer` → 履歴の 1 行。払った側が通常決済で書く行 (hooks/usePaymentHistory の standard の成功:
 * flow standard-merchant・payMode standard・gasMode null・ネットワーク手数料相当額なし) と同じ欄。金額・お客様は log の値・
 * 時刻は block の時刻・block の番号は log の block (払った側も receipt の block を書く)。withDetail は buildQrSaleEntry と同じ。
 */
export function buildQrStdSaleEntry(
  bill: QrStdBill,
  transfer: TransferLog,
  txHash: string,
  blockNumber: bigint,
  blockTime: bigint,
  withDetail: boolean,
): HistoryEntry {
  return buildHistoryEntry({
    ts: Number(blockTime) * 1000,
    flow: 'standard-merchant',
    status: 'success',
    chainId: bill.chainId,
    chainSlug: bill.chainSlug,
    asset: 'jpyc',
    tokenAddress: bill.deployment.address,
    payMode: 'standard',
    // 通常決済は OpenPay がガスに触れない (払った側の行も null)。
    gasMode: null,
    merchant: bill.merchant,
    merchantAmount: transfer.value,
    customer: transfer.from,
    feeReceiver: env.feeReceiver,
    feeAmount: bill.expected.feeAmount,
    saleAmount: bill.expected.saleAmount,
    networkFeeEquivalent: null,
    txHash,
    userOpHash: null,
    blockNumber,
    errorMessage: null,
    ...saleDetailOf(bill.sale, bill.deployment.decimals, withDetail),
  });
}
