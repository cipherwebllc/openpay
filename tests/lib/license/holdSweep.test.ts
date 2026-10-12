// @vitest-environment node
// 押さえの掃除と滞留の監視 (lib/license/holdSweep.ts) の no-throw と KV の応答の扱い。本物の Lua での掃除・
// 在庫の解放・閾値は tests/lib/license/stock.test.ts の 'license hold sweep' が見る。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ kvEval: vi.fn(), kvSet: vi.fn(), getIntent: vi.fn(), reconcile: vi.fn(), warn: vi.fn() }));
vi.mock('@/lib/kv', () => ({ kvEval: h.kvEval, kvSet: h.kvSet }));
vi.mock('@/lib/logger', () => ({ logger: { warn: h.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/x402/purchaseIntent', () => ({
  getPurchaseIntent: h.getIntent,
  isPurchaseIntentSalt: (value: unknown) => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value),
  purchasePendingIndexKey: () => 'store:intent:pending',
  reconcilePurchaseIntent: h.reconcile,
  PURCHASE_QUOTE_TTL_SEC: 600,
  PURCHASE_RECONCILE_BATCH_SIZE: 50,
}));
import { LICENSE_HOLD_SWEEP_CURSOR_KEY, runLicenseHoldSweep } from '@/lib/license/holdSweep';

const NOW = 1_800_000_000_000;
const deadline = () => Date.now() + 60_000;
beforeEach(() => { vi.clearAllMocks(); h.kvSet.mockResolvedValue({ ok: true, value: 'OK' }); });

