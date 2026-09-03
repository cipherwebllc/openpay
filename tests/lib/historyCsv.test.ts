import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CSV_BOM,
  CSV_NEWLINE,
  historyCsvFilename,
  toCsv,
} from '@/lib/historyCsv';
import { entryTotals, type HistoryEntry } from '@/lib/history';
import { toLineItemsCsv } from '@/lib/lineItemsCsv';

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    schemaVersion: 1,
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
    provider: null,
    circlePaymasterAddress: null,
    circlePaymasterNetUsdc: null,
    circleVerification: null,
    saleAmount: null,
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

  it('v3: 売上総額 / ネットワーク手数料相当額 / 内訳バージョン 列を出力 (分離済)', () => {
    const csv = toCsv([
      entry({
        saleAmount: '1234000000000000000000', // 1234 (着金と区別できる値)
        networkFeeEquivalent: '4000000000000000000', // 4
        feeAmount: '0',
        feeBreakdownVersion: 1,
      }),
    ]);
    // ヘッダに新列 + 既存列の "raw wei" → "raw" 修正 (USDC は 6dp で wei 表記は不正確)
    expect(csv).toContain('売上総額(decimal)');
    expect(csv).toContain('ネットワーク手数料相当額(decimal)');
    expect(csv).toContain('内訳バージョン');
    expect(csv).toContain('金額(raw)');
    expect(csv).not.toContain('raw wei');
    // 値: 売上総額 raw / 網手数料相当額 raw / 内訳=分離済
    expect(csv).toContain('1234000000000000000000');
    expect(csv).toContain('4000000000000000000');
    expect(csv).toContain('分離済');
  });

  it('v3: legacy(feeBreakdownVersion=0) は内訳バージョン列で「内訳不明 (旧データ)」', () => {
    const csv = toCsv([entry({ feeBreakdownVersion: 0 })]);
    expect(csv).toContain('内訳不明 (旧データ)');
  });

  it('v4: 異通貨建ての anchor (元価格建て + 通貨 + FX レート) 列を出力', () => {
    const csv = toCsv([
      entry({
        asset: 'usdc', // USDC で受領したが
        anchorAmount: '1500', // 元は 1500 JPYC 建て
        anchorSymbol: 'jpyc',
        fxRateUsdcJpy: '156.32',
      }),
    ]);
    // 新ヘッダ
    expect(csv).toContain('請求建て金額');
    expect(csv).toContain('請求建て通貨');
    expect(csv).toContain('FXレート(USDC/JPY)');
    // anchor は固定列 (v5 列がさらに後ろに追加されるため header 相対で検証)。
    const lines = csv.slice(CSV_BOM.length).split(CSV_NEWLINE);
    const header = lines[0].split(',');
    const cells = lines[1].split(',');
    const at = (name: string) => cells[header.indexOf(name)];
    expect(at('請求建て金額')).toBe('1500');
    expect(at('請求建て通貨')).toBe('JPYC');
    expect(at('FXレート(USDC/JPY)')).toBe('156.32');
  });

  it('v4: 通常決済 (anchor 無し) は anchor 列が空', () => {
    const lines = toCsv([entry()]).slice(CSV_BOM.length).split(CSV_NEWLINE);
    const header = lines[0].split(',');
    const cells = lines[1].split(',');
    const at = (name: string) => cells[header.indexOf(name)];
    expect(at('請求建て金額')).toBe('');
    expect(at('請求建て通貨')).toBe('');
    expect(at('FXレート(USDC/JPY)')).toBe('');
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

  it('1000 件 (HISTORY_MAX_ENTRIES boundary) でも 200ms 以内で出力できる', () => {
    function buildEntry(id: string): HistoryEntry {
      return {
        schemaVersion: 1,
        id,
        ts: 1_700_000_000_000,
        flow: 'batch',
        status: 'success',
        chainId: 137,
        chainSlug: 'polygon',
        asset: 'jpyc',
        tokenAddress: '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29',
        payMode: 'gasless',
        gasMode: 'customer',
        merchant: '0x1111111111111111111111111111111111111111',
        merchantAmount: '500000000000000000000',
        customer: '0x9999999999999999999999999999999999999999',
        feeReceiver: '0x2222222222222222222222222222222222222222',
        feeAmount: '5000000000000000000',
        txHash: '0xaaaa',
        userOpHash: '0xbbbb',
        blockNumber: '1',
        errorMessage: null,
        storeName: 'お店, テスト',
        note: 'a'.repeat(100),
        provider: null,
        circlePaymasterAddress: null,
        circlePaymasterNetUsdc: null,
        circleVerification: null,
        saleAmount: null,
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
      };
    }
    const entries = Array.from({ length: 1000 }, (_, i) =>
      buildEntry(`b-${i}`),
    );
    const t0 = performance.now();
    const csv = toCsv(entries);
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(200);
    // 1000 行 + header + trailing CRLF
    const lines = csv.slice(CSV_BOM.length).split(CSV_NEWLINE);
    expect(lines.length).toBe(1002);
    // 1 entry ~ 500-800 bytes → 1000 件で 500KB-800KB (LocalStorage 5MB 上限の 16% 内)
    expect(csv.length).toBeLessThan(1_000_000);
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

// RFC-4180 適合の最小 CSV parser。round-trip 整合性検証専用。
// quoted field 内の "" → "、改行 / カンマは quote 内では literal。
function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuote = false;
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (inQuote) {
      if (c === '"' && input[i + 1] === '"') {
        cell += '"';
        i += 2;
        continue;
      }
      if (c === '"') {
        inQuote = false;
        i += 1;
        continue;
      }
      cell += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuote = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      row.push(cell);
      cell = '';
      i += 1;
      continue;
    }
    if (c === '\r' && input[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 2;
      continue;
    }
    cell += c;
    i += 1;
  }
  // 末尾 cell / row のフラッシュ (trailing CRLF が無い場合)
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

describe('CSV round-trip 整合性 (escape の逆 parse)', () => {
  function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
    return {
      schemaVersion: 1,
      id: 'rt',
      ts: new Date(2026, 4, 17, 9, 5, 3).getTime(),
      flow: 'batch',
      status: 'success',
      chainId: 137,
      chainSlug: 'polygon',
      asset: 'jpyc',
      tokenAddress: '0xToken',
      payMode: 'gasless',
      gasMode: 'customer',
      merchant: '0xMerchant',
      merchantAmount: '1000000000000000000000',
      customer: '0xCustomer',
      feeReceiver: '0xFee',
      feeAmount: '10000000000000000000',
      txHash: '0xTx',
      userOpHash: '0xUserOp',
      blockNumber: '12345',
      errorMessage: null,
      storeName: '',
      note: '',
      provider: null,
      circlePaymasterAddress: null,
      circlePaymasterNetUsdc: null,
      circleVerification: null,
      saleAmount: null,
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

  it('単純 entry: BOM 除去 + parse すると header + 1 行になる', () => {
    const csv = toCsv([entry()]);
    const stripped = csv.slice(CSV_BOM.length);
    const rows = parseCsv(stripped);
    // 末尾 CRLF 分の空 row も含む可能性。空でない rows だけ取る
    const nonEmpty = rows.filter((r) => r.some((c) => c.length > 0));
    expect(nonEmpty).toHaveLength(2); // header + 1 data row
    // header 数 = data row 数
    expect(nonEmpty[0].length).toBe(nonEmpty[1].length);
  });

  it('カンマ含む store name: 元の値に復元される', () => {
    const csv = toCsv([entry({ storeName: 'お店,珈琲, 限定' })]);
    const rows = parseCsv(csv.slice(CSV_BOM.length));
    const data = rows[1];
    // header の "店舗名" は index 3 (日時, ステータス, 種別, 店舗名, ...)
    expect(data[3]).toBe('お店,珈琲, 限定');
  });

  it('ダブルクオート含む note: 元の値に復元される', () => {
    const csv = toCsv([entry({ note: 'He said "Hi" today' })]);
    const rows = parseCsv(csv.slice(CSV_BOM.length));
    const data = rows[1];
    // header の "メモ" は index 19
    expect(data[19]).toBe('He said "Hi" today');
  });

  it('改行 (\\n) 含む note: 元の値に復元される', () => {
    const csv = toCsv([entry({ note: 'line1\nline2\nline3' })]);
    const rows = parseCsv(csv.slice(CSV_BOM.length));
    expect(rows[1][19]).toBe('line1\nline2\nline3');
  });

  it('CRLF を含む note (Windows 改行): 元の値に復元される', () => {
    const csv = toCsv([entry({ note: 'win\r\nstyle' })]);
    const rows = parseCsv(csv.slice(CSV_BOM.length));
    expect(rows[1][19]).toBe('win\r\nstyle');
  });

  it('CSV injection: storeName="=cmd|..." → defang prefix `\'` が CSV 上に残る', () => {
    const csv = toCsv([entry({ storeName: '=HYPERLINK("evil")' })]);
    const rows = parseCsv(csv.slice(CSV_BOM.length));
    // round-trip では prefix " ' " は残る (Excel の formula evaluator 抑止が目的)
    expect(rows[1][3]).toBe('\'=HYPERLINK("evil")');
  });

  it('複合: カンマ + クオート + 改行 + injection prefix を 1 つの値に混ぜる', () => {
    const tricky = '=cmd, "quoted"\nline2';
    const csv = toCsv([entry({ note: tricky })]);
    const rows = parseCsv(csv.slice(CSV_BOM.length));
    // injection prefix が defang される
    expect(rows[1][19]).toBe(`'${tricky}`);
  });

  it('100 件で全 fields が正しく round-trip', () => {
    const entries = Array.from({ length: 100 }, (_, i) =>
      entry({
        id: `i-${i}`,
        storeName: `お店 #${i}, テスト`,
        note: i % 2 === 0 ? `multi\nline ${i}` : '',
        merchantAmount: String(BigInt(1000 + i) * 10n ** 18n),
        feeAmount: String(BigInt(10 + i) * 10n ** 17n),
      }),
    );
    const csv = toCsv(entries);
    const rows = parseCsv(csv.slice(CSV_BOM.length));
    const data = rows
      .slice(1)
      .filter((r) => r.some((c) => c.length > 0));
    expect(data).toHaveLength(100);
    // ランダム 3 件で値を sample 検証
    [0, 50, 99].forEach((idx) => {
      // index 3 = 店舗名、index 19 = メモ、index 6 = 金額 raw wei
      expect(data[idx][3]).toBe(entries[idx].storeName);
      expect(data[idx][19]).toBe(entries[idx].note);
      expect(data[idx][6]).toBe(entries[idx].merchantAmount);
    });
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

describe('CSV: Circle Paymaster 監査列 (Phase1)', () => {
  it('circle entry は Paymaster種別 / ガス代USDC / 検証列を出力する', () => {
    const e = entry({
      asset: 'usdc',
      provider: 'circle',
      circlePaymasterAddress: '0x3BA9A96eE3eFf3A69E2B18886AcF52027EFF8966',
      circlePaymasterNetUsdc: '9000', // 6dp → 0.009
      circleVerification: 'client-reported',
    });
    const csv = toCsv([e]);
    const rows = parseCsv(csv.slice(CSV_BOM.length)).filter((r) =>
      r.some((c) => c.length > 0),
    );
    const header = rows[0];
    const row = rows[1];
    const iProvider = header.indexOf('Paymaster種別');
    const iNet = header.indexOf('Circleガス代USDC(decimal)');
    const iVerif = header.indexOf('Circleガス代検証');
    expect(iProvider).toBeGreaterThan(-1);
    expect(row[iProvider]).toBe('Circle');
    expect(row[iNet]).toBe('0.009');
    expect(row[iVerif]).toBe('client 申告 (未検証)');
  });

  it('非 circle entry は Circle 列が空', () => {
    const csv = toCsv([entry({ provider: null })]);
    const rows = parseCsv(csv.slice(CSV_BOM.length)).filter((r) =>
      r.some((c) => c.length > 0),
    );
    const header = rows[0];
    const row = rows[1];
    expect(row[header.indexOf('Paymaster種別')]).toBe('');
    expect(row[header.indexOf('Circleガス代USDC(decimal)')]).toBe('');
    expect(row[header.indexOf('Circleガス代検証')]).toBe('');
  });
});

describe('CSV v5: 記帳補助メタ列 (商品名/税/明細・末尾追加で非破壊)', () => {
  function cellsByHeader(csv: string): (name: string) => string {
    const rows = parseCsv(csv.slice(CSV_BOM.length)).filter((r) =>
      r.some((c) => c.length > 0),
    );
    const header = rows[0];
    const row = rows[1];
    return (name: string) => row[header.indexOf(name)];
  }

  it('JPYC: 商品名/メモ/税率/税区分/税額/管理番号/数量/単価/明細 を出力', () => {
    const csv = toCsv([
      entry({
        productName: 'コーヒー',
        memo: 'イベント販売',
        taxRate: 10,
        taxCategory: 'taxable_10',
        receiptNo: 'R-1',
        merchantAmount: '1100000000000000000000', // 1100 JPYC (税込) → 内税 100
        lineItems: [
          {
            name: 'コーヒー',
            quantity: 2,
            unitPrice: '550',
            amount: '1100',
            taxRate: 10,
            taxCategory: 'taxable_10',
            memo: null,
          },
        ],
      }),
    ]);
    const at = cellsByHeader(csv);
    expect(at('商品名')).toBe('コーヒー');
    expect(at('会計メモ')).toBe('イベント販売');
    expect(at('税率(%)')).toBe('10');
    expect(at('税区分')).toBe('課税10%');
    expect(at('税額(円)')).toBe('100');
    expect(at('管理番号')).toBe('R-1');
    expect(at('数量')).toBe('2');
    expect(at('単価')).toBe('550');
    expect(at('明細')).toBe('コーヒー×2@550');
  });

  it('店舗負担手数料の JPYC 税額は saleAmount (gross) から算出', () => {
    const csv = toCsv([
      entry({
        merchantAmount: '990000000000000000000', // net なら内税 90
        saleAmount: '1100000000000000000000', // gross 1100 なら内税 100
        taxRate: 10,
        taxCategory: 'taxable_10',
      }),
    ]);
    expect(cellsByHeader(csv)('税額(円)')).toBe('100');
  });

  it('standard-fee leg は taxRate があっても税額セルを空にする', () => {
    const csv = toCsv([
      entry({
        flow: 'standard-fee',
        merchantAmount: '11000000000000000000',
        saleAmount: null,
        taxRate: 10,
        taxCategory: 'taxable_10',
      }),
    ]);
    const at = cellsByHeader(csv);
    expect(at('税率(%)')).toBe('10');
    expect(at('税額(円)')).toBe('');
  });

  it('USDC anchor 付き: 税額は anchor 円から算出 (rate 非依存)', () => {
    const csv = toCsv([
      entry({
        asset: 'usdc',
        merchantAmount: '6400000',
        anchorAmount: '1100',
        anchorSymbol: 'jpyc',
        fxRateUsdcJpy: '156.32',
        taxRate: 10,
        taxCategory: 'taxable_10',
      }),
    ]);
    expect(cellsByHeader(csv)('税額(円)')).toBe('100');
  });

  it('USDC anchor 無し + usdcJpy 無し: 税額は空 (強制 JPY 変換しない)', () => {
    const csv = toCsv([
      entry({
        asset: 'usdc',
        merchantAmount: '6400000',
        anchorAmount: null,
        taxRate: 10,
        taxCategory: 'taxable_10',
      }),
    ]);
    expect(cellsByHeader(csv)('税額(円)')).toBe('');
  });

  it('USDC anchor 無し + usdcJpy 指定: 現レートで税額算出', () => {
    const csv = toCsv(
      [
        entry({
          asset: 'usdc',
          merchantAmount: '6400000', // 6.4 USDC
          anchorAmount: null,
          taxRate: 10,
          taxCategory: 'taxable_10',
        }),
      ],
      { usdcJpy: 156.25 }, // 6.4 * 156.25 = 1000円 → 内税 91
    );
    expect(cellsByHeader(csv)('税額(円)')).toBe('91');
  });

  // 混在税率 (10% と 8%) の税額は「行ごとに計算して合算」が正。以前は entry 単位の単一税率を
  // 合計額に掛けていたため、明細CSV (lineItemsCsv) / 仕訳CSV / 履歴表示 (entryTotals) と食い違っていた。
  const mixedLineItems = [
    {
      name: 'コーヒー',
      quantity: 2,
      unitPrice: '500',
      amount: '1000',
      taxRate: 10,
      taxCategory: 'taxable_10' as const,
      memo: null,
    },
    {
      name: '食品',
      quantity: 1,
      unitPrice: '3000',
      amount: '3000',
      taxRate: 8,
      taxCategory: 'taxable_8' as const,
      memo: null,
    },
  ];

  it('混在税率: 税額(円) は行別税額の合計 (10% 91 + 8% 222 = 313)', () => {
    const csv = toCsv([
      entry({
        merchantAmount: '4000000000000000000000', // 4000 JPYC
        saleAmount: '4000000000000000000000',
        taxRate: null, // 明細が税率を持つ (entry 単位の税率は無い)
        lineItems: mixedLineItems,
      }),
    ]);
    expect(cellsByHeader(csv)('税額(円)')).toBe('313');
  });

  it('混在税率: entry 単位の税率が残っていても行別合計を優先する', () => {
    const csv = toCsv([
      entry({
        merchantAmount: '4000000000000000000000',
        saleAmount: '4000000000000000000000',
        taxRate: 10, // 旧実装ならこの単一税率で 4000 → 364 になっていた
        taxCategory: 'taxable_10',
        lineItems: mixedLineItems,
      }),
    ]);
    const at = cellsByHeader(csv);
    expect(at('税率(%)')).toBe('10'); // 税率列は entry 値のまま (列の意味は不変)
    expect(at('税額(円)')).toBe('313');
  });

  it('混在税率: 明細CSV / entryTotals の税額と一致する', () => {
    const e = entry({
      merchantAmount: '4000000000000000000000',
      saleAmount: '4000000000000000000000',
      taxRate: null,
      lineItems: mixedLineItems,
    });
    const perLine = toLineItemsCsv([e]);
    expect(perLine.ok).toBe(true);
    if (!perLine.ok) return;
    const lineTaxSum = parseCsv(perLine.csv.slice(CSV_BOM.length))
      .slice(1)
      .filter((r) => r.length > 1)
      .reduce((sum, r) => sum + Number(r[11]), 0);

    expect(cellsByHeader(toCsv([e]))('税額(円)')).toBe(String(lineTaxSum));
    expect(entryTotals(e).totalTax).toBe(String(lineTaxSum));
  });

  it('単一税率の明細は従来値のまま (回帰): gross 按分でも 1100 → 100', () => {
    const csv = toCsv([
      entry({
        merchantAmount: '990000000000000000000', // net 990
        saleAmount: '1100000000000000000000', // gross 1100
        taxRate: 10,
        taxCategory: 'taxable_10',
        lineItems: [
          {
            name: 'コーヒー',
            quantity: 1,
            unitPrice: '990',
            amount: '990',
            taxRate: 10,
            taxCategory: 'taxable_10',
            memo: null,
          },
        ],
      }),
    ]);
    expect(cellsByHeader(csv)('税額(円)')).toBe('100');
  });

  it('旧 entry (記帳補助メタ無し) は v5 列が空 (後方互換)', () => {
    const at = cellsByHeader(toCsv([entry()]));
    expect(at('商品名')).toBe('');
    expect(at('税率(%)')).toBe('');
    expect(at('税区分')).toBe('');
    expect(at('税額(円)')).toBe('');
    expect(at('明細')).toBe('');
  });
});
