// lib/sjis.ts (弥生ネイティブ CSV の Shift_JIS 書き出し) の検証。
// Shift_JIS は表現できない文字を無言で `?` に落とすため、どの文字が失われるかを
// 事前に列挙できること (sjisLossyChars) を固定する。会計データの店舗名・メモは自由入力で、
// 絵文字や JIS 外字 (𠮷 等) が普通に混ざる。

import { describe, expect, it } from 'vitest';
import { encodeShiftJis, sjisLossyChars } from '@/lib/sjis';

describe('sjisLossyChars', () => {
  it('ASCII / ひらがな / 漢字 / JIS 記号は失われない', async () => {
    expect(await sjisLossyChars('OpenPay 珈琲店 ①②③ 1,000円')).toEqual([]);
  });

  it('絵文字は置換対象として列挙される', async () => {
    expect(await sjisLossyChars('コーヒー🍣')).toEqual(['🍣']);
  });

  it('JIS 外字 (サロゲートペア) も列挙される', async () => {
    expect(await sjisLossyChars('𠮷野家')).toEqual(['𠮷']);
  });

  it('同じ文字の重複は 1 件に畳み、初出順で返す', async () => {
    expect(await sjisLossyChars('🍣あ🍺あ🍣')).toEqual(['🍣', '🍺']);
  });

  it('元から ? の文字は判定不能なので列挙しない (誤検知を出さない)', async () => {
    expect(await sjisLossyChars('???')).toEqual([]);
  });

  it('空文字は空配列', async () => {
    expect(await sjisLossyChars('')).toEqual([]);
  });
});

describe('encodeShiftJis', () => {
  it('Shift_JIS バイト列を返す (ASCII は 1 バイト・かなは 2 バイト)', async () => {
    expect(Array.from(await encodeShiftJis('A'))).toEqual([0x41]);
    expect((await encodeShiftJis('あ')).byteLength).toBe(2);
  });

  it('列挙された文字は実際に ? (0x3f) へ置換される', async () => {
    const lossy = await sjisLossyChars('🍣');
    expect(lossy).toEqual(['🍣']);
    expect(Array.from(await encodeShiftJis('🍣'))).toContain(0x3f);
  });
});
