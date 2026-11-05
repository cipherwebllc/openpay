// lib/relay/statusLookupBudget.ts: 署名なしの relay status の照会が小分けの探索を始めてよいか (第 9 回レビュー A-3)。
// 鍵 (チェーン単位の 1 分の窓・(chain, from, nonce) の重複の抑止)、上限の境目、予算で断ったときに自分の重複の鍵だけを
// 消すこと、KV の障害・遅れで探索を止めない (fail-open・判定全体の待ちの上限) を固定する。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import { RELEASE_PAYMENT_CLAIM_IF_OWNED } from '@/lib/paymentClaim';

const h = vi.hoisted(() => ({
  configured: true,
  kvSet: vi.fn(),
  kvIncr: vi.fn(),
  kvEval: vi.fn(),
}));

vi.mock('@/lib/kv', () => ({
  isKvConfigured: () => h.configured,
  kvSet: h.kvSet,
  kvIncr: h.kvIncr,
  kvEval: h.kvEval,
}));

import {
  NONCE_LOOKUP_NARROW_SEARCH_CLAIM_TIMEOUT_MS,
  NONCE_LOOKUP_NARROW_SEARCH_DEDUP_SEC,
  NONCE_LOOKUP_NARROW_SEARCH_PER_MINUTE,
  claimNonceLookupNarrowSearch,
  narrowSearchBudgetKey,
  narrowSearchOnceKey,
} from '@/lib/relay/statusLookupBudget';

const FROM = '0xAbCdEf0000000000000000000000000000000001' as Address;
const NONCE = `0x${'Ab'.repeat(32)}` as Hex;
const ONCE_KEY = narrowSearchOnceKey(137, FROM, NONCE);
const OVER = { ok: true, value: NONCE_LOOKUP_NARROW_SEARCH_PER_MINUTE + 1 } as const;
/** 解決しない KV の往復 (遅い KV)。 */
const never = () => new Promise<never>(() => {});

