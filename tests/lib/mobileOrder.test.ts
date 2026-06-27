// モバイルオーダー設定の URL コーデック (lib/mobileOrder.ts) を実コードで検証。
// 観点: round-trip 一致 / UTF-8(日本語・絵文字) / untrusted 入力の全検証 (不正は null・throw しない)。

import { describe, it, expect } from 'vitest';
import {
  encodeOrderConfig,
  decodeOrderConfig,
  validateOrderConfig,
  validateStorefrontParts,
  groupMenuByCategory,
  buildOrderUrl,
  type MenuItem,
  safeHttpUrl,
  telHref,
  mapSearchHref,
  ORDER_PATH,
  MENU_MAX,
  SHOP_NAME_MAX,
  TAGLINE_MAX,
  EMOJI_MAX,
  SOCIALS_MAX,
  type MobileOrderConfig,
} from '@/lib/mobileOrder';

const RECEIVER = '0x1111111111111111111111111111111111111111' as const;

function baseConfig(): MobileOrderConfig {
  return {
    receiver: RECEIVER,
    chain: 'polygon',
    shopName: '珈琲スタンド OpenPay',
    avatar: 'https://img.example/shop-icon.png',
    mode: 'preorder',
    feePayer: 'merchant',
    socials: ['https://x.com/openpay', 'https://instagram.com/openpay'],
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
      chain: 'kaia',
      shopName: '店',
      mode: 'storefront',
      feePayer: 'customer',
      socials: [],
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

  it('chain が JPYC チェーンslug でない / 欠落 → null', () => {
    expect(corrupt((c) => (c.chain = 'base'))).toBeNull(); // base は JPYC チェーンでない
    expect(corrupt((c) => (c.chain = 'polygonn'))).toBeNull();
    expect(corrupt((c) => delete c.chain)).toBeNull(); // 欠落
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

  // socials は配列。不正 URL は **黙って除外** (注文自体は壊さない・@handle と同型)。
  it('SNS の非 https / 非文字列は除外し、有効な https のみ順序保持 (config は null にしない)', () => {
    const decoded = corrupt((c) => {
      c.socials = [
        'http://x.com', // http は不可
        'https://ok.example/a', // 有効
        'javascript:alert(1)', // XSS スキーム
        42, // 非文字列
        'https://ok.example/b', // 有効
      ];
    });
    expect(decoded).not.toBeNull();
    expect(decoded?.socials).toEqual(['https://ok.example/a', 'https://ok.example/b']);
  });

  it('SNS が配列でなければ空配列 (null にしない)', () => {
    expect(corrupt((c) => (c.socials = { x: 'https://x.com' }))?.socials).toEqual([]);
    expect(corrupt((c) => (c.socials = 'https://x.com'))?.socials).toEqual([]);
    expect(corrupt((c) => delete c.socials)?.socials).toEqual([]);
  });

  it('SNS は SOCIALS_MAX 件で切り詰め', () => {
    const decoded = corrupt((c) => {
      c.socials = Array.from({ length: SOCIALS_MAX + 3 }, (_, i) => `https://s${i}.example`);
    });
    expect(decoded?.socials).toHaveLength(SOCIALS_MAX);
  });

  // avatar も socials と同じ寛容さ: 非 https / 空 / 非文字列は黙って除外 (config は壊さない)。
  it('avatar が非 https / 空 / 非文字列は除外し config は null にしない', () => {
    expect(corrupt((c) => (c.avatar = 'http://x/icon.png'))?.avatar).toBeUndefined();
    expect(corrupt((c) => (c.avatar = 'javascript:alert(1)'))?.avatar).toBeUndefined();
    expect(corrupt((c) => (c.avatar = ''))?.avatar).toBeUndefined();
    expect(corrupt((c) => (c.avatar = 123))?.avatar).toBeUndefined();
    expect(corrupt((c) => delete c.avatar)?.avatar).toBeUndefined();
    // 不正 avatar でも他が valid なら config 自体は成立する。
    expect(corrupt((c) => (c.avatar = 'ftp://x'))).not.toBeNull();
  });

  it('valid な avatar (https) は往復で保持される', () => {
    const c = baseConfig();
    expect(decodeOrderConfig(encodeOrderConfig(c))?.avatar).toBe(c.avatar);
  });

  it('tagline (店名下のひとこと) は往復で保持される', () => {
    const c = { ...baseConfig(), tagline: '自家焙煎の一杯をあなたに' };
    expect(decodeOrderConfig(encodeOrderConfig(c))?.tagline).toBe(c.tagline);
  });

  it('tagline 未設定は config に載らない (任意・round-trip 最小形)', () => {
    expect(
      decodeOrderConfig(encodeOrderConfig(baseConfig()))?.tagline,
    ).toBeUndefined();
  });

  it('tagline が長すぎ → 黙って除外し config は null にしない', () => {
    const c = { ...baseConfig(), tagline: 'あ'.repeat(TAGLINE_MAX + 1) };
    const d = decodeOrderConfig(encodeOrderConfig(c));
    expect(d).not.toBeNull();
    expect(d?.tagline).toBeUndefined();
  });

  it('validateStorefrontParts も tagline を trim して載せる', () => {
    const parts = validateStorefrontParts({ ...baseConfig(), tagline: '  ひとこと  ' });
    expect(parts?.tagline).toBe('ひとこと');
  });
});

describe('mobileOrder: validateOrderConfig は decode と検証を共有 (単一情報源)', () => {
  it('valid なオブジェクトはそのまま config を返す (encode/decode 経由しない)', () => {
    const c = baseConfig();
    expect(validateOrderConfig(c)).toEqual(c);
  });

  it('非オブジェクト / 不正 receiver は null', () => {
    expect(validateOrderConfig(null)).toBeNull();
    expect(validateOrderConfig('x')).toBeNull();
    expect(validateOrderConfig({ ...baseConfig(), receiver: 'nope' })).toBeNull();
  });

  it('decode は validateOrderConfig に委譲する (往復が validate と一致)', () => {
    const c = baseConfig();
    expect(decodeOrderConfig(encodeOrderConfig(c))).toEqual(validateOrderConfig(c));
  });
});

describe('mobileOrder: validateStorefrontParts (@handle storefront の単一情報源)', () => {
  const good = {
    chain: 'polygon',
    mode: 'storefront',
    feePayer: 'merchant',
    menu: [{ id: 'a', name: 'A', price: '500' }],
  };
  it('valid な {chain,mode,feePayer,menu} を返す', () => {
    expect(validateStorefrontParts(good)).toEqual(good);
  });
  it('chain が JPYC チェーンでない → null', () => {
    expect(validateStorefrontParts({ ...good, chain: 'base' })).toBeNull();
    expect(validateStorefrontParts({ ...good, chain: 'polygonn' })).toBeNull();
  });
  it('mode / feePayer が enum 外 → null', () => {
    expect(validateStorefrontParts({ ...good, mode: 'delivery' })).toBeNull();
    expect(validateStorefrontParts({ ...good, feePayer: 'platform' })).toBeNull();
  });
  it('menu が空 / 上限超過 → null', () => {
    expect(validateStorefrontParts({ ...good, menu: [] })).toBeNull();
    expect(
      validateStorefrontParts({
        ...good,
        menu: Array.from({ length: MENU_MAX + 1 }, (_, i) => ({ id: `i${i}`, name: 'x', price: '1' })),
      }),
    ).toBeNull();
  });
  it('menu 要素が不正 (価格0) → null', () => {
    expect(validateStorefrontParts({ ...good, menu: [{ id: 'a', name: 'A', price: '0' }] })).toBeNull();
  });
  it('非オブジェクト → null', () => {
    expect(validateStorefrontParts(null)).toBeNull();
    expect(validateStorefrontParts('x')).toBeNull();
  });
  it('店舗ブランディング (shopName/avatar/socials) を保持・不正は除外', () => {
    const r = validateStorefrontParts({
      ...good,
      shopName: 'テスト珈琲店',
      avatar: 'https://img.example/icon.png',
      socials: ['https://x.com/shop', 'http://insecure', 'javascript:1'],
    });
    expect(r?.shopName).toBe('テスト珈琲店');
    expect(r?.avatar).toBe('https://img.example/icon.png');
    expect(r?.socials).toEqual(['https://x.com/shop']); // 非 https は除外
  });
  it('不正な avatar / 全て非 https の socials は載せない (任意・null にしない)', () => {
    const r = validateStorefrontParts({ ...good, avatar: 'http://x/a.png', socials: ['http://x'] });
    expect(r).not.toBeNull();
    expect(r?.avatar).toBeUndefined();
    expect(r?.socials).toBeUndefined();
  });
  it('店舗情報 (address/hours/phone) を trim 保持・acceptingOrders は false のみ保持', () => {
    const r = validateStorefrontParts({
      ...good,
      address: '  東京都〇〇 1-2-3  ',
      hours: '  11:00-22:00  ',
      phone: '  03-1234-5678  ',
      acceptingOrders: false,
    });
    expect(r?.address).toBe('東京都〇〇 1-2-3');
    expect(r?.hours).toBe('11:00-22:00');
    expect(r?.phone).toBe('03-1234-5678');
    expect(r?.acceptingOrders).toBe(false);
  });
  it('acceptingOrders=true (既定) はフィールドを持たない (round-trip 最小化)', () => {
    const r = validateStorefrontParts({ ...good, acceptingOrders: true });
    expect(r).not.toBeNull();
    expect('acceptingOrders' in (r ?? {})).toBe(false);
  });
  it('空 / 長すぎる店舗情報は黙って除外 (注文は壊さない)', () => {
    const r = validateStorefrontParts({ ...good, address: '', phone: 'x'.repeat(200) });
    expect(r).not.toBeNull();
    expect(r?.address).toBeUndefined();
    expect(r?.phone).toBeUndefined();
  });
});

describe('mobileOrder: validateOrderConfig は店舗情報を parts から載せる', () => {
  it('address/hours/phone/acceptingOrders=false を config に載せる', () => {
    const c = validateOrderConfig({
      ...baseConfig(),
      address: '東京都〇〇',
      hours: '11:00-22:00',
      phone: '03-1234-5678',
      acceptingOrders: false,
    });
    expect(c?.address).toBe('東京都〇〇');
    expect(c?.hours).toBe('11:00-22:00');
    expect(c?.phone).toBe('03-1234-5678');
    expect(c?.acceptingOrders).toBe(false);
  });
  it('accent (テーマ色) は有効な #rrggbb のみ載せ、不正/未設定は落とす', () => {
    expect(validateOrderConfig({ ...baseConfig(), accent: '#9a3412' })?.accent).toBe('#9a3412');
    expect('accent' in (validateOrderConfig({ ...baseConfig(), accent: 'red' }) ?? {})).toBe(false);
    expect('accent' in (validateOrderConfig({ ...baseConfig(), accent: '#abc' }) ?? {})).toBe(false);
    expect('accent' in (validateOrderConfig(baseConfig()) ?? {})).toBe(false);
  });
  it('店舗情報込みで encode→decode が往復一致', () => {
    const c = validateOrderConfig({ ...baseConfig(), address: '東京都〇〇', acceptingOrders: false })!;
    expect(decodeOrderConfig(encodeOrderConfig(c))).toEqual(c);
  });
});

describe('mobileOrder: dineIn (提供形態・店内のテーブル番号)', () => {
  const good = {
    chain: 'polygon',
    mode: 'storefront',
    feePayer: 'merchant',
    menu: [{ id: 'a', name: 'A', price: '500' }],
  };
  it('dineIn=true のときだけ parts に true を保持', () => {
    expect(validateStorefrontParts({ ...good, dineIn: true })?.dineIn).toBe(true);
  });
  it('dineIn=false / 未設定 (テイクアウト) はフィールドを持たない (round-trip 最小化)', () => {
    expect('dineIn' in (validateStorefrontParts({ ...good, dineIn: false }) ?? {})).toBe(false);
    expect('dineIn' in (validateStorefrontParts(good) ?? {})).toBe(false);
  });
  it('validateOrderConfig が dineIn を config に載せ・往復一致 (storefront)', () => {
    // dineIn は storefront のときのみ採用 (preorder は来店前ゆえテーブル予約不可)。
    const c = validateOrderConfig({ ...baseConfig(), mode: 'storefront', dineIn: true })!;
    expect(c.dineIn).toBe(true);
    expect(decodeOrderConfig(encodeOrderConfig(c))?.dineIn).toBe(true);
  });
  it('dineIn 未設定の config は dineIn を持たない (既定 テイクアウト)', () => {
    expect('dineIn' in (validateOrderConfig(baseConfig()) ?? {})).toBe(false);
  });
  // 不変条件: preorder (事前注文) は来店前ゆえテーブル予約不可 → dineIn は採用しない (常にテイクアウト)。
  it('preorder + dineIn=true は dineIn を捨てる (テイクアウト固定・storefront のみ店内可)', () => {
    const parts = validateStorefrontParts({ ...good, mode: 'preorder', dineIn: true });
    expect(parts?.mode).toBe('preorder');
    expect('dineIn' in (parts ?? {})).toBe(false);
  });
  it('validateOrderConfig も preorder では dineIn を載せない (decode 単一情報源)', () => {
    const c = validateOrderConfig({ ...baseConfig(), mode: 'preorder', dineIn: true })!;
    expect(c.mode).toBe('preorder');
    expect('dineIn' in c).toBe(false);
    expect('dineIn' in (decodeOrderConfig(encodeOrderConfig(c)) ?? {})).toBe(false);
  });
});

describe('mobileOrder: chains (受取チェーン複数選択)', () => {
  const good = {
    chain: 'polygon',
    mode: 'storefront',
    feePayer: 'merchant',
    menu: [{ id: 'a', name: 'A', price: '500' }],
  };
  it('chains 複数を保持 (chain を含め重複除去)', () => {
    expect(validateStorefrontParts({ ...good, chains: ['polygon', 'kaia'] })?.chains).toEqual([
      'polygon',
      'kaia',
    ]);
  });
  it('chain (primary) が chains に無ければ先頭へ補完', () => {
    expect(
      validateStorefrontParts({ ...good, chain: 'polygon', chains: ['kaia'] })?.chains,
    ).toEqual(['polygon', 'kaia']);
  });
  it('重複・不正チェーンは除去', () => {
    expect(
      validateStorefrontParts({ ...good, chains: ['polygon', 'polygon', 'nope', 'kaia'] })?.chains,
    ).toEqual(['polygon', 'kaia']);
  });
  it('1 件のみ / chains 無し (旧 schema) は chains を持たない (単一扱い)', () => {
    expect('chains' in (validateStorefrontParts({ ...good, chains: ['polygon'] }) ?? {})).toBe(false);
    expect('chains' in (validateStorefrontParts(good) ?? {})).toBe(false);
  });
  it('validateOrderConfig が chains を config に載せ・往復一致', () => {
    const c = validateOrderConfig({ ...baseConfig(), chain: 'polygon', chains: ['polygon', 'kaia'] })!;
    expect(c.chains).toEqual(['polygon', 'kaia']);
    expect(decodeOrderConfig(encodeOrderConfig(c))?.chains).toEqual(['polygon', 'kaia']);
  });
});

describe('mobileOrder: telHref / mapSearchHref (公開ページの電話/地図リンク)', () => {
  it('telHref は数字と先頭 + のみ残す', () => {
    expect(telHref('03-1234-5678')).toBe('tel:0312345678');
    expect(telHref('+81 (3) 1234-5678')).toBe('tel:+81312345678');
  });
  it('telHref は数字無し / undefined / 空 → undefined', () => {
    expect(telHref('お電話で')).toBeUndefined();
    expect(telHref(undefined)).toBeUndefined();
    expect(telHref('')).toBeUndefined();
  });
  it('mapSearchHref は https の Google Maps 検索 URL (encode 済み)', () => {
    const h = mapSearchHref('東京都 渋谷');
    expect(h?.startsWith('https://www.google.com/maps/search/?api=1&query=')).toBe(true);
    expect(h).toContain(encodeURIComponent('東京都 渋谷'));
  });
  it('mapSearchHref は空白のみ / undefined → undefined', () => {
    expect(mapSearchHref('   ')).toBeUndefined();
    expect(mapSearchHref(undefined)).toBeUndefined();
  });
});

describe('mobileOrder: category (メニューのカテゴリー)', () => {
  it('category 付き項目が往復一致 (validMenuItem が保持)', () => {
    const c: MobileOrderConfig = {
      ...baseConfig(),
      menu: [{ id: 'a', name: 'A', price: '500', category: 'ドリンク' }],
    };
    expect(decodeOrderConfig(encodeOrderConfig(c))?.menu[0].category).toBe('ドリンク');
  });
  it('空/長すぎる category は無視 (項目自体は残る)', () => {
    const enc = (cat: unknown) =>
      Buffer.from(
        JSON.stringify({
          ...baseConfig(),
          menu: [{ id: 'a', name: 'A', price: '500', category: cat }],
        }),
        'utf8',
      )
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    expect(decodeOrderConfig(enc(''))?.menu[0].category).toBeUndefined();
    expect(decodeOrderConfig(enc('あ'.repeat(25)))?.menu[0].category).toBeUndefined();
    expect(decodeOrderConfig(enc('あ'.repeat(25)))?.menu[0].name).toBe('A'); // 項目は残る
  });
});

describe('mobileOrder: groupMenuByCategory', () => {
  const item = (id: string, category?: string): MenuItem => ({
    id,
    name: id,
    price: '100',
    ...(category ? { category } : {}),
  });
  it('カテゴリー出現順にグループ化・各グループ内は menu 順', () => {
    const groups = groupMenuByCategory([
      item('a', 'ドリンク'),
      item('b', 'フード'),
      item('c', 'ドリンク'),
      item('d'),
    ]);
    expect(groups.map((g) => g.category)).toEqual(['ドリンク', 'フード', null]);
    expect(groups[0].items.map((i) => i.id)).toEqual(['a', 'c']);
    expect(groups[1].items.map((i) => i.id)).toEqual(['b']);
    expect(groups[2].items.map((i) => i.id)).toEqual(['d']); // 未分類
  });
  it('全て未分類なら 1 グループ (category:null)', () => {
    const groups = groupMenuByCategory([item('a'), item('b')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].category).toBeNull();
    expect(groups[0].items).toHaveLength(2);
  });
  it('空メニューは空配列', () => {
    expect(groupMenuByCategory([])).toEqual([]);
  });
});

describe('mobileOrder: buildOrderUrl', () => {
  it('origin + /order?s=<token> を組み立て、token は元 config へ復号できる', () => {
    const c = baseConfig();
    const url = buildOrderUrl('https://open-pay.jp', c);
    expect(url.startsWith(`https://open-pay.jp${ORDER_PATH}?s=`)).toBe(true);
    const token = url.slice(`https://open-pay.jp${ORDER_PATH}?s=`.length);
    expect(decodeOrderConfig(token)).toEqual(c);
  });

  it('クエリ値は URL 安全 (base64url のみ・%エンコード不要)', () => {
    const url = buildOrderUrl('https://open-pay.jp', baseConfig());
    const token = url.split('?s=')[1];
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // new URL で round-trip しても s パラメータが変質しない (エスケープ不要)。
    expect(new URL(url).searchParams.get('s')).toBe(token);
  });
});

describe('mobileOrder: safeHttpUrl (href/src 描画直前の XSS 二重防御)', () => {
  it('https はそのまま返す', () => {
    expect(safeHttpUrl('https://x.com/shop')).toBe('https://x.com/shop');
    expect(safeHttpUrl('https://i.imgur.com/a.png')).toBe('https://i.imgur.com/a.png');
  });

  it('javascript: / data: / http: / vbscript: は undefined (XSS スキーム排除)', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeHttpUrl('data:text/html,<script>alert(1)</script>')).toBeUndefined();
    expect(safeHttpUrl('http://x.com')).toBeUndefined(); // https のみ
    expect(safeHttpUrl('vbscript:msgbox(1)')).toBeUndefined();
  });

  it('空 / undefined / 解析不能は undefined', () => {
    expect(safeHttpUrl(undefined)).toBeUndefined();
    expect(safeHttpUrl('')).toBeUndefined();
    expect(safeHttpUrl('not a url')).toBeUndefined();
  });
});

describe('mobileOrder: メニュー項目の税 (taxRate/taxCategory) — presets 由来', () => {
  it('税率/税区分を持つ項目が往復一致', () => {
    const c: MobileOrderConfig = {
      receiver: RECEIVER,
      chain: 'polygon',
      shopName: '店',
      mode: 'storefront',
      feePayer: 'merchant',
      socials: [],
      menu: [{ id: 'a', name: 'A', price: '500', taxRate: 10, taxCategory: 'taxable_10' }],
    };
    expect(decodeOrderConfig(encodeOrderConfig(c))).toEqual(c);
  });

  it('不正な税率/税区分は黙って無視 (項目自体は残る)', () => {
    const enc = (menu: unknown) =>
      Buffer.from(
        JSON.stringify({
          receiver: RECEIVER,
          chain: 'polygon',
          shopName: '店',
          mode: 'storefront',
          feePayer: 'merchant',
          socials: [],
          menu,
        }),
        'utf8',
      )
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    const decoded = decodeOrderConfig(
      enc([{ id: 'a', name: 'A', price: '500', taxRate: 999, taxCategory: 'bogus' }]),
    );
    expect(decoded?.menu[0]).toEqual({ id: 'a', name: 'A', price: '500' });
  });
});
