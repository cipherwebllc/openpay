import { describe, it, expect } from 'vitest';
import { stripControlChars, truncateSafe } from '@/lib/sanitize';

// ---------------------------------------------------------------------------
// truncateSafe
// ---------------------------------------------------------------------------
describe('truncateSafe', () => {
  it('max 以下なら変更なし', () => {
    expect(truncateSafe('abc', 5)).toBe('abc');
    expect(truncateSafe('abc', 3)).toBe('abc');
  });

  it('ASCII のみ: ちょうど max で切詰', () => {
    expect(truncateSafe('abcde', 3)).toBe('abc');
    expect(truncateSafe('Hello, World!', 5)).toBe('Hello');
  });

  it('絵文字ペアが境界をまたぐ (max-1 が high surrogate) → ペアごと落として max-1', () => {
    // 🎉 = U+1F389 → UTF-16: 🎉 (2 code units)
    // 79 ASCII 文字 + 🎉 = 81 code units
    // max=80: position 79 (0-indexed) is the high surrogate → drop pair → length 79
    const base = 'a'.repeat(79);
    const s = base + '🎉'; // 🎉
    expect(s.length).toBe(81);
    const result = truncateSafe(s, 80);
    expect(result.length).toBe(79);
    expect(result).toBe(base);
  });

  it('絵文字ペアが max 内に完全に収まる → 不変 (low surrogate が境界)', () => {
    // 78 ASCII + 🎉 = 80 code units → max=80 はそのまま
    const base = 'a'.repeat(78);
    const s = base + '🎉'; // 🎉
    expect(s.length).toBe(80);
    const result = truncateSafe(s, 80);
    expect(result).toBe(s);
  });

  it('絵文字ペアの直後で切詰 (max=80, ペアが 79-80 位置) → ペアは保持', () => {
    // 78 ASCII + 🎉 (2 units) = 80 → max=80 → no truncation
    const base = 'a'.repeat(78);
    const emoji = '🎉';
    const s = base + emoji;
    expect(s.length).toBe(80);
    expect(truncateSafe(s, 80)).toBe(s);
  });

  it('空文字は空文字のまま', () => {
    expect(truncateSafe('', 5)).toBe('');
    expect(truncateSafe('', 0)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// stripControlChars — 既存挙動 + 孤立サロゲート除去
// ---------------------------------------------------------------------------
describe('stripControlChars', () => {
  it('制御文字 (C0) を除去し trim する (既存挙動不変)', () => {
    expect(stripControlChars('\x00hello\x1f')).toBe('hello');
    // タブ (U+0009) は C0 制御文字に含まれるため除去される
    expect(stripControlChars('  foo\tbar  ')).toBe('foobar');
    expect(stripControlChars('\x01\x02\x03')).toBe('');
  });

  it('DEL (U+007F) を除去する (既存挙動不変)', () => {
    expect(stripControlChars('hello\x7fworld')).toBe('helloworld');
  });

  it('通常テキストは変更なし (既存挙動不変)', () => {
    expect(stripControlChars('こんにちは')).toBe('こんにちは');
    expect(stripControlChars('abc 123')).toBe('abc 123');
  });

  it('正規の絵文字ペア (サロゲートペア) は除去されない', () => {
    // 🎉 = 🎉, 🌟 = 🌟
    const s = '商品🎉名前';
    expect(stripControlChars(s)).toBe(s);
  });

  it('結合文字シーケンスは除去されない', () => {
    // é = 'e' + combining acute (U+0301)
    const s = 'café';
    expect(stripControlChars(s)).toBe(s);
  });

  it('孤立 high surrogate が除去される', () => {
    // \uD83C 単体 (low surrogate が続かない)
    const s = 'abc\uD83Cdef';
    expect(stripControlChars(s)).toBe('abcdef');
  });

  it('孤立 low surrogate が除去される', () => {
    // \uDF89 単体 (high surrogate が先行しない)
    const s = 'abc\uDF89def';
    expect(stripControlChars(s)).toBe('abcdef');
  });

  it('孤立サロゲートが複数あっても全除去される', () => {
    const s = '\uD800hello\uDFFFworld\uDBFF';
    expect(stripControlChars(s)).toBe('helloworld');
  });

  it('正規ペアの前後に孤立サロゲートが混在しても正規ペアは保持', () => {
    // 🎉 = 🎉 (正規), \uD800 = 孤立 high
    const s = '\uD800🎉\uDFFF';
    const result = stripControlChars(s);
    expect(result).toBe('🎉'); // 🎉 のみ残る
  });
});
