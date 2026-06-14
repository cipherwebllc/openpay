import { describe, it, expect, vi, beforeEach } from 'vitest';

// forwarderConfig と recoverFee をモックして純粋テスト
vi.mock('@/lib/relay/forwarderConfig', () => ({
  jpycForwarderFor: vi.fn(() => null),
  relayGasFeeValue: vi.fn(() => 2n * 10n ** 18n),
}));
// L2: mock の戻り値は floor (relayGasFeeValue=2e18) と **別の distinctive な値** (7e18) にする。
// 以前は recoverFeeValue mock が 2e18 (= floor と同値) を返していたため、buildRecoverFeeDisplay
// が「recoverFeeValue を呼んで委譲している」のか「floor をハードコードしている」のかを区別できず
// テストが tautology だった。fee≠floor にすることで、表示が fee 側を使うこと (= 委譲) を実証する。
const DISTINCT_FEE = 7n * 10n ** 18n; // 7 JPYC: floor(2) とも 1000 とも異なる
vi.mock('@/lib/relay/recoverFee', () => ({
  recoverFeeValue: vi.fn(() => 7n * 10n ** 18n), // distinctive ≠ floor(2e18) で委譲を実証
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
      // distinctive fee (7 JPYC ≠ floor 2 JPYC) で「fee は recoverFeeValue 由来」を実証する。
      vi.mocked(recoverFeeValue).mockReturnValue(DISTINCT_FEE);
    });

    it('feeHuman は recoverFeeValue 由来 ("7"・floor の "2" ではない)・bps は 0', () => {
      const result = buildRecoverFeeDisplay(AMOUNT_1000, 137, 'customer');
      expect(result).not.toBeNull();
      expect(result!.bps).toBe(0);
      // 委譲フェンス: floor をハードコードしていたら "2" になるが、recoverFeeValue を呼べば "7"。
      expect(result!.feeHuman).toBe('7');
      // recoverFeeValue が (billAmount, gasMode, chainId) で実際に呼ばれたことを確認 (delegation の直接証明)。
      expect(recoverFeeValue).toHaveBeenCalledWith(AMOUNT_1000, 'customer', 137);
    });

    it('gasMode=customer: customerPaysHuman = amount + fee (fee=7)', () => {
      const result = buildRecoverFeeDisplay(AMOUNT_1000, 137, 'customer');
      expect(result!.gasMode).toBe('customer');
      expect(result!.customerPaysHuman).toBe('1007'); // 1000 + 7
      expect(result!.merchantReceivesHuman).toBe('1000');
    });

    it('gasMode=merchant: merchantReceivesHuman = amount − fee (fee=7)', () => {
      const result = buildRecoverFeeDisplay(AMOUNT_1000, 137, 'merchant');
      expect(result!.gasMode).toBe('merchant');
      expect(result!.customerPaysHuman).toBe('1000');
      expect(result!.merchantReceivesHuman).toBe('993'); // 1000 - 7
      expect(result!.tooSmall).toBe(false);
    });

    it('merchant mode, billAmount < fee: tooSmall true + merchantReceives clamped to "0"', () => {
      // merchant が 1 JPYC・fee 7 JPYC → 1 - fee がマイナスになる。負の受取額を
      // 表示せず '0' にクランプし、tooSmall フラグを立てる (F2)。
      const ONE_JPYC = 1n * 10n ** 18n;
      const result = buildRecoverFeeDisplay(ONE_JPYC, 137, 'merchant');
      expect(result).not.toBeNull();
      expect(result!.tooSmall).toBe(true);
      expect(result!.merchantReceivesHuman).toBe('0');
    });

    it('merchant mode, billAmount === fee: tooSmall true (<= 境界) + merchantReceives "0"', () => {
      // billAmount == fee (7 JPYC) も受取 0 で受付不可。<= 境界が含まれることを fence。
      // distinctive fee (7) ちょうどの billAmount を渡し、境界が floor ではなく fee で効くことを示す。
      const SEVEN_JPYC = 7n * 10n ** 18n;
      const result = buildRecoverFeeDisplay(SEVEN_JPYC, 137, 'merchant');
      expect(result!.tooSmall).toBe(true);
      expect(result!.merchantReceivesHuman).toBe('0');
    });

    it('customer mode, small amount: tooSmall false (顧客が amount+fee を払うので成立)', () => {
      // customer 負担では金額が手数料以下でも顧客が amount + fee を払うため受付可能。
      // tooSmall は merchant 専用フラグなので常に false。
      const ONE_JPYC = 1n * 10n ** 18n;
      const result = buildRecoverFeeDisplay(ONE_JPYC, 137, 'customer');
      expect(result!.tooSmall).toBe(false);
      expect(result!.customerPaysHuman).toBe('8'); // 1 + 7
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
