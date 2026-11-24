// 会計仕訳 CSV の勘定科目の名前の検証 (lib/accountingAccounts.ts)。
// 画面・保存・CSV の生成が同じ検証を使うので、境はここで固定する。
import { describe, it, expect } from 'vitest';
import {
  ACCOUNT_NAME_MAX_CHARS,
  DEFAULT_ACCOUNTING_ACCOUNTS,
  checkAccountName,
  normalizeAccountingAccounts,
  resolveAccountingAccounts,
} from '@/lib/accountingAccounts';
import { escapeCsvCell, startsWithCsvFormulaChar } from '@/lib/csv';

// 見えない字は source に直接書かず、code point から作る (editor や整形で消えない・化けない)。
const cp = (...points: number[]) => String.fromCodePoint(...points);
const FULL_WIDTH_SPACE = cp(0x3000);
const ZERO_WIDTH_SPACE = cp(0x200b);
const KICHI = cp(0x20bb7); // 𠮷 (surrogate pair で表す 1 字)

describe('checkAccountName', () => {
  it('上限は 12 字', () => {
    expect(ACCOUNT_NAME_MAX_CHARS).toBe(12);
  });

  it('通る名前は value にそのまま返す', () => {
    expect(checkAccountName('現金')).toEqual({ ok: true, value: '現金' });
    expect(checkAccountName('Sales 2026')).toEqual({ ok: true, value: 'Sales 2026' });
  });

  it('前後の空白 (半角・全角・tab・改行) を除く', () => {
    expect(checkAccountName(`  ${FULL_WIDTH_SPACE}現金${FULL_WIDTH_SPACE}\t\r\n`)).toEqual({
      ok: true,
      value: '現金',
    });
    // 途中の空白は名前の一部として残す。
    expect(checkAccountName(' 売上 高 ')).toEqual({ ok: true, value: '売上 高' });
  });

  it.each([['', '空文字'], ['   ', '半角の空白'], [FULL_WIDTH_SPACE.repeat(2), '全角の空白'], ['\t\n', 'tab と改行']])(
    '空 (%j・%s) は empty',
    (raw) => {
      expect(checkAccountName(raw)).toEqual({ ok: false, reason: 'empty' });
    },
  );

  it('NFC にそろえる (NFD の「ガ」= カ + 濁点)', () => {
    const nfd = `${cp(0x30ab, 0x3099)}ス代`;
    expect(nfd).toHaveLength(4);
    const r = checkAccountName(nfd);
    expect(r).toEqual({ ok: true, value: 'ガス代' });
    if (r.ok) expect(r.value).toHaveLength(3);
  });

  it('長さは NFC にそろえた後で数える (NFD の 12 字 = 24 code point は通る)', () => {
    const nfd = cp(0x30ab, 0x3099).repeat(12);
    expect([...nfd]).toHaveLength(24);
    expect(checkAccountName(nfd)).toEqual({ ok: true, value: 'ガ'.repeat(12) });
  });

  it.each([
    ['全角', 'あ'],
    ['半角', 'a'],
    ['半角カナ', cp(0xff71)],
  ])('%s: 12 字は通り、13 字は tooLong (全角も半角も 1 字)', (_label, ch) => {
    expect(checkAccountName(ch.repeat(12))).toEqual({ ok: true, value: ch.repeat(12) });
    expect(checkAccountName(ch.repeat(13))).toEqual({ ok: false, reason: 'tooLong' });
  });

  it('surrogate pair の 1 字は 1 字と数える (𠮷 + 11 字 = 12 字)', () => {
    expect(KICHI).toHaveLength(2);
    expect(checkAccountName(KICHI + 'あ'.repeat(11))).toEqual({
      ok: true,
      value: KICHI + 'あ'.repeat(11),
    });
    expect(checkAccountName(KICHI.repeat(12))).toEqual({ ok: true, value: KICHI.repeat(12) });
    expect(checkAccountName(KICHI + 'あ'.repeat(12))).toEqual({ ok: false, reason: 'tooLong' });
  });

  it('前後の空白は長さに数えない', () => {
    expect(checkAccountName(`  ${'あ'.repeat(12)}  `)).toEqual({ ok: true, value: 'あ'.repeat(12) });
  });

  it.each([
    ['カンマ', '売上,高'],
    ['引用符', '売上"高'],
    ['途中の改行 (LF)', '売上\n高'],
    ['途中の改行 (CR)', '売上\r高'],
    ['途中の tab', '売上\t高'],
    ['NUL', `売上${cp(0x00)}高`],
    ['DEL', `売上${cp(0x7f)}高`],
    ['ゼロ幅の空白', `売上${ZERO_WIDTH_SPACE}高`],
    ['ゼロ幅の接合子', `売上${cp(0x200d)}高`],
    ['途中の BOM', `売上${cp(0xfeff)}高`],
    ['ソフトハイフン', `売上${cp(0x00ad)}高`],
    ['右から左への上書き', `売上${cp(0x202e)}高`],
    ['行の区切り (U+2028)', `売上${cp(0x2028)}高`],
    ['段落の区切り (U+2029)', `売上${cp(0x2029)}高`],
    ['孤立した surrogate', `売上${String.fromCharCode(0xd800)}高`],
  ])('使えない字 (%s) は forbidden', (_label, raw) => {
    expect(checkAccountName(raw)).toEqual({ ok: false, reason: 'forbidden' });
  });

  it.each(['=', '+', '-', '@'])('先頭の %s は formula', (ch) => {
    expect(checkAccountName(`${ch}売上`)).toEqual({ ok: false, reason: 'formula' });
    // 前後の空白を除いた後の先頭で見る。
    expect(checkAccountName(`  ${ch}売上`)).toEqual({ ok: false, reason: 'formula' });
  });

  it('数式の字は先頭だけ見る・全角の ＝＋－＠ も数式 (lib/csv.ts と同じ・2026-11-25 から)', () => {
    expect(checkAccountName('売上=高')).toEqual({ ok: true, value: '売上=高' });
    expect(checkAccountName('A-1')).toEqual({ ok: true, value: 'A-1' });
    expect(checkAccountName(`売上${cp(0xff1d)}高`)).toEqual({ ok: true, value: `売上${cp(0xff1d)}高` });
    for (const ch of [0xff1d, 0xff0b, 0xff0d, 0xff20]) {
      expect(checkAccountName(`${cp(ch)}売上`)).toEqual({ ok: false, reason: 'formula' });
    }
  });

  it('見る順は 使えない字 → 数式の字 → 長さ', () => {
    expect(checkAccountName('=a,b')).toEqual({ ok: false, reason: 'forbidden' });
    expect(checkAccountName(`=${'a'.repeat(20)}`)).toEqual({ ok: false, reason: 'formula' });
    expect(checkAccountName(`${'a'.repeat(20)},`)).toEqual({ ok: false, reason: 'forbidden' });
  });
});

