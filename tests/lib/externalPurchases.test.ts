// /transparency 「9. 外部からの実購入」の SOT フェンス。
// 自社・関係者ウォレットの動作確認決済が混入すると「8. 実績の数え方」の約束 (自己購入除外) を
// 公開ページで破ることになるので、ここで機械的に止める。

import { describe, expect, it } from 'vitest';
import { isAddress } from 'viem';
import {
  EXTERNAL_PURCHASES,
  EXTERNAL_PURCHASES_AS_OF,
  FIRST_PARTY_WALLETS,
  basescanTxUrl,
  externalPurchaseSummary,
  shortAddress,
} from '@/lib/externalPurchases';
import { transparencyContentFor } from '@/lib/transparency';

describe('external purchases (transparency §9)', () => {
  it('自社・関係者ウォレットの行を含まない', () => {
    const own = new Set(FIRST_PARTY_WALLETS.map((a) => a.toLowerCase()));
    for (const row of EXTERNAL_PURCHASES) {
      expect(own.has(row.payer.toLowerCase()), row.tx).toBe(false);
    }
  });

  it('各行は検証可能な形 (checksum address・64 桁 tx・USDC/Base・日付昇順・重複なし)', () => {
    const txs = new Set<string>();
    let prev = '';
    for (const row of EXTERNAL_PURCHASES) {
      expect(isAddress(row.payer), row.tx).toBe(true);
      expect(row.tx).toMatch(/^0x[0-9a-f]{64}$/);
      expect(txs.has(row.tx)).toBe(false);
      txs.add(row.tx);
      expect(row.chain).toBe('base');
      expect(row.asset).toBe('USDC');
      expect(row.amount).toMatch(/^[0-9]+(\.[0-9]+)?$/);
      expect(row.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(row.date >= prev).toBe(true);
      prev = row.date;
      expect(row.date <= EXTERNAL_PURCHASES_AS_OF).toBe(true);
    }
  });

  it('集計 (2026-09-11 時点) と表示文言が一致する', () => {
    const summary = externalPurchaseSummary();
    expect(summary).toEqual({ buyers: 11, settlements: 20, first: '2026-07-19', last: '2026-09-08' });
    for (const locale of ['ja', 'en'] as const) {
      const c = transparencyContentFor(locale);
      expect(c.externalSummary).toContain(String(summary.buyers));
      expect(c.externalSummary).toContain(String(summary.settlements));
      expect(c.externalSummary).toContain(summary.first!);
      expect(c.externalLead).toContain(EXTERNAL_PURCHASES_AS_OF);
      // 保証と誤読される表現を入れない (稼働率・納品の保証ではない旨は caveat に固定)。
      expect(c.externalCaveat.length).toBeGreaterThan(10);
    }
  });

  it('表示ヘルパー', () => {
    expect(shortAddress('0x7e571e959cc7c75ccdd2eac24f8775ea2eaa2f09')).toBe('0x7e57…2f09');
    expect(basescanTxUrl('0xabc')).toBe('https://basescan.org/tx/0xabc');
  });
});
