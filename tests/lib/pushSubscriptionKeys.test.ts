// lib/push/subscriptionKeys.ts の条件が、実物の web-push (encryption-helper) が送る前に確かめる条件と同じであることを固定する
// (web-push を更新して条件が変わったら、ここで気づく)。65 byte の p256dh には本物の P-256 の公開鍵を使い、長さを通った鍵は
// 暗号化まで成功することも確かめる (長さ以外の理由で断られたら、このテストが投げて気づく)。

import { createECDH } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { hasSendablePushKeys, pushKeyByteLengths } from '@/lib/push/subscriptionKeys';

const requireCjs = createRequire(import.meta.url);
const helper = requireCjs('web-push/src/encryption-helper') as {
  encrypt: (p256dh: string, auth: string, payload: string, encoding: string) => unknown;
};

const LENGTH_ERRORS = /p256dh value should be 65 bytes long|auth key should be at least 16 bytes long/;

const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
const REAL_P256DH = ecdh.getPublicKey().toString('base64url'); // 65 byte = 87 文字

/** web-push が受け取って暗号化できれば true、長さで断れば false。それ以外の理由で投げたらそのまま投げる。 */
function acceptedByWebPush(p256dh: string, auth: string): boolean {
  try {
    helper.encrypt(p256dh, auth, 'x', 'aes128gcm');
    return true;
  } catch (error) {
    if (LENGTH_ERRORS.test((error as Error).message)) return false;
    throw error;
  }
}

describe('hasSendablePushKeys は web-push と同じ長さの条件', () => {
  // p256dh: 85・86・88・89 文字 (63・64・66・66 byte) と本物の公開鍵 (65 byte)。auth: 20〜24 文字 (15〜18 byte)。
  const p256dhKeys = ['B'.repeat(85), 'B'.repeat(86), REAL_P256DH, 'B'.repeat(88), 'B'.repeat(89)];
  const authLengths = [20, 21, 22, 23, 24];
  it.each(p256dhKeys.flatMap((p256dh) => authLengths.map((a) => [p256dh.length, a, p256dh] as const)))(
    'p256dh %i 文字・auth %i 文字',
    (_p, a, p256dh) => {
      const keys = { p256dh, auth: 'C'.repeat(a) };
      expect(hasSendablePushKeys(keys)).toBe(acceptedByWebPush(keys.p256dh, keys.auth));
    },
  );

  it('本物の公開鍵と 16 byte の auth は送れる (境界の内側)', () => {
    expect(REAL_P256DH).toHaveLength(87);
    expect(hasSendablePushKeys({ p256dh: REAL_P256DH, auth: 'C'.repeat(22) })).toBe(true);
    expect(acceptedByWebPush(REAL_P256DH, 'C'.repeat(22))).toBe(true);
  });

  it('長さは base64url として読んだ byte 数', () => {
    expect(pushKeyByteLengths({ p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) })).toEqual({ p256dhBytes: 65, authBytes: 16 });
  });
});
