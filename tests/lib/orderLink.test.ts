// 注文リンク (lib/orderLink.ts): 公開の文書にあるパラメーターだけで /checkout のリンクを作り、
// 表示する利用料が /checkout の実計算と同じであることを固定する。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';

const JPYC_FLOOR = 2n * 10n ** 18n;
const flags = vi.hoisted(() => ({ relay: true, forwarder: true, floors: {} as Record<number, bigint> }));
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/relay/forwarderConfig')>();
  return {
    ...actual,
    jpycForwarderFor: () => (flags.forwarder ? '0x0F4560a777415580F0680F8B56a79B0022C6B848' : null),
    relayGasFeeValue: (chainId: number) => flags.floors[chainId] ?? JPYC_FLOOR,
  };
});
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      recoverFeeBps: 100,
      get enableJpycEip3009() {
        return flags.relay;
      },
    },
  };
});

import { JPYC_CHAINS } from '@/lib/chains';
import { buildCheckoutLineItems } from '@/lib/checkoutLineItems';
import { invoiceRateGroups } from '@/lib/invoice';
import {
  buildOrderLink,
  nextOrderLinkId,
  orderLinkChains,
  orderLinkLineIssues,
  orderLinkFitsStandard,
  orderLinkGoodsWei,
  orderLinkLineAmount,
  orderLinkPreviewLines,
  type OrderLinkInput,
} from '@/lib/orderLink';
import { deploymentForSlug, isGaslessSupported } from '@/lib/tokens';
import { calcCheckoutPayable, parseCheckoutParams } from '@/lib/url/checkout';

const TO = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' as Address;

function input(patch: Partial<OrderLinkInput> = {}): OrderLinkInput {
  return {
    origin: 'https://open-pay.jp',
    to: TO,
    chains: ['polygon'],
    mode: 'gasless',
    reusable: false,
    orderId: 'A-001',
    contact: null,
    description: '',
    storeName: '',
    lines: [{ name: 'Tシャツ M', qty: '2', price: '3000' }],
    shipping: '500',
    shippingLabel: '送料',
    ...patch,
  };
}

function okUrl(result: ReturnType<typeof buildOrderLink>): URL {
  if (!result.ok) throw new Error(`expected ok: ${result.error}`);
  return new URL(result.url);
}

beforeEach(() => {
  flags.relay = true;
  flags.forwarder = true;
  flags.floors = {};
});

