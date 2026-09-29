import { describe, expect, it } from 'vitest';
import { USDC_JPY_SOURCE_URL, parseUsdcJpy, roundUsdcJpyForDisplay } from '@/lib/usdcJpyRate';

// 取得元と応答の読み取りを固定する (表示 /api/market/rates と Store の USDC 見積もりの両方が使う)。
describe('usdcJpyRate', () => {
  it('取得元は鍵の要らない Coinbase の公開 API (USDC を基準にした表)', () => {
    expect(USDC_JPY_SOURCE_URL).toBe('https://api.coinbase.com/v2/exchange-rates?currency=USDC');
  });

  it('data.rates.JPY の文字列を「1 USDC が何円か」として全桁で読む (丸めない・安全確認と見積もりは全桁)', () => {
    // 実際の応答 (2026-09-29) と同じ長い小数の文字列。
    const raw = '157.4318856113143365644986761414795';
    expect(parseUsdcJpy({ data: { currency: 'USDC', rates: { USD: '1', JPY: raw } } })).toEqual({ value: Number(raw), decimal: raw });
    expect(parseUsdcJpy({ data: { currency: 'USDC', rates: { JPY: '165.000001' } } })?.value).toBe(165.000001);
    expect(parseUsdcJpy({ data: { currency: 'USDC', rates: { JPY: '150' } } })).toEqual({ value: 150, decimal: '150' });
  });

  it.each([
    ['JPY の欠け', { data: { currency: 'USDC', rates: {} } }],
    ['data の欠け', {}],
    ['null', null],
    ['数値でない文字列', { data: { rates: { JPY: 'abc' } } }],
    ['空文字', { data: { rates: { JPY: '' } } }],
    ['0', { data: { rates: { JPY: '0' } } }],
    ['負の値', { data: { rates: { JPY: '-150' } } }],
    ['指数表記', { data: { rates: { JPY: '1.5e2' } } }],
    ['無限大', { data: { rates: { JPY: 'Infinity' } } }],
    ['文字列でない (数値)', { data: { rates: { JPY: 150 } } }],
  ])('%s は null', (_label, json) => {
    expect(parseUsdcJpy(json)).toBeNull();
  });

  it.each([
    ['157.4318856113143365644986761414795', 157.43],
    // 浮動小数の掛け算では 150.015 × 100 = 15001.4999… で切り捨て側に倒れる。10 進数のまま四捨五入する。
    ['150.015', 150.02],
    ['150.005', 150.01],
    ['149.995', 150],
    ['150.004', 150],
    ['150', 150],
    ['150.1', 150.1],
    ['499.999', 500],
  ])('表示用の丸め: %s → %s', (decimal, expected) => {
    expect(roundUsdcJpyForDisplay(decimal)).toBe(expected);
  });
});
