import { describe, it, expect } from 'vitest';
import {
  buildCheckoutPath,
  buildCheckoutUrl,
  calcCheckoutTotal,
  CHECKOUT_MAX_ITEMS,
  CHECKOUT_QTY_MAX,
  encodeItems,
  parseCheckoutItemDrafts,
  parseCheckoutParams,
  type CheckoutItem,
} from '@/lib/url';

const MERCHANT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function search(query: string) {
  return new URLSearchParams(query);
}

describe('encodeItems / parseCheckoutParams roundtrip', () => {
  it('ASCII items: encode → URLSearchParams → parse で完全一致', () => {
    const items: CheckoutItem[] = [
      { name: 'T-shirt', qty: 1, price: '25.00' },
      { name: 'Mug', qty: 2, price: '15.00' },
    ];
    const path = buildCheckoutPath({
      to: MERCHANT,
      token: 'usdc',
      gas: 'customer',
      items,
    });
    expect(path).toContain('items=');
    const sp = new URLSearchParams(path.split('?')[1]);
    const r = parseCheckoutParams(sp);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.items).toEqual(items);
      expect(r.params.token).toBe('usdc');
      expect(r.params.to).toBe(MERCHANT);
      expect(r.params.gas).toBe('customer');
    }
  });

  it('多バイト文字 (絵文字 + 日本語) を含む name もロスレスに roundtrip', () => {
    const items: CheckoutItem[] = [
      { name: 'Tシャツ 🎽', qty: 3, price: '2500' },
      { name: 'マグカップ', qty: 1, price: '1500' },
    ];
    const path = buildCheckoutPath({
      to: MERCHANT,
      token: 'jpyc',
      gas: 'customer',
      items,
    });
    const sp = new URLSearchParams(path.split('?')[1]);
    const r = parseCheckoutParams(sp);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.items).toEqual(items);
      expect(r.params.token).toBe('jpyc');
    }
  });

  it('name に区切り文字 ":" "," を含む場合も encode で escape されて roundtrip', () => {
    const items: CheckoutItem[] = [
      { name: 'A:B', qty: 1, price: '10' },
      { name: 'C,D', qty: 2, price: '20' },
    ];
    const path = buildCheckoutPath({
      to: MERCHANT,
      token: 'usdc',
      gas: 'customer',
      items,
    });
    const sp = new URLSearchParams(path.split('?')[1]);
    const r = parseCheckoutParams(sp);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.items[0].name).toBe('A:B');
      expect(r.params.items[1].name).toBe('C,D');
    }
  });

  it('encodeItems の出力フォーマット (1 件)', () => {
    expect(encodeItems([{ name: 'T-shirt', qty: 1, price: '25' }])).toBe(
      'T-shirt:1:25',
    );
  });

  it('encodeItems の出力フォーマット (多バイト + 区切り escape)', () => {
    const out = encodeItems([{ name: 'A,B', qty: 2, price: '10.5' }]);
    expect(out).toBe('A%2CB:2:10.5');
  });
});