beforeEach(() => {
  h.configured = true;
  h.kvSet.mockReset().mockResolvedValue({ ok: true, value: 'OK' });
  h.kvIncr.mockReset().mockResolvedValue({ ok: true, value: 1 });
  h.kvEval.mockReset().mockResolvedValue({ ok: true, value: 1 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('claimNonceLookupNarrowSearch', () => {
  it('鍵はチェーン単位の 1 分の窓と (chain, from, nonce) だけ (未署名の validBefore を含めない)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-05T00:00:59Z'));
    expect(await claimNonceLookupNarrowSearch(137, FROM, NONCE)).toBe(true);
    const minute = Math.floor(Date.parse('2026-11-05T00:00:59Z') / 60_000);
    expect(narrowSearchBudgetKey(137)).toBe(`relay:status:narrow:budget:137:${minute}`);
    expect(ONCE_KEY).toBe(`relay:status:narrow:once:137:${FROM.toLowerCase()}:${NONCE.toLowerCase()}`);
    expect(h.kvSet).toHaveBeenCalledWith(ONCE_KEY, expect.any(String), {
      nx: true,
      ttlSec: NONCE_LOOKUP_NARROW_SEARCH_DEDUP_SEC,
    });
    expect(h.kvIncr).toHaveBeenCalledWith(`relay:status:narrow:budget:137:${minute}`, { initialTtlSec: 120 });
  });

  it(`上限 (${NONCE_LOOKUP_NARROW_SEARCH_PER_MINUTE} 回) までは許して重複の鍵を残し、超えたら断る`, async () => {
    h.kvIncr.mockResolvedValueOnce({ ok: true, value: NONCE_LOOKUP_NARROW_SEARCH_PER_MINUTE });
    expect(await claimNonceLookupNarrowSearch(137, FROM, NONCE)).toBe(true);
    expect(h.kvEval).not.toHaveBeenCalled();
    h.kvIncr.mockResolvedValueOnce(OVER);
    expect(await claimNonceLookupNarrowSearch(137, FROM, NONCE)).toBe(false);
  });

  it('予算で断ったら、自分が置いた重複の鍵だけを消す (自分の token で compare-and-delete)', async () => {
    h.kvIncr.mockResolvedValueOnce(OVER);
    expect(await claimNonceLookupNarrowSearch(137, FROM, NONCE)).toBe(false);
    const token = h.kvSet.mock.calls[0][1] as string;
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.kvEval).toHaveBeenCalledWith(RELEASE_PAYMENT_CLAIM_IF_OWNED, [ONCE_KEY], [token]);
  });

  it('token は要求ごとに違う (並行する別の要求の鍵を消さない)', async () => {
    h.kvIncr.mockResolvedValue(OVER);
    await claimNonceLookupNarrowSearch(137, FROM, NONCE);
    await claimNonceLookupNarrowSearch(137, FROM, NONCE);
    const [a, b] = h.kvSet.mock.calls.map((c) => c[1] as string);
    expect(a).not.toBe(b);
    expect(h.kvEval.mock.calls.map((c) => c[2])).toEqual([[a], [b]]);
  });

  it('同じ nonce を直近に探していれば断り、共有の予算も重複の鍵の解放も触らない', async () => {
    h.kvSet.mockResolvedValueOnce({ ok: true, value: null });
    expect(await claimNonceLookupNarrowSearch(137, FROM, NONCE)).toBe(false);
    expect(h.kvIncr).not.toHaveBeenCalled();
    expect(h.kvEval).not.toHaveBeenCalled();
  });

  it('KV が無ければ KV に触れずに許す (fail-open)', async () => {
    h.configured = false;
    expect(await claimNonceLookupNarrowSearch(137, FROM, NONCE)).toBe(true);
    expect(h.kvSet).not.toHaveBeenCalled();
    expect(h.kvIncr).not.toHaveBeenCalled();
  });

  it('重複の抑止の保存に失敗しても予算で判定する (fail-open は抑止だけ)', async () => {
    h.kvSet.mockResolvedValueOnce({ ok: false, reason: 'http_error' });
    h.kvIncr.mockResolvedValueOnce(OVER);
    expect(await claimNonceLookupNarrowSearch(137, FROM, NONCE)).toBe(false);
  });

  it('予算の保存に失敗したら許す (fail-open: 決済済みの復旧を止めない)', async () => {
    h.kvIncr.mockResolvedValueOnce({ ok: false, reason: 'http_error' });
    expect(await claimNonceLookupNarrowSearch(137, FROM, NONCE)).toBe(true);
  });

  it('鍵の解放に失敗しても断ったまま (鍵は期限まで残るだけ)', async () => {
    h.kvIncr.mockResolvedValueOnce(OVER);
    h.kvEval.mockResolvedValueOnce({ ok: false, reason: 'http_error' });
    expect(await claimNonceLookupNarrowSearch(137, FROM, NONCE)).toBe(false);
  });

  it('KV の想定外の例外でも投げずに許す (no-throw)', async () => {
    h.kvSet.mockRejectedValueOnce(new Error('boom'));
    await expect(claimNonceLookupNarrowSearch(137, FROM, NONCE)).resolves.toBe(true);
  });

  it(`KV が遅いときは判定全体の上限 (${NONCE_LOOKUP_NARROW_SEARCH_CLAIM_TIMEOUT_MS} ms) で許す (KV の 5 秒 × 往復を待たない)`, async () => {
    // 上限は短く (client の fetch の期限 10 秒から、広い検索・小分けの探索 6 秒・receipt の照合の分を残す)
    expect(NONCE_LOOKUP_NARROW_SEARCH_CLAIM_TIMEOUT_MS).toBeGreaterThanOrEqual(1_000);
    expect(NONCE_LOOKUP_NARROW_SEARCH_CLAIM_TIMEOUT_MS).toBeLessThanOrEqual(1_500);
    vi.useFakeTimers();
    h.kvSet.mockImplementationOnce(never);
    let result: boolean | undefined;
    void claimNonceLookupNarrowSearch(137, FROM, NONCE).then((v) => {
      result = v;
    });
    await vi.advanceTimersByTimeAsync(NONCE_LOOKUP_NARROW_SEARCH_CLAIM_TIMEOUT_MS - 1);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe(true);
  });

  it('上限は判定全体にかかる (重複の鍵は速くても予算の往復が遅ければ上限で許す)', async () => {
    vi.useFakeTimers();
    h.kvIncr.mockImplementationOnce(never);
    const pending = claimNonceLookupNarrowSearch(137, FROM, NONCE);
    await vi.advanceTimersByTimeAsync(NONCE_LOOKUP_NARROW_SEARCH_CLAIM_TIMEOUT_MS);
    expect(await pending).toBe(true);
  });

  it('時間切れで許したあとに予算超過が届いても、探索中の重複の鍵は消さない', async () => {
    vi.useFakeTimers();
    h.kvIncr.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(OVER), NONCE_LOOKUP_NARROW_SEARCH_CLAIM_TIMEOUT_MS + 500)),
    );
    const pending = claimNonceLookupNarrowSearch(137, FROM, NONCE);
    await vi.advanceTimersByTimeAsync(NONCE_LOOKUP_NARROW_SEARCH_CLAIM_TIMEOUT_MS);
    expect(await pending).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.kvEval).not.toHaveBeenCalled();
  });
});