describe('buildOrderLink', () => {
  it('商品と送料の明細・注文番号をお客様の画面で読めるリンクにする', () => {
    const url = okUrl(buildOrderLink(input()));
    expect(url.pathname).toBe('/checkout');
    const parsed = parseCheckoutParams(url.searchParams);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.params.to).toBe(TO);
    expect(parsed.params.token).toBe('jpyc');
    expect(parsed.params.orderId).toBe('A-001');
    expect(parsed.params.items).toEqual([
      { name: 'Tシャツ M', qty: 2, price: '3000' },
      { name: '送料', qty: 1, price: '500' },
    ]);
  });

  it('公開の文書にあるパラメーターだけを使う (内部用を足さない)', () => {
    const url = okUrl(
      buildOrderLink(input({ chains: ['kaia'], mode: 'standard', description: '秋のイベント物販' })),
    );
    expect([...url.searchParams.keys()].sort()).toEqual(
      ['chain', 'description', 'items', 'mode', 'order_id', 'to', 'token'].sort(),
    );
  });

  it('受取チェーンが 2 つ以上なら chains を入れ chain を書かない (お客様が払う前に選ぶ)', () => {
    const url = okUrl(buildOrderLink(input({ chains: ['polygon', 'kaia', 'kaia'] })));
    expect(url.searchParams.get('chains')).toBe('polygon,kaia');
    expect(url.searchParams.has('chain')).toBe(false);
    const parsed = parseCheckoutParams(url.searchParams);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.params.chains).toEqual(['polygon', 'kaia']);
    expect(parsed.params.pickChain).toBe(true);
    expect(parsed.params.chain).toBe('polygon');
    // 1 つなら今までどおり
    expect(okUrl(buildOrderLink(input({ chains: ['kaia'] }))).searchParams.get('chain')).toBe('kaia');
    expect(okUrl(buildOrderLink(input({ chains: ['kaia'] }))).searchParams.has('chains')).toBe(false);
    expect(buildOrderLink(input({ chains: [] }))).toEqual({ ok: false, error: 'invalid' });
  });

  it('利用料はチェーンごとに出し、どれかのチェーンで利用料以下なら作らない (いちばん高い最低額を出す)', () => {
    const kaia = deploymentForSlug('jpyc', 'kaia').chainId;
    flags.floors = { [kaia]: 5n * 10n ** 18n };
    const ok = buildOrderLink(input({ chains: ['polygon', 'kaia'], lines: [{ name: 'ステッカー', qty: '1', price: '100' }], shipping: '' }));
    expect(ok).toMatchObject({
      ok: true,
      fee: '2',
      receive: '98',
      byChain: [
        { chain: 'polygon', fee: '2', receive: '98' },
        { chain: 'kaia', fee: '5', receive: '95' },
      ],
    });
    expect(
      buildOrderLink(input({ chains: ['polygon', 'kaia'], lines: [{ name: 'ステッカー', qty: '1', price: '4' }], shipping: '' })),
    ).toEqual({ ok: false, error: 'tooSmall', minimum: '5', total: '4' });
  });

  it('既定のチェーンとガスレスは URL を増やさない', () => {
    const url = okUrl(buildOrderLink(input()));
    expect([...url.searchParams.keys()].sort()).toEqual(['items', 'order_id', 'to', 'token'].sort());
  });

  it('ガスレスは利用料を受取額から引く: 1% が最低額を超える場合', () => {
    const result = buildOrderLink(input());
    expect(result).toMatchObject({ ok: true, total: '6500', fee: '65', receive: '6435' });
  });

  it('ガスレスは利用料を受取額から引く: 1% が最低額より小さい場合', () => {
    const result = buildOrderLink(input({ lines: [{ name: 'ステッカー', qty: '1', price: '100' }], shipping: '' }));
    expect(result).toMatchObject({ ok: true, total: '100', fee: '2', receive: '98' });
  });

  it('通常決済は利用料 0', () => {
    const result = buildOrderLink(input({ mode: 'standard' }));
    expect(result).toMatchObject({ ok: true, total: '6500', fee: '0', receive: '6500' });
  });

  it('利用料は /checkout の経路の判定に従う: relay が無効なら 0', () => {
    flags.relay = false;
    expect(buildOrderLink(input())).toMatchObject({ ok: true, fee: '0', receive: '6500' });
  });

  it('利用料は /checkout の経路の判定に従う: forwarder が無ければ 0', () => {
    flags.forwarder = false;
    expect(buildOrderLink(input())).toMatchObject({ ok: true, fee: '0', receive: '6500' });
  });

  it('利用料が 0 の経路では、少額を止めない', () => {
    flags.relay = false;
    const result = buildOrderLink(input({ lines: [{ name: 'ステッカー', qty: '1', price: '1' }], shipping: '' }));
    expect(result).toMatchObject({ ok: true, total: '1', receive: '1' });
  });

  it('上限を超えるリンクを作らない', () => {
    const at = (price: string, mode: 'gasless' | 'standard') =>
      buildOrderLink(input({ mode, lines: [{ name: '機材', qty: '1', price }], shipping: '' }));
    expect(at('50000', 'gasless').ok).toBe(true);
    expect(at('50001', 'gasless')).toEqual({ ok: false, error: 'tooLarge', maximum: '50000', total: '50001' });
    expect(at('1000000', 'standard').ok).toBe(true);
    expect(at('1000001', 'standard')).toEqual({ ok: false, error: 'tooLarge', maximum: '1000000', total: '1000001' });
  });

  it('店名は公開の store に入り、お客様の画面で読み直せる (空なら付けない)', () => {
    const url = okUrl(buildOrderLink(input({ storeName: '  OpenPay 工房  ' })));
    expect(url.searchParams.get('store')).toBe('OpenPay 工房');
    const parsed = parseCheckoutParams(url.searchParams);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.params.storeName).toBe('OpenPay 工房');
    expect(okUrl(buildOrderLink(input({ storeName: '   ' }))).searchParams.has('store')).toBe(false);
  });

  it('店名は /checkout と同じく制御文字を除き 48 文字で切ってから入れる (読み直しと食い違わない)', () => {
    const cleaned = okUrl(buildOrderLink(input({ storeName: 'Open\u0007Pay' })));
    expect(cleaned.searchParams.get('store')).toBe('OpenPay');
    const long = okUrl(buildOrderLink(input({ storeName: 'あ'.repeat(60) })));
    expect(long.searchParams.get('store')).toBe('あ'.repeat(48));
  });

  it('何度でも使えるリンクは番号を持たず ship=ask を付ける (番号の欄が空でも作れる)', () => {
    const url = okUrl(buildOrderLink(input({ reusable: true, orderId: '' })));
    expect(url.searchParams.has('order_id')).toBe(false);
    expect(url.searchParams.get('ship')).toBe('ask');
    const parsed = parseCheckoutParams(url.searchParams);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.params.orderId).toBeUndefined();
    expect(parsed.params.ship).toBe('ask');
    // 番号が残っていても何度でも使えるリンクには入れない
    expect(okUrl(buildOrderLink(input({ reusable: true, orderId: 'A-009' }))).searchParams.has('order_id')).toBe(false);
    // 番号つきのリンクには ship を付けない
    expect(okUrl(buildOrderLink(input())).searchParams.has('ship')).toBe(false);
  });

  it('注文の送り先は contact に入り、読み直せる。形の合わない送り先ではリンクを作らない', () => {
    const line = okUrl(buildOrderLink(input({ contact: { kind: 'line', id: '@openpay' } })));
    expect(line.searchParams.get('contact')).toBe('line:@openpay');
    const parsed = parseCheckoutParams(line.searchParams);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.params.contact).toEqual({ kind: 'line', id: '@openpay' });
    const mail = okUrl(buildOrderLink(input({ contact: { kind: 'mail', address: 'shop@example.com' } })));
    expect(mail.searchParams.get('contact')).toBe('mail:shop@example.com');
    expect(okUrl(buildOrderLink(input())).searchParams.has('contact')).toBe(false);
    expect(buildOrderLink(input({ contact: 'invalid' }))).toEqual({ ok: false, error: 'contact' });
  });

  it('説明が読み直しで変わるならリンクを作らない', () => {
    expect(buildOrderLink(input({ description: 'a\u0007b' }))).toEqual({ ok: false, error: 'invalid' });
  });

  it('商品名の記号はリンクを壊さない', () => {
    const url = okUrl(buildOrderLink(input({ lines: [{ name: 'A:B,C', qty: '1', price: '500' }], shipping: '' })));
    const parsed = parseCheckoutParams(url.searchParams);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.params.items[0].name).toBe('A:B,C');
  });

  it('空の行は無視し、送料が空または 0 なら送料の行を出さない', () => {
    for (const shipping of ['', '0', '0.0']) {
      const url = okUrl(
        buildOrderLink(input({ lines: [{ name: 'Tシャツ', qty: '1', price: '3000' }, { name: '', qty: '1', price: '' }], shipping })),
      );
      const parsed = parseCheckoutParams(url.searchParams);
      if (!parsed.ok) throw new Error(parsed.error);
      expect(parsed.params.items).toHaveLength(1);
    }
  });

  it('入力の不足と不正は、どこを直すかを返す', () => {
    expect(buildOrderLink(input({ to: null }))).toEqual({ ok: false, error: 'receiver' });
    expect(buildOrderLink(input({ orderId: ' ' }))).toEqual({ ok: false, error: 'orderId' });
    expect(buildOrderLink(input({ orderId: 'x'.repeat(65) }))).toEqual({ ok: false, error: 'orderId' });
    expect(buildOrderLink(input({ lines: [{ name: '', qty: '1', price: '' }] }))).toEqual({ ok: false, error: 'noItems' });
    expect(buildOrderLink(input({ shipping: 'abc' }))).toEqual({ ok: false, error: 'shipping' });
    for (const line of [
      { name: '', qty: '1', price: '500' },
      { name: 'Tシャツ', qty: '0', price: '500' },
      { name: 'Tシャツ', qty: '1000', price: '500' },
      { name: 'Tシャツ', qty: '1.5', price: '500' },
      { name: 'Tシャツ', qty: '1', price: '0' },
      { name: 'Tシャツ', qty: '1', price: '-5' },
      { name: 'x'.repeat(81), qty: '1', price: '500' },
    ]) {
      expect(buildOrderLink(input({ lines: [line] })), JSON.stringify(line)).toEqual({ ok: false, error: 'item' });
    }
  });

  it('明細は送料を含めて 10 行まで', () => {
    const line = { name: 'Tシャツ', qty: '1', price: '500' };
    expect(buildOrderLink(input({ lines: Array(9).fill(line) })).ok).toBe(true);
    expect(buildOrderLink(input({ lines: Array(10).fill(line) }))).toEqual({ ok: false, error: 'tooManyLines' });
  });

  it('合計が利用料以下ならリンクを作らない (/checkout が止める額を渡さない)', () => {
    const result = buildOrderLink(input({ lines: [{ name: 'ステッカー', qty: '1', price: '2' }], shipping: '' }));
    expect(result).toEqual({ ok: false, error: 'tooSmall', minimum: '2', total: '2' });
  });
});

