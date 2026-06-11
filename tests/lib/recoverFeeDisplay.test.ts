import { describe, it, expect, vi, beforeEach } from 'vitest';

// forwarderConfig と recoverFee をモックして純粋テスト
vi.mock('@/lib/relay/forwarderConfig', () => ({
  jpycForwarderFor: vi.fn(() => null),
  relayGasFeeValue: vi.fn(() => 2n * 10n ** 18n),
}));
vi.mock('@/lib/relay/recoverFee', () => ({
  recoverFeeValue: vi.fn((amount: bigint) => 2n * 10n ** 18n), // default bps=0: returns floor
  recoverFeeBps: vi.fn(() => 0),
}));

import { buildRecoverFeeDisplay } from '@/lib/recoverFeeDisplay';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { recoverFeeValue, recoverFeeBps } from '@/lib/relay/recoverFee';

const MOCK_FORWARDER = '0x1234567890123456789012345678901234567890' as `0x${string}`;
const AMOUNT_1000 = 1000n * 10n ** 18n; // 1000 JPYC

describe('buildRecoverFeeDisplay', () => {
  describe('free mode (forwarder null)', () => {
    beforeEach(() => {
      vi.mocked(jpycForwarderFor).mockReturnValue(null);
    });

    it('returns null → no disclosure', () => {
      const result = buildRecoverFeeDisplay(AMOUNT_1000, 137, 'customer');
      expect(result).toBeNull();
    });
  });

  describe('recover mode (forwarder set)', () => {
    beforeEach(() => {
      vi.mocked(jpycForwarderFor).mockReturnValue(MOCK_FORWARDER);
      vi.mocked(recoverFeeBps).mockReturnValue(0);
      vi.mocked(recoverFeeValue).mockReturnValue(2n * 10n ** 18n);
    });

    it('bps=0: feeHuman is "2", bps is 0', () => {
      const result = buildRecoverFeeDisplay(AMOUNT_1000, 137, 'customer');
      expect(result).not.toBeNull();
      expect(result!.bps).toBe(0);
      expect(result!.feeHuman).toBe('2');
    });

    it('bps=0, gasMode=customer: customerPaysHuman = amount+fee', () => {
      const result = buildRecoverFeeDisplay(AMOUNT_1000, 137, 'customer');
      expect(result!.gasMode).toBe('customer');
      expect(result!.customerPaysHuman).toBe('1002'); // 1000 + 2
      expect(result!.merchantReceivesHuman).toBe('1000');
    });

    it('bps=0, gasMode=merchant: merchantReceivesHuman = amount-fee', () => {
      const result = buildRecoverFeeDisplay(AMOUNT_1000, 137, 'merchant');
      expect(result!.gasMode).toBe('merchant');
      expect(result!.customerPaysHuman).toBe('1000');
      expect(result!.merchantReceivesHuman).toBe('998'); // 1000 - 2
    });

    it('bps=100 (1%): returns bps=100 and floorHuman="2"', () => {
      vi.mocked(recoverFeeBps).mockReturnValue(100);
      // 1% of 1000 = 10 > floor=2, so fee=10
      vi.mocked(recoverFeeValue).mockReturnValue(10n * 10n ** 18n);
      const result = buildRecoverFeeDisplay(AMOUNT_1000, 137, 'customer');
      expect(result!.bps).toBe(100);
      expect(result!.feeHuman).toBe('10');
      expect(result!.floorHuman).toBe('2');
      expect(result!.customerPaysHuman).toBe('1010');
      expect(result!.merchantReceivesHuman).toBe('1000');
    });

    it('bps=100, gasMode=merchant', () => {
      vi.mocked(recoverFeeBps).mockReturnValue(100);
      vi.mocked(recoverFeeValue).mockReturnValue(10n * 10n ** 18n);
      const result = buildRecoverFeeDisplay(AMOUNT_1000, 137, 'merchant');
      expect(result!.merchantReceivesHuman).toBe('990'); // 1000 - 10
    });

    it('returns null for amount=0', () => {
      const result = buildRecoverFeeDisplay(0n, 137, 'customer');
      expect(result).toBeNull();
    });
  });
});
