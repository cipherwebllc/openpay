import { describe, it, expect } from 'vitest';
import {
  buildPayPath,
  parsePayParams,
  buildCheckoutPath,
  parseCheckoutParams,
  type CheckoutItem,
} from '@/lib/url';

const TO = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function parsePay(query: string) {
  return parsePayParams(new URLSearchParams(query));
}
function parseCheckout(query: string) {
  return parseCheckoutParams(new URLSearchParams(query));
}

describe('/pay 記帳補助メタ (商品名/メモ/税/管理番号/店舗名)', () => {
  const base = {
    to: TO as `0x${string}`,
    token: 'jpyc' as const,
    gas: 'customer' as const,
    amount: '1100',
    mode: 'gasless' as const,
  };

  it('build: 未指定なら新 param は出ない (旧 QR 不変)', () => {
    const path = buildPayPath(base);
    for (const k of ['pname', 'memo', 'tax', 'taxcat', 'rcpt', 'store']) {
      expect(path).not.toContain(`${k}=`);
    }
  });

  it('build: 在るときだけ出力', () => {
    const path = buildPayPath({
      ...base,
      storeName: '神田珈琲',
      productName: 'コーヒー',
      memo: 'イベント販売',
      taxRate: 10,
      taxCategory: 'taxable_10',
      receiptNo: 'R-20260615-001',
    });
    expect(path).toContain('store=');
    expect(path).toContain('pname=');
    expect(path).toContain('memo=');
    expect(path).toContain('tax=10');
    expect(path).toContain('taxcat=taxable_10');
    expect(path).toContain('rcpt=R-20260615-001');
  });

  it('round-trip: build → parse で値が戻る', () => {
    const path = buildPayPath({
      ...base,
      storeName: 'Cafe X',
      productName: 'コーヒー',
      memo: 'メモ',
      taxRate: 8,
      taxCategory: 'taxable_8',
      receiptNo: 'R-1',
    });
    const r = parsePay(path.split('?')[1]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.storeName).toBe('Cafe X');
    expect(r.params.productName).toBe('コーヒー');
    expect(r.params.memo).toBe('メモ');
    expect(r.params.taxRate).toBe(8);
    expect(r.params.taxCategory).toBe('taxable_8');
    expect(r.params.receiptNo).toBe('R-1');
  });

  it('parse: 税率 0 (非課税/対象外) も保持される', () => {
    const path = buildPayPath({ ...base, taxRate: 0, taxCategory: 'out_of_scope' });
    expect(path).toContain('tax=0');
    const r = parsePay(path.split('?')[1]);
    expect(r.ok && r.params.taxRate).toBe(0);
    expect(r.ok && r.params.taxCategory).toBe('out_of_scope');
  });

  it('parse: 不正な taxcat / tax は undefined に degrade (支払いは止めない)', () => {
    const r = parsePay(`to=${TO}&token=jpyc&amount=1000&tax=abc&taxcat=nope`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.taxRate).toBeUndefined();
    expect(r.params.taxCategory).toBeUndefined();
  });

  it('parse: 商品名は制御文字 strip + cap (80) される', () => {
    const long = 'A'.repeat(200);
    const r = parsePay(
      `to=${TO}&token=jpyc&amount=1000&pname=${encodeURIComponent('xy' + long)}`,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.params.productName ?? '').length).toBeLessThanOrEqual(80);
    expect(r.params.productName?.startsWith('xy')).toBe(true);
  });

  it('後方互換: 新 param 無しの旧 URL は従来どおり parse', () => {
    const r = parsePay(`to=${TO}&token=jpyc&amount=1000`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.productName).toBeUndefined();
    expect(r.params.taxRate).toBeUndefined();
    expect(r.params.amount).toBe('1000');
  });
});

describe('/checkout 記帳補助メタ (税/管理番号)', () => {
  const items: CheckoutItem[] = [{ name: 'コーヒー', qty: 2, price: '500' }];

  it('round-trip: tax / taxcat / rcpt', () => {
    const path = buildCheckoutPath({
      to: TO as `0x${string}`,
      token: 'jpyc',
      gas: 'customer',
      mode: 'gasless',
      items,
      taxRate: 10,
      taxCategory: 'taxable_10',
      receiptNo: 'R-9',
    });
    expect(path).toContain('tax=10');
    expect(path).toContain('taxcat=taxable_10');
    expect(path).toContain('rcpt=R-9');
    const r = parseCheckout(path.split('?')[1]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.taxRate).toBe(10);
    expect(r.params.taxCategory).toBe('taxable_10');
    expect(r.params.receiptNo).toBe('R-9');
    expect(r.params.items).toHaveLength(1);
  });

  it('後方互換: tax 無しの checkout は従来どおり (items のみ)', () => {
    const path = buildCheckoutPath({
      to: TO as `0x${string}`,
      token: 'jpyc',
      gas: 'customer',
      mode: 'gasless',
      items,
    });
    expect(path).not.toContain('tax=');
    const r = parseCheckout(path.split('?')[1]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.taxRate).toBeUndefined();
    expect(r.params.taxCategory).toBeUndefined();
  });
});

