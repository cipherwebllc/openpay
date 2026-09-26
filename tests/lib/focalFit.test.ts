import { describe, expect, it } from 'vitest';
import { estimateFocalEm, focalFitCqi } from '@/lib/focalFit';

// 実測 (Chromium・本番フォント・2026-09-26) の em 幅。見積もりは必ずこれ以上 (= 収まる側) であること。
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
