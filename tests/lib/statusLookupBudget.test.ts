// lib/relay/statusLookupBudget.ts: 署名なしの relay status の照会が小分けの探索を始めてよいか (第 9 回レビュー A-3)。
// 鍵 (チェーン単位の 1 分の窓・(chain, from, nonce) の重複の抑止)、上限の境目、KV の障害で探索を止めない (fail-open) を固定する。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';

const h = vi.hoisted(() => ({
  configured: true,
  kvSet: vi.fn(),
  kvIncr: vi.fn(),
}));

vi.mock('@/lib/kv', () => ({
  isKvConfigured: () => h.configured,
  kvSet: h.kvSet,
  kvIncr: h.kvIncr,
}));

import {
  NONCE_LOOKUP_NARROW_SEARCH_DEDUP_SEC,
  NONCE_LOOKUP_NARROW_SEARCH_PER_MINUTE,
  claimNonceLookupNarrowSearch,
  narrowSearchBudgetKey,
  narrowSearchOnceKey,
} from '@/lib/relay/statusLookupBudget';

const FROM = '0xAbCdEf0000000000000000000000000000000001' as Address;
const NONCE = `0x${'Ab'.repeat(32)}` as Hex;

beforeEach(() => {
  h.configured = true;
  h.kvSet.mockReset().mockResolvedValue({ ok: true, value: 'OK' });
  h.kvIncr.mockReset().mockResolvedValue({ ok: true, value: 1 });
});

describe('claimNonceLookupNarrowSearch', () => {
  it('鍵はチェーン単位の 1 分の窓と (chain, from, nonce) だけ (未署名の validBefore を含めない)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-05T00:00:59Z'));
      expect(await claimNonceLookupNarrowSearch(137, FROM, NONCE)).toBe(true);
      const minute = Math.floor(Date.parse('2026-11-05T00:00:59Z') / 60_000);
      expect(narrowSearchBudgetKey(137)).toBe(`relay:status:narrow:budget:137:${minute}`);
      expect(narrowSearchOnceKey(137, FROM, NONCE)).toBe(
        `relay:status:narrow:once:137:${FROM.toLowerCase()}:${NONCE.toLowerCase()}`,
      );
      expect(h.kvSet).toHaveBeenCalledWith(narrowSearchOnceKey(137, FROM, NONCE), '1', {
        nx: true,
        ttlSec: NONCE_LOOKUP_NARROW_SEARCH_DEDUP_SEC,
      });
      expect(h.kvIncr).toHaveBeenCalledWith(`relay:status:narrow:budget:137:${minute}`, { initialTtlSec: 120 });
    } finally {
      vi.useRealTimers();
    }
  });

  it(`上限 (${NONCE_LOOKUP_NARROW_SEARCH_PER_MINUTE} 回) までは許し、超えたら断る`, async () => {
    h.kvIncr.mockResolvedValueOnce({ ok: true, value: NONCE_LOOKUP_NARROW_SEARCH_PER_MINUTE });
    expect(await claimNonceLookupNarrowSearch(137, FROM, NONCE)).toBe(true);
    h.kvIncr.mockResolvedValueOnce({ ok: true, value: NONCE_LOOKUP_NARROW_SEARCH_PER_MINUTE + 1 });
    expect(await claimNonceLookupNarrowSearch(137, FROM, NONCE)).toBe(false);
  });

  it('同じ nonce を直近に探していれば断り、共有の予算は減らさない', async () => {
    h.kvSet.mockResolvedValueOnce({ ok: true, value: null });
    expect(await claimNonceLookupNarrowSearch(137, FROM, NONCE)).toBe(false);
    expect(h.kvIncr).not.toHaveBeenCalled();
  });

  it('KV が無ければ KV に触れずに許す (fail-open)', async () => {
    h.configured = false;
    expect(await claimNonceLookupNarrowSearch(137, FROM, NONCE)).toBe(true);
    expect(h.kvSet).not.toHaveBeenCalled();
    expect(h.kvIncr).not.toHaveBeenCalled();
  });

  it('重複の抑止の保存に失敗しても予算で判定する (fail-open は抑止だけ)', async () => {
    h.kvSet.mockResolvedValueOnce({ ok: false, reason: 'http_error' });
    h.kvIncr.mockResolvedValueOnce({ ok: true, value: NONCE_LOOKUP_NARROW_SEARCH_PER_MINUTE + 1 });
    expect(await claimNonceLookupNarrowSearch(137, FROM, NONCE)).toBe(false);
  });

  it('予算の保存に失敗したら許す (fail-open: 決済済みの復旧を止めない)', async () => {
    h.kvIncr.mockResolvedValueOnce({ ok: false, reason: 'http_error' });
    expect(await claimNonceLookupNarrowSearch(137, FROM, NONCE)).toBe(true);
  });

  it('KV の想定外の例外でも投げずに許す (no-throw)', async () => {
    h.kvSet.mockRejectedValueOnce(new Error('boom'));
    await expect(claimNonceLookupNarrowSearch(137, FROM, NONCE)).resolves.toBe(true);
  });
});
