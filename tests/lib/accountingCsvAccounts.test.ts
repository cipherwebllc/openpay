// 会計仕訳 CSV の勘定科目 (toAccountingCsv の opts.accounts)。
// - 科目を変えていないときの出力は、科目を変えられるようにする前の main (0ab09dd6) と byte まで同じ。
//   MAIN_GOLDEN は、その main の toAccountingCsv に下の GOLDEN_ENTRIES を渡した出力をそのまま写したもの
//   (新しい code どうしを比べているのではない)。
// - 科目を変えると、弥生・MF・弥生ネイティブは借方と貸方の列、freee は勘定科目の列だけが変わる。
import { describe, it, expect } from 'vitest';
import { convert, codeToString } from 'encoding-japanese';
import { toAccountingCsv, type AccountingFormat } from '@/lib/accountingCsv';
import { encodeShiftJis } from '@/lib/sjis';
import type { HistoryEntry } from '@/lib/history';

const BOM = String.fromCodePoint(0xfeff);
const CRLF = '\r\n';
const FORMATS: AccountingFormat[] = ['freee', 'yayoi', 'mf', 'yayoi-native'];

// tests/lib/accountingCsv.test.ts の fixture と同じ形。
function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    schemaVersion: 4,
    id: Math.random().toString(36),
    ts: Date.parse('2026-06-15T12:00:00+09:00'),
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

const JPYC = entry({ asset: 'jpyc', merchantAmount: '1000000000000000000000' });
const USDC_ANCHOR = entry({
  asset: 'usdc',
  merchantAmount: '6400000',
  saleAmount: '7000000',
  anchorAmount: '1500',
  anchorSymbol: 'jpyc',
  fxRateUsdcJpy: '156.32',
});
const USDC_PLAIN = entry({ asset: 'usdc', merchantAmount: '6400000', anchorAmount: null });
const REVERTED = entry({ status: 'reverted' });
const FEE_LEG = entry({ flow: 'standard-fee', status: 'success' });
const ERRORED = entry({ status: 'error' });
// 10% と 8% が混ざった取引 (税区分ごとに 2 行へ分かれる)。
const MIXED_1500 = entry({
  merchantAmount: '1500000000000000000000',
  lineItems: [
    { name: 'A', quantity: 1, unitPrice: '1000', amount: '1000', taxRate: 10, taxCategory: 'taxable_10', memo: null },
    { name: 'B', quantity: 1, unitPrice: '500', amount: '500', taxRate: 8, taxCategory: 'taxable_8', memo: null },
  ],
});
const ENRICHED = entry({
  taxCategory: 'taxable_8',
  taxRate: 8,
  storeName: '珈琲店',
  productName: 'コーヒー',
  receiptNo: 'R-1',
  memo: 'イベント',
});
const INJECTION = entry({ asset: 'jpyc', storeName: '=HYPERLINK("evil")' });

const GOLDEN_ENTRIES = [
  JPYC,
  USDC_ANCHOR,
  USDC_PLAIN,
  REVERTED,
  FEE_LEG,
  ERRORED,
  MIXED_1500,
  ENRICHED,
  INJECTION,
];
const GOLDEN_OPTS = { usdcJpy: 150 };

