// 払う側 (/pay・/checkout) が、いまの画面の URL から会計ごとの印 (bill key・`bk`) の文字列を読む。
// 読むだけで、形は見ない (形の検査と hash は遅延 chunk の lib/relay/billKeySalt.ts・JPYC ガスレスの hook が使う)。
//
// PayParams / CheckoutParams には入れない (lib/url/pay.ts・checkout.ts の parser と builder は `bk` を知らない)。入れると、
// /checkout の作り直しの key (lib/checkoutFormKey.ts)・通常決済の復元の指紋 (lib/checkoutIntentContext.ts)・履歴・控え・
// 記録の送信まで bill key が流れ、出し直した QR (bill key だけが違う) で復元が一致しなくなる。
// 押した瞬間 (submit の handler) にだけ呼ぶ (window を読むので描画の途中では呼ばない)。
export function readBillKeyParam(): string | null {
  return new URLSearchParams(window.location.search).get('bk');
}
