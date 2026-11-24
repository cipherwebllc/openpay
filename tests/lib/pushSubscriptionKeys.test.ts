// lib/push/subscriptionKeys.ts の条件が、実物の web-push (encryption-helper) が送る前に確かめる条件と同じであることを固定する
// (web-push を更新して条件が変わったら、ここで気づく)。encrypt は長さを確かめた後に暗号化へ進むので、長さで断られたかどうかを
// 投げた message で見分ける (長さを通った鍵は、テスト用の値が曲線上の点でないため別の message で投げる)。

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { hasSendablePushKeys, pushKeyByteLengths } from '@/lib/push/subscriptionKeys';

const requireCjs = createRequire(import.meta.url);
const helper = requireCjs('web-push/src/encryption-helper') as {
  encrypt: (p256dh: string, auth: string, payload: string, encoding: string) => unknown;
};

const LENGTH_ERRORS = /p256dh value should be 65 bytes long|auth key should be at least 16 bytes long/;

function rejectedForLength(p256dh: string, auth: string): boolean {
  try {
    helper.encrypt(p256dh, auth, 'x', 'aes128gcm');
    return false;
  } catch (error) {
    return LENGTH_ERRORS.test((error as Error).message);
  }
}

describe('hasSendablePushKeys は web-push と同じ長さの条件', () => {
  // base64url 85〜89 文字 = 63〜66 byte、20〜24 文字 = 15〜18 byte (境界の両側)
  const p256dhLengths = [85, 86, 87, 88, 89];
  const authLengths = [20, 21, 22, 23, 24];
  it.each(p256dhLengths.flatMap((p) => authLengths.map((a) => [p, a] as const)))(
    'p256dh %i 文字・auth %i 文字',
    (p, a) => {
      const keys = { p256dh: 'B'.repeat(p), auth: 'C'.repeat(a) };
      expect(hasSendablePushKeys(keys)).toBe(!rejectedForLength(keys.p256dh, keys.auth));
    },
  );

  it('長さは base64url として読んだ byte 数', () => {
    expect(pushKeyByteLengths({ p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) })).toEqual({ p256dhBytes: 65, authBytes: 16 });
  });
});
