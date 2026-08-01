import { describe, it, expect } from 'vitest';
import {
  buildTipOgModel,
  buildTipOgImageUrl,
  buildTipMeta,
  buildProductOgImageUrl,
  buildProductOgModel,
  buildStorefrontOgModel,
  buildStorefrontMeta,
  OG_DEFAULT_COLOR,
} from '@/lib/ogTipCard';

const ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const sp = (q: string) => new URLSearchParams(q);

describe('buildTipOgModel', () => {
  it('default (no params) is the Japanese generic card', () => {
    const m = buildTipOgModel(sp(''));
    expect(m.locale).toBe('ja');
    expect(m.brand).toBe('OpenPay');
    expect(m.heading).toBe('チップを送る');
    expect(m.sub).toBe('JPYC / USDCで応援 · ガス不要');
    expect(m.footer).toBe('ウォレットで直接受け取り');
    expect(m.url).toBe('open-pay.jp');
    expect(m.color).toBe(OG_DEFAULT_COLOR);
  });

  it('locale=en uses English generic copy', () => {
    const m = buildTipOgModel(sp('locale=en'));
    expect(m.locale).toBe('en');
    expect(m.heading).toBe('Send a tip');
    expect(m.sub).toBe('Support with JPYC / USDC · no gas');
    expect(m.footer).toBe('Straight to your wallet');
  });

  it('valid tip (to+token=jpyc, ja): named heading + JPYC sub', () => {
    const m = buildTipOgModel(sp(`to=${ADDR}&token=jpyc&name=Alice`));
    expect(m.heading).toBe('Alice さんへ');
    expect(m.sub).toBe('JPYCで応援 · ガス不要');
  });

  it('valid tip (to+token=usdc, en): Tip heading + USDC sub', () => {
    const m = buildTipOgModel(sp(`locale=en&to=${ADDR}&token=usdc&name=Bob`));
    expect(m.heading).toBe('Tip Bob');
    expect(m.sub).toBe('Support with USDC · no gas');
  });

  it('native=polygon => POL label; not gasless so no gas claim', () => {
    const m = buildTipOgModel(sp(`to=${ADDR}&native=polygon&name=Alice`));
    expect(m.heading).toBe('Alice さんへ');
    expect(m.sub).toBe('POLで応援');
    expect(m.sub).not.toContain('ガス不要');
  });

  it('native=kaia (en): KAIA label, no gas claim', () => {
    const m = buildTipOgModel(sp(`locale=en&to=${ADDR}&native=kaia`));
    expect(m.sub).toBe('Support with KAIA');
    expect(m.sub).not.toContain('no gas');
  });

  it('name is only used for a valid tip (to + token/native); otherwise generic', () => {
    // 宛先 (to) 無しの直接アクセスは name を採らない (ブランド悪用防止)。
    expect(buildTipOgModel(sp('token=jpyc&name=Evil')).heading).toBe('チップを送る');
    // token も native も無ければ name 無視。
    expect(buildTipOgModel(sp(`to=${ADDR}&name=Evil`)).heading).toBe('チップを送る');
    // 不正 address は name 無視。
    expect(
      buildTipOgModel(sp('to=0xnope&token=jpyc&name=Evil')).heading,
    ).toBe('チップを送る');
  });

  it('long name is truncated to 20 with an ellipsis', () => {
    const long = 'a'.repeat(25);
    const m = buildTipOgModel(sp(`to=${ADDR}&token=jpyc&name=${long}`));
    expect(m.heading).toBe(`${'a'.repeat(20)}… さんへ`);
    expect(m.heading).not.toContain('a'.repeat(21));
  });

  it('control characters are stripped from name (NUL / BEL)', () => {
    // 制御文字はソースに literal で置かず runtime 生成 (source を純 ASCII に保つ)。
    const noisy = `A${String.fromCharCode(0)}B${String.fromCharCode(7)}C`;
    const m = buildTipOgModel(
      sp(`to=${ADDR}&token=jpyc&name=${encodeURIComponent(noisy)}`),
    );
    expect(m.heading).toBe('ABC さんへ');
  });

  it('whitespace-only name falls back to generic', () => {
    const m = buildTipOgModel(
      sp(`to=${ADDR}&token=jpyc&name=${encodeURIComponent('   ')}`),
    );
    expect(m.heading).toBe('チップを送る');
  });

  it('valid color is used; invalid / missing falls back to default', () => {
    expect(buildTipOgModel(sp(`to=${ADDR}&token=jpyc&color=%23ff8800`)).color).toBe(
      '#ff8800',
    );
    expect(buildTipOgModel(sp('color=red')).color).toBe(OG_DEFAULT_COLOR);
    expect(buildTipOgModel(sp('color=%23xyz')).color).toBe(OG_DEFAULT_COLOR);
  });

  it('allowlist theme のみモデルへ載せ、不正/欠落は従来モデルのまま', () => {
    expect(
      buildTipOgModel(sp(`to=${ADDR}&token=jpyc&theme=night`)).theme,
    ).toBe('night');
    expect(
      buildTipOgModel(sp(`to=${ADDR}&token=jpyc&theme=neon`)).theme,
    ).toBeUndefined();
    expect(buildTipOgModel(sp(`to=${ADDR}&token=jpyc`)).theme).toBeUndefined();
  });

  it('invalid token falls back to the JPYC / USDC label', () => {
    expect(buildTipOgModel(sp(`to=${ADDR}&token=eth`)).sub).toBe(
      'JPYC / USDCで応援 · ガス不要',
    );
  });
});