describe('parseCheckoutParams バリデーション', () => {
  it('to なし → エラー', () => {
    const r = parseCheckoutParams(search('token=usdc&items=A:1:5'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('to');
  });

  it('to が不正 → エラー', () => {
    const r = parseCheckoutParams(search('to=0xnope&token=usdc&items=A:1:5'));
    expect(r.ok).toBe(false);
  });

  it('token なし → エラー', () => {
    const r = parseCheckoutParams(search(`to=${MERCHANT}&items=A:1:5`));
    expect(r.ok).toBe(false);
  });

  it('token が unsupported → エラー', () => {
    const r = parseCheckoutParams(
      search(`to=${MERCHANT}&token=eth&items=A:1:5`),
    );
    expect(r.ok).toBe(false);
  });

  it('items なし → エラー', () => {
    const r = parseCheckoutParams(search(`to=${MERCHANT}&token=usdc`));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('items');
  });

  it('items が空文字 → エラー', () => {
    const r = parseCheckoutParams(search(`to=${MERCHANT}&token=usdc&items=`));
    expect(r.ok).toBe(false);
  });

  it('items の qty が 0 → エラー', () => {
    const r = parseCheckoutParams(
      search(`to=${MERCHANT}&token=usdc&items=A:0:5`),
    );
    expect(r.ok).toBe(false);
  });

  it('items の qty が 上限超過 (1000) → エラー', () => {
    const r = parseCheckoutParams(
      search(`to=${MERCHANT}&token=usdc&items=A:1000:5`),
    );
    expect(r.ok).toBe(false);
  });

  it('items の qty が小数 → エラー', () => {
    const r = parseCheckoutParams(
      search(`to=${MERCHANT}&token=usdc&items=A:1.5:5`),
    );
    expect(r.ok).toBe(false);
  });

  it('items の qty が負 → エラー', () => {
    const r = parseCheckoutParams(
      search(`to=${MERCHANT}&token=usdc&items=A:-1:5`),
    );
    expect(r.ok).toBe(false);
  });

  it('items の price が不正な decimal (アルファベット混入) → エラー', () => {
    const r = parseCheckoutParams(
      search(`to=${MERCHANT}&token=usdc&items=A:1:abc`),
    );
    expect(r.ok).toBe(false);
  });

  it('items の price が 0 → エラー (実質無料は意味なし)', () => {
    const r = parseCheckoutParams(
      search(`to=${MERCHANT}&token=usdc&items=A:1:0`),
    );
    expect(r.ok).toBe(false);
  });

  it('items の price が "0.00" → エラー', () => {
    const r = parseCheckoutParams(
      search(`to=${MERCHANT}&token=usdc&items=A:1:0.00`),
    );
    expect(r.ok).toBe(false);
  });

  it('items の price decimals が token decimals 超過 (USDC=6 なのに 7 桁) → エラー', () => {
    const r = parseCheckoutParams(
      search(`to=${MERCHANT}&token=usdc&items=A:1:1.1234567`),
    );
    expect(r.ok).toBe(false);
  });

  it('items の price decimals が token decimals 同等 (USDC=6 で 6 桁) → OK', () => {
    const r = parseCheckoutParams(
      search(`to=${MERCHANT}&token=usdc&items=A:1:1.123456`),
    );
    expect(r.ok).toBe(true);
  });

  it('items の price decimals が JPYC=18 で 18 桁 → OK', () => {
    const r = parseCheckoutParams(
      search(
        `to=${MERCHANT}&token=jpyc&items=A:1:1.123456789012345678`,
      ),
    );
    expect(r.ok).toBe(true);
  });

  it('items のフィールド数が 3 でない → エラー', () => {
    const r = parseCheckoutParams(
      search(`to=${MERCHANT}&token=usdc&items=A:1`),
    );
    expect(r.ok).toBe(false);
    const r2 = parseCheckoutParams(
      search(`to=${MERCHANT}&token=usdc&items=A:1:5:extra`),
    );
    expect(r2.ok).toBe(false);
  });

  it('items の name が空 → エラー', () => {
    const r = parseCheckoutParams(
      search(`to=${MERCHANT}&token=usdc&items=:1:5`),
    );
    expect(r.ok).toBe(false);
  });

  it('items の name が空白のみ → エラー', () => {
    const r = parseCheckoutParams(
      search(
        `to=${MERCHANT}&token=usdc&items=${encodeURIComponent('   ')}:1:5`,
      ),
    );
    expect(r.ok).toBe(false);
  });

  it('items の name に C0 制御文字 → 除去後に invalid (空) なら エラー', () => {
    // 制御文字のみの name はサニタイズ後空 → invalid
    const r = parseCheckoutParams(
      search(
        `to=${MERCHANT}&token=usdc&items=${encodeURIComponent(
          '\x00\x01\x02',
        )}:1:5`,
      ),
    );
    expect(r.ok).toBe(false);
  });

  it('items の name に C0 制御文字混在 → 除去されて通る', () => {
    const r = parseCheckoutParams(
      search(
        `to=${MERCHANT}&token=usdc&items=${encodeURIComponent('A\x01B\x07')}:1:5`,
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.items[0].name).toBe('AB');
  });

  it(`items の件数が ${CHECKOUT_MAX_ITEMS} を超える → エラー`, () => {
    const list = Array.from({ length: CHECKOUT_MAX_ITEMS + 1 }, (_, i) => `I${i}:1:1`).join(',');
    const r = parseCheckoutParams(
      search(`to=${MERCHANT}&token=usdc&items=${list}`),
    );
    expect(r.ok).toBe(false);
  });

  it(`items の件数 ${CHECKOUT_MAX_ITEMS} 件は OK`, () => {
    const list = Array.from({ length: CHECKOUT_MAX_ITEMS }, (_, i) => `I${i}:1:1`).join(',');
    const r = parseCheckoutParams(
      search(`to=${MERCHANT}&token=usdc&items=${list}`),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.items).toHaveLength(CHECKOUT_MAX_ITEMS);
  });

  it('items の name が 80 文字超過 → 切詰される', () => {
    const longName = 'あ'.repeat(120);
    const r = parseCheckoutParams(
      search(
        `to=${MERCHANT}&token=usdc&items=${encodeURIComponent(longName)}:1:1`,
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.items[0].name.length).toBe(80);
  });

  it('decodeURIComponent で throw する不正 %XX → エラー', () => {
    const r = parseCheckoutParams(
      // %ZZ は不正 (16 進ではない)
      search(`to=${MERCHANT}&token=usdc&items=%ZZ:1:5`),
    );
    expect(r.ok).toBe(false);
  });
});

describe('parseCheckoutParams: chain パラメタ', () => {
  it('chain 省略 → usdc は base / jpyc は polygon', () => {
    const u = parseCheckoutParams(
      search(`to=${MERCHANT}&token=usdc&items=A:1:5`),
    );
    expect(u.ok).toBe(true);
    if (u.ok) expect(u.params.chain).toBe('base');
    const j = parseCheckoutParams(
      search(`to=${MERCHANT}&token=jpyc&items=A:1:5`),
    );
    expect(j.ok).toBe(true);
    if (j.ok) expect(j.params.chain).toBe('polygon');
  });

  it('chain=arbitrum + token=usdc → OK', () => {
    const r = parseCheckoutParams(
      search(`to=${MERCHANT}&token=usdc&chain=arbitrum&items=A:1:5`),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.chain).toBe('arbitrum');
  });

  it('chain=arbitrum + token=jpyc → エラー (deployment 不在)', () => {
    const r = parseCheckoutParams(
      search(`to=${MERCHANT}&token=jpyc&chain=arbitrum&items=A:1:5`),
    );
    expect(r.ok).toBe(false);
  });

  it('chain=avalanche → エラー (slug invalid)', () => {
    const r = parseCheckoutParams(
      search(`to=${MERCHANT}&token=usdc&chain=avalanche&items=A:1:5`),
    );
    expect(r.ok).toBe(false);
  });
});

describe('parseCheckoutParams: gas / metadata', () => {
  it('gas 省略 → customer', () => {
    const r = parseCheckoutParams(
      search(`to=${MERCHANT}&token=usdc&items=A:1:5`),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.gas).toBe('customer');
  });

  it('gas=merchant 受理', () => {
    const r = parseCheckoutParams(
      search(`to=${MERCHANT}&token=usdc&items=A:1:5&gas=merchant`),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.gas).toBe('merchant');
  });

  it('order_id / description / customer_email を読み取る (空白・制御文字 sanitize)', () => {
    const r = parseCheckoutParams(
      search(
        `to=${MERCHANT}&token=usdc&items=A:1:5&order_id=abc-123&description=${encodeURIComponent('Order summary')}&customer_email=alice@example.com`,
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.orderId).toBe('abc-123');
      expect(r.params.description).toBe('Order summary');
      expect(r.params.customerEmail).toBe('alice@example.com');
    }
  });

  it('success_url / cancel_url / webhook が http(s) のみ受理', () => {
    const r = parseCheckoutParams(
      search(
        `to=${MERCHANT}&token=usdc&items=A:1:5&success_url=${encodeURIComponent('https://shop.example.com/thanks')}&webhook=${encodeURIComponent('https://shop.example.com/hook')}`,
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.successUrl).toBe('https://shop.example.com/thanks');
      expect(r.params.webhook).toBe('https://shop.example.com/hook');
    }
  });

  it('success_url が javascript: スキーム → 除外', () => {
    const r = parseCheckoutParams(
      search(
        `to=${MERCHANT}&token=usdc&items=A:1:5&success_url=${encodeURIComponent('javascript:alert(1)')}`,
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.successUrl).toBeUndefined();
  });

  it('order_id が長すぎる → 64 文字に切詰', () => {
    const long = 'a'.repeat(120);
    const r = parseCheckoutParams(
      search(`to=${MERCHANT}&token=usdc&items=A:1:5&order_id=${long}`),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.orderId!.length).toBe(64);
  });

  it('description / customer_email も指定上限で切詰', () => {
    const longDesc = 'd'.repeat(300);
    const longEmail = 'e'.repeat(300);
    const r = parseCheckoutParams(
      search(
        `to=${MERCHANT}&token=usdc&items=A:1:5&description=${longDesc}&customer_email=${longEmail}`,
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.description!.length).toBe(200);
      expect(r.params.customerEmail!.length).toBe(240);
    }
  });
});

describe('buildCheckoutPath / buildCheckoutUrl', () => {
  it('default chain (usdc=base) は URL に出さない', () => {
    const path = buildCheckoutPath({
      to: MERCHANT,
      token: 'usdc',
      chain: 'base',
      gas: 'customer',
      items: [{ name: 'A', qty: 1, price: '5' }],
    });
    expect(path).not.toContain('chain=');
  });

  it('non-default chain (usdc=arbitrum) は URL に出る', () => {
    const path = buildCheckoutPath({
      to: MERCHANT,
      token: 'usdc',
      chain: 'arbitrum',
      gas: 'customer',
      items: [{ name: 'A', qty: 1, price: '5' }],
    });
    expect(path).toContain('chain=arbitrum');
  });

  it('gas=customer は URL に出さない (default)', () => {
    const path = buildCheckoutPath({
      to: MERCHANT,
      token: 'usdc',
      gas: 'customer',
      items: [{ name: 'A', qty: 1, price: '5' }],
    });
    expect(path).not.toContain('gas=');
  });

  it('gas=merchant は URL に出る', () => {
    const path = buildCheckoutPath({
      to: MERCHANT,
      token: 'usdc',
      gas: 'merchant',
      items: [{ name: 'A', qty: 1, price: '5' }],
    });
    expect(path).toContain('gas=merchant');
  });

  it('buildCheckoutUrl は origin を前置', () => {
    const url = buildCheckoutUrl('https://openpay.example.com', {
      to: MERCHANT,
      token: 'usdc',
      gas: 'customer',
      items: [{ name: 'A', qty: 1, price: '5' }],
    });
    expect(url.startsWith('https://openpay.example.com/checkout?')).toBe(true);
  });

  it('javascript: success_url は build 時に出力されない', () => {
    const path = buildCheckoutPath({
      to: MERCHANT,
      token: 'usdc',
      gas: 'customer',
      items: [{ name: 'A', qty: 1, price: '5' }],
      successUrl: 'javascript:alert(1)',
    });
    expect(path).not.toContain('success_url=');
  });

  it('buildCheckoutPath roundtrip with all metadata', () => {
    const params = {
      to: MERCHANT as `0x${string}`,
      token: 'usdc' as const,
      chain: 'optimism' as const,
      gas: 'merchant' as const,
      items: [
        { name: 'Tシャツ', qty: 1, price: '25.00' },
        { name: 'Mug', qty: 2, price: '15.00' },
      ],
      orderId: 'ord-42',
      description: 'Summer sale',
      customerEmail: 'a@b.com',
      successUrl: 'https://shop.example.com/thanks',
      cancelUrl: 'https://shop.example.com/cart',
      webhook: 'https://shop.example.com/hook',
    };
    const path = buildCheckoutPath(params);
    const sp = new URLSearchParams(path.split('?')[1]);
    const r = parseCheckoutParams(sp);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.to).toBe(MERCHANT);
      expect(r.params.token).toBe('usdc');
      expect(r.params.chain).toBe('optimism');
      expect(r.params.gas).toBe('merchant');
      expect(r.params.items).toEqual(params.items);
      expect(r.params.orderId).toBe('ord-42');
      expect(r.params.description).toBe('Summer sale');
      expect(r.params.customerEmail).toBe('a@b.com');
      expect(r.params.successUrl).toBe('https://shop.example.com/thanks');
      expect(r.params.cancelUrl).toBe('https://shop.example.com/cart');
      expect(r.params.webhook).toBe('https://shop.example.com/hook');
    }
  });
});

describe('calcCheckoutTotal', () => {
  it('USDC (6 decimals): 単一 item', () => {
    expect(
      calcCheckoutTotal([{ name: 'A', qty: 1, price: '25' }], 6),
    ).toBe(25_000_000n);
  });

  it('USDC: 複数 item で合算', () => {
    const items: CheckoutItem[] = [
      { name: 'A', qty: 1, price: '25.00' },
      { name: 'B', qty: 2, price: '15.50' },
    ];
    // 25 + 31 = 56
    expect(calcCheckoutTotal(items, 6)).toBe(56_000_000n);
  });

  it('JPYC (18 decimals): 1000 JPYC × 3 = 3000 JPYC (wei)', () => {
    expect(
      calcCheckoutTotal([{ name: 'A', qty: 3, price: '1000' }], 18),
    ).toBe(3000n * 10n ** 18n);
  });

  it('巨大な qty × price でも bigint で精度保証', () => {
    const items: CheckoutItem[] = [{ name: 'A', qty: 999, price: '999.999999' }];
    // 999 * 999.999999 = 999_999_999_001 USDC base = 999999999001 (6 decimals)
    expect(calcCheckoutTotal(items, 6)).toBe(
      parseUnitsLike('999.999999', 6) * 999n,
    );
  });

  it('item 0 件 → 0n', () => {
    expect(calcCheckoutTotal([], 6)).toBe(0n);
  });
});

describe('parseCheckoutItemDrafts (CheckoutLinkGenerator UI 用)', () => {
  it('全空 draft → items=null, errors=[] (未入力扱い)', () => {
    const r = parseCheckoutItemDrafts(
      [{ name: '', qty: '', price: '' }],
      6,
    );
    expect(r.items).toBeNull();
    expect(r.errors).toEqual([]);
  });

  it('全 valid draft → items 確定', () => {
    const r = parseCheckoutItemDrafts(
      [
        { name: 'A', qty: '1', price: '10' },
        { name: 'B', qty: '2', price: '5.5' },
      ],
      6,
    );
    expect(r.items).toHaveLength(2);
    expect(r.errors).toEqual([]);
  });

  it('部分入力 (name のみ) → empty error', () => {
    const r = parseCheckoutItemDrafts(
      [{ name: 'A', qty: '', price: '' }],
      6,
    );
    expect(r.items).toBeNull();
    expect(r.errors).toEqual([{ index: 0, reason: 'empty' }]);
  });

  it('qty 範囲外 → qty error', () => {
    expect(
      parseCheckoutItemDrafts(
        [{ name: 'A', qty: '0', price: '5' }],
        6,
      ).errors,
    ).toEqual([{ index: 0, reason: 'qty' }]);
    expect(
      parseCheckoutItemDrafts(
        [{ name: 'A', qty: '1000', price: '5' }],
        6,
      ).errors,
    ).toEqual([{ index: 0, reason: 'qty' }]);
    expect(
      parseCheckoutItemDrafts(
        [{ name: 'A', qty: '1.5', price: '5' }],
        6,
      ).errors,
    ).toEqual([{ index: 0, reason: 'qty' }]);
  });

  it('price 不正 / decimals 超過 / 0 → price error', () => {
    expect(
      parseCheckoutItemDrafts(
        [{ name: 'A', qty: '1', price: 'abc' }],
        6,
      ).errors[0].reason,
    ).toBe('price');
    expect(
      parseCheckoutItemDrafts(
        [{ name: 'A', qty: '1', price: '1.1234567' }],
        6,
      ).errors[0].reason,
    ).toBe('price');
    expect(
      parseCheckoutItemDrafts(
        [{ name: 'A', qty: '1', price: '0' }],
        6,
      ).errors[0].reason,
    ).toBe('price');
  });

  it('複数 draft で混在 (1 valid + 1 invalid) → all-or-nothing で items=null', () => {
    const r = parseCheckoutItemDrafts(
      [
        { name: 'A', qty: '1', price: '5' },
        { name: 'B', qty: '0', price: '5' },
      ],
      6,
    );
    expect(r.items).toBeNull();
    expect(r.errors).toEqual([{ index: 1, reason: 'qty' }]);
  });

  it('空 draft 行が混在 → 無視される (valid なものだけ items に集約)', () => {
    const r = parseCheckoutItemDrafts(
      [
        { name: 'A', qty: '1', price: '5' },
        { name: '', qty: '', price: '' },
        { name: 'B', qty: '2', price: '10' },
      ],
      6,
    );
    expect(r.items).toEqual([
      { name: 'A', qty: 1, price: '5' },
      { name: 'B', qty: 2, price: '10' },
    ]);
  });

  it('JPYC (decimals=18): 18 桁精度の price OK', () => {
    const r = parseCheckoutItemDrafts(
      [{ name: 'A', qty: '1', price: '0.000000000000000001' }],
      18,
    );
    expect(r.items).toEqual([{ name: 'A', qty: 1, price: '0.000000000000000001' }]);
  });

  it('name に C0 制御文字 → 除去されて name 確定', () => {
    const r = parseCheckoutItemDrafts(
      [{ name: 'A\x01B', qty: '1', price: '5' }],
      6,
    );
    expect(r.items).toEqual([{ name: 'AB', qty: 1, price: '5' }]);
  });
});

// テスト helper (vi の parseUnits を直接使うとモック汚染避けが面倒なので最小実装)
function parseUnitsLike(value: string, decimals: number): bigint {
  const [int, frac = ''] = value.split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(int + padded);
}