// main (0ab09dd6) の toAccountingCsv(GOLDEN_ENTRIES, { format, usdcJpy: 150 }) の出力。行ごとの文字列のまま。
// 作り直さない (今の code の出力で上書きすると、main と同じかどうかを確かめられなくなる)。
const MAIN_GOLDEN: Record<AccountingFormat, string> = {
  freee:
    BOM + [
      '収支区分,発生日,勘定科目,税区分,金額,取引先,備考',
      '収入,2026-06-15,売上高,課税売上10%,1000,0xCustomer,JPYC/polygon / tx:0xdddd…dddd',
      '収入,2026-06-15,売上高,課税売上10%,1500,0xCustomer,USDC/polygon / tx:0xdddd…dddd / 元:1500 JPYC @156.32',
      '収入,2026-06-15,売上高,課税売上10%,960,0xCustomer,USDC/polygon / tx:0xdddd…dddd / 概算@150',
      '収入,2026-06-15,売上高,課税売上10%,1000,0xCustomer,A x1 / B x1 / JPYC/polygon / tx:0xdddd…dddd / 税区分別 1/2',
      '収入,2026-06-15,売上高,課税売上8%（軽）,500,0xCustomer,A x1 / B x1 / JPYC/polygon / tx:0xdddd…dddd / 税区分別 2/2',
      '収入,2026-06-15,売上高,課税売上8%（軽）,1000,珈琲店,コーヒー x1 / JPYC/polygon / tx:0xdddd…dddd / No:R-1 / イベント',
      '収入,2026-06-15,売上高,課税売上10%,1000,"\'=HYPERLINK(""evil"")",JPYC/polygon / tx:0xdddd…dddd',
    ].join(CRLF) + CRLF,
  yayoi:
    BOM + [
      '2000,1,,2026/06/15,売掛金,,,対象外,1000,0,売上高,,,課税売上込10%,1000,0,JPYC/polygon / tx:0xdddd…dddd,,,0,,,0,0,no',
      '2000,2,,2026/06/15,売掛金,,,対象外,1500,0,売上高,,,課税売上込10%,1500,0,USDC/polygon / tx:0xdddd…dddd / 元:1500 JPYC @156.32,,,0,,,0,0,no',
      '2000,3,,2026/06/15,売掛金,,,対象外,960,0,売上高,,,課税売上込10%,960,0,USDC/polygon / tx:0xdddd…dddd / 概算@150,,,0,,,0,0,no',
      '2000,4,,2026/06/15,売掛金,,,対象外,1000,0,売上高,,,課税売上込10%,1000,0,A x1 / B x1 / JPYC/polygon / tx:0xdddd…dddd / 税区分別 1/2,,,0,,,0,0,no',
      '2000,5,,2026/06/15,売掛金,,,対象外,500,0,売上高,,,課税売上込8%(軽),500,0,A x1 / B x1 / JPYC/polygon / tx:0xdddd…dddd / 税区分別 2/2,,,0,,,0,0,no',
      '2000,6,,2026/06/15,売掛金,,,対象外,1000,0,売上高,,,課税売上込8%(軽),1000,0,コーヒー x1 / JPYC/polygon / tx:0xdddd…dddd / No:R-1 / イベント,,,0,,,0,0,no',
      '2000,7,,2026/06/15,売掛金,,,対象外,1000,0,売上高,,,課税売上込10%,1000,0,JPYC/polygon / tx:0xdddd…dddd,,,0,,,0,0,no',
    ].join(CRLF) + CRLF,
  mf:
    BOM + [
      '取引No,取引日,借方勘定科目,借方補助科目,借方部門,借方税区分,借方金額(円),借方税額,貸方勘定科目,貸方補助科目,貸方部門,貸方税区分,貸方金額(円),貸方税額,摘要',
      '1,2026/06/15,売掛金,,,対象外,1000,0,売上高,,,課税売上10%,1000,0,JPYC/polygon / tx:0xdddd…dddd',
      '2,2026/06/15,売掛金,,,対象外,1500,0,売上高,,,課税売上10%,1500,0,USDC/polygon / tx:0xdddd…dddd / 元:1500 JPYC @156.32',
      '3,2026/06/15,売掛金,,,対象外,960,0,売上高,,,課税売上10%,960,0,USDC/polygon / tx:0xdddd…dddd / 概算@150',
      '4,2026/06/15,売掛金,,,対象外,1000,0,売上高,,,課税売上10%,1000,0,A x1 / B x1 / JPYC/polygon / tx:0xdddd…dddd / 税区分別 1/2',
      '5,2026/06/15,売掛金,,,対象外,500,0,売上高,,,課税売上8%(軽),500,0,A x1 / B x1 / JPYC/polygon / tx:0xdddd…dddd / 税区分別 2/2',
      '6,2026/06/15,売掛金,,,対象外,1000,0,売上高,,,課税売上8%(軽),1000,0,コーヒー x1 / JPYC/polygon / tx:0xdddd…dddd / No:R-1 / イベント',
      '7,2026/06/15,売掛金,,,対象外,1000,0,売上高,,,課税売上10%,1000,0,JPYC/polygon / tx:0xdddd…dddd',
    ].join(CRLF) + CRLF,
  'yayoi-native':
    [
      '2000,1,,2026/06/15,売掛金,,,対象外,1000,0,売上高,,,課税売上込10%,1000,0,JPYC/polygon / tx:0xdddd…dddd,,,0,,,0,0,no',
      '2000,2,,2026/06/15,売掛金,,,対象外,1500,0,売上高,,,課税売上込10%,1500,0,USDC/polygon / tx:0xdddd…dddd / 元:1500 JPYC @156.32,,,0,,,0,0,no',
      '2000,3,,2026/06/15,売掛金,,,対象外,960,0,売上高,,,課税売上込10%,960,0,USDC/polygon / tx:0xdddd…dddd / 概算@150,,,0,,,0,0,no',
      '2000,4,,2026/06/15,売掛金,,,対象外,1000,0,売上高,,,課税売上込10%,1000,0,A x1 / B x1 / JPYC/polygon / tx:0xdddd…dddd / 税区分別 1/2,,,0,,,0,0,no',
      '2000,5,,2026/06/15,売掛金,,,対象外,500,0,売上高,,,課税売上込8%(軽),500,0,A x1 / B x1 / JPYC/polygon / tx:0xdddd…dddd / 税区分別 2/2,,,0,,,0,0,no',
      '2000,6,,2026/06/15,売掛金,,,対象外,1000,0,売上高,,,課税売上込8%(軽),1000,0,コーヒー x1 / JPYC/polygon / tx:0xdddd…dddd / No:R-1 / イベント,,,0,,,0,0,no',
      '2000,7,,2026/06/15,売掛金,,,対象外,1000,0,売上高,,,課税売上込10%,1000,0,JPYC/polygon / tx:0xdddd…dddd,,,0,,,0,0,no',
    ].join(CRLF) + CRLF,
};