describe('lib/csv.ts の述語 (startsWithCsvFormulaChar) と escapeCsvCell', () => {
  // escapeCsvCell の出力を元の値に戻す (引用符で囲まれていれば外す)。
  const unquote = (cell: string) =>
    cell.startsWith('"') ? cell.slice(1, -1).replace(/""/g, '"') : cell;

  it('ASCII の全部の字と全角の記号で、述語と escapeCsvCell が同じ字を数式とみなす', () => {
    const heads = [
      ...Array.from({ length: 0x80 }, (_, i) => cp(i)),
      cp(0xff1d), // ＝
      cp(0xff0b), // ＋
      cp(0xff0d), // －
      cp(0xff20), // ＠
      'あ',
    ];
    const formulaHeads: string[] = [];
    for (const head of heads) {
      const value = `${head}x`;
      const defanged = unquote(escapeCsvCell(value)) === `'${value}`;
      expect(startsWithCsvFormulaChar(value), JSON.stringify(head)).toBe(defanged);
      if (defanged) formulaHeads.push(head);
    }
    // LF と全角の 4 字は 2026-11-25 の外部レビューで足した。
    expect(formulaHeads).toEqual(['\t', '\n', '\r', '+', '-', '=', '@', '＝', '＋', '－', '＠']);
  });

  it('先頭以外の数式の字は述語が見ない', () => {
    expect(startsWithCsvFormulaChar('a=b')).toBe(false);
    expect(startsWithCsvFormulaChar('')).toBe(false);
  });

  it('検証を通った名前は、CSV のセルにそのままの字で出る (single quote も引用符も付かない)', () => {
    const names = [
      '現金',
      '売上 高',
      'A-1',
      '売上=高',
      "O'Brien",
      'Sales (JPYC)',
      `${KICHI}野家`,
      'あ'.repeat(12),
      cp(0xff71).repeat(12),
    ];
    for (const name of names) {
      const r = checkAccountName(name);
      expect(r, name).toEqual({ ok: true, value: name });
      expect(escapeCsvCell(name), name).toBe(name);
    }
  });
});

