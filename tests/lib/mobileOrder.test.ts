// モバイルオーダー設定の URL コーデック (lib/mobileOrder.ts) を実コードで検証。
// 観点: round-trip 一致 / UTF-8(日本語・絵文字) / untrusted 入力の全検証 (不正は null・throw しない)。

import { describe, it, expect } from 'vitest';
import {
  encodeOrderConfig,
  decodeOrderConfig,
  MENU_MAX,
  SHOP_NAME_MAX,
  EMOJI_MAX,
  type MobileOrderConfig,
} from '@/lib/mobileOrder';

const RECEIVER = '0x1111111111111111111111111111111111111111' as const;

function baseConfig(): MobileOrderConfig {
  return {
    receiver: RECEIVER,
    shopName: '珈琲スタンド OpenPay',
    mode: 'preorder',
    feePayer: 'merchant',
    socials: { x: 'https://x.com/openpay', instagram: 'https://instagram.com/openpay' },
    menu: [
      { id: 'a1', name: 'ブレンド☕', price: '500', visual: { kind: 'emoji', value: '☕' } },
      { id: 'a2', name: 'チーズケーキ', price: '650', visual: { kind: 'image', url: 'https://i.imgur.com/x.png' } },
      { id: 'a3', name: '水', price: '0.5' }, // visual 省略 + 小数価格
    ],
  };
}

describe('mobileOrder: encode/decode round-trip', () => {
  it('完全な設定 (絵文字/画像/SNS/日本語/小数) が往復で一致', () => {
    const c = baseConfig();
    const decoded = decodeOrderConfig(encodeOrderConfig(c));
    expect(decoded).toEqual(c);
  });

  it('SNS 無し・visual 無しの最小構成も往復一致', () => {
    const c: MobileOrderConfig = {
      receiver: RECEIVER,
      shopName: '店',
      mode: 'storefront',
      feePayer: 'customer',
      socials: {},
      menu: [{ id: 'x', name: 'A', price: '100' }],
    };
    expect(decodeOrderConfig(encodeOrderConfig(c))).toEqual(c);
  });

  it('エンコード結果は URL 安全 (+ / = を含まない)', () => {
    const token = encodeOrderConfig(baseConfig());
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('mobileOrder: decode は untrusted 入力を全検証 (不正は null)', () => {
  it('不正な base64 / 非JSON は null', () => {
    expect(decodeOrderConfig('!!!not-base64!!!')).toBeNull();
    expect(decodeOrderConfig(encodeOrderConfig(baseConfig()) + '@@')).toBeNull();
  });

  it('JSON だが非オブジェクト/配列は null', () => {
    const enc = (v: unknown) =>
      Buffer.from(JSON.stringify(v), 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    expect(decodeOrderConfig(enc('x'))).toBeNull();
    expect(decodeOrderConfig(enc(42))).toBeNull();
    expect(decodeOrderConfig(enc(null))).toBeNull();
  });

  // 各フィールドを 1 つずつ壊して null を確認 (encode は型を緩めて流し込む)。
  function corrupt(mut: (c: Record<string, unknown>) => void): ReturnType<typeof decodeOrderConfig> {
    const c = baseConfig() as unknown as Record<string, unknown>;
    mut(c);
    return decodeOrderConfig(encodeOrderConfig(c as unknown as MobileOrderConfig));
  }

  it('receiver がアドレスでない → null', () => {
    expect(corrupt((c) => (c.receiver = '0xnotanaddress'))).toBeNull();
    expect(corrupt((c) => (c.receiver = 123))).toBeNull();
  });

  it('shopName 空 / 長すぎ → null', () => {
    expect(corrupt((c) => (c.shopName = ''))).toBeNull();
    expect(corrupt((c) => (c.shopName = 'あ'.repeat(SHOP_NAME_MAX + 1)))).toBeNull();
  });

  it('mode / feePayer が enum 外 → null', () => {
    expect(corrupt((c) => (c.mode = 'delivery'))).toBeNull();
    expect(corrupt((c) => (c.feePayer = 'platform'))).toBeNull();
  });

  it('menu が空 / 上限超過 → null', () => {
    expect(corrupt((c) => (c.menu = []))).toBeNull();
    expect(
      corrupt((c) => {
        c.menu = Array.from({ length: MENU_MAX + 1 }, (_, i) => ({
          id: `i${i}`,
          name: 'x',
          price: '1',
        }));
      }),
    ).toBeNull();
  });

  it('price が非正/非数 → null', () => {
    expect(corrupt((c) => ((c.menu as { price: string }[])[0].price = '0'))).toBeNull();
    expect(corrupt((c) => ((c.menu as { price: string }[])[0].price = '-5'))).toBeNull();
    expect(corrupt((c) => ((c.menu as { price: string }[])[0].price = 'abc'))).toBeNull();
  });

  it('画像 visual が https でない → null (javascript:/http: を弾く)', () => {
    expect(
      corrupt((c) => ((c.menu as { visual: unknown }[])[1].visual = { kind: 'image', url: 'http://x/p.png' })),
    ).toBeNull();
    expect(
      corrupt((c) => ((c.menu as { visual: unknown }[])[1].visual = { kind: 'image', url: 'javascript:alert(1)' })),
    ).toBeNull();
  });

  it('emoji visual が長すぎ / 不明な kind → null', () => {
    expect(
      corrupt((c) => ((c.menu as { visual: unknown }[])[0].visual = { kind: 'emoji', value: '☕'.repeat(EMOJI_MAX + 1) })),
    ).toBeNull();
    expect(
      corrupt((c) => ((c.menu as { visual: unknown }[])[0].visual = { kind: 'video', url: 'https://x' })),
    ).toBeNull();
  });

  it('SNS が https でない → null', () => {
    expect(corrupt((c) => ((c.socials as { x: string }).x = 'http://x.com'))).toBeNull();
    expect(corrupt((c) => ((c.socials as { x: string }).x = 'ftp://x'))).toBeNull();
  });
});