describe('値引き (disc)', () => {
  it('値引きはリンクの disc に入り、/checkout で読み直すと払う額 = 小計 − 値引き。利用料と届く額は値引きの後の額で出す', () => {
    // 商品 6000 + 送料 500 = 6500 から 1000 引き → 5500・利用料 1% = 55 → 届く 5445
    const result = buildOrderLink(input({ discount: '1000' }));
    expect(result).toMatchObject({ ok: true, total: '5500', fee: '55', receive: '5445' });
    const url = okUrl(result);
    expect(url.searchParams.get('disc')).toBe('1000');
    // 受付番号 (order_id) つきのリンクでも /checkout が受け付ける
    expect(url.searchParams.get('order_id')).toBe('A-001');
    const parsed = parseCheckoutParams(url.searchParams);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.params.discount).toBe('1000');
    expect(calcCheckoutPayable(parsed.params, 18)).toBe(5500n * 10n ** 18n);
  });

  it('値引きなしのリンクは今までと同じ (disc を出さない)', () => {
    expect(okUrl(buildOrderLink(input())).searchParams.has('disc')).toBe(false);
    expect(okUrl(buildOrderLink(input({ discount: '' }))).searchParams.has('disc')).toBe(false);
  });

  it('何度でも使えるリンクにも入る', () => {
    const url = okUrl(buildOrderLink(input({ reusable: true, orderId: '', discount: '500' })));
    expect(url.searchParams.get('disc')).toBe('500');
    expect(parseCheckoutParams(url.searchParams).ok).toBe(true);
  });

  it('使えない値引き (欄の誤り・商品の合計以上・1 円単位でない) ではリンクを作らない', () => {
    expect(buildOrderLink(input({ discount: 'invalid' }))).toEqual({ ok: false, error: 'discount' });
    // 商品の合計は 6000 (送料を除く)。送料を含めた 6500 未満でも、商品の合計以上は止める
    expect(buildOrderLink(input({ discount: '6000' }))).toEqual({ ok: false, error: 'discount' });
    expect(buildOrderLink(input({ discount: '0.5' }))).toEqual({ ok: false, error: 'discount' });
    expect(buildOrderLink(input({ discount: '5999' })).ok).toBe(true);
  });

  it('上限と少額の判定は値引きの後の額で行う', () => {
    const big = (discount?: string) =>
      buildOrderLink(input({ lines: [{ name: '機材', qty: '1', price: '50100' }], shipping: '', discount }));
    expect(big()).toMatchObject({ ok: false, error: 'tooLarge', total: '50100' });
    expect(big('100')).toMatchObject({ ok: true, total: '50000' });
    const small = buildOrderLink(input({ lines: [{ name: 'ステッカー', qty: '1', price: '5' }], shipping: '', discount: '3' }));
    expect(small).toEqual({ ok: false, error: 'tooSmall', minimum: '2', total: '2' });
  });
});

