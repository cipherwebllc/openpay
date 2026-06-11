// 「署名安心 UX」(plans/sign-reassurance-ux.md) の照合表データを組み立てる純関数。
//
// 本質: 照合表に出す各値は、hook (useJpycEip3009Payment) が実際に署名する payload と
// **同一ソース**でなければならない。OpenPay 側で別計算して表示すると、ウォレットに出る
// 生の数字 (value の 18 桁表記など) と乖離し「お店が言う額とウォレットが言う額が違う」
// という最悪の不信を生む。よって amountAtomic は hook が署名する `value` の `.toString()`
// と完全一致させる (tests/lib/signPreview.test.ts でフェンス)。
//
// スコープは P1 = JPYC relay free mode のみ (standard/USDC/recover は出さない)。

import { formatUnits, type Address } from 'viem';
import { AUTHORIZATION_VALIDITY_WINDOW_SEC } from './jpycEip3009';

export type JpycRelaySignPreview = {
  // 人間可読の金額 (formatUnits(value, decimals))。安心パネルの本文・バッジ表示用。
  amountHuman: string;
  // 表示シンボル (例: "JPYC")。
  symbol: string;
  // ウォレットの署名画面に出る生の数字 (value.toString())。照合表の value 欄に出し、
  // 顧客がウォレット表示と突合できるようにする (= 本物のセキュリティ教育)。
  amountAtomic: string;
  // 受取アドレス。hook の mutate に渡す merchant と同一値 (照合表の to 欄に全文表示)。
  to: Address;
  // 店舗名 (任意・QR の store param 由来)。署名待ちオーバーレイの送金先表示に使う。
  storeName?: string;
  // 署名の有効分数 = AUTHORIZATION_VALIDITY_WINDOW_SEC / 60。失効説明に使う。
  expiresInMin: number;
  // token の小数桁数 (照合表の value 欄で「内部表記 (N 桁)」と正確に説明するため)。
  // JPYC=18 が基本だが FX 換算 QR で USDC 6 桁になっても正確に出せるよう preview に持つ。
  decimals: number;
};

// 署名 payload と同一ソース (value/merchant) からプレビューを導出する。表示用に再計算
// しない (乖離をゼロにする)。decimals/displaySymbol は deployment から渡す (FX 換算 QR で
// USDC 6 桁になっても自動対応)。
export function buildJpycRelaySignPreview(args: {
  value: bigint;
  merchant: Address;
  storeName?: string;
  decimals: number;
  displaySymbol: string;
}): JpycRelaySignPreview {
  return {
    amountHuman: formatUnits(args.value, args.decimals),
    symbol: args.displaySymbol,
    amountAtomic: args.value.toString(),
    to: args.merchant,
    storeName: args.storeName,
    expiresInMin: AUTHORIZATION_VALIDITY_WINDOW_SEC / 60,
    decimals: args.decimals,
  };
}
