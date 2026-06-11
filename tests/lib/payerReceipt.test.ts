import { describe, it, expect, beforeEach, vi } from 'vitest';
import { polygonAmoy } from 'viem/chains';
import { buildHistoryEntry, type BuildHistoryBase } from '@/lib/history';
import {
  buildPayerReceipt,
  payerReceiptFromHistoryEntry,
  payerReceiptCopyText,
  payerReceiptToJson,
  payerReceiptCsv,
  payerReceiptCsvFilename,
  payerReceiptJsonFilename,
  formatReceiptDateTime,
  payerReceiptHasTax,
  appendPayerReceipt,
  promotePayerReceiptStatus,
  loadPayerReceipts,
  removePayerReceipt,
  clearPayerReceipts,
  PAYER_RECEIPTS_STORAGE_KEY,
  PAYER_RECEIPTS_CHANGED_EVENT,
  PAYER_RECEIPTS_MAX,
  PAYER_RECEIPT_SCHEMA_VERSION,
  type PayerReceipt,
} from '@/lib/payerReceipt';

const NOW = new Date('2026-06-04T01:42:00.000Z');
const TX = `0x${'a'.repeat(64)}`;

function saleEntry(over: Partial<BuildHistoryBase> = {}) {
  return buildHistoryEntry({
    flow: 'batch',
    status: 'success',
    chainId: polygonAmoy.id,
    chainSlug: 'polygon',
    asset: 'jpyc',
    tokenAddress: '0xToken',
    payMode: 'gasless',
    gasMode: 'customer',
    merchant: '0xMerchantWallet',
    merchantAmount: 4000n * 10n ** 18n, // 4000 JPYC
    customer: '0xPayerWallet',
    feeReceiver: '0xFee',
    feeAmount: 0n,
    txHash: TX,
    userOpHash: '0xUO',
    blockNumber: 1n,
    errorMessage: null,
    storeName: 'OpenPay Cafe',
    receiptNo: 'OP-20260604-001',
    lineItems: [
      { name: 'コーヒー', quantity: 2, unitPrice: '500', amount: '1000', taxRate: 10, taxCategory: 'taxable_10', memo: null },
      { name: 'Tシャツ', quantity: 1, unitPrice: '3000', amount: '3000', taxRate: 10, taxCategory: 'taxable_10', memo: null },
    ],
    productName: 'コーヒー, Tシャツ',
    ...over,
  });
}

describe('buildPayerReceipt', () => {
  it('lineItems あり → そのまま保持・direction/kind/status・chain/explorer/通貨 を導出', () => {
    const r = buildPayerReceipt(
      {
        txHash: TX,
        chainId: polygonAmoy.id,
        asset: 'jpyc',
        amount: '4000',
        merchantAddress: '0xMerchantWallet',
        merchantName: 'OpenPay Cafe',
        payerAddress: '0xPayerWallet',
        paymentMode: 'gasless',
        gasMode: 'customer',
        lineItems: [
          { name: 'コーヒー', quantity: 2, unitPrice: '500', amount: '1000', taxRate: 10, taxCategory: 'taxable_10', memo: null },
        ],
        totalTaxAmount: '364',
        sourceRoute: '/checkout',
        locale: 'ja',
      },
      NOW,
    );
    expect(r.direction).toBe('paid');
    expect(r.kind).toBe('payment_receipt');
    expect(r.status).toBe('confirmed');
    expect(r.receiptId).toBe(TX);
    expect(r.tokenSymbol).toBe('JPYC');
    expect(r.currency).toBe('JPYC');
    expect(r.chainName).toBeTruthy();
    expect(r.explorerUrl).toContain(TX);
    expect(r.lineItems).toHaveLength(1);
    expect(r.totalTaxAmount).toBe('364');
    expect(r.createdAt).toBe(NOW.toISOString());
    expect(r.paidAt).toBe(NOW.toISOString());
  });

  it('lineItems 無し (単純送金/旧QR) → 仮想 1 行 (merchantName or OpenPay payment)', () => {
    const named = buildPayerReceipt(
      { asset: 'usdc', amount: '12.5', merchantAddress: '0xM', merchantName: 'Shop X', txHash: '0xt' },
      NOW,
    );
    expect(named.lineItems).toHaveLength(1);
    expect(named.lineItems?.[0]).toMatchObject({
      name: 'Shop X',
      quantity: 1,
      unitPrice: '12.5',
      amount: '12.5',
      taxRate: null,
      taxCategory: 'out_of_scope',
      taxAmount: '0',
    });
    const anon = buildPayerReceipt({ asset: 'usdc', amount: '1', merchantAddress: '0xM' }, NOW);
    expect(anon.lineItems?.[0].name).toBe('OpenPay payment');
  });

  it('receiptId は txHash > userOpHash > ランダム', () => {
    expect(buildPayerReceipt({ asset: 'jpyc', amount: '1', merchantAddress: '0xM', txHash: '0xA', userOpHash: '0xB' }, NOW).receiptId).toBe('0xA');
    expect(buildPayerReceipt({ asset: 'jpyc', amount: '1', merchantAddress: '0xM', userOpHash: '0xB' }, NOW).receiptId).toBe('0xB');
    const rand = buildPayerReceipt({ asset: 'jpyc', amount: '1', merchantAddress: '0xM' }, NOW);
    expect(rand.receiptId.length).toBeGreaterThan(0);
    expect(rand.paidAt).toBeUndefined(); // txHash 無 → paidAt 無
  });
});