describe('消費税とインボイス登録番号', () => {
  const INVOICE = 'T1234567890123';
  const parsedOf = (result: ReturnType<typeof buildOrderLink>) => {
    const parsed = parseCheckoutParams(okUrl(result).searchParams);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.params;
  };

  it('消費税を入れないリンクは今までと同じ (明細に税を書かず、登録番号も入れない・うち消費税を出さない)', () => {
    const result = buildOrderLink(input({ tax: null, invoiceNo: INVOICE }));
    const url = okUrl(result);
    expect(url.searchParams.get('items')).toBe(`${encodeURIComponent('Tシャツ M')}:2:3000,${encodeURIComponent('送料')}:1:500`);
    expect(url.searchParams.has('inv')).toBe(false);
    expect(result).not.toHaveProperty('tax');
  });

  it('税率を選ぶと商品と送料 (課税 10%) に税率が入り、/checkout で読み直せる。うち消費税は控えと同じ計算', () => {
    const result = buildOrderLink(input({ tax: 'taxable_10' }));
    const params = parsedOf(result);
    expect(params.items).toEqual([
      { name: 'Tシャツ M', qty: 2, price: '3000', taxRate: 10, taxCategory: 'taxable_10' },
      { name: '送料', qty: 1, price: '500', taxRate: 10, taxCategory: 'taxable_10' },
    ]);
    // 6,500 × 10 / 110 = 590.9… → 591
    expect(result).toMatchObject({ ok: true, total: '6500', tax: '591' });
  });

  it('商品ごとに税率を変えられ (軽減 8% と標準 10% が混ざる注文)、送料は軽減税率の商品でも課税 10%', () => {
    const result = buildOrderLink(
      input({
        tax: 'taxable_10',
        lines: [
          { name: 'コーヒー豆', qty: '1', price: '2000', tax: 'taxable_8' },
          { name: 'マグ', qty: '1', price: '3000' },
        ],
      }),
    );
    const params = parsedOf(result);
    expect(params.items.map((item) => [item.name, item.taxRate, item.taxCategory])).toEqual([
      ['コーヒー豆', 8, 'taxable_8'],
      ['マグ', 10, 'taxable_10'],
      ['送料', 10, 'taxable_10'],
    ]);
    // 8%: 2,000 × 8 / 108 = 148.1… → 148・10%: 3,500 × 10 / 110 = 318.1… → 318
    expect(result).toMatchObject({ ok: true, tax: '466' });
  });

  it('非課税の商品は税額 0 で、送料だけ課税 10%', () => {
    const result = buildOrderLink(input({ tax: 'tax_free' }));
    const params = parsedOf(result);
    expect(params.items[0]).toMatchObject({ taxRate: 0, taxCategory: 'tax_free' });
    // 送料 500 × 10 / 110 = 45.4… → 45
    expect(result).toMatchObject({ ok: true, tax: '45' });
  });

  it('値引きがあれば、うち消費税は値引きの後の額から出す (税率ごとに按分・控えと同じ)', () => {
    // 6,500 − 1,000 = 5,500 × 10 / 110 = 500
    expect(buildOrderLink(input({ tax: 'taxable_10', discount: '1000' }))).toMatchObject({ ok: true, total: '5500', tax: '500' });
  });

  it('値引きの額は商品の合計から出すが、控えの税率ごとの金額は送料も含めた金額の比で分ける (レジの一括値引きと同じ・見本と控えで一致)', () => {
    // 食品 10,800 (8%)・送料 1,100 (10%)・商品の 10% 引き = 1,080。比で分けると 8% に 980・10% に 100
    // → 8%: 9,820 × 8 / 108 = 727.4… → 727・10%: 1,000 × 10 / 110 = 90.9… → 91 → 818
    const result = buildOrderLink(
      input({ tax: 'taxable_8', lines: [{ name: 'お米', qty: '1', price: '10800' }], shipping: '1100', discount: '1080' }),
    );
    expect(result).toMatchObject({ ok: true, total: '10820', tax: '818' });
  });

  it('登録番号は消費税を入れるリンクにだけ、形の合う番号を入れる (全角や区切りは直す)', () => {
    expect(parsedOf(buildOrderLink(input({ tax: 'taxable_10', invoiceNo: INVOICE }))).invoiceNo).toBe(INVOICE);
    expect(parsedOf(buildOrderLink(input({ tax: 'taxable_10', invoiceNo: 'Ｔ1234-5678-90123' }))).invoiceNo).toBe(INVOICE);
    expect(okUrl(buildOrderLink(input({ tax: 'taxable_10', invoiceNo: 'T123' }))).searchParams.has('inv')).toBe(false);
  });

  it('お客様の控えの明細 (支払い画面と同じ組み方) から、税率ごとの金額の合計が払う額と一致する (控えがインボイスの形になる条件)', () => {
    const result = buildOrderLink(
      input({
        tax: 'taxable_10',
        invoiceNo: INVOICE,
        discount: '300',
        lines: [
          { name: 'コーヒー豆', qty: '1', price: '2000', tax: 'taxable_8' },
          { name: 'マグ', qty: '1', price: '3000' },
        ],
      }),
    );
    const params = parsedOf(result);
    const groups = invoiceRateGroups(
      buildCheckoutLineItems({ items: params.items, discount: params.discount, token: 'jpyc', decimals: 18 }),
    );
    expect(groups).not.toBeNull();
    const sum = (groups ?? []).reduce((acc, group) => acc + BigInt(group.total), 0n);
    expect(sum.toString()).toBe(result.ok ? result.total : '');
    expect((groups ?? []).reduce((acc, group) => acc + BigInt(group.tax), 0n).toString()).toBe(result.ok ? result.tax : '');
  });
});