describe('/checkout per-item 税/メモ (複数商品カート・6セグ encoding)', () => {
  it('round-trip: 混在税率 + per-item メモ', () => {
    const cart: CheckoutItem[] = [
      { name: 'コーヒー', qty: 2, price: '500', taxRate: 10, taxCategory: 'taxable_10', memo: 'ホット' },
      { name: 'チケット', qty: 1, price: '1000', taxRate: 0, taxCategory: 'out_of_scope' },
    ];
    const path = buildCheckoutPath({
      to: TO as `0x${string}`,
      token: 'jpyc',
      gas: 'customer',
      mode: 'gasless',
      items: cart,
    });
    const r = parseCheckout(path.split('?')[1]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.items).toHaveLength(2);
    expect(r.params.items[0]).toMatchObject({
      name: 'コーヒー',
      qty: 2,
      price: '500',
      taxRate: 10,
      taxCategory: 'taxable_10',
      memo: 'ホット',
    });
    expect(r.params.items[1]).toMatchObject({
      name: 'チケット',
      qty: 1,
      taxRate: 0,
      taxCategory: 'out_of_scope',
    });
    expect(r.params.items[1].memo).toBeUndefined();
  });

  it('後方互換: 旧 3 セグ items (税なし) も parse できる', () => {
    // 旧 QR が生成する items=encName:qty:price 形式を直接 parse。
    const legacy = `items=${encodeURIComponent('コーヒー')}:2:500`;
    const r = parseCheckout(`to=${TO}&token=jpyc&${legacy}`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.items[0]).toMatchObject({ name: 'コーヒー', qty: 2, price: '500' });
    expect(r.params.items[0].taxRate).toBeUndefined();
  });

  it('税なし item は 3 セグのまま (URL を無駄に長くしない)', () => {
    const path = buildCheckoutPath({
      to: TO as `0x${string}`,
      token: 'jpyc',
      gas: 'customer',
      mode: 'gasless',
      items: [{ name: 'A', qty: 1, price: '100' }],
    });
    const r = parseCheckout(path.split('?')[1]);
    expect(r.ok && r.params.items[0].taxRate).toBeUndefined();
  });
});

describe('/checkout items parse: 境界・不正入力 (per-item)', () => {
  // 生の items 値を直接 parse (二重 encode を避け URLSearchParams に decode させる)。
  function withItems(raw: string) {
    return parseCheckout(`to=${TO}&token=jpyc&items=${encodeURIComponent(raw)}`);
  }

  it.each([
    ['A:2:100:10', '4 セグ'],
    ['A:2:100:10:taxable_10', '5 セグ'],
    ['A:2:100:10:taxable_10:m:extra', '7 セグ'],
  ])('不正なセグメント数 (%s) は全体 reject', (raw) => {
    expect(withItems(raw).ok).toBe(false);
  });

  it('6 セグで税率が範囲外 (999) → taxRate は捨て・item は維持 (決済は止めない)', () => {
    const r = withItems('A:2:100:999:taxable_10:');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.items[0]).toMatchObject({ name: 'A', qty: 2, price: '100' });
    expect(r.params.items[0].taxRate).toBeUndefined(); // 範囲外 → degrade
    expect(r.params.items[0].taxCategory).toBe('taxable_10'); // 区分は有効
  });

  it('6 セグで税区分が不正 (bogus) → taxCategory は捨て・taxRate は維持', () => {
    const r = withItems('A:2:100:8:bogus:');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.items[0].taxRate).toBe(8);
    expect(r.params.items[0].taxCategory).toBeUndefined();
  });

  it("商品名に ':' / ',' を含んでも round-trip する (内側 encodeURIComponent で衝突回避)", () => {
    const path = buildCheckoutPath({
      to: TO as `0x${string}`,
      token: 'jpyc',
      gas: 'customer',
      mode: 'gasless',
      items: [{ name: 'A:B, C', qty: 1, price: '100', taxRate: 10, taxCategory: 'taxable_10' }],
    });
    const r = parseCheckout(path.split('?')[1]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.items[0].name).toBe('A:B, C');
    expect(r.params.items[0].taxRate).toBe(10);
  });

  it('item が 10 件超 → 全体 reject (CHECKOUT_MAX_ITEMS)', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      name: `P${i}`,
      qty: 1,
      price: '1',
    }));
    const path = buildCheckoutPath({
      to: TO as `0x${string}`,
      token: 'jpyc',
      gas: 'customer',
      mode: 'gasless',
      items: many,
    });
    expect(parseCheckout(path.split('?')[1]).ok).toBe(false);
  });
});