describe('buildTipOgImageUrl', () => {
  it('always carries to/token/locale; name/color only when present', () => {
    const url = buildTipOgImageUrl(
      ADDR,
      { token: 'jpyc', name: 'Alice', color: '#ff8800' },
      'ja',
    );
    expect(url.startsWith('/og/tip?')).toBe(true);
    const q = new URLSearchParams(url.split('?')[1]);
    expect(q.get('to')).toBe(ADDR);
    expect(q.get('token')).toBe('jpyc');
    expect(q.get('name')).toBe('Alice');
    expect(q.get('color')).toBe('#ff8800');
    expect(q.get('locale')).toBe('ja');
  });

  it('theme 無し URL は従来バイト列、theme ありだけ additive に出力', () => {
    expect(buildTipOgImageUrl(ADDR, { token: 'jpyc' }, 'ja')).toBe(
      `/og/tip?to=${ADDR}&token=jpyc&locale=ja`,
    );
    const themed = buildTipOgImageUrl(
      ADDR,
      { token: 'jpyc', theme: 'soft' },
      'ja',
    );
    expect(new URLSearchParams(themed.split('?')[1]).get('theme')).toBe('soft');
  });

  it('omits name/color when not provided', () => {
    const url = buildTipOgImageUrl(ADDR, { token: 'usdc' }, 'en');
    const q = new URLSearchParams(url.split('?')[1]);
    expect(q.has('name')).toBe(false);
    expect(q.has('color')).toBe(false);
    expect(q.get('token')).toBe('usdc');
    expect(q.get('locale')).toBe('en');
  });

  it('carries native instead of token when native is given', () => {
    const url = buildTipOgImageUrl(ADDR, { native: 'polygon', name: 'Alice' }, 'ja');
    const q = new URLSearchParams(url.split('?')[1]);
    expect(q.get('native')).toBe('polygon');
    expect(q.has('token')).toBe(false);
    expect(q.get('name')).toBe('Alice');
  });
});

describe('buildTipMeta', () => {
  it('named ja (gasless): name + token + gas-free claim', () => {
    const { title, description } = buildTipMeta(
      { name: 'Alice', tokenLabel: 'JPYC', gasless: true },
      'ja',
    );
    expect(title).toBe('Alice さんへチップ — OpenPay');
    expect(description).toContain('JPYC で Alice さんを応援');
    expect(description).toContain('ガス不要');
  });

  it('named en (gasless)', () => {
    const { title } = buildTipMeta(
      { name: 'Bob', tokenLabel: 'USDC', gasless: true },
      'en',
    );
    expect(title).toBe('Tip Bob — OpenPay');
  });

  it('nameless but known token => description uses that token (not both)', () => {
    const { description } = buildTipMeta(
      { tokenLabel: 'USDC', gasless: true },
      'ja',
    );
    expect(description).toContain('USDC');
    expect(description).not.toContain('JPYC / USDC');
  });

  it('native (gasless=false) does not claim gas-free', () => {
    const { description } = buildTipMeta(
      { name: 'Alice', tokenLabel: 'POL', gasless: false },
      'ja',
    );
    expect(description).toContain('POL');
    expect(description).not.toContain('ガス不要');
  });

  it('generic (facts=null) ja/en uses both-token generic copy', () => {
    expect(buildTipMeta(null, 'ja').title).toBe('OpenPay でチップを送る');
    expect(buildTipMeta(null, 'ja').description).toContain('JPYC / USDC');
    expect(buildTipMeta(null, 'en').title).toBe('Send a tip with OpenPay');
  });
});

