import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CSV_BOM,
  CSV_NEWLINE,
  historyCsvFilename,
  toCsv,
} from '@/lib/historyCsv';
import type { HistoryEntry } from '@/lib/history';

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: 'test-id',
    ts: new Date(2026, 4, 17, 9, 5, 3).getTime(),
    flow: 'batch',
    status: 'success',
    chainId: 137,
    chainSlug: 'polygon',
    asset: 'jpyc',
    tokenAddress: '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29',
    payMode: 'gasless',
    gasMode: 'customer',
    merchant: '0xMerchant',
    merchantAmount: '1000000000000000000000', // 1000 JPYC (18 decimals)
    customer: '0xCustomer',
    feeReceiver: '0xFee',
    feeAmount: '10000000000000000000', // 10 JPYC
    txHash: '0xTx',
    userOpHash: '0xUserOp',
    blockNumber: '12345',
    errorMessage: null,
    storeName: 'Test Store',
    note: '',
    ...overrides,
  };
}

describe('toCsv', () => {
  it('BOM 付きで始まる (Excel が UTF-8 自動認識)', () => {
    const csv = toCsv([]);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
  });

  it('header 行を 1 行目に置く + CRLF', () => {
    const csv = toCsv([]);
    const stripped = csv.slice(CSV_BOM.length);
    const lines = stripped.split(CSV_NEWLINE);
    // 1 行目 = header、最後は trailing CRLF 由来の空文字
    expect(lines[0]).toMatch(/^日時,ステータス,種別,/);
    expect(lines[lines.length - 1]).toBe('');
  });

  it('1 件 entry の主要 columns が出力される (decimal 化含む)', () => {
    const csv = toCsv([entry()]);
    const stripped = csv.slice(CSV_BOM.length);
    const [, row1] = stripped.split(CSV_NEWLINE);
    expect(row1).toContain('2026-05-17 09:05:03');
    expect(row1).toContain('成功');
    expect(row1).toContain('JPYC');
    // 1000000000000000000000 wei → 1000.0 (raw decimal)
    expect(row1).toContain('1000,1000000000000000000000');
    // 10 JPYC = 10000000000000000000 wei
    expect(row1).toContain('10,10000000000000000000');
    expect(row1).toContain('0xMerchant');
    expect(row1).toContain('0xCustomer');
    expect(row1).toContain('0xFee');
    expect(row1).toContain('0xTx');
    expect(row1).toContain('0xUserOp');
    expect(row1).toContain('12345');
  });

  it('USDC (6 decimals) の decimal 化', () => {
    const csv = toCsv([
      entry({
        asset: 'usdc',
        merchantAmount: '1000000', // 1 USDC
        feeAmount: '5000', // 0.005 USDC
      }),
    ]);
    expect(csv).toContain(',USDC,');
    // 1 USDC の表示と raw が並ぶ
    expect(csv).toContain(',1,1000000,');
    expect(csv).toContain(',0.005,5000,');
  });

  it('CSV escape: `,` を含む値は double-quote で囲む', () => {
    const csv = toCsv([entry({ storeName: 'お店,珈琲' })]);
    expect(csv).toContain('"お店,珈琲"');
  });

  it('CSV escape: 全角読点 (、) は CSV delimiter ではないので quote 不要', () => {
    const csv = toCsv([entry({ note: '備考、テスト' })]);
    expect(csv).toContain('備考、テスト');
    expect(csv).not.toContain('"備考、テスト"');
  });

  it('CSV escape: `"` を含む値は `""` にエスケープ + 全体 quote', () => {
    const csv = toCsv([entry({ storeName: 'He said "Hi"' })]);
    expect(csv).toContain('"He said ""Hi"""');
  });

  it('CSV escape: 改行 (\\n / \\r) を含む値は quote', () => {
    const csv = toCsv([entry({ note: 'line1\nline2' })]);
    expect(csv).toContain('"line1\nline2"');
  });

  it.each([
    ['=cmd|...', "'=cmd|..."],
    ['+SUM(1)', "'+SUM(1)"],
    ['-2+3', "'-2+3"],
    ['@HYPERLINK', "'@HYPERLINK"],
  ])(
    'CSV injection 防御: 先頭 %s → defang される',
    (input, expectedSubstring) => {
      const csv = toCsv([entry({ storeName: input })]);
      expect(csv).toContain(expectedSubstring);
    },
  );

  it('CSV injection: 通常の `=`を含まない店舗名は触らない', () => {
    const csv = toCsv([entry({ storeName: 'NormalStore' })]);
    expect(csv).toContain('NormalStore');
    expect(csv).not.toContain("'NormalStore");
  });

  it('null fields は空文字列で出力 (Excel で NULL カラムが空に見える)', () => {
    const csv = toCsv([
      entry({
        customer: null,
        feeReceiver: null,
        feeAmount: null,
        txHash: null,
        userOpHash: null,
        blockNumber: null,
        errorMessage: null,
      }),
    ]);
    // ,, が連続する箇所 (空フィールド) を含む
    expect(csv).toMatch(/,,/);
  });

  it('error entry: ステータス=エラー + errorMessage 列', () => {
    const csv = toCsv([
      entry({ status: 'error', errorMessage: 'gas underpriced' }),
    ]);
    expect(csv).toContain(',エラー,');
    expect(csv).toContain('gas underpriced');
  });

  it('reverted entry: ステータス=revert', () => {
    const csv = toCsv([entry({ status: 'reverted' })]);
    expect(csv).toContain(',revert,');
  });

  it('100 件でも 1 ms 級で出る (パフォーマンス sanity)', () => {
    const entries = Array.from({ length: 100 }, (_, i) =>
      entry({ id: `i-${i}`, storeName: `Store ${i}` }),
    );
    const t0 = performance.now();
    const csv = toCsv(entries);
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(50);
    // 100 行 + header + trailing CRLF → 101 line break + 1 (BOM)
    const lines = csv.slice(CSV_BOM.length).split(CSV_NEWLINE);
    expect(lines.length).toBe(102);
  });

  it.each(['batch', 'direct', 'standard-merchant', 'standard-fee'] as const)(
    'flow=%s の種別ラベルが日本語化される',
    (flow) => {
      const csv = toCsv([entry({ flow })]);
      // 何らかの日本語ラベルが出る
      const stripped = csv.slice(CSV_BOM.length);
      const [, row1] = stripped.split(CSV_NEWLINE);
      const kind = row1.split(',')[2];
      // CSV cell に "," が無い限り escape されないので素直に取れる
      expect(kind.length).toBeGreaterThan(0);
      expect(/[一-龯ぁ-んァ-ヶ]/.test(kind)).toBe(true);
    },
  );

  it('gasMode=null → "対象外 (通常決済)"', () => {
    const csv = toCsv([
      entry({ payMode: 'standard', gasMode: null }),
    ]);
    expect(csv).toContain('対象外 (通常決済)');
  });
});

describe('historyCsvFilename', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('openpay-history-yyyy-MM-dd.csv 形式', () => {
    const out = historyCsvFilename(new Date(2026, 4, 17));
    expect(out).toBe('openpay-history-2026-05-17.csv');
  });

  it('引数なしのときは今日の日付', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 11, 31, 23, 59, 59));
    expect(historyCsvFilename()).toBe('openpay-history-2026-12-31.csv');
  });
});