function csvOf(format: AccountingFormat, accounts?: unknown): string {
  const r = toAccountingCsv(GOLDEN_ENTRIES, {
    format,
    ...GOLDEN_OPTS,
    // 画面の検証を通っていない値 (型の合わない値を含む) を直接渡す場合も試すので unknown で受ける。
    ...(accounts === undefined ? {} : { accounts: accounts as { debit: string; credit: string } }),
  });
  expect(r.ok).toBe(true);
  return r.ok ? r.csv : '';
}

/** データ行をセルに分ける (この fixture のセルの中のカンマは、引用符で囲まれた取引先の 1 つだけ)。 */
function dataRows(format: AccountingFormat, csv: string): string[][] {
  const body = csv.startsWith(BOM) ? csv.slice(BOM.length) : csv;
  const lines = body.split(CRLF).filter((line) => line.length > 0);
  const hasHeader = format === 'freee' || format === 'mf';
  return lines.slice(hasHeader ? 1 : 0).map((line) => line.split(','));
}

// 形式ごとの勘定科目の列 (freee は単式で借方の列が無い)。
const ACCOUNT_COLUMNS: Record<AccountingFormat, { debit: number | null; credit: number }> = {
  freee: { debit: null, credit: 2 },
  yayoi: { debit: 4, credit: 10 },
  mf: { debit: 2, credit: 8 },
  'yayoi-native': { debit: 4, credit: 10 },
};

describe('toAccountingCsv: 科目を変えていないときの出力は main と byte まで同じ', () => {
  it('fixture は 6 件の売上 (うち 1 件は税区分で 2 行に分かれる) = 7 行', () => {
    for (const format of FORMATS) {
      expect(dataRows(format, MAIN_GOLDEN[format])).toHaveLength(7);
    }
  });

  it.each(FORMATS)('%s: accounts を渡さない', (format) => {
    expect(csvOf(format)).toBe(MAIN_GOLDEN[format]);
  });

  it.each(FORMATS)('%s: 既定の科目の名前 (売掛金 / 売上高) を渡す', (format) => {
    expect(csvOf(format, { debit: '売掛金', credit: '売上高' })).toBe(MAIN_GOLDEN[format]);
  });

  it.each(FORMATS)('%s: 保存の形の既定 (空文字) を渡す', (format) => {
    expect(csvOf(format, { debit: '', credit: '' })).toBe(MAIN_GOLDEN[format]);
  });

  it.each(FORMATS)('%s: 行数・件数・文字コードの結果も変わらない', (format) => {
    const base = toAccountingCsv(GOLDEN_ENTRIES, { format, ...GOLDEN_OPTS });
    const custom = toAccountingCsv(GOLDEN_ENTRIES, {
      format,
      ...GOLDEN_OPTS,
      accounts: { debit: '現金', credit: '売上' },
    });
    expect(base).toMatchObject({ ok: true, rowCount: 6, approxCount: 1 });
    expect(custom).toMatchObject({ ok: true, rowCount: 6, approxCount: 1 });
    if (base.ok && custom.ok) expect(custom.charset).toBe(base.charset);
  });
});