describe('orderLinkGoodsWei', () => {
  it('リンクに入る行 (商品名と単価が読める行) の金額だけを足し、送料は入れない', () => {
    expect(
      orderLinkGoodsWei([
        { name: 'Tシャツ', qty: '2', price: '3000' },
        { name: 'マグ', qty: '1', price: '200' },
        { name: 'ステッカー', qty: '1', price: '' },
        { name: '', qty: '1', price: '200' },
        { name: 'バッジ', qty: '0', price: '100' },
      ]),
    ).toBe(6200n * 10n ** 18n);
    expect(orderLinkGoodsWei([])).toBe(0n);
  });
});

describe('打っている途中の扱い', () => {
  it('商品名だけ・単価だけの途中は誤りにしない (単価が入って商品名が無いときだけ欄を示す)', () => {
    expect(buildOrderLink(input({ lines: [{ name: 'Tシャツ', qty: '1', price: '' }] }))).toEqual({ ok: false, error: 'noItems' });
    expect(orderLinkLineIssues({ name: 'Tシャツ', qty: '1', price: '' })).toEqual([]);
    expect(orderLinkLineIssues({ name: '', qty: '1', price: '500' })).toEqual(['name']);
    expect(orderLinkLineIssues({ name: '', qty: '1', price: '' })).toEqual([]);
  });

  it('直す欄を示す', () => {
    expect(orderLinkLineIssues({ name: 'Tシャツ', qty: '0', price: '500' })).toEqual(['qty']);
    expect(orderLinkLineIssues({ name: 'Tシャツ', qty: '1', price: '0' })).toEqual(['price']);
  });
});