describe('runLicenseHoldSweep isolation', () => {
  it('reads the backlog and the sweep targets in one read-only EVAL over the hold and pending indexes', async () => {
    h.kvEval.mockResolvedValue({ ok: true, value: [0, 0, '', [], 0, []] });
    expect(await runLicenseHoldSweep({ now: NOW, deadline: deadline() })).toMatchObject({ ok: true, checked: 0, backlog: { pendingCount: 0, holdCount: 0 } });
    expect(h.kvEval).toHaveBeenCalledTimes(1);
    const [script, keys, args] = h.kvEval.mock.calls[0]!;
    // 3 つ目は前回の続きを示す cursor (Lua は押さえがあるときだけ読む)。
    expect(keys).toEqual(['store:license:holds', 'store:intent:pending', 'store:license:holds:sweep_cursor']);
    // score の範囲 = [now − 7 時間, now − 10 分]・最大 20 件。7 時間より古い押さえの見本は最大 3 件。
    expect(args).toEqual([String(NOW - 7 * 3_600_000), String(NOW - 600_000), '20', '3']);
    expect(script).not.toMatch(/"(?:SET|DEL|ZADD|ZREM|EXPIRE)"/);
    // 押さえが 0 件の run は cursor を書かない (KV のコマンドは EVAL 1 本のまま)。
    expect(h.kvSet).not.toHaveBeenCalled();
    expect(h.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['KV failure', { ok: false, reason: 'network_error' }],
    ['non-array reply', { ok: true, value: 'OK' }],
    ['non-numeric count', { ok: true, value: ['1', 0, '', [], 0, []] }],
    ['non-string member', { ok: true, value: [1, 0, '', [7], 0, []] }],
    ['non-string member with a score', { ok: true, value: [1, 0, '', [7, '1'], 0, []] }],
    ['hold without its score', { ok: true, value: [1, 0, '', [`0x${'a'.repeat(64)}`], 0, []] }],
    ['non-numeric hold score', { ok: true, value: [1, 0, '', [`0x${'a'.repeat(64)}`, 'abc'], 0, []] }],
    ['empty hold score', { ok: true, value: [1, 0, '', [`0x${'a'.repeat(64)}`, ''], 0, []] }],
    ['non-numeric score', { ok: true, value: [0, 1, 'abc', [], 0, []] }],
    ['missing stale count', { ok: true, value: [0, 0, '', []] }],
    ['non-string stale sample', { ok: true, value: [1, 0, '', [], 1, [7]] }],
  ] as const)('%s is storage_unavailable with a sweep warn, never a silent zero', async (_name, reply) => {
    h.kvEval.mockResolvedValue(reply);
    expect(await runLicenseHoldSweep({ now: NOW, deadline: deadline() })).toEqual({ ok: false, error: 'storage_unavailable' });
    expect(h.warn).toHaveBeenCalledWith('license.hold_sweep_failed', { reason: 'storage' });
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  it('an unexpected exception is contained (no throw to the cron) and warned', async () => {
    const error = new Error('boom');
    h.kvEval.mockRejectedValue(error);
    expect(await runLicenseHoldSweep({ now: NOW, deadline: deadline() })).toEqual({ ok: false, error: 'sweep_failed' });
    expect(h.warn).toHaveBeenCalledWith('license.hold_sweep_failed', { reason: 'exception', error });
  });

  it('intent read and reconcile storage failures are counted and warned without stopping the other holds', async () => {
    const a = `0x${'a'.repeat(64)}`; const b = `0x${'b'.repeat(64)}`;
    h.kvEval.mockResolvedValue({ ok: true, value: [2, 0, '', [a, String(NOW - 3_600_000), b, String(NOW - 3_000_000)], 0, []] });
    const intent = { metadata: { productKind: 'license' }, state: 'failed_prebroadcast', failureReason: 'ip_rate_limited', claim: { validBefore: String(NOW / 1000 - 1200) } };
    h.getIntent.mockImplementation(async (salt: string) => salt === a ? 'storage' : intent);
    h.reconcile.mockResolvedValue({ ok: false, reason: 'storage' });
    const result = await runLicenseHoldSweep({ now: NOW, deadline: deadline() });
    expect(result).toMatchObject({ ok: true, checked: 1, storageErrors: 2 });
    expect(h.reconcile).toHaveBeenCalledWith(b, { now: NOW, deadline: expect.any(Number) });
    expect(h.warn).toHaveBeenCalledWith('license.hold_sweep_failed', { reason: 'storage', storageErrors: 2 });
  });
});

// 前回の続きから読む cursor (決着しない押さえが 20 件以上あっても、後ろの押さえを 15 分おきに照合する)。読む範囲 (wrap) は
// 本物の Lua で tests/lib/license/holdSweep-lua.test.ts が見る。ここは cursor に何を書くか・書かないか。
describe('runLicenseHoldSweep cursor', () => {
  const salt = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
  const expired = { metadata: { productKind: 'license' }, state: 'failed_prebroadcast', failureReason: 'ip_rate_limited', claim: { validBefore: String(NOW / 1000 - 1200) } };
  const reply = (holds: [string, number][]) => ({ ok: true, value: [holds.length, 0, '', holds.flatMap(([member, score]) => [member, String(score)]), 0, []] });
  const CURSOR_TTL_SEC = 7 * 3600;
  afterEach(() => { vi.useRealTimers(); });

  it('writes the score of the last processed hold once with the range TTL; the recount does not pass the cursor key', async () => {
    h.kvEval.mockResolvedValue(reply([[salt(1), NOW - 3_000_000], ['not-a-salt', NOW - 2_900_000], [salt(3), NOW - 2_800_000]]));
    h.getIntent.mockResolvedValue(expired);
    h.reconcile.mockResolvedValue({ ok: true, state: 'pending' });
    expect(await runLicenseHoldSweep({ now: NOW, deadline: deadline() })).toMatchObject({ ok: true, checked: 2, skipped: 1, pending: 2, deferred: 0 });
    expect(h.reconcile.mock.calls.map(([member]) => member)).toEqual([salt(1), salt(3)]);
    expect(h.kvSet).toHaveBeenCalledTimes(1);
    expect(h.kvSet).toHaveBeenCalledWith(LICENSE_HOLD_SWEEP_CURSOR_KEY, String(NOW - 2_800_000), { ttlSec: CURSOR_TTL_SEC });
    // 数え直し (照合した run の 2 回目の EVAL) は cursor の key を渡さない = Lua は cursor を読まない。
    expect(h.kvEval).toHaveBeenCalledTimes(2);
    expect(h.kvEval.mock.calls[1]![1]).toEqual(['store:license:holds', 'store:intent:pending']);
  });

  it('a skipped hold advances the cursor; a hold whose intent could not be read does not', async () => {
    h.kvEval.mockResolvedValue(reply([[salt(1), NOW - 3_000_000], [salt(2), NOW - 2_900_000]]));
    h.getIntent.mockImplementation(async (member: string) => member === salt(1) ? null : 'storage');
    expect(await runLicenseHoldSweep({ now: NOW, deadline: deadline() })).toMatchObject({ ok: true, checked: 0, skipped: 1, storageErrors: 1 });
    expect(h.kvSet).toHaveBeenCalledTimes(1);
    expect(h.kvSet).toHaveBeenCalledWith(LICENSE_HOLD_SWEEP_CURSOR_KEY, String(NOW - 3_000_000), { ttlSec: CURSOR_TTL_SEC });
  });

  it('does not advance the cursor past holds deferred by the deadline (the next run reads them first)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const end = NOW + 50_000;
    h.kvEval.mockResolvedValue(reply([[salt(1), NOW - 3_000_000], [salt(2), NOW - 2_900_000], [salt(3), NOW - 2_800_000]]));
    h.getIntent.mockResolvedValue(expired);
    // 1 件目の照合で締切を使い切る (残りは後回し)。
    h.reconcile.mockImplementation(async () => { vi.setSystemTime(end); return { ok: true, state: 'pending' }; });
    expect(await runLicenseHoldSweep({ now: NOW, deadline: end })).toMatchObject({ ok: true, checked: 1, pending: 1, deferred: 2 });
    expect(h.kvSet).toHaveBeenCalledTimes(1);
    expect(h.kvSet).toHaveBeenCalledWith(LICENSE_HOLD_SWEEP_CURSOR_KEY, String(NOW - 3_000_000), { ttlSec: CURSOR_TTL_SEC });
  });

  it('writes no cursor when every hold is deferred', async () => {
    h.kvEval.mockResolvedValue(reply([[salt(1), NOW - 3_000_000], [salt(2), NOW - 2_900_000]]));
    expect(await runLicenseHoldSweep({ now: NOW, deadline: Date.now() - 1 })).toMatchObject({ ok: true, checked: 0, deferred: 2 });
    expect(h.getIntent).not.toHaveBeenCalled();
    expect(h.kvSet).not.toHaveBeenCalled();
    expect(h.kvEval).toHaveBeenCalledTimes(1);
  });

  it('a failed cursor write is warned and changes nothing else in the result', async () => {
    h.kvEval.mockResolvedValue(reply([[salt(1), NOW - 3_000_000]]));
    h.getIntent.mockResolvedValue(expired);
    h.reconcile.mockResolvedValue({ ok: true, state: 'failed_prebroadcast' });
    h.kvSet.mockResolvedValue({ ok: false, reason: 'network_error' });
    expect(await runLicenseHoldSweep({ now: NOW, deadline: deadline() })).toEqual({
      ok: true, checked: 1, released: 1, settled: 0, pending: 0, skipped: 0, storageErrors: 0, deferred: 0, staleHolds: 0,
      backlog: { pendingCount: 0, pendingOldestWaitMs: 0, holdCount: 1, stuckHolds: 0 }, exceeded: [],
    });
    expect(h.warn).toHaveBeenCalledWith('license.hold_sweep_failed', { reason: 'storage', step: 'cursor' });
  });
});