describe('toAccountingCsv: 科目を変える', () => {
  const CUSTOM = { debit: '現金', credit: '売上' };

  it.each(['yayoi', 'mf', 'yayoi-native'] as const)(
    '%s: 借方と貸方の列が、分割された行を含む全行で変わる',
    (format) => {
      const rows = dataRows(format, csvOf(format, CUSTOM));
      const cols = ACCOUNT_COLUMNS[format];
      expect(rows).toHaveLength(7);
      expect(rows.map((row) => row[cols.debit as number])).toEqual(Array(7).fill('現金'));
      expect(rows.map((row) => row[cols.credit])).toEqual(Array(7).fill('売上'));
    },
  );

  it('freee: 勘定科目の列は売上の科目 (貸方) だけ・借方の名前はどこにも出ない', () => {
    const csv = csvOf('freee', CUSTOM);
    const rows = dataRows('freee', csv);
    expect(rows).toHaveLength(7);
    expect(rows.map((row) => row[2])).toEqual(Array(7).fill('売上'));
    expect(csv).not.toContain('現金');
    // 借方だけを変えても freee の出力は変わらない。
    expect(csvOf('freee', { debit: '現金', credit: '' })).toBe(MAIN_GOLDEN.freee);
  });

  it.each(FORMATS)('%s: 変わるのは勘定科目の名前だけ (税区分・金額・摘要・番号はそのまま)', (format) => {
    // main の出力の中の科目名だけを置き換えたものと byte まで同じ (fixture のほかのセルに科目名は無い)。
    const expected = MAIN_GOLDEN[format].replaceAll('売掛金', '現金').replaceAll('売上高', '売上');
    expect(expected).not.toBe(MAIN_GOLDEN[format]);
    expect(csvOf(format, CUSTOM)).toBe(expected);
  });

  it.each(['yayoi', 'mf'] as const)('%s: 片方だけを変えると、もう片方は既定の科目のまま', (format) => {
    const cols = ACCOUNT_COLUMNS[format];
    const debitOnly = dataRows(format, csvOf(format, { debit: '現金', credit: '' }));
    expect(debitOnly.map((row) => row[cols.debit as number])).toEqual(Array(7).fill('現金'));
    expect(debitOnly.map((row) => row[cols.credit])).toEqual(Array(7).fill('売上高'));
    const creditOnly = dataRows(format, csvOf(format, { debit: '', credit: '売上' }));
    expect(creditOnly.map((row) => row[cols.debit as number])).toEqual(Array(7).fill('売掛金'));
    expect(creditOnly.map((row) => row[cols.credit])).toEqual(Array(7).fill('売上'));
  });

  it('前後の空白と NFC は入口でそろえる (画面を通らない呼び出しでも同じ名前になる)', () => {
    const nfdGa = String.fromCodePoint(0x30ab, 0x3099);
    const rows = dataRows('yayoi', csvOf('yayoi', { debit: ' 現金 ', credit: `${nfdGa}ス売上` }));
    expect(rows[0][4]).toBe('現金');
    expect(rows[0][10]).toBe('ガス売上');
  });

  it('弥生ネイティブ: Shift_JIS の byte にして戻しても、変えた科目が借方と貸方の列にある', async () => {
    const bytes = await encodeShiftJis(csvOf('yayoi-native', CUSTOM));
    const back = codeToString(convert(Array.from(bytes), 'UNICODE', 'SJIS'));
    const rows = back
      .split(CRLF)
      .filter((line) => line.length > 0)
      .map((line) => line.split(','));
    expect(rows).toHaveLength(7);
    expect(rows.map((row) => row[4])).toEqual(Array(7).fill('現金'));
    expect(rows.map((row) => row[10])).toEqual(Array(7).fill('売上'));
  });
});

describe('toAccountingCsv: 検証を通らない名前を直接渡しても、CSV には既定の科目が出る', () => {
  const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);

  it.each([
    ['先頭の数式の字 (=)', '=HYPERLINK("evil")'],
    ['先頭の数式の字 (+)', '+売上'],
    ['先頭の数式の字 (-)', '-売上'],
    ['先頭の数式の字 (@)', '@SUM(A1)'],
    ['カンマ', '売上,高'],
    ['引用符', '売上"高'],
    ['改行', '売上\r\n2000,9,,2026/06/15,現金'],
    ['ゼロ幅の空白', `売上${ZERO_WIDTH_SPACE}高`],
    ['長すぎる (13 字)', 'あ'.repeat(13)],
    ['空白だけ', '   '],
    ['文字列でない', 42],
    ['null', null],
  ])('%s', (_label, bad) => {
    for (const format of FORMATS) {
      expect(csvOf(format, { debit: bad, credit: bad })).toBe(MAIN_GOLDEN[format]);
    }
  });

  it.each([[null], ['売上'], [['現金', '売上']], [7]])('accounts が object でない (%j)', (bad) => {
    for (const format of FORMATS) {
      expect(csvOf(format, bad)).toBe(MAIN_GOLDEN[format]);
    }
  });

  it('項目ごとに見る: 通らない借方は既定の科目・通る貸方は変えた名前', () => {
    const rows = dataRows('mf', csvOf('mf', { debit: '=現金', credit: '売上' }));
    expect(rows.map((row) => row[2])).toEqual(Array(7).fill('売掛金'));
    expect(rows.map((row) => row[8])).toEqual(Array(7).fill('売上'));
  });
});
