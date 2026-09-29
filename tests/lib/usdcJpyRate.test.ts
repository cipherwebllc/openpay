import { describe, expect, it } from 'vitest';
import { USDC_JPY_SOURCE_URL, parseUsdcJpy } from '@/lib/usdcJpyRate';

// 取得元と応答の読み取りを固定する (表示 /api/market/rates と Store の USDC 見積もりの両方が使う)。
describe('usdcJpyRate', () => {
  it('取得元は鍵の要らない Coinbase の公開 API (USDC を基準にした表)', () => {
    expect(USDC_JPY_SOURCE_URL).toBe('https://api.coinbase.com/v2/exchange-rates?currency=USDC');
  });

  it('data.rates.JPY の文字列を「1 USDC が何円か」として読み、小数第 2 位に丸める', () => {
    // 実際の応答 (2026-09-29) と同じ長い小数の文字列。
    expect(parseUsdcJpy({ data: { currency: 'USDC', rates: { USD: '1', JPY: '157.4318856113143365644986761414795' } } })).toBe(157.43);
    expect(parseUsdcJpy({ data: { currency: 'USDC', rates: { JPY: '157.395' } } })).toBe(157.4);
    expect(parseUsdcJpy({ data: { currency: 'USDC', rates: { JPY: '150' } } })).toBe(150);
  });

  it.each([
    ['JPY の欠け', { data: { currency: 'USDC', rates: {} } }],
    ['data の欠け', {}],
    ['null', null],
    ['数値でない文字列', { data: { rates: { JPY: 'abc' } } }],
    ['空文字', { data: { rates: { JPY: '' } } }],
    ['0', { data: { rates: { JPY: '0' } } }],
    ['負の値', { data: { rates: { JPY: '-150' } } }],
    ['無限大', { data: { rates: { JPY: 'Infinity' } } }],
    ['文字列でない (数値)', { data: { rates: { JPY: 150 } } }],
  ])('%s は null', (_label, json) => {
    expect(parseUsdcJpy(json)).toBeNull();
  });
});
