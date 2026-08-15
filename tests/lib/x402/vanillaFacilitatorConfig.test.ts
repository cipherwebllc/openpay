// parseVanillaFacilitator (lib/x402/config) のフェンス:
// 既定 = 従来 URL のまま挙動不変 / cdp = 鍵必須 (欠けたら fail-loud) / 未知値は throw。

import { describe, it, expect } from 'vitest';
import { parseVanillaFacilitator } from '@/lib/x402/config';

const FALLBACK = 'https://facilitator.payai.network';

describe('parseVanillaFacilitator', () => {
  it('未設定 (既定): 従来の facilitator URL・auth なし = 挙動完全不変', () => {
    for (const mode of [undefined, '']) {
      const c = parseVanillaFacilitator({
        mode,
        fallbackUrl: FALLBACK,
        cdpKeyId: undefined,
        cdpKeySecret: undefined,
      });
      expect(c).toEqual({ url: FALLBACK });
      expect(c.cdpAuth).toBeUndefined();
    }
  });

  it('cdp + 鍵あり: CDP URL と auth を返す', () => {
    const c = parseVanillaFacilitator({
      mode: 'cdp',
      fallbackUrl: FALLBACK,
      cdpKeyId: 'org/key',
      cdpKeySecret: 'c2VjcmV0',
    });
    expect(c.url).toBe('https://api.cdp.coinbase.com/platform/v2/x402');
    expect(c.cdpAuth).toEqual({ keyId: 'org/key', keySecret: 'c2VjcmV0' });
  });

  it('cdp + 鍵欠落: throw (無言で fallback に落ちて掲載されない事故を防ぐ)', () => {
    for (const [id, secret] of [
      [undefined, 'x'],
      ['x', undefined],
      ['', 'x'],
      ['x', ''],
    ] as const) {
      expect(() =>
        parseVanillaFacilitator({
          mode: 'cdp',
          fallbackUrl: FALLBACK,
          cdpKeyId: id,
          cdpKeySecret: secret,
        }),
      ).toThrow(/CDP_API_KEY_ID and CDP_API_KEY_SECRET/);
    }
  });

  it('未知の mode は throw', () => {
    expect(() =>
      parseVanillaFacilitator({
        mode: 'payai',
        fallbackUrl: FALLBACK,
        cdpKeyId: undefined,
        cdpKeySecret: undefined,
      }),
    ).toThrow(/unset or 'cdp'/);
  });
});