describe('normalizeAccountingAccounts (保存の形・空文字 = 既定)', () => {
  it.each([[undefined], [null], ['売上'], [3], [true], [[]], [['現金', '売上']]])(
    'object でない値 (%j) は両方とも空文字',
    (raw) => {
      expect(normalizeAccountingAccounts(raw)).toEqual({ debit: '', credit: '' });
    },
  );

  it('通る名前は残し、空白と NFC をそろえる', () => {
    expect(
      normalizeAccountingAccounts({ debit: ' 現金 ', credit: `${cp(0x30ab, 0x3099)}ス売上` }),
    ).toEqual({ debit: '現金', credit: 'ガス売上' });
  });

  it('項目ごとに見る: 通らない項目だけが空文字になる', () => {
    expect(normalizeAccountingAccounts({ debit: '=現金', credit: '売上' })).toEqual({
      debit: '',
      credit: '売上',
    });
    expect(normalizeAccountingAccounts({ debit: '現金', credit: 'あ'.repeat(13) })).toEqual({
      debit: '現金',
      credit: '',
    });
    expect(normalizeAccountingAccounts({ debit: '現金' })).toEqual({ debit: '現金', credit: '' });
  });

  it.each([
    ['数式の字', '=SUM(A1)'],
    ['カンマ', '売上,高'],
    ['改行', '売上\n高'],
    ['ゼロ幅の空白', `売上${ZERO_WIDTH_SPACE}高`],
    ['長すぎる', 'あ'.repeat(13)],
    ['空文字', ''],
    ['空白だけ', '  '],
    ['数値', 5],
    ['null', null],
    ['object', { name: '売上' }],
  ])('通らない値 (%s) は空文字', (_label, value) => {
    expect(normalizeAccountingAccounts({ debit: value, credit: value })).toEqual({
      debit: '',
      credit: '',
    });
  });

  it('既定と同じ名前は空文字にする (保存するのは店が変えた名前だけ)', () => {
    expect(normalizeAccountingAccounts({ ...DEFAULT_ACCOUNTING_ACCOUNTS })).toEqual({
      debit: '',
      credit: '',
    });
    // 既定の名前でも、もう一方の項目に入れたものは店が変えた名前。
    expect(normalizeAccountingAccounts({ debit: '売上高', credit: '売掛金' })).toEqual({
      debit: '売上高',
      credit: '売掛金',
    });
  });

  it('知らない項目は落とす', () => {
    expect(normalizeAccountingAccounts({ debit: '現金', credit: '売上', extra: 'x' })).toEqual({
      debit: '現金',
      credit: '売上',
    });
  });

  it('冪等 (もう 1 度通しても変わらない)', () => {
    const samples: unknown[] = [
      undefined,
      {},
      { debit: ' 現金 ', credit: '=売上' },
      { ...DEFAULT_ACCOUNTING_ACCOUNTS },
      { debit: cp(0x30ab, 0x3099), credit: 'あ'.repeat(12) },
      { debit: 'あ'.repeat(13), credit: '売上,高' },
    ];
    for (const sample of samples) {
      const once = normalizeAccountingAccounts(sample);
      expect(normalizeAccountingAccounts(once)).toEqual(once);
    }
  });
});

describe('resolveAccountingAccounts (実際に使う名前)', () => {
  it('既定は 売掛金 / 売上高', () => {
    expect(DEFAULT_ACCOUNTING_ACCOUNTS).toEqual({ debit: '売掛金', credit: '売上高' });
    expect(resolveAccountingAccounts(undefined)).toEqual({ debit: '売掛金', credit: '売上高' });
    expect(resolveAccountingAccounts({ debit: '', credit: '' })).toEqual({
      debit: '売掛金',
      credit: '売上高',
    });
  });

  it('通る名前はその名前・通らない項目は既定の科目', () => {
    expect(resolveAccountingAccounts({ debit: ' 現金 ', credit: '+売上' })).toEqual({
      debit: '現金',
      credit: '売上高',
    });
  });

  it('冪等', () => {
    for (const sample of [undefined, { debit: '現金', credit: '' }, { debit: '=x', credit: '売上' }]) {
      const once = resolveAccountingAccounts(sample);
      expect(resolveAccountingAccounts(once)).toEqual(once);
    }
  });
});
