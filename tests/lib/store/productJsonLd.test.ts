import { describe, expect, it } from 'vitest';
import { formatUnits } from 'viem';
import { storeProductJsonLd, type StoreProductJsonLdInput } from '@/lib/store/productJsonLd';
import { hostedPurchaseFeeValue } from '@/lib/x402/hostedPurchaseWire';

const ID = `h_${'a'.repeat(32)}`;
const LABELS: StoreProductJsonLdInput['labels'] = {
  price: '商品価格',
  fee: '買い手負担 x402 手数料',
  usageHeading: '利用条件',
  usage: { commercial: '商用利用', modify: '改変', redistribute: '再配布・再販売' },
  usageNote: '補足',
  usageDisclaimer: '出品者が定めた条件です。',
};

function build(product: Partial<StoreProductJsonLdInput['product']> = {}, over: Partial<StoreProductJsonLdInput> = {}) {
  return storeProductJsonLd({
    product: { id: ID, title: 'カフェ内装キット', priceJpyc: '4950', ...product },
    handle: 'fixture',
    locale: 'ja',
    origin: 'https://open-pay.jp',
    sellerName: 'Fixture Studio',
    fallbackImagePath: `/og/handle?h=fixture&locale=ja&product=${ID}`,
    labels: LABELS,
    ...over,
  });
}

type Offer = { price: string; priceCurrency: string; availability?: string; inventoryLevel?: { value: number }; url: string; seller: unknown;
  priceSpecification: { price: string; priceComponent: { name: string; price: string; priceCurrency: string }[] } };

