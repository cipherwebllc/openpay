import { describe, expect, it } from 'vitest';
import { formatUnits } from 'viem';
import { hostedPurchaseTotalJpyc } from '@/lib/store/purchaseTotal';
import { hostedPurchaseFeeValue } from '@/lib/x402/hostedPurchaseWire';

describe('hostedPurchaseTotalJpyc', () => {
  it.each([['100', '101'], ['150', '151.5'], ['1200', '1212'], ['4950', '4999.5']])(
    '価格 %s JPYC の支払総額は %s JPYC (価格 + 買い手負担 x402 手数料)',
    (priceJpyc, total) => {
      expect(hostedPurchaseTotalJpyc(priceJpyc)).toBe(total);
      // 単一ソース (hostedPurchaseFeeValue) と一致すること
      const wei = BigInt(priceJpyc) * 10n ** 18n;
      expect(hostedPurchaseTotalJpyc(priceJpyc)).toBe(formatUnits(wei + hostedPurchaseFeeValue(wei), 18));
    },
  );
});
