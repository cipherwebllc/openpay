// 顧客の「注文状況」トークン (client 生成・256-bit 乱数・base64url 43字)。お渡し準備完了通知用。
// status endpoint (/api/order/status) はこれを不透明キーとして {merchant,chainId,txHash} に紐付ける。
// 形式は lib/orderToken (店員の閲覧トークンと同型・isOrderTokenLike) に一致させる。決済成功時に
// CheckoutForm が 1 度だけ生成し、webhook payload (notify がポインタ保存) と完了画面リンクで使う。

import { ORDER_TOKEN_BYTES } from '@/lib/orderToken';

/** 256-bit 乱数を base64url (padding 無し・43字) で返す。WebCrypto (ブラウザ / Node18+) を使う。 */
export function generateStatusToken(): string {
  const bytes = new Uint8Array(ORDER_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
