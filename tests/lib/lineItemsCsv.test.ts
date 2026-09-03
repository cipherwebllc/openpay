import { describe, it, expect, vi, afterEach } from 'vitest';
import { ACCOUNTING_MAX_ROWS, CSV_BOM, CSV_NEWLINE } from '@/lib/csv';
import { toLineItemsCsv, lineItemsCsvFilename } from '@/lib/lineItemsCsv';
import type { HistoryEntry } from '@/lib/history';

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    schemaVersion: 5,
    id: 'e-' + Math.random().toString(36).slice(2),
    ts: new Date(2026, 5, 15, 9, 0, 0).getTime(),
    flow: 'batch',
    status: 'success',
    chainId: 137,
    chainSlug: 'polygon',
    asset: 'jpyc',
    tokenAddress: '0xToken',
    payMode: 'gasless',
    gasMode: 'customer',
    merchant: '0xMerchant',
    merchantAmount: '4000000000000000000000', // 4000 JPYC
    customer: '0xCustomer',
    feeReceiver: '0xFee',
    feeAmount: '0',
    txHash: `0x${'a'.repeat(64)}`,
    userOpHash: null,
    blockNumber: '1',
    errorMessage: null,
    storeName: '',
    note: '',
    provider: null,
    circlePaymasterAddress: null,
    circlePaymasterNetUsdc: null,
    circleVerification: null,
    saleAmount: '4000000000000000000000',
    networkFeeEquivalent: null,
    feeBreakdownVersion: 1,
    anchorAmount: null,
    anchorSymbol: null,
    fxRateUsdcJpy: null,
    productName: null,
    memo: null,
    taxRate: null,
    taxCategory: null,
    receiptNo: 'R-1',
    lineItems: [
      { name: 'コーヒー', quantity: 2, unitPrice: '500', amount: '1000', taxRate: 10, taxCategory: 'taxable_10', memo: 'ホット' },
      { name: 'Tシャツ', quantity: 1, unitPrice: '3000', amount: '3000', taxRate: 8, taxCategory: 'taxable_8', memo: null },
    ],
    ...overrides,
  };
}

function parse(csv: string): string[][] {
  return csv
    .slice(CSV_BOM.length)
    .split(CSV_NEWLINE)
    .filter((l) => l.length > 0)
    .map((l) => l.split(','));
}