describe('nextOrderLinkId', () => {
  it('末尾の数字に 1 を足し、桁数を保つ', () => {
    expect(nextOrderLinkId('A-001')).toBe('A-002');
    expect(nextOrderLinkId('A-009')).toBe('A-010');
    expect(nextOrderLinkId('A-999')).toBe('A-1000');
    expect(nextOrderLinkId('ORD-105')).toBe('ORD-106');
    expect(nextOrderLinkId('7')).toBe('8');
  });

  it('続きを決められない番号は空にする', () => {
    expect(nextOrderLinkId('秋のイベント')).toBe('');
    expect(nextOrderLinkId('')).toBe('');
    expect(nextOrderLinkId(`${'x'.repeat(63)}9`)).toBe('');
  });
});

describe('orderLinkPreviewLines', () => {
  it('行の金額を数量つきで出し、送料を末尾に足す', () => {
    expect(orderLinkPreviewLines([{ name: 'Tシャツ', qty: '2', price: '3000' }], '500', '送料')).toEqual([
      { name: 'Tシャツ', qty: 2, amount: '6000' },
      { name: '送料', qty: 1, amount: '500' },
    ]);
  });

  it('読めない行と、商品が無いときの送料は出さない', () => {
    expect(orderLinkPreviewLines([{ name: 'Tシャツ', qty: '1', price: '' }], '500', '送料')).toEqual([]);
    expect(orderLinkPreviewLines([{ name: 'Tシャツ', qty: '0', price: '500' }], '500', '送料')).toEqual([]);
  });
});

describe('orderLinkChains', () => {
  it('ガスレスを使えるチェーンだけを返す', () => {
    const chains = orderLinkChains(JPYC_CHAINS);
    expect(chains).toContain('polygon');
    expect(chains.every((slug) => isGaslessSupported(deploymentForSlug('jpyc', slug)))).toBe(true);
  });
});

describe('orderLinkLineAmount', () => {
  it('数量 × 単価を返す', () => {
    expect(orderLinkLineAmount({ name: 'A', qty: '3', price: '1.5' })).toBe('4.5');
  });

  it('単価が無い行・読めない行は null', () => {
    expect(orderLinkLineAmount({ name: 'A', qty: '2', price: '' })).toBeNull();
    expect(orderLinkLineAmount({ name: '', qty: '2', price: '100' })).toBeNull();
    expect(orderLinkLineAmount({ name: 'A', qty: '0', price: '100' })).toBeNull();
    expect(orderLinkLineAmount({ name: 'A', qty: '2', price: 'abc' })).toBeNull();
  });
});

describe('orderLinkFitsStandard', () => {
  it('通常決済の上限まで true', () => {
    expect(orderLinkFitsStandard('1000000')).toBe(true);
    expect(orderLinkFitsStandard('1000000.01')).toBe(false);
  });
});
