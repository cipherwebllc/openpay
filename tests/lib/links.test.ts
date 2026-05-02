import { describe, it, expect } from 'vitest';
import { getExchangeLink } from '@/lib/links';

describe('getExchangeLink', () => {
  describe('JPYC', () => {
    it('ja → JPYC 公式 (jpyc.co.jp)、注記なし', () => {
      const link = getExchangeLink('jpyc', 'ja');
      expect(link.url).toBe('https://jpyc.co.jp/');
      expect(link.label).toBe('JPYC 公式');
      expect(link.jaResidentsOnly).toBeUndefined();
      expect(link.blocksJapaneseResidents).toBeUndefined();
    });

    it('en → JPYC official (jpyc.co.jp)、jaResidentsOnly = true', () => {
      const link = getExchangeLink('jpyc', 'en');
      expect(link.url).toBe('https://jpyc.co.jp/');
      expect(link.label).toBe('JPYC official');
      expect(link.jaResidentsOnly).toBe(true);
      expect(link.blocksJapaneseResidents).toBeUndefined();
    });
  });

  describe('USDC', () => {
    it('ja → SBI VC トレード、注記なし', () => {
      const link = getExchangeLink('usdc', 'ja');
      expect(link.url).toBe('https://www.sbivc.co.jp/');
      expect(link.label).toBe('SBI VC トレード');
      expect(link.jaResidentsOnly).toBeUndefined();
      expect(link.blocksJapaneseResidents).toBeUndefined();
    });

    it('en → Coinbase、blocksJapaneseResidents = true', () => {
      const link = getExchangeLink('usdc', 'en');
      expect(link.url).toBe('https://www.coinbase.com/');
      expect(link.label).toBe('Coinbase');
      expect(link.blocksJapaneseResidents).toBe(true);
      expect(link.jaResidentsOnly).toBeUndefined();
    });
  });

  describe('一貫性', () => {
    it('全 4 組合せで https URL を返す (phishing 防御の前提)', () => {
      for (const token of ['jpyc', 'usdc'] as const) {
        for (const locale of ['ja', 'en'] as const) {
          const link = getExchangeLink(token, locale);
          expect(link.url.startsWith('https://')).toBe(true);
        }
      }
    });

    it('jpyc は ja/en で同じ URL (JPYC 公式 1 拠点)', () => {
      expect(getExchangeLink('jpyc', 'ja').url).toBe(
        getExchangeLink('jpyc', 'en').url,
      );
    });

    it('usdc は ja/en で異なる URL (SBI vs Coinbase)', () => {
      expect(getExchangeLink('usdc', 'ja').url).not.toBe(
        getExchangeLink('usdc', 'en').url,
      );
    });

    it('jaResidentsOnly と blocksJapaneseResidents は同時に true にならない', () => {
      for (const token of ['jpyc', 'usdc'] as const) {
        for (const locale of ['ja', 'en'] as const) {
          const link = getExchangeLink(token, locale);
          expect(
            link.jaResidentsOnly === true &&
              link.blocksJapaneseResidents === true,
          ).toBe(false);
        }
      }
    });
  });
});
