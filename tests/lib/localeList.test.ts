import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatLocaleList } from '@/lib/localeList';

describe('formatLocaleList', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('ja は「・」で並べ、en は Intl.ListFormat (Oxford comma)', () => {
    expect(formatLocaleList('ja', ['POL', 'KAIA', 'AVAX'])).toBe('POL・KAIA・AVAX');
    expect(formatLocaleList('en', ['POL', 'KAIA'])).toBe('POL and KAIA');
    expect(formatLocaleList('en', ['POL', 'KAIA', 'AVAX'])).toBe('POL, KAIA, and AVAX');
    expect(formatLocaleList('en', ['POL'])).toBe('POL');
    expect(formatLocaleList('en', [])).toBe('');
  });

  // 表示の整形が失敗しても、パネル (残高・戻す) を巻き込んで落とさない。
  it('Intl.ListFormat が無いブラウザでは区切り文字で並べる', () => {
    vi.stubGlobal('Intl', { ...Intl, ListFormat: undefined });
    expect(formatLocaleList('en', ['POL', 'KAIA', 'AVAX'])).toBe('POL, KAIA, AVAX');
    expect(formatLocaleList('ja', ['POL', 'KAIA'])).toBe('POL・KAIA');
  });

  it('Intl.ListFormat が throw しても区切り文字で並べる', () => {
    vi.stubGlobal('Intl', {
      ...Intl,
      ListFormat: class {
        constructor() {
          throw new RangeError('Incorrect locale information provided');
        }
      },
    });
    expect(formatLocaleList('en', ['POL', 'KAIA'])).toBe('POL, KAIA');
  });
});
