import { describe, it, expect } from 'vitest';
import { convert, codeToString } from 'encoding-japanese';
import {
  toAccountingCsv,
  accountingCsvFilename,
} from '@/lib/accountingCsv';
import { encodeShiftJis } from '@/lib/sjis';
import { CSV_BOM, CSV_NEWLINE } from '@/lib/csv';
import type { HistoryEntry } from '@/lib/history';

// テスト用: Shift_JIS バイト列 → 文字列 (encodeShiftJis の逆変換)。
function decodeShiftJis(bytes: Uint8Array): string {
  return codeToString(convert(Array.from(bytes), 'UNICODE', 'SJIS'));
}

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    schemaVersion: 4,
    id: Math.random().toString(36),
    ts: new Date(2026, 5, 15, 12, 0, 0).getTime(),
    flow: 'batch',
    status: 'success',
    chainId: 137,
    chainSlug: 'polygon',
    asset: 'jpyc',
    tokenAddress: '0xToken',
    payMode: 'gasless',
    gasMode: 'customer',
    merchant: '0xMerchant',
    merchantAmount: '1000000000000000000000', // 1000 JPYC
    customer: '0xCustomer',
    feeReceiver: '0xFee',
    feeAmount: '0',
    txHash: `0x${'d'.repeat(64)}`,
    userOpHash: null,
    blockNumber: '1',
    errorMessage: null,
    storeName: '',
    note: '',
    provider: null,
    circlePaymasterAddress: null,
    circlePaymasterNetUsdc: null,
    circleVerification: null,
    saleAmount: '1000000000000000000000',
    networkFeeEquivalent: null,
    feeBreakdownVersion: 1,
    anchorAmount: null,
    anchorSymbol: null,
    fxRateUsdcJpy: null,
    productName: null,
    memo: null,
    taxRate: null,
    taxCategory: null,
    receiptNo: null,
    lineItems: null,
    ...overrides,
  };
}

function parseRows(csv: string): string[][] {
  return csv
    .slice(CSV_BOM.length)
    .split(CSV_NEWLINE)
    .filter((l) => l.length > 0)
    .map((l) => l.split(','));
}

const JPYC = entry({ asset: 'jpyc', merchantAmount: '1000000000000000000000' }); // → 1000円
const USDC_ANCHOR = entry({
  asset: 'usdc',
  merchantAmount: '6400000',
  anchorAmount: '1500',
  anchorSymbol: 'jpyc',
  fxRateUsdcJpy: '156.32',
}); // → 1500円 (exact)
const USDC_PLAIN = entry({
  asset: 'usdc',
  merchantAmount: '6400000',
  anchorAmount: null,
}); // → 6.4*rate (approx)
const REVERTED = entry({ status: 'reverted' });
const FEE_LEG = entry({ flow: 'standard-fee', status: 'success' });
const ERRORED = entry({ status: 'error' });

