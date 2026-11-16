// お店の側 (/create の決済QR・レジ) が、会計ごとの印 (bill key) を作り、画面に表示する QR の URL にだけ足す。
// 払う側が読む所は lib/url/billKey.ts・印から intentSalt を作る所は lib/relay/billKeySalt.ts。
//
// 足すのは「画面に表示中の QR」の値だけ (hooks/useQrBillKey.ts が呼ぶ)。PayParams / CheckoutParams・buildPayUrl /
// buildCheckoutUrl・URL のコピー・印刷 / PNG / SVG の保存・前回の受け取り QR の保存は bill key を知らない
// (印のある URL を画面の外へ出さない: 後から払われても、お店の端末はその会計をもう持っていない)。

/** 新しい bill key = 128 bit の乱数を base64url にした 22 字 (lib/relay/billKeySalt.ts が受ける形)。 */
export function newBillKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 画面に表示する QR の URL = 元の URL (query つき) の末尾に bill key を足したもの。 */
export function withBillKey(url: string, billKey: string): string {
  return `${url}&bk=${billKey}`;
}
