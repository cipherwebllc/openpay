import { counterpartSymbol, deploymentsForSymbol, type TokenSymbol } from '@/lib/tokens';
import type { SettlementScreen } from './restoredSettlement';

// 復元した支払いの確定が今の画面の支払いかの判定 (./restoredSettlement の isForeignSettlement・第 10 回レビュー H-S) に渡す
// 「画面の形」のうち、3 画面 (Pay / Checkout / Tip) で作り方が同じ所。/checkout の形は lib/orderPaidLookup の
// checkoutSettlementScreen (合計と上乗せの形を足す)。

/**
 * 画面の token と別の token の address (別の symbol の deployment の address)。address の上書き (env) は形しか確かめず、symbol の
 * 間で重ならないことを強制しないので、この画面の symbol の今の address と重なるものは「どちらの token か決められない」= 除く
 * (何の波及を断つか: 別の token の設定の誤りで、この token の正当な支払いを別の支払いとすること)。除いた後に残る誤りは、別の
 * token の上書きがこの token の今は表に無い昔の address と同じになる場合だけ (2 つの設定の誤りが重なる場合)。
 */
export function otherTokenAddresses(token: TokenSymbol): string[] {
  const own = deploymentsForSymbol(token).map((deployment) => deployment.address.toLowerCase());
  return deploymentsForSymbol(counterpartSymbol(token))
    .map((deployment) => deployment.address)
    .filter((address) => !own.includes(address.toLowerCase()));
}

/**
 * 鍵 (contextKey・orderLinkKey) を付けずに払う画面 (/pay・/tip) の形。鍵を付けるのは /checkout だけなので、鍵を持つ記録は
 * この画面の支払いでない (contextKeyed: false)。お客様が利用料を上乗せする形は額の照合に使わない (customerFeeOnTop: false):
 * /pay の relay は free (利用料 0) か、お店が利用料を負担する recover (受取 + 利用料 = 額) だけで、/tip は額を比べない
 * (/pay の recover をお店の負担に固定したのは 2026-06-12・relay の枠を保存し始めたのは 2026-07-26 の #273 = 上乗せの形の
 * /pay の記録は無い。固定は tests/components/PaymentForm.test.tsx の「前提の固定」)。
 *
 * amount は URL で決まる額だけを渡す (/pay の金額ありの QR)。入力で決まる額 (/pay の金額なしの QR・/tip の選んだ額) は null:
 * 読み込み直すと入力は空・既定に戻るので、今の入力と記録の額が違っても別の支払いの証明にならない (何の波及を断つか: 同じ支払いを
 * 読み直した人に「この画面の支払いではありません」と出して、もう一度払わせること)。
 */
export function unkeyedSettlementScreen(merchant: string, token: TokenSymbol, amount: bigint | null): SettlementScreen {
  return { merchant, amount, customerFeeOnTop: false, otherTokenAddresses: otherTokenAddresses(token), contextKeyed: false };
}