describe('toAccountingCsv: freee 形式', () => {
  it('ヘッダ + income-success のみ (status フィルタ非依存で revert/error/手数料を除外)', () => {
    const r = toAccountingCsv(
      [JPYC, USDC_ANCHOR, USDC_PLAIN, REVERTED, FEE_LEG, ERRORED],
      { format: 'freee', usdcJpy: 150 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rowCount).toBe(3); // 売上 3 件のみ
    expect(r.approxCount).toBe(1); // USDC_PLAIN
    const rows = parseRows(r.csv);
    expect(rows[0]).toEqual([
      '収支区分',
      '発生日',
      '勘定科目',
      '税区分',
      '金額',
      '取引先',
      '備考',
    ]);
    // 金額 (列 idx 4) は整数円: 1000 / 1500 / 960
    expect(rows[1][0]).toBe('収入');
    expect(rows[1][1]).toBe('2026-06-15');
    expect(rows[1][4]).toBe('1000'); // JPYC 1:1
    expect(rows[2][4]).toBe('1500'); // USDC + anchor (exact)
    expect(rows[3][4]).toBe('960'); // 6.4 * 150 approx
    // 備考
    expect(rows[2][6]).toContain('元:1500 JPYC');
    expect(rows[3][6]).toContain('概算@150');
    expect(rows[1][6]).toContain('JPYC/polygon');
  });

  it('rate-unavailable: USDC 無 anchor + レート無で中断', () => {
    const r = toAccountingCsv([USDC_PLAIN], { format: 'freee', usdcJpy: undefined });
    expect(r).toEqual({ ok: false, reason: 'rate-unavailable', blockingRowCount: 1 });
  });

  it('anchor 付き USDC はレート無でも ok (anchor で exact)', () => {
    const r = toAccountingCsv([USDC_ANCHOR], { format: 'freee', usdcJpy: undefined });
    expect(r.ok).toBe(true);
    if (r.ok) expect(parseRows(r.csv)[1][4]).toBe('1500');
  });

  it('no-rows: income 行が無い → no-rows', () => {
    const r = toAccountingCsv([REVERTED, FEE_LEG, ERRORED], {
      format: 'freee',
      usdcJpy: 150,
    });
    expect(r).toEqual({ ok: false, reason: 'no-rows' });
  });

  it('too-many-rows: 5000 超で中断', () => {
    const many = Array.from({ length: 5001 }, () => JPYC);
    const r = toAccountingCsv(many, { format: 'freee', usdcJpy: 150 });
    expect(r).toEqual({ ok: false, reason: 'too-many-rows', rowCount: 5001 });
  });
});

describe('toAccountingCsv: 弥生 形式 (仕訳・25列・ヘッダ無し)', () => {
  it('借方 売掛金 / 貸方 売上高 の 1 仕訳・日付 YYYY/MM/DD・25 列', () => {
    const r = toAccountingCsv([JPYC], { format: 'yayoi', usdcJpy: 150 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = parseRows(r.csv);
    expect(rows).toHaveLength(1); // ヘッダ無し・1 仕訳
    const row = rows[0];
    expect(row).toHaveLength(25);
    expect(row[0]).toBe('2000'); // 識別フラグ
    expect(row[3]).toBe('2026/06/15'); // 取引日付
    expect(row[4]).toBe('売掛金'); // 借方勘定科目
    expect(row[8]).toBe('1000'); // 借方金額
    expect(row[10]).toBe('売上高'); // 貸方勘定科目
    expect(row[14]).toBe('1000'); // 貸方金額
    expect(row[24]).toBe('no'); // 調整
  });
});

describe('toAccountingCsv: charset', () => {
  it('freee/yayoi/mf は UTF-8 (BOM 付き)・yayoi-native は Shift_JIS (BOM 無し)', () => {
    for (const format of ['freee', 'yayoi', 'mf'] as const) {
      const r = toAccountingCsv([JPYC], { format, usdcJpy: 150 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.charset).toBe('utf-8');
      expect(r.csv.startsWith(CSV_BOM)).toBe(true);
    }
    const ynative = toAccountingCsv([JPYC], { format: 'yayoi-native', usdcJpy: 150 });
    expect(ynative.ok).toBe(true);
    if (!ynative.ok) return;
    expect(ynative.charset).toBe('shift_jis');
    expect(ynative.csv.startsWith(CSV_BOM)).toBe(false); // UTF-8 BOM を含まない
  });
});

describe('toAccountingCsv: マネーフォワード 形式 (仕訳帳・ヘッダ付き・複式)', () => {
  it('ヘッダ + 借方売掛金/貸方売上高・日付 YYYY/MM/DD・金額は両建て整数円', () => {
    const r = toAccountingCsv([JPYC, USDC_ANCHOR], { format: 'mf', usdcJpy: 150 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rowCount).toBe(2);
    const rows = parseRows(r.csv);
    expect(rows[0][0]).toBe('取引No');
    expect(rows[0]).toContain('借方勘定科目');
    expect(rows[0]).toContain('貸方勘定科目');
    expect(rows[0]).toHaveLength(15);
    const row = rows[1];
    expect(row[0]).toBe('1'); // 取引No
    expect(row[1]).toBe('2026/06/15'); // 取引日
    expect(row[2]).toBe('売掛金'); // 借方勘定科目
    expect(row[6]).toBe('1000'); // 借方金額(円) = JPYC 1:1
    expect(row[8]).toBe('売上高'); // 貸方勘定科目
    expect(row[12]).toBe('1000'); // 貸方金額(円)
    expect(rows[2][6]).toBe('1500'); // USDC + anchor (exact)
    expect(rows[2][14]).toContain('元:1500 JPYC'); // 摘要
  });

  it('income-only (status フィルタ非依存で revert/error/手数料を除外)', () => {
    const r = toAccountingCsv([JPYC, REVERTED, FEE_LEG, ERRORED], {
      format: 'mf',
      usdcJpy: 150,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rowCount).toBe(1);
  });
});

describe('toAccountingCsv: 弥生ネイティブ (Shift_JIS round-trip)', () => {
  it('Shift_JIS エンコード → デコードで日本語列が保たれる (25列・ヘッダ無し)', async () => {
    const r = toAccountingCsv([JPYC], { format: 'yayoi-native', usdcJpy: 150 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const bytes = await encodeShiftJis(r.csv);
    const back = decodeShiftJis(bytes);
    expect(back).toContain('売掛金');
    expect(back).toContain('売上高');
    expect(back).toContain('課税売上込10%');
    expect(back).toContain('2026/06/15');
    // 25 列・ヘッダ無し (yayoi と同一レイアウト) を round-trip 後も維持
    const cols = back.split(CSV_NEWLINE).filter((l) => l.length > 0)[0].split(',');
    expect(cols).toHaveLength(25);
    expect(cols[0]).toBe('2000');
  });
});

describe('取引先 / 備考 のエッジケース', () => {
  it('storeName 空 → 取引先は customer にフォールバック (freee)', () => {
    const e = entry({ asset: 'jpyc', storeName: '', customer: '0xCustomerAddr' });
    const r = toAccountingCsv([e], { format: 'freee', usdcJpy: 150 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(parseRows(r.csv)[1][5]).toBe('0xCustomerAddr'); // 取引先 列
  });

  it('storeName が formula injection (=cmd) → CSV defang (先頭 single quote)', () => {
    const e = entry({ asset: 'jpyc', storeName: '=HYPERLINK("evil")' });
    const r = toAccountingCsv([e], { format: 'freee', usdcJpy: 150 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // escapeCsvCell が = 始まりを 'で無害化 + カンマ含むので quote
    expect(r.csv).toContain('"\'=HYPERLINK(""evil"")"');
  });

  it('5000 行ちょうどは ok (上限内・境界)', () => {
    const r = toAccountingCsv(Array.from({ length: 5000 }, () => JPYC), {
      format: 'freee',
      usdcJpy: 150,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rowCount).toBe(5000);
  });
});

describe('accountingCsvFilename', () => {
  it('openpay-{format}-YYYY-MM-DD.csv', () => {
    const d = new Date(2026, 5, 3);
    expect(accountingCsvFilename('freee', d)).toBe('openpay-freee-2026-06-03.csv');
    expect(accountingCsvFilename('yayoi', d)).toBe('openpay-yayoi-2026-06-03.csv');
    expect(accountingCsvFilename('mf', d)).toBe('openpay-mf-2026-06-03.csv');
    expect(accountingCsvFilename('yayoi-native', d)).toBe(
      'openpay-yayoi-native-2026-06-03.csv',
    );
  });
});

describe('toAccountingCsv: v5 税区分出し分け + 摘要 enrich (非破壊)', () => {
  it('freee: taxCategory で税区分を出し分け + 商品名/管理番号/メモを備考へ', () => {
    const e = entry({
      taxCategory: 'taxable_8',
      taxRate: 8,
      productName: 'コーヒー',
      receiptNo: 'R-1',
      memo: 'イベント',
    });
    const r = toAccountingCsv([e], { format: 'freee', usdcJpy: 150 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = parseRows(r.csv);
    expect(rows[1][3]).toBe('課税売上8%（軽）'); // 税区分列
    expect(rows[1][6]).toContain('コーヒー'); // 備考: 商品名
    expect(rows[1][6]).toContain('No:R-1'); // 備考: 管理番号
    expect(rows[1][6]).toContain('イベント'); // 備考: メモ
  });

  it('freee: taxCategory 未指定 (旧データ) は従来どおり 課税売上10%', () => {
    const r = toAccountingCsv([entry()], { format: 'freee', usdcJpy: 150 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(parseRows(r.csv)[1][3]).toBe('課税売上10%');
  });

  it('弥生: 貸方税区分 (idx 13) を taxCategory で出し分け', () => {
    const r = toAccountingCsv([entry({ taxCategory: 'tax_free' })], {
      format: 'yayoi',
      usdcJpy: 150,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(parseRows(r.csv)[0][13]).toBe('非課税売上'); // 弥生はヘッダ無し → rows[0]=データ
  });

  it('MF: 貸方税区分を taxCategory で出し分け', () => {
    const r = toAccountingCsv([entry({ taxCategory: 'out_of_scope' })], {
      format: 'mf',
      usdcJpy: 150,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = parseRows(r.csv);
    const idx = rows[0].indexOf('貸方税区分');
    expect(rows[1][idx]).toBe('対象外');
  });
});

describe('toAccountingCsv: 複数商品カート (摘要サマリ + 代表税区分)', () => {
  it('freee 摘要に「商品 x数量」を列挙・混在税率の代表税区分は既存デフォルト', () => {
    const e = entry({
      lineItems: [
        { name: 'コーヒー', quantity: 2, unitPrice: '500', amount: '1000', taxRate: 10, taxCategory: 'taxable_10', memo: null },
        { name: 'Tシャツ', quantity: 1, unitPrice: '3000', amount: '3000', taxRate: 8, taxCategory: 'taxable_8', memo: null },
      ],
    });
    const r = toAccountingCsv([e], { format: 'freee', usdcJpy: 150 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = parseRows(r.csv);
    expect(rows[1][6]).toContain('コーヒー x2'); // 備考
    expect(rows[1][6]).toContain('Tシャツ x1');
    expect(rows[1][3]).toBe('課税売上10%'); // 混在 → 既存デフォルト
  });

  it('全行同一税率なら代表税区分は其れ (軽減8%)', () => {
    const e = entry({
      lineItems: [
        { name: 'A', quantity: 1, unitPrice: '100', amount: '100', taxRate: 8, taxCategory: 'taxable_8', memo: null },
        { name: 'B', quantity: 1, unitPrice: '200', amount: '200', taxRate: 8, taxCategory: 'taxable_8', memo: null },
      ],
    });
    const r = toAccountingCsv([e], { format: 'freee', usdcJpy: 150 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(parseRows(r.csv)[1][3]).toBe('課税売上8%（軽）');
  });

  it('明細 6 件以上 → 摘要は 5 件まで + 「ほか」', () => {
    const li = (n: number) => ({
      name: `P${n}`, quantity: 1, unitPrice: '1', amount: '1',
      taxRate: 10, taxCategory: 'taxable_10' as const, memo: null,
    });
    const e = entry({ lineItems: [li(1), li(2), li(3), li(4), li(5), li(6)] });
    const r = toAccountingCsv([e], { format: 'freee', usdcJpy: 150 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const bikou = parseRows(r.csv)[1][6];
    expect(bikou).toContain('P5 x1');
    expect(bikou).toContain('ほか');
    expect(bikou).not.toContain('P6 x1');
  });

  it('明細の税区分が全 null → entry.taxCategory に倒す (代表値)', () => {
    const e = entry({
      taxCategory: 'tax_free',
      lineItems: [
        { name: 'X', quantity: 1, unitPrice: '1', amount: '1', taxRate: null, taxCategory: null, memo: null },
      ],
    });
    const r = toAccountingCsv([e], { format: 'freee', usdcJpy: 150 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(parseRows(r.csv)[1][3]).toBe('非課税売上');
  });
});