describe('payerReceiptFromHistoryEntry', () => {
  it('HistoryEntry (sale 成功) → 顧客レシートへ写像 (明細/合計/店舗/顧客/status)', () => {
    const r = payerReceiptFromHistoryEntry(saleEntry(), { sourceRoute: '/checkout', locale: 'ja', now: NOW });
    expect(r.amount).toBe('4000'); // entryTotals.total
    expect(r.totalAmount).toBe('4000');
    expect(r.lineItems).toHaveLength(2);
    expect(r.merchantName).toBe('OpenPay Cafe');
    expect(r.merchantAddress).toBe('0xMerchantWallet');
    expect(r.payerAddress).toBe('0xPayerWallet');
    expect(r.receiptNo).toBe('OP-20260604-001');
    expect(r.status).toBe('confirmed');
    expect(r.sourceRoute).toBe('/checkout');
  });

  it('pending entry → status pending', () => {
    const r = payerReceiptFromHistoryEntry(saleEntry({ status: 'pending' }), { now: NOW });
    expect(r.status).toBe('pending');
  });

  it('gas=merchant (saleAmount > merchantAmount): 総額は gross(saleAmount)=明細合計', () => {
    // 店主が gas 100 JPYC を吸収 → 手取り merchantAmount=3900 だが顧客が払った商品代は 4000。
    const r = payerReceiptFromHistoryEntry(
      saleEntry({
        gasMode: 'merchant',
        merchantAmount: 3900n * 10n ** 18n,
        saleAmount: 4000n * 10n ** 18n,
      }),
      { now: NOW },
    );
    expect(r.totalAmount).toBe('4000'); // merchantAmount(3900) ではなく gross
    expect(r.subtotalAmount).toBe('4000');
    expect(r.amount).toBe('4000');
    // 明細合計 (コーヒー 1000 + Tシャツ 3000) と総額が一致 (内部整合)。
    const sum = (r.lineItems ?? []).reduce((a, li) => a + Number(li.amount), 0);
    expect(sum).toBe(4000);
  });
});

describe('copy / JSON / CSV 出力', () => {
  const r = payerReceiptFromHistoryEntry(saleEntry(), { locale: 'ja', now: NOW });

  it('copyText に主要項目 (レシート番号/明細/合計/txHash/両ウォレット)', () => {
    const t = payerReceiptCopyText(r, 'ja');
    expect(t).toContain('OP-20260604-001');
    expect(t).toContain('コーヒー x 2');
    expect(t).toContain('Tシャツ x 1');
    expect(t).toContain('合計：4000 JPYC');
    expect(t).toContain(TX);
    expect(t).toContain('0xMerchantWallet');
    expect(t).toContain('0xPayerWallet');
  });

  it('JSON は round-trip (秘密情報なし・receipt そのまま)', () => {
    const parsed = JSON.parse(payerReceiptToJson(r)) as PayerReceipt;
    expect(parsed.receiptId).toBe(r.receiptId);
    expect(parsed.lineItems).toHaveLength(2);
    // 秘密情報 (private key 等) は構造上持たない
    expect(JSON.stringify(parsed)).not.toMatch(/privateKey|mnemonic|seed/i);
  });

  it('CSV は 1 商品 1 行 + ヘッダ', () => {
    const csv = payerReceiptCsv(r);
    expect(csv).toContain('コーヒー');
    expect(csv).toContain('Tシャツ');
    expect(csv).toContain('商品名'); // header
    expect(csv).toContain(TX);
  });
});

