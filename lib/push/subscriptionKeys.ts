// Web Push の購読の鍵が、送れる形かを確かめる。条件は web-push (node_modules/web-push/src/encryption-helper.js) が
// 暗号化の前に確かめるものと同じ: p256dh は 65 byte (P-256 の非圧縮の公開鍵)・auth は 16 byte 以上 (base64url を読んだ長さ)。
//
// 形式 (base64url の文字) だけ見て保存すると、長さの違う鍵の購読が残り、送るたびに web-push が送る前に投げて失敗し続ける
// (2026-11-24 Sentry push.send_failed「The subscription p256dh value should be 65 bytes long.」)。登録のときに断り
// (app/api/push/subscribe)、もう保存されているものは送らずに消す (lib/push/server.ts)。

import 'server-only';

export const PUSH_P256DH_BYTES = 65;
export const PUSH_AUTH_MIN_BYTES = 16;

/** 鍵を base64url として読んだ長さ (byte)。鍵そのものは記録せず、壊れた鍵の原因を調べるために長さだけを記録する。 */
export function pushKeyByteLengths(keys: { p256dh: string; auth: string }): { p256dhBytes: number; authBytes: number } {
  return {
    p256dhBytes: Buffer.from(keys.p256dh, 'base64url').length,
    authBytes: Buffer.from(keys.auth, 'base64url').length,
  };
}

export function hasSendablePushKeys(keys: { p256dh: string; auth: string }): boolean {
  const { p256dhBytes, authBytes } = pushKeyByteLengths(keys);
  return p256dhBytes === PUSH_P256DH_BYTES && authBytes >= PUSH_AUTH_MIN_BYTES;
}
