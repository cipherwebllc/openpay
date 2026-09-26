import { describe, expect, it } from 'vitest';
import { estimateFocalEm, focalFitCqi } from '@/lib/focalFit';

// 実幅 (em)。見積もりは必ずこれ以上 (= 収まる側) であること。Mac の実測 (Chromium・system-ui) と、
// CI の Linux で使われる字幅の広い DejaVu Sans Bold の字幅表からの近似 (末尾 wide) の両方を置く。
const WIDE_FONT_EM: Record<string, number> = {
  'No sign-up (wide)': 6.08,
  'Seconds (wide)': 4.7,
  'JPYC 1% (wide)': 4.68,
  '≈2 JPYC (wide)': 4.51,
  '1% / 3% (wide)': 4.46,
  '1% (wide)': 1.7,
};
const MEASURED_EM: Record<string, number> = {
  'No sign-up': 5.22,
  Seconds: 4.15,
  '登録不要': 4.0,
  '数秒': 2.0,
  '1%': 1.44,
  '¥0': 1.36,
  '1% / 3%': 3.77,
  '≈2 JPYC': 4.07,
  'JPYC 1%': 4.2,
  '約2JPYC': 4.2,
};

describe('estimateFocalEm', () => {
  it.each(Object.entries(MEASURED_EM))('%s は実測 %s em 以上に見積もる (はみ出さない側)', (text, measured) => {
    expect(estimateFocalEm(text)).toBeGreaterThanOrEqual(measured);
  });

  it.each(Object.entries(WIDE_FONT_EM))('%s: 字幅の広い書体の近似 %s em 以上に見積もる', (label, wide) => {
    expect(estimateFocalEm(label.replace(' (wide)', ''))).toBeGreaterThanOrEqual(wide);
  });

  it('CJK は 1 文字 1em を基準に、英小文字より広く数える', () => {
    expect(estimateFocalEm('登録')).toBeGreaterThan(estimateFocalEm('ab'));
  });
});

describe('focalFitCqi', () => {
  it('長い文言ほど小さい cqi になる', () => {
    const size = (text: string) => Number.parseFloat(focalFitCqi(text));
    expect(size('No sign-up')).toBeLessThan(size('Seconds'));
    expect(size('Seconds')).toBeLessThan(size('1%'));
  });

  it('空文字でも有限の値を返す (0 除算しない)', () => {
    expect(focalFitCqi('')).toBe('100.00cqi');
  });
});