describe('storeProductJsonLd', () => {
  it('Product と Offer の基本形 (言語に依存しない @id・言語つきの url・JPYC・売り手は ProfilePage と同じ Person)', () => {
    const ld = build({ desc: '短い説明', details: '長い説明', imageUrl: 'https://img.example/a.png', galleryUrls: ['https://img.example/b.png'] }, { categoryName: '3D・ゲーム' });
    expect(ld).toMatchObject({
      '@context': 'https://schema.org',
      '@type': 'Product',
      '@id': `https://open-pay.jp/@fixture?product=${ID}`,
      productID: ID,
      sku: ID,
      name: 'カフェ内装キット',
      description: '短い説明',
      image: ['https://img.example/a.png', 'https://img.example/b.png'],
      category: '3D・ゲーム',
      url: `https://open-pay.jp/ja/@fixture?product=${ID}`,
    });
    // inLanguage は Product の項目ではなく、ページの言語は商品の言語でもない (Codex P2)
    expect(ld).not.toHaveProperty('inLanguage');
    const offer = ld.offers as Offer;
    expect(offer).toMatchObject({
      '@type': 'Offer',
      url: `https://open-pay.jp/ja/@fixture?product=${ID}`,
      priceCurrency: 'JPYC',
      availability: 'https://schema.org/InStock',
      seller: { '@type': 'Person', name: 'Fixture Studio', url: 'https://open-pay.jp/@fixture' },
    });
    // 流入元 (from=store / from=agent) は url に入れない
    expect(JSON.stringify(ld)).not.toContain('from=');
  });

  it.each([['4950', '49.5', '4999.5'], ['100', '1', '101'], ['150', '1.5', '151.5']])(
    'Offer.price は手数料込みの支払総額・内訳は商品価格と買い手負担の手数料 (価格 %s)',
    (priceJpyc, fee, total) => {
      const offer = build({ priceJpyc }).offers as Offer;
      // 単一ソース (hostedPurchaseFeeValue) と一致すること
      const wei = BigInt(priceJpyc) * 10n ** 18n;
      expect(formatUnits(hostedPurchaseFeeValue(wei), 18)).toBe(fee);
      expect(offer.price).toBe(total);
      expect(offer.priceSpecification).toMatchObject({ '@type': 'CompoundPriceSpecification', price: total, priceCurrency: 'JPYC' });
      expect(offer.priceSpecification.priceComponent).toEqual([
        { '@type': 'UnitPriceSpecification', name: '商品価格', price: priceJpyc, priceCurrency: 'JPYC' },
        { '@type': 'UnitPriceSpecification', name: '買い手負担 x402 手数料', price: fee, priceCurrency: 'JPYC' },
      ]);
    },
  );

  it('description は desc を優先し、無ければ details・どちらも無ければ出さない', () => {
    expect(build({ details: '長い説明' }).description).toBe('長い説明');
    expect(build()).not.toHaveProperty('description');
    expect(build()).not.toHaveProperty('category');
  });

  it('画像が無い商品は商品の OG カードを絶対 URL で使う', () => {
    expect(build().image).toEqual([`https://open-pay.jp/og/handle?h=fixture&locale=ja&product=${ID}`]);
  });

  it('仕様表と利用条件を additionalProperty に入れる (利用条件の値は機械向けの語・未記載は not_stated・注記を添える)', () => {
    const ld = build({
      specs: [{ label: '形式', value: 'GLB' }],
      usage: { commercial: 'allowed', redistribute: 'not_allowed', note: 'クレジット表記は不要です。' },
    });
    expect(ld.additionalProperty).toEqual([
      { '@type': 'PropertyValue', name: '形式', value: 'GLB' },
      { '@type': 'PropertyValue', propertyID: 'openpay:usage.commercial', name: '商用利用', value: 'allowed' },
      { '@type': 'PropertyValue', propertyID: 'openpay:usage.modify', name: '改変', value: 'not_stated' },
      { '@type': 'PropertyValue', propertyID: 'openpay:usage.redistribute', name: '再配布・再販売', value: 'not_allowed' },
      { '@type': 'PropertyValue', propertyID: 'openpay:usage.note', name: '補足', value: 'クレジット表記は不要です。' },
      { '@type': 'PropertyValue', propertyID: 'openpay:usage.disclaimer', name: '利用条件', value: '出品者が定めた条件です。' },
    ]);
    // 利用条件も仕様も無い商品は additionalProperty を持たない
    expect(build()).not.toHaveProperty('additionalProperty');
  });

  it('USDC の rail と license の公開記述子は印だけ添える (USDC の固定の Offer は作らない)', () => {
    const ld = build({ usdcEnabled: true }, { licenseDescriptorUrl: `https://open-pay.jp/api/license/products/${ID}` });
    expect(ld.additionalProperty).toEqual([
      { '@type': 'PropertyValue', propertyID: 'openpay:usdcEnabled', value: true },
      { '@type': 'PropertyValue', propertyID: 'openpay:license.descriptor', value: `https://open-pay.jp/api/license/products/${ID}` },
    ]);
    expect((ld.offers as Offer).priceCurrency).toBe('JPYC');
  });

  it.each([
    [3, 'https://schema.org/InStock', 3],
    [0, 'https://schema.org/SoldOut', 0],
    [null, undefined, undefined],
    [undefined, undefined, undefined],
  ])('license の在庫 %s → availability %s', (remaining, availability, inventory) => {
    const offer = build({ productKind: 'license', license: { remaining } }).offers as Offer;
    expect(offer.availability).toBe(availability);
    expect(offer.inventoryLevel?.value).toBe(inventory);
  });

  it('入力に私的な項目が混ざっていても詰め替えで落とす (受け取った項目だけを出す)', () => {
    const product = {
      priceJpyc: '300', owner: '0xOWNER_SENTINEL', payTo: '0xPAYTO_SENTINEL', deliveryUrl: 'https://drive.example/SECRET',
      content: { kind: 'text', value: 'SECRET_BODY' }, registration: { status: 'registered' }, protectedDelivery: true,
    } as unknown as StoreProductJsonLdInput['product'];
    const serialized = JSON.stringify(build(product));
    for (const leaked of ['OWNER_SENTINEL', 'PAYTO_SENTINEL', 'SECRET', 'registration', 'protectedDelivery']) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it('en の商品ページは url だけが変わり、@id は同じ', () => {
    const ja = build();
    const en = build({}, { locale: 'en' });
    expect(en['@id']).toBe(ja['@id']);
    expect(en.url).toBe(`https://open-pay.jp/en/@fixture?product=${ID}`);
  });
});