describe('firstGrapheme / truncateGraphemes (サロゲート安全)', () => {
  it('絵文字/補助多言語面の漢字を先頭1文字で割らない', async () => {
    const { firstGrapheme } = await import('@/lib/ogTipCard');
    expect(firstGrapheme('🌸さくら')).toBe('🌸');
    expect(firstGrapheme('𠮷田太郎')).toBe('𠮷'); // U+20BB7 サロゲートペア
    expect(firstGrapheme('Alice')).toBe('A');
    expect(firstGrapheme('')).toBe('');
    expect('🌸'.slice(0, 1)).not.toBe(firstGrapheme('🌸さくら')); // 素の slice は壊れる
  });
  it('truncate はコードポイント単位で … を付ける', async () => {
    const { truncateGraphemes } = await import('@/lib/ogTipCard');
    expect(truncateGraphemes('abc', 5)).toBe('abc');
    expect(truncateGraphemes('abcdef', 3)).toBe('abc…');
    const out = truncateGraphemes('🌸'.repeat(4), 2);
    expect(out).toBe('🌸🌸…');
    expect(out.isWellFormed()).toBe(true);
  });
});

describe('buildHandleOgModel — サロゲート安全な initial', () => {
  it('絵文字始まりの名前でも initial が壊れない', async () => {
    const { buildHandleOgModel } = await import('@/lib/ogTipCard');
    const card = buildHandleOgModel({
      handle: 'sakura',
      name: '🌸さくら',
      tokenLabels: ['JPYC'],
      locale: 'ja',
    });
    expect(card.initial).toBe('🌸');
    expect(card.initial.isWellFormed()).toBe(true);
  });
});

describe('hexToRgba', () => {
  it('hex → rgba 変換・不正 hex は既定色に倒す', async () => {
    const { hexToRgba, OG_DEFAULT_COLOR } = await import('@/lib/ogTipCard');
    expect(hexToRgba('#2563eb', 0.5)).toBe('rgba(37, 99, 235, 0.5)');
    expect(hexToRgba('oops', 1)).toBe(hexToRgba(OG_DEFAULT_COLOR, 1));
  });
});

describe('tipModelToCard', () => {
  it('sub をピルに分解し、名前の頭文字を initial に採る', async () => {
    const { buildTipOgModel, tipModelToCard } = await import('@/lib/ogTipCard');
    const m = buildTipOgModel(
      new URLSearchParams({
        to: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81',
        token: 'jpyc',
        name: '山田太郎',
        locale: 'ja',
      }),
    );
    const card = tipModelToCard(m);
    expect(card.chips).toEqual(['JPYCで応援', 'ガス不要']);
    expect(card.initial).toBe('山');
    expect(card.handleLine).toBeUndefined();
  });
  it('汎用カードは initial=TIP', async () => {
    const { buildTipOgModel, tipModelToCard } = await import('@/lib/ogTipCard');
    const card = tipModelToCard(buildTipOgModel(new URLSearchParams({ locale: 'ja' })));
    expect(card.initial).toBe('TIP');
    expect(card.heading).toBe('チップを送る');
  });
  it('theme ありは OG 背景/文字トークンを反映し、無しは追加しない', async () => {
    const { buildTipOgModel, tipModelToCard } = await import('@/lib/ogTipCard');
    const themed = tipModelToCard(
      buildTipOgModel(
        new URLSearchParams({
          to: ADDR,
          token: 'jpyc',
          theme: 'night',
        }),
      ),
    );
    expect(themed.themeStyle?.backgroundColor).toBe('#0f172a');
    expect(themed.themeStyle?.headingColor).toBe('#f8fafc');
    const legacy = tipModelToCard(
      buildTipOgModel(new URLSearchParams({ to: ADDR, token: 'jpyc' })),
    );
    expect(legacy.themeStyle).toBeUndefined();
  });
});