describe('ストア (LocalStorage)', () => {
  beforeEach(() => window.localStorage.clear());

  it('append → load (dedupe by receiptId)', () => {
    const r = payerReceiptFromHistoryEntry(saleEntry(), { now: NOW });
    appendPayerReceipt(r);
    appendPayerReceipt(r); // 同一 receiptId → no-op
    expect(loadPayerReceipts()).toHaveLength(1);
    expect(loadPayerReceipts()[0].receiptId).toBe(TX);
  });

  it('新しい順 (新規が先頭)', () => {
    appendPayerReceipt(buildPayerReceipt({ asset: 'jpyc', amount: '1', merchantAddress: '0xM', txHash: '0x1' }, NOW));
    appendPayerReceipt(buildPayerReceipt({ asset: 'jpyc', amount: '2', merchantAddress: '0xM', txHash: '0x2' }, NOW));
    expect(loadPayerReceipts().map((r) => r.txHash)).toEqual(['0x2', '0x1']);
  });

  it('remove / clear', () => {
    appendPayerReceipt(buildPayerReceipt({ asset: 'jpyc', amount: '1', merchantAddress: '0xM', txHash: '0x1' }, NOW));
    appendPayerReceipt(buildPayerReceipt({ asset: 'jpyc', amount: '2', merchantAddress: '0xM', txHash: '0x2' }, NOW));
    removePayerReceipt('0x1');
    expect(loadPayerReceipts().map((r) => r.txHash)).toEqual(['0x2']);
    clearPayerReceipts();
    expect(loadPayerReceipts()).toEqual([]);
  });

  it('壊れた/不正データは drop し crash しない', () => {
    window.localStorage.setItem(
      PAYER_RECEIPTS_STORAGE_KEY,
      JSON.stringify([
        { schemaVersion: PAYER_RECEIPT_SCHEMA_VERSION, receiptId: 'ok', direction: 'paid', kind: 'payment_receipt', createdAt: 'x', tokenSymbol: 'JPYC', amount: '1', merchantAddress: '0xM' },
        { foo: 'bar' }, // 不正
        null,
        { receiptId: 'no-kind', direction: 'paid', kind: 'wrong', createdAt: 'x', tokenSymbol: 'JPYC', amount: '1', merchantAddress: '0xM', schemaVersion: 1 },
      ]),
    );
    const loaded = loadPayerReceipts();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].receiptId).toBe('ok');
  });

  it('非 array の LocalStorage → []', () => {
    window.localStorage.setItem(PAYER_RECEIPTS_STORAGE_KEY, JSON.stringify({ not: 'array' }));
    expect(loadPayerReceipts()).toEqual([]);
  });

  it('未来 schemaVersion は drop・schemaVersion 欠落は 1 として救済', () => {
    window.localStorage.setItem(
      PAYER_RECEIPTS_STORAGE_KEY,
      JSON.stringify([
        // 未知の未来 version → migrator 無し → drop (silent regression を避ける)
        { schemaVersion: 999, receiptId: 'future', direction: 'paid', kind: 'payment_receipt', createdAt: 'x', tokenSymbol: 'JPYC', amount: '1', merchantAddress: '0xM' },
        // schemaVersion 欠落 (旧データ) → 1 として正規化し、他が妥当なら救済
        { receiptId: 'legacy', direction: 'paid', kind: 'payment_receipt', createdAt: 'x', tokenSymbol: 'JPYC', amount: '1', merchantAddress: '0xM' },
      ]),
    );
    const loaded = loadPayerReceipts();
    expect(loaded.map((r) => r.receiptId)).toEqual(['legacy']);
    expect(loaded[0].schemaVersion).toBe(PAYER_RECEIPT_SCHEMA_VERSION);
  });

  it('lineItems が array でない不正レシートは drop', () => {
    window.localStorage.setItem(
      PAYER_RECEIPTS_STORAGE_KEY,
      JSON.stringify([
        { schemaVersion: 1, receiptId: 'bad-li', direction: 'paid', kind: 'payment_receipt', createdAt: 'x', tokenSymbol: 'JPYC', amount: '1', merchantAddress: '0xM', lineItems: 'not-array' },
      ]),
    );
    expect(loadPayerReceipts()).toEqual([]);
  });

  it('lineItem の必須数値/文字列フィールド欠落 (quantity/unitPrice/amount) は drop', () => {
    window.localStorage.setItem(
      PAYER_RECEIPTS_STORAGE_KEY,
      JSON.stringify([
        // name はあるが quantity(number)/unitPrice/amount(string) が欠落 → undefined 表示を防ぐため drop。
        { schemaVersion: 1, receiptId: 'broken-li', direction: 'paid', kind: 'payment_receipt', createdAt: 'x', tokenSymbol: 'JPYC', amount: '1', merchantAddress: '0xM', lineItems: [{ name: 'コーヒー' }] },
        // 完全な lineItem は通す (回帰防止)。
        { schemaVersion: 1, receiptId: 'ok-li', direction: 'paid', kind: 'payment_receipt', createdAt: 'x', tokenSymbol: 'JPYC', amount: '1', merchantAddress: '0xM', lineItems: [{ name: 'コーヒー', quantity: 1, unitPrice: '1', amount: '1', taxRate: null, taxCategory: 'out_of_scope', taxAmount: '0', memo: null }] },
      ]),
    );
    expect(loadPayerReceipts().map((r) => r.receiptId)).toEqual(['ok-li']);
  });

  it('FIFO cap: 上限超過は最古を落とし最新 PAYER_RECEIPTS_MAX 件を保持', () => {
    const total = PAYER_RECEIPTS_MAX + 5;
    for (let i = 0; i < total; i++) {
      appendPayerReceipt(
        buildPayerReceipt({ asset: 'jpyc', amount: '1', merchantAddress: '0xM', txHash: `0xtx${i}` }, NOW),
      );
    }
    const loaded = loadPayerReceipts();
    expect(loaded).toHaveLength(PAYER_RECEIPTS_MAX);
    // 新しい順: 最後に append した tx が先頭、最古 (tx0..tx4) は押し出される。
    expect(loaded[0].txHash).toBe(`0xtx${total - 1}`);
    expect(loaded.some((r) => r.txHash === '0xtx0')).toBe(false);
    expect(loaded.some((r) => r.txHash === `0xtx${total - PAYER_RECEIPTS_MAX}`)).toBe(true);
  });

  it('remove: 存在しない id は no-op (件数不変)', () => {
    appendPayerReceipt(buildPayerReceipt({ asset: 'jpyc', amount: '1', merchantAddress: '0xM', txHash: '0xkeep' }, NOW));
    removePayerReceipt('0xnonexistent');
    expect(loadPayerReceipts()).toHaveLength(1);
  });
});

