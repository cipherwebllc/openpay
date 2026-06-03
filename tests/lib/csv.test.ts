import { describe, it, expect } from 'vitest';
import { escapeCsvCell, buildCsv, CSV_BOM, CSV_NEWLINE } from '@/lib/csv';

describe('escapeCsvCell', () => {
  it('特殊文字なしは素通り', () => {
    expect(escapeCsvCell('hello')).toBe('hello');
    expect(escapeCsvCell('156.32')).toBe('156.32');
  });
  it('カンマ/改行/二重引用符は quote + "" escape', () => {
    expect(escapeCsvCell('a,b')).toBe('"a,b"');
    expect(escapeCsvCell('a"b')).toBe('"a""b"');
    expect(escapeCsvCell('a\nb')).toBe('"a\nb"');
  });
  it('formula injection 防御 (=,+,-,@ 始まりは single quote 付与)', () => {
    expect(escapeCsvCell('=cmd')).toBe("'=cmd");
    expect(escapeCsvCell('+1')).toBe("'+1");
    expect(escapeCsvCell('-1')).toBe("'-1");
    expect(escapeCsvCell('@x')).toBe("'@x");
  });
  it('injection prefix かつ特殊文字 → defang 後に quote', () => {
    expect(escapeCsvCell('=a,b')).toBe('"\'=a,b"');
  });
});

describe('buildCsv', () => {
  it('BOM 先頭 + CRLF 区切り + 末尾 CRLF', () => {
    const csv = buildCsv([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(csv.endsWith(CSV_NEWLINE)).toBe(true);
    const body = csv.slice(CSV_BOM.length);
    expect(body.split(CSV_NEWLINE)).toEqual(['a,b', '1,2', '']);
  });
  it('各セルを escape する', () => {
    const csv = buildCsv([['=x', 'a,b']]);
    expect(csv).toContain("'=x");
    expect(csv).toContain('"a,b"');
  });
  it('bom:false で UTF-8 BOM を付けない (Shift_JIS 出力用)', () => {
    const csv = buildCsv([['a', 'b']], { bom: false });
    expect(csv.startsWith(CSV_BOM)).toBe(false);
    expect(csv).toBe(`a,b${CSV_NEWLINE}`);
    // escape は bom 有無に依らず効く
    expect(buildCsv([['=x']], { bom: false })).toBe(`'=x${CSV_NEWLINE}`);
  });
});