describe('buildHandleOgModel / buildHandleOgImageUrl', () => {
  it('名前あり: heading=名前・handleLine=@x・initial=頭文字・ピル', async () => {
    const { buildHandleOgModel } = await import('@/lib/ogTipCard');
    const card = buildHandleOgModel({
      handle: 'masia',
      name: '山田太郎',
      color: '#2563eb',
      bio: 'Web3 クリエイター',
      tokenLabels: ['JPYC'],
      locale: 'ja',
    });
    expect(card.heading).toBe('山田太郎');
    expect(card.handleLine).toBe('@masia');
    expect(card.bio).toBe('Web3 クリエイター');
    expect(card.chips).toEqual(['JPYC で応援', 'ガス不要']);
    expect(card.initial).toBe('山');
    expect(card.accent).toBe('#2563eb');
  });
  it('名前なし: heading=@handle・initial=handle 頭文字 (大文字)・不正色は既定色', async () => {
    const { buildHandleOgModel, OG_DEFAULT_COLOR } = await import('@/lib/ogTipCard');
    const card = buildHandleOgModel({
      handle: 'alice',
      color: 'red',
      tokenLabels: [],
      locale: 'en',
    });
    expect(card.heading).toBe('@alice');
    expect(card.initial).toBe('A');
    expect(card.accent).toBe(OG_DEFAULT_COLOR);
    expect(card.chips[0]).toContain('JPYC'); // tokenLabels 空でも JPYC に倒す
  });
  it('長い bio は truncate (… 付き)', async () => {
    const { buildHandleOgModel } = await import('@/lib/ogTipCard');
    const card = buildHandleOgModel({
      handle: 'a_b',
      bio: 'x'.repeat(100),
      tokenLabels: ['JPYC', 'USDC'],
      locale: 'ja',
    });
    expect(card.bio).toBe('x'.repeat(48) + '…');
    expect(card.chips[0]).toBe('JPYC / USDC で応援');
  });
  it('og:image URL は /og/handle?h=&locale=', async () => {
    const { buildHandleOgImageUrl } = await import('@/lib/ogTipCard');
    expect(buildHandleOgImageUrl('masia', 'ja')).toBe('/og/handle?h=masia&locale=ja');
  });
});

describe('buildProductOgModel / buildProductOgImageUrl', () => {
  it('絵文字なしの initial は商品名の先頭文字 (飾り glyph の豆腐化を防ぐ)', () => {
    const card = buildProductOgModel({
      handle: 'alice',
      color: '#2563eb',
      title: 'アイコン素材集',
      priceJpyc: '120',
      locale: 'ja',
    });
    expect(card.initial).toBe('ア');
  });

  it('商品名・絵文字・価格/chain・出品者を商品カードへ載せる', () => {
    const card = buildProductOgModel({
      handle: 'masia',
      name: '山田太郎',
      color: '#2563eb',
      title: 'AI プロンプト集',
      emoji: '🧠',
      imageUrl: 'https://cdn.example.com/product.png',
      priceJpyc: '1200',
      locale: 'ja',
    });
    expect(card.heading).toBe('AI プロンプト集');
    expect(card.initial).toBe('🧠');
    expect(card.imageUrl).toBe('https://cdn.example.com/product.png');
    expect(card.chips).toEqual(['1,200 JPYC · Polygon']);
    expect(card.handleLine).toBe('山田太郎 · @masia');
    expect(card.footer).toBe('デジタル商品を購入');
    expect(card.accent).toBe('#2563eb');
  });

  it('名前/絵文字/色なしは @handle・記号・既定色へ fallback する', () => {
    const card = buildProductOgModel({
      handle: 'alice',
      title: 'Download',
      priceJpyc: '300',
      locale: 'en',
    });
    expect(card.handleLine).toBe('@alice');
    // 飾り glyph '✦' は satori で豆腐化するため、見出し先頭文字に fallback する (2026-07-31)。
    expect(card.initial).toBe('D');
    expect(card).not.toHaveProperty('imageUrl');
    expect(card.footer).toBe('Buy this digital product');
    expect(card.accent).toBe(OG_DEFAULT_COLOR);
  });

  it('商品 og:image URL は server authority route へ product ID だけを渡す', () => {
    const productId = `h_${'a'.repeat(32)}`;
    expect(buildProductOgImageUrl('masia', 'ja', productId)).toBe(
      `/og/handle?h=masia&locale=ja&product=${productId}`,
    );
  });
});

