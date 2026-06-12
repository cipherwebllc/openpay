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
      expect(result!.tooSmall).toBe(false);
    });

    it('merchant mode, billAmount < fee: tooSmall true + merchantReceives clamped to "0"', () => {
      // merchant が 1 JPYC・floor 2 JPYC → 1000 - fee がマイナスになる。負の受取額を
      // 表示せず '0' にクランプし、tooSmall フラグを立てる (F2)。
      const ONE_JPYC = 1n * 10n ** 18n;
      const result = buildRecoverFeeDisplay(ONE_JPYC, 137, 'merchant');
      expect(result).not.toBeNull();
      expect(result!.tooSmall).toBe(true);
      expect(result!.merchantReceivesHuman).toBe('0');
    });

    it('merchant mode, billAmount === fee: tooSmall true (<= 境界) + merchantReceives "0"', () => {
      // billAmount == fee (2 JPYC) も受取 0 で受付不可。<= 境界が含まれることを fence。
      const TWO_JPYC = 2n * 10n ** 18n;
      const result = buildRecoverFeeDisplay(TWO_JPYC, 137, 'merchant');
      expect(result!.tooSmall).toBe(true);
      expect(result!.merchantReceivesHuman).toBe('0');
    });

    it('customer mode, small amount: tooSmall false (顧客が amount+fee を払うので成立)', () => {
      // customer 負担では金額が手数料以下でも顧客が amount + fee を払うため受付可能。
      // tooSmall は merchant 専用フラグなので常に false。
      const ONE_JPYC = 1n * 10n ** 18n;
      const result = buildRecoverFeeDisplay(ONE_JPYC, 137, 'customer');
      expect(result!.tooSmall).toBe(false);
      expect(result!.customerPaysHuman).toBe('3'); // 1 + 2
      expect(result!.merchantReceivesHuman).toBe('1');
    });

    // 確定モデル (2026-06-12): % 形式の開示は merchant (決済) のみ。customer (チップ) は
    // bps を適用しないフラットなフロアなので、buildRecoverFeeDisplay は bps を 0 として扱う
    // (RecoverFeeNotice は disclosureGasOnly を選ぶ)。
    it('bps=100 (1%), gasMode=merchant (決済): % 開示 (bps=100・floorHuman="2")', () => {
      vi.mocked(recoverFeeBps).mockReturnValue(100);
      // 1% of 1000 = 10 > floor=2, so fee=10 (merchant スケジュール)
      vi.mocked(recoverFeeValue).mockReturnValue(10n * 10n ** 18n);
      const result = buildRecoverFeeDisplay(AMOUNT_1000, 137, 'merchant');
      expect(result!.bps).toBe(100);
      expect(result!.feeHuman).toBe('10');
      expect(result!.floorHuman).toBe('2');
      // merchant 吸収: 顧客は表示額のみ・店舗受取 = 1000 - 10 = 990。
      expect(result!.customerPaysHuman).toBe('1000');
      expect(result!.merchantReceivesHuman).toBe('990');
    });

    it('bps=100 でも gasMode=customer (チップ): bps は 0 として扱われ % 開示にならない', () => {
      vi.mocked(recoverFeeBps).mockReturnValue(100);
      // チップ (customer) はフロア固定なので mock もフロアを返す。
      vi.mocked(recoverFeeValue).mockReturnValue(2n * 10n ** 18n);
      const result = buildRecoverFeeDisplay(AMOUNT_1000, 137, 'customer');
      // customer は % 形式 (disclosurePercent) を出さないため bps=0 にクランプ。
      expect(result!.bps).toBe(0);
      expect(result!.feeHuman).toBe('2');
      // customer 上乗せ: 顧客は amount + fee = 1002 を払う。
      expect(result!.customerPaysHuman).toBe('1002');
      expect(result!.merchantReceivesHuman).toBe('1000');
    });

    it('returns null for amount=0', () => {
      const result = buildRecoverFeeDisplay(0n, 137, 'customer');
      expect(result).toBeNull();
    });
  });
});