describe('toLineItemsCsv (1 商品 1 行)', () => {
  it('複数明細を 1 商品 1 行で出力 (行別 税率/税区分/税額 + 取引合計)', () => {
    const r = toLineItemsCsv([entry()]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rowCount).toBe(2);
    const rows = parse(r.csv);
    // header
    expect(rows[0]).toEqual([
      '日時', '管理番号', '取引Hash', 'チェーン', '通貨', '商品名', '数量',
      '単価', '明細金額', '税率(%)', '税区分', '税額', '取引合計', 'メモ',
    ]);
    // row1 = コーヒー x2 @500 = 1000 / 10% / 課税10% / 内税 91 / 取引合計 4000
    const r1 = rows[1];
    expect(r1[5]).toBe('コーヒー');
    expect(r1[6]).toBe('2');
    expect(r1[7]).toBe('500');
    expect(r1[8]).toBe('1000');
    expect(r1[9]).toBe('10');
    expect(r1[10]).toBe('課税10%');
    expect(r1[11]).toBe('91'); // 1000 税込@10% 内税
    expect(r1[12]).toBe('4000'); // 取引合計
    // row2 = Tシャツ @8%
    expect(rows[2][5]).toBe('Tシャツ');
    expect(rows[2][10]).toBe('軽減8%');
    expect(rows[2][11]).toBe('222'); // 3000 税込@8% 内税
  });

  it('収入売上以外 (reverted/error/手数料) は除外', () => {
    const r = toLineItemsCsv([
      entry({ id: 'rev', status: 'reverted' }),
      entry({ id: 'fee', flow: 'standard-fee' }),
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('no-rows');
  });

  it('明細の無い単品 entry (productName) も仮想 1 行で出力', () => {
    const r = toLineItemsCsv([
      entry({
        lineItems: null,
        productName: 'イベント参加費',
        merchantAmount: '1000000000000000000000',
        taxRate: 10,
        taxCategory: 'taxable_10',
      }),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = parse(r.csv);
    expect(rows[1][5]).toBe('イベント参加費');
    expect(rows[1][6]).toBe('1');
  });

  it('BOM 付きで始まる', () => {
    const r = toLineItemsCsv([entry()]);
    expect(r.ok && r.csv.startsWith(CSV_BOM)).toBe(true);
  });

  it('明細も商品名も無い収入 entry → 取引合計のみの 1 行で取りこぼさない (fallback)', () => {
    const r = toLineItemsCsv([
      entry({
        lineItems: null,
        productName: null,
        merchantAmount: '7000000000000000000000', // 7000 JPYC
        receiptNo: 'R-x',
        memo: 'メモ',
      }),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rowCount).toBe(1);
    const row = parse(r.csv)[1];
    expect(row[5]).toBe(''); // 商品名 空
    expect(row[6]).toBe(''); // 数量 空
    expect(row[8]).toBe('7000'); // 明細金額 = 取引合計
    expect(row[12]).toBe('7000'); // 取引合計
    expect(row[1]).toBe('R-x'); // 管理番号
    expect(row[13]).toBe('メモ'); // メモ
  });

  it('USDC: 通貨列と token 単位の金額/税額 (stored taxAmount を優先)', () => {
    const r = toLineItemsCsv([
      entry({
        asset: 'usdc',
        merchantAmount: '30000000', // 30 USDC
        lineItems: [
          {
            name: 'グッズ',
            quantity: 1,
            unitPrice: '30',
            amount: '30',
            currency: 'usdc',
            taxRate: 10,
            taxCategory: 'taxable_10',
            taxAmount: '2.73', // stored 値を尊重 (再算出しない)
            memo: null,
          },
        ],
      }),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = parse(r.csv)[1];
    expect(row[4]).toBe('USDC'); // 通貨
    expect(row[8]).toBe('30'); // 明細金額 (token 単位)
    expect(row[11]).toBe('2.73'); // 税額 = stored
  });

  it('複数 entry → 取引ごとに行がグループされる', () => {
    const r = toLineItemsCsv([
      entry({ id: 'a', txHash: '0xaaa' }),
      entry({ id: 'b', txHash: '0xbbb' }),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rowCount).toBe(4); // 2 entry × 2 明細
  });

  it('取込上限 (5000 行) 超過は中断 — 仕訳CSV と同じ扱い', () => {
    // 明細CSV は 1 entry が複数行に展開されるので、判定は entry 数ではなく行数。
    // 2 明細 × 2500 entry = ちょうど 5000 行 → 通る。
    const exact = toLineItemsCsv(
      Array.from({ length: ACCOUNTING_MAX_ROWS / 2 }, (_, i) =>
        entry({ id: `ok-${i}` }),
      ),
    );
    expect(exact.ok).toBe(true);
    expect(exact.ok && exact.rowCount).toBe(ACCOUNTING_MAX_ROWS);

    // +1 entry (= 5002 行) → too-many-rows
    const over = toLineItemsCsv(
      Array.from({ length: ACCOUNTING_MAX_ROWS / 2 + 1 }, (_, i) =>
        entry({ id: `over-${i}` }),
      ),
    );
    expect(over).toEqual({
      ok: false,
      reason: 'too-many-rows',
      rowCount: ACCOUNTING_MAX_ROWS + 2,
    });
  });

  it('CSV escape: 商品名のカンマは quote・先頭 = は defang', () => {
    const r1 = toLineItemsCsv([
      entry({ lineItems: [{ name: 'お店,珈琲', quantity: 1, unitPrice: '500', amount: '500', taxRate: null, taxCategory: null, memo: null }] }),
    ]);
    expect(r1.ok && r1.csv).toContain('"お店,珈琲"');
    const r2 = toLineItemsCsv([
      entry({ lineItems: [{ name: '=HYPERLINK("x")', quantity: 1, unitPrice: '1', amount: '1', taxRate: null, taxCategory: null, memo: null }] }),
    ]);
    expect(r2.ok && r2.csv).toContain("'=HYPERLINK"); // OWASP defang prefix
  });
});

describe('lineItemsCsvFilename', () => {
  afterEach(() => vi.useRealTimers());
  it('openpay-line-items-yyyy-MM-dd.csv', () => {
    expect(lineItemsCsvFilename(new Date(2026, 5, 4))).toBe(
      'openpay-line-items-2026-06-04.csv',
    );
  });
});