describe('buildStorefrontOgModel (モバイルオーダー店舗カード)', () => {
  it('ja: 店名・@handle・tagline(bio)・店舗ピル・イニシャル', () => {
    const m = buildStorefrontOgModel({
      handle: 'yamada',
      shopName: '山田カフェ',
      tagline: 'こだわり珈琲',
      locale: 'ja',
    });
    expect(m.heading).toBe('山田カフェ');
    expect(m.handleLine).toBe('@yamada');
    expect(m.bio).toBe('こだわり珈琲');
    expect(m.chips).toEqual(['スマホで注文', 'JPYC で支払い']);
    expect(m.initial).toBe('山');
    expect(m.accent).toBe(OG_DEFAULT_COLOR);
    expect(m.brand).toBe('OpenPay');
  });

  it('en: English のピル・tagline 無しは bio undefined', () => {
    const m = buildStorefrontOgModel({ handle: 'yamada', shopName: 'Yamada Cafe', locale: 'en' });
    expect(m.chips).toEqual(['Order on your phone', 'Pay in JPYC']);
    expect(m.bio).toBeUndefined();
    expect(m.initial).toBe('Y');
  });

  it('shopName 無しは @handle を heading・先頭文字を大文字イニシャルに', () => {
    const m = buildStorefrontOgModel({ handle: 'yamada', locale: 'ja' });
    expect(m.heading).toBe('@yamada');
    expect(m.initial).toBe('Y');
  });

  it('制御文字を含む tagline は除去される', () => {
    const tagline = `a${String.fromCharCode(0)}b`; // 制御文字 (NUL) 入り
    const m = buildStorefrontOgModel({ handle: 'x', shopName: 'S', tagline, locale: 'ja' });
    expect(m.bio).toBe('ab');
  });

  it('長い tagline は OG_BIO_DISPLAY_MAX (48) で … 付き truncate', () => {
    const m = buildStorefrontOgModel({
      handle: 'x',
      shopName: 'S',
      tagline: 'あ'.repeat(60),
      locale: 'ja',
    });
    expect(m.bio).toBe(`${'あ'.repeat(48)}…`);
  });
});

describe('buildStorefrontMeta', () => {
  it('ja: 店名つき title + tagline を description 先頭に', () => {
    const m = buildStorefrontMeta({ handle: 'yamada', shopName: '山田カフェ', tagline: 'こだわり珈琲' }, 'ja');
    expect(m.title).toBe('山田カフェ のモバイルオーダー — OpenPay');
    expect(m.description.startsWith('こだわり珈琲｜')).toBe(true);
    expect(m.description).toContain('JPYC');
  });

  it('ja: tagline 無しは汎用 description (区切り無し)', () => {
    const m = buildStorefrontMeta({ handle: 'yamada', shopName: '山田カフェ' }, 'ja');
    expect(m.title).toBe('山田カフェ のモバイルオーダー — OpenPay');
    expect(m.description).not.toContain('｜');
    expect(m.description).toContain('JPYC');
  });

  it('en: 店名つき title/description', () => {
    const m = buildStorefrontMeta(
      { handle: 'yamada', shopName: 'Yamada Cafe', tagline: 'Specialty coffee' },
      'en',
    );
    expect(m.title).toBe('Yamada Cafe — Mobile Order on OpenPay');
    expect(m.description).toContain('Specialty coffee');
    expect(m.description).toContain('JPYC');
  });

  it('shopName 無しは @handle にフォールバック (カードと一致・ja/en)', () => {
    expect(buildStorefrontMeta({ handle: 'yamada' }, 'ja').title).toBe(
      '@yamada のモバイルオーダー — OpenPay',
    );
    expect(buildStorefrontMeta({ handle: 'yamada' }, 'en').title).toBe(
      '@yamada — Mobile Order on OpenPay',
    );
  });
});

describe('themeStyle の backgroundImage は satori 安全 (色レイヤー禁止)', () => {
  // 本番実害: gradient/night が Web ページ用 background ショートハンド (末尾に
  // 裸の色レイヤー) を satori の backgroundImage に渡し、/api/og/tip が
  // `Invalid background image: "#ffffff"` で 500 になった。satori の
  // background-image はグラデーション関数のみ許容するため、全テーマの全
  // トップレベルレイヤーが gradient 関数で始まることをフェンスする。
  const topLevelLayers = (value: string): string[] => {
    const layers: string[] = [];
    let depth = 0;
    let cur = '';
    for (const ch of value) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) {
        layers.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    layers.push(cur.trim());
    return layers;
  };

  it('全テーマ×代表色で backgroundImage の全レイヤーが gradient 関数', async () => {
    const { buildTipOgModel, tipModelToCard } = await import('@/lib/ogTipCard');
    const { HANDLE_THEMES } = await import('@/lib/handleTheme');
    for (const theme of HANDLE_THEMES) {
      for (const color of ['#2563eb', '#ffffff', '#0f172a']) {
        const card = tipModelToCard(
          buildTipOgModel(
            new URLSearchParams({
              to: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81',
              token: 'jpyc',
              theme,
              color,
            }),
          ),
        );
        const style = card.themeStyle;
        expect(style, `${theme} は themeStyle を持つ`).toBeDefined();
        for (const layer of topLevelLayers(style!.backgroundImage)) {
          expect(
            /^(linear|radial)-gradient\(/.test(layer),
            `${theme}/${color} の backgroundImage レイヤーが satori 非対応: ${layer}`,
          ).toBe(true);
        }
      }
    }
  });
});
