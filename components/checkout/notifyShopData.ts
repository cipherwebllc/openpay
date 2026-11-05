// 「お店に知らせる / 注文を送る」の中身 (NotifyShopData)。支払いの画面 (CheckoutForm) とチェーンを選ぶ画面
// (CheckoutChainPicker) の両方がここで作る (第 9 回レビュー D-9: 2 か所で組み立てていた)。
//
// 金額は呼び出し側が渡す customerPays をそのまま表示する (2026-11 user 裁定 Q14 は「お客様が実際に払った額」)。
// 支払いの画面は今の breakdown.customerPays を渡す。チェーンを選ぶ画面は URL の額を渡す: この画面は JPYC のリンクに
// しか出ず (lib/url/checkout.ts の parseOfferedChains)、利用料の種類 (feeKind) も無い。JPYC はどの経路 (relay の回収・
// relay のガス代 OpenPay 負担・Pimlico・通常決済) でもお客様が払う額 = URL の額 (回収の利用料はお店の受取から引き、
// ガス代はお客様に足さない・lib/paymentMoney.ts) なので、払った記録に経路や額が無くても実際に払った額と一致する
// (tests/components/notifyShopData.test.tsx で固定)。
// 一致を言えるのは JPYC (feeKind なし) だけ: USDC の gasless で gas=customer のときは customerPays にガス代の見積もりが
// 入り、支払いの画面が後から見積もりを取り直すと (このタブで払った記録からの復元・mainnet の再取得)、払った時の額と
// ずれうる (変更前からの挙動・plans の第 9 回レビューの後追い)。

import type { Address } from 'viem';
import type { NotifyShopData } from '@/components/NotifyShopButton';
import { chainForSlug, txExplorerUrl, type ChainSlug } from '@/lib/chains';
import { formatTokenAmount } from '@/lib/format';
import type { TokenDeployment } from '@/lib/tokens';
import type { CheckoutParams } from '@/lib/url/checkout';

export function notifyShopData(input: {
  params: Pick<CheckoutParams, 'orderId' | 'ship' | 'storeName' | 'items' | 'to' | 'token' | 'contact'>;
  /** 表示する額 (支払いの画面は今の breakdown.customerPays・チェーンを選ぶ画面は URL の額)。JPYC では払った額と一致する。 */
  customerPays: bigint;
  /** customerPays を表示するトークン (桁と記号)。 */
  deployment: TokenDeployment;
  txHash: string;
  /** 払ったウォレット (支払いを送った時点の接続先)。分からなければ入れない。 */
  payer: Address | undefined;
  /** 払ったチェーン (Explorer のリンクと確認の署名の文に入る)。 */
  chain: ChainSlug;
}): NotifyShopData {
  const { params, txHash, payer, chain } = input;
  return {
    orderNo: params.orderId,
    askShipping: params.ship === 'ask',
    storeName: params.storeName,
    items: params.items.map((item) => ({ name: item.name, qty: item.qty })),
    amountDisplay: formatTokenAmount(input.customerPays, input.deployment),
    txHash,
    explorerTxUrl: txExplorerUrl(chainForSlug(chain).id, txHash),
    chain,
    shop: params.to,
    ...(payer ? { payer } : {}),
    // お店が確かめられるのは JPYC だけ (注文リンクの「入金を確かめる」)。他のトークンでは署名を求めない。
    confirm: params.token === 'jpyc',
    contact: params.contact,
  };
}
