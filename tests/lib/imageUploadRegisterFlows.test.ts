// 画像のアップロード PR 3B (レジの商品の画像・モバイル注文の店のアイコンとカバー) で、アップロードした画像の URL (Vercel Blob の
// 公開の URL) が今までの流れをそのまま通ること。保存の形は今と同じ https URL の文字列なので、どの変換・検証も変えていない:
// - メニューへの流れ: 商品 (image) → presetsToMenu → visual {kind:'image', url} → menuToPresets → image。
// - 公開: 下書き + メニュー → draftToStorefrontParts → validateStorefrontParts (POST /api/handle と同じ検証・512 字の上限)。
// - 旧い注文ページの URL (/order?s=): 設定一式を base64url(utf8(JSON)) に入れる (画像の URL の長さだけ長くなる)。卓上の QR
//   (/@handle) は画像に関わらない (components の test が見る)。
// - 購入の snapshot (注文の照合の digest) は商品の名前・数量・価格だけで、画像は入らない。
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MOBILE_ORDER_DRAFT,
  draftToStorefrontParts,
  menuToPresets,
  presetsToMenu,
} from '@/hooks/useMobileOrderDraft';
import type { ProductPreset } from '@/hooks/useProductPresets';
import { decodeOrderConfig, encodeOrderConfig, validateStorefrontParts, type MobileOrderConfig } from '@/lib/mobileOrder';
import { canonicalOrder, orderDigest } from '@/lib/orderBind';

const ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const STORE = 'https://teststore.public.blob.vercel-storage.com/v1/AbCdEfGhIjKlMnOpQrStUv';
const PRESET_URL = `${STORE}/preset/Zx9_Yw8-Vu7tS6rQ5pO4nM.jpg`;
const AVATAR_URL = `${STORE}/storefront/Aa1_Bb2-Cc3dD4eE5fF6gG.png`;
const COVER_URL = `${STORE}/storefront/Hh7_Ii8-Jj9kK0lL1mM2nN.jpg`;

function preset(over: Partial<ProductPreset>): ProductPreset {
  return {
    id: 'p1',
    name: 'ブレンド',
    unitPrice: '500',
    token: 'jpyc',
    taxRate: 8,
    taxCategory: 'taxable_8',
    memo: null,
    sortOrder: 0,
    enabled: true,
    ...over,
  };
}

describe('アップロードした画像の URL の流れ', () => {
  it('メニューへの往復: 商品の image が visual {kind:image} になり、読み込むと image に戻る', () => {
    const presets = [preset({ id: 'a', image: PRESET_URL }), preset({ id: 'b', name: 'ラテ', unitPrice: '600', sortOrder: 1 })];
    const menu = presetsToMenu(presets);
    expect(menu[0].visual).toEqual({ kind: 'image', url: PRESET_URL });
    expect(menu[1].visual).toBeUndefined();
    const back = menuToPresets(menu);
    expect(back.map((p) => [p.id, p.image])).toEqual([
      ['a', PRESET_URL],
      ['b', undefined],
    ]);
  });

  it('公開: アイコン・カバー・メニューの画像の URL は POST /api/handle と同じ検証を通り、512 字を超える URL は今までどおり外れる', () => {
    const menu = presetsToMenu([preset({ id: 'a', image: PRESET_URL })]);
    const parts = draftToStorefrontParts({ ...DEFAULT_MOBILE_ORDER_DRAFT, shopName: 'Cafe', avatar: AVATAR_URL, cover: COVER_URL }, menu);
    const valid = validateStorefrontParts(parts);
    expect(valid).toMatchObject({ avatar: AVATAR_URL, cover: COVER_URL });
    expect(valid?.menu[0].visual).toEqual({ kind: 'image', url: PRESET_URL });

    const tooLong = `${STORE}/storefront/${'a'.repeat(512)}.jpg`;
    const rejected = validateStorefrontParts(draftToStorefrontParts({ ...DEFAULT_MOBILE_ORDER_DRAFT, shopName: 'Cafe', avatar: tooLong }, menu));
    expect(rejected?.avatar).toBeUndefined();
  });

  it('旧い注文ページの URL (/order?s=): 画像の URL を入れても往復でき、長さは URL の分だけ (base64url で約 4/3 倍) 増える', () => {
    const base: MobileOrderConfig = {
      receiver: ADDR,
      chain: 'polygon',
      shopName: 'Cafe',
      mode: 'storefront',
      feePayer: 'merchant',
      socials: [],
      menu: [{ id: 'a', name: 'ブレンド', price: '500' }],
    };
    const withImages: MobileOrderConfig = {
      ...base,
      avatar: AVATAR_URL,
      cover: COVER_URL,
      menu: [{ id: 'a', name: 'ブレンド', price: '500', visual: { kind: 'image', url: PRESET_URL } }],
    };
    const plain = encodeOrderConfig(base);
    const token = encodeOrderConfig(withImages);
    expect(decodeOrderConfig(token)).toMatchObject({
      avatar: AVATAR_URL,
      cover: COVER_URL,
      menu: [{ id: 'a', visual: { kind: 'image', url: PRESET_URL } }],
    });
    const addedJson = JSON.stringify(withImages).length - JSON.stringify(base).length;
    expect(token.length - plain.length).toBeLessThanOrEqual(Math.ceil((addedJson * 4) / 3) + 4);
  });

  it('購入の snapshot (注文の照合の digest) は画像に関わらない (名前・数量・価格だけ)', () => {
    const order = (items: unknown[]) =>
      orderDigest(
        canonicalOrder({
          chainId: 137,
          tokenAddress: '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29',
          merchant: ADDR,
          handle: 'cafe',
          orderId: 'O-1',
          items,
        }),
      );
    const withImage = presetsToMenu([preset({ id: 'a', image: PRESET_URL })]).map((m) => ({ name: m.name, qty: 2, price: m.price, visual: m.visual }));
    const withoutImage = presetsToMenu([preset({ id: 'a' })]).map((m) => ({ name: m.name, qty: 2, price: m.price }));
    expect(order(withImage)).toBe(order(withoutImage));
    expect(canonicalOrder({ chainId: 137, tokenAddress: '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29', merchant: ADDR, handle: 'cafe', orderId: 'O-1', items: withImage }).items).toEqual([
      { name: 'ブレンド', qty: 2, price: '500' },
    ]);
  });
});