describe('appendPayerReceipt: pending → confirmed/failed 昇格', () => {
  beforeEach(() => window.localStorage.clear());

  function pendingReceipt(txHash: string): PayerReceipt {
    return { ...buildPayerReceipt({ asset: 'jpyc', amount: '1', merchantAddress: '0xM', txHash }, NOW), status: 'pending', paidAt: undefined };
  }

  it('pending 保存後に同一 tx の confirmed を append → status 昇格・1 件のまま・paidAt 反映', () => {
    appendPayerReceipt(pendingReceipt('0xpa'));
    expect(loadPayerReceipts()[0].status).toBe('pending');
    const confirmed: PayerReceipt = { ...pendingReceipt('0xpa'), status: 'confirmed', paidAt: NOW.toISOString() };
    appendPayerReceipt(confirmed);
    const loaded = loadPayerReceipts();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].status).toBe('confirmed');
    expect(loaded[0].paidAt).toBe(NOW.toISOString());
  });

  it('pending 保存後に failed を append → status=failed に昇格 (1 件のまま)', () => {
    appendPayerReceipt(pendingReceipt('0xpb'));
    appendPayerReceipt({ ...pendingReceipt('0xpb'), status: 'failed' });
    const loaded = loadPayerReceipts();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].status).toBe('failed');
  });

  it('confirmed 保存後に同一 tx の pending を append → downgrade しない (no-op)', () => {
    appendPayerReceipt(buildPayerReceipt({ asset: 'jpyc', amount: '1', merchantAddress: '0xM', txHash: '0xpc' }, NOW)); // status=confirmed
    appendPayerReceipt(pendingReceipt('0xpc'));
    expect(loadPayerReceipts()[0].status).toBe('confirmed');
  });

  it('同一 status の再 append は no-op (配列参照・storage 不変)', () => {
    appendPayerReceipt(pendingReceipt('0xpd'));
    const before = window.localStorage.getItem(PAYER_RECEIPTS_STORAGE_KEY);
    appendPayerReceipt(pendingReceipt('0xpd')); // 同 status (pending) → no-op (StrictMode 二重発火)
    expect(window.localStorage.getItem(PAYER_RECEIPTS_STORAGE_KEY)).toBe(before);
    expect(loadPayerReceipts()).toHaveLength(1);
  });

  it('昇格時に CHANGED_EVENT を dispatch する', () => {
    appendPayerReceipt(pendingReceipt('0xpe'));
    const spy = vi.fn();
    window.addEventListener(PAYER_RECEIPTS_CHANGED_EVENT, spy);
    appendPayerReceipt({ ...pendingReceipt('0xpe'), status: 'confirmed', paidAt: NOW.toISOString() });
    window.removeEventListener(PAYER_RECEIPTS_CHANGED_EVENT, spy);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('promotePayerReceiptStatus', () => {
  beforeEach(() => window.localStorage.clear());

  function seedPending(txHash: string) {
    appendPayerReceipt({ ...buildPayerReceipt({ asset: 'jpyc', amount: '1', merchantAddress: '0xM', txHash }, NOW), status: 'pending', paidAt: undefined });
  }

  it('pending → confirmed: true を返し status 更新', () => {
    seedPending('0xq1');
    expect(promotePayerReceiptStatus('0xq1', 'confirmed')).toBe(true);
    expect(loadPayerReceipts()[0].status).toBe('confirmed');
  });

  it('non-pending → false (no-op)', () => {
    appendPayerReceipt(buildPayerReceipt({ asset: 'jpyc', amount: '1', merchantAddress: '0xM', txHash: '0xq2' }, NOW)); // confirmed
    expect(promotePayerReceiptStatus('0xq2', 'failed')).toBe(false);
    expect(loadPayerReceipts()[0].status).toBe('confirmed');
  });

  it('不在 id → false', () => {
    expect(promotePayerReceiptStatus('0xnope', 'confirmed')).toBe(false);
  });

  it('true 時に CHANGED_EVENT を dispatch', () => {
    seedPending('0xq3');
    const spy = vi.fn();
    window.addEventListener(PAYER_RECEIPTS_CHANGED_EVENT, spy);
    promotePayerReceiptStatus('0xq3', 'confirmed');
    window.removeEventListener(PAYER_RECEIPTS_CHANGED_EVENT, spy);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('buildPayerReceipt: 境界・派生', () => {
  it('未対応 chainId → chainName / explorerUrl 省略 (tokenSymbol は維持)', () => {
    const r = buildPayerReceipt(
      { asset: 'usdc', amount: '5', merchantAddress: '0xM', txHash: '0xt', chainId: 999999 },
      NOW,
    );
    expect(r.chainName).toBeUndefined();
    expect(r.explorerUrl).toBeUndefined();
    expect(r.tokenSymbol).toBe('USDC');
  });

  it('chainId 省略 → chainName / explorerUrl とも undefined', () => {
    const r = buildPayerReceipt({ asset: 'jpyc', amount: '5', merchantAddress: '0xM', txHash: '0xt' }, NOW);
    expect(r.chainName).toBeUndefined();
    expect(r.explorerUrl).toBeUndefined();
  });

  it('amount のみ → subtotal/total=amount・tax=0 に既定化', () => {
    const r = buildPayerReceipt({ asset: 'jpyc', amount: '500', merchantAddress: '0xM' }, NOW);
    expect(r.subtotalAmount).toBe('500');
    expect(r.totalAmount).toBe('500');
    expect(r.totalTaxAmount).toBe('0');
  });

  it('空白のみ merchantName / memo → 仮想行は fallback 名・merchantName/memo は undefined', () => {
    const r = buildPayerReceipt(
      { asset: 'jpyc', amount: '1', merchantAddress: '0xM', merchantName: '   ', memo: '  ' },
      NOW,
    );
    expect(r.merchantName).toBeUndefined();
    expect(r.memo).toBeUndefined();
    expect(r.lineItems?.[0].name).toBe('OpenPay payment');
  });
});

describe('payerReceiptFromHistoryEntry: status 写像', () => {
  it('reverted entry → status unknown (控え自体は生成可能)', () => {
    const r = payerReceiptFromHistoryEntry(saleEntry({ status: 'reverted' }), { now: NOW });
    expect(r.status).toBe('unknown');
  });

  it('error entry → status unknown', () => {
    const r = payerReceiptFromHistoryEntry(saleEntry({ status: 'error' }), { now: NOW });
    expect(r.status).toBe('unknown');
  });
});

describe('payerReceiptFromHistoryEntry: 異通貨建て (anchor)', () => {
  // settled=USDC (6 decimals)・anchor=JPYC 建ての FX 換算 QR。
  function fxEntry(over: Partial<BuildHistoryBase> = {}) {
    return saleEntry({
      asset: 'usdc',
      merchantAmount: 6_400_000n, // 6.4 USDC
      anchorAmount: '1000',
      anchorSymbol: 'jpyc',
      fxRateUsdcJpy: '155.5',
      lineItems: null,
      productName: null,
      ...over,
    });
  }

  it('元価格 (anchor) を控えに反映 (settled は実支払額のまま)', () => {
    const r = payerReceiptFromHistoryEntry(fxEntry(), { locale: 'ja', now: NOW });
    expect(r.currency).toBe('USDC');
    expect(r.amount).toBe('6.4'); // settled = merchantAmount
    expect(r.anchorAmount).toBe('1000');
    expect(r.anchorSymbol).toBe('JPYC'); // displaySymbolFor('jpyc')
    expect(r.fxRate).toBe('155.5');
  });

  it('copyText に元価格 + レート行を含む', () => {
    const r = payerReceiptFromHistoryEntry(fxEntry(), { now: NOW });
    const t = payerReceiptCopyText(r, 'ja');
    expect(t).toContain('元の価格：1000 JPYC ≈ 6.4 USDC');
    expect(t).toContain('1 USDC = 155.5');
  });

  it('通常決済 (anchor 無し) → anchor フィールドは undefined', () => {
    const r = payerReceiptFromHistoryEntry(saleEntry(), { now: NOW });
    expect(r.anchorAmount).toBeUndefined();
    expect(r.anchorSymbol).toBeUndefined();
    expect(r.fxRate).toBeUndefined();
  });
});

describe('payerReceiptFromHistoryEntry: productName のみ (lineItems 無し)', () => {
  it('仮想 1 行を合成し、entry.taxRate から内税を算出', () => {
    const r = payerReceiptFromHistoryEntry(
      saleEntry({
        lineItems: null,
        productName: 'コーヒー',
        taxRate: 10,
        taxCategory: 'taxable_10',
        merchantAmount: 1100n * 10n ** 18n, // 1100 JPYC (税込)
      }),
      { now: NOW },
    );
    expect(r.lineItems).toHaveLength(1);
    expect(r.lineItems?.[0].name).toBe('コーヒー');
    expect(r.totalAmount).toBe('1100');
    // 内税 10%: 1100 × 10/110 = 100
    expect(r.totalTaxAmount).toBe('100');
  });
});

describe('formatReceiptDateTime / payerReceiptHasTax', () => {
  it('undefined → "—" ・不正 ISO → そのまま返す', () => {
    expect(formatReceiptDateTime(undefined)).toBe('—');
    expect(formatReceiptDateTime('not-a-date')).toBe('not-a-date');
  });

  it('妥当 ISO は年を含むロケール文字列 (ja/en とも)', () => {
    expect(formatReceiptDateTime(NOW.toISOString(), 'ja')).toContain('2026');
    expect(formatReceiptDateTime(NOW.toISOString(), 'en')).toContain('2026');
  });

  it('payerReceiptHasTax: 0/欠落 → false・正値 → true', () => {
    expect(payerReceiptHasTax({ totalTaxAmount: '0' } as PayerReceipt)).toBe(false);
    expect(payerReceiptHasTax({ totalTaxAmount: undefined } as unknown as PayerReceipt)).toBe(false);
    expect(payerReceiptHasTax({ totalTaxAmount: '90' } as PayerReceipt)).toBe(true);
  });
});

describe('ファイル名生成', () => {
  function r(over: Partial<PayerReceipt> = {}): PayerReceipt {
    return { ...buildPayerReceipt({ asset: 'jpyc', amount: '1', merchantAddress: '0xM', txHash: '0xabc' }, NOW), ...over };
  }

  it('CSV / JSON で拡張子が分かれる', () => {
    expect(payerReceiptCsvFilename(r())).toMatch(/\.csv$/);
    expect(payerReceiptJsonFilename(r())).toMatch(/\.json$/);
  });

  it('receiptNo を優先・特殊文字を除去', () => {
    expect(payerReceiptCsvFilename(r({ receiptNo: 'OP/2026#001' }))).toBe('openpay-receipt-OP2026001.csv');
  });

  it('slug が空になる receiptNo は日付スタンプに fallback', () => {
    const name = payerReceiptCsvFilename(r({ receiptNo: '###' }), new Date(2026, 5, 4));
    expect(name).toBe('openpay-receipt-20260604.csv');
  });
});

describe('CSV 出力の堅牢性 (実 buildCsv 経路)', () => {
  it('CSV Injection 防御 (=,+,-,@ 始まりに先頭 quote)', () => {
    const r = buildPayerReceipt(
      {
        asset: 'jpyc',
        amount: '100',
        merchantAddress: '0xM',
        txHash: '0xt',
        chainId: polygonAmoy.id,
        lineItems: [
          { name: '=SUM(A1)', quantity: 1, unitPrice: '100', amount: '100', taxRate: null, taxCategory: 'out_of_scope', taxAmount: '0', memo: null },
        ],
      },
      NOW,
    );
    const csv = payerReceiptCsv(r);
    expect(csv).toContain("'=SUM(A1)"); // defang
    expect(csv.charCodeAt(0)).toBe(0xfeff); // UTF-8 BOM
  });

  it('RFC-4180: カンマ/引用符を含む値は quote + "" escape', () => {
    const r = buildPayerReceipt(
      {
        asset: 'jpyc',
        amount: '100',
        merchantAddress: '0xM',
        txHash: '0xt',
        chainId: polygonAmoy.id,
        lineItems: [
          { name: 'Tea, "Coffee"', quantity: 1, unitPrice: '100', amount: '100', taxRate: null, taxCategory: 'out_of_scope', taxAmount: '0', memo: null },
        ],
      },
      NOW,
    );
    const csv = payerReceiptCsv(r);
    expect(csv).toContain('"Tea, ""Coffee"""');
  });
});

describe('payerReceiptCopyText: gating / locale / optional 省略', () => {
  it('税額 0 → 小計/消費税を出さず合計のみ', () => {
    const r = buildPayerReceipt({ asset: 'jpyc', amount: '500', merchantAddress: '0xM', txHash: '0xt' }, NOW);
    const t = payerReceiptCopyText(r, 'ja');
    expect(t).not.toContain('小計');
    expect(t).not.toContain('消費税');
    expect(t).toContain('合計：500 JPYC');
  });

  it('税額 > 0 → 小計/消費税/合計を併記', () => {
    const r = buildPayerReceipt(
      { asset: 'jpyc', amount: '4000', merchantAddress: '0xM', txHash: '0xt', subtotalAmount: '4000', totalTaxAmount: '362', totalAmount: '4000' },
      NOW,
    );
    const t = payerReceiptCopyText(r, 'ja');
    expect(t).toContain('小計：4000 JPYC');
    expect(t).toContain('消費税：362 JPYC');
    expect(t).toContain('合計：4000 JPYC');
  });

  it('en locale → 英語ラベル', () => {
    const r = buildPayerReceipt({ asset: 'usdc', amount: '12', merchantAddress: '0xM', txHash: '0xt' }, NOW);
    const t = payerReceiptCopyText(r, 'en');
    expect(t).toContain('OpenPay payment receipt');
    expect(t).toContain('Total：12 USDC');
    expect(t).not.toContain('合計');
  });

  it('merchantName / payerAddress 不在 → その行を省略', () => {
    const r = buildPayerReceipt({ asset: 'jpyc', amount: '1', merchantAddress: '0xM', txHash: '0xt' }, NOW);
    const t = payerReceiptCopyText(r, 'ja');
    expect(t).not.toContain('店舗：');
    expect(t).not.toContain('顧客ウォレット');
    expect(t).toContain('店舗ウォレット：0xM'); // 店舗ウォレットは必須
  });
});
