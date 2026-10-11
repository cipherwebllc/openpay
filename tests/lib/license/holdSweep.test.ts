// @vitest-environment node
// 押さえの掃除と滞留の監視 (lib/license/holdSweep.ts) の no-throw と KV の応答の扱い。本物の Lua での掃除・
// 在庫の解放・閾値は tests/lib/license/stock.test.ts の 'license hold sweep' が見る。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ kvEval: vi.fn(), getIntent: vi.fn(), reconcile: vi.fn(), warn: vi.fn() }));
vi.mock('@/lib/kv', () => ({ kvEval: h.kvEval }));
vi.mock('@/lib/logger', () => ({ logger: { warn: h.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/x402/purchaseIntent', () => ({
  getPurchaseIntent: h.getIntent,
  isPurchaseIntentSalt: (value: unknown) => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value),
  purchasePendingIndexKey: () => 'store:intent:pending',
  reconcilePurchaseIntent: h.reconcile,
  PURCHASE_QUOTE_TTL_SEC: 600,
  PURCHASE_RECONCILE_BATCH_SIZE: 50,
}));
import { runLicenseHoldSweep } from '@/lib/license/holdSweep';

const NOW = 1_800_000_000_000;
const deadline = () => Date.now() + 60_000;
beforeEach(() => { vi.clearAllMocks(); });

describe('runLicenseHoldSweep isolation', () => {
  it('reads the backlog and the sweep targets in one read-only EVAL over the hold and pending indexes', async () => {
    h.kvEval.mockResolvedValue({ ok: true, value: [0, 0, '', [], 0, []] });
    expect(await runLicenseHoldSweep({ now: NOW, deadline: deadline() })).toMatchObject({ ok: true, checked: 0, backlog: { pendingCount: 0, holdCount: 0 } });
    expect(h.kvEval).toHaveBeenCalledTimes(1);
    const [script, keys, args] = h.kvEval.mock.calls[0]!;
    expect(keys).toEqual(['store:license:holds', 'store:intent:pending']);
    // score の範囲 = [now − 7 時間, now − 10 分]・最大 20 件。7 時間より古い押さえの見本は最大 3 件。
    expect(args).toEqual([String(NOW - 7 * 3_600_000), String(NOW - 600_000), '20', '3']);
    expect(script).not.toMatch(/"(?:SET|DEL|ZADD|ZREM|EXPIRE)"/);
    expect(h.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['KV failure', { ok: false, reason: 'network_error' }],
    ['non-array reply', { ok: true, value: 'OK' }],
    ['non-numeric count', { ok: true, value: ['1', 0, '', [], 0, []] }],
    ['non-string member', { ok: true, value: [1, 0, '', [7], 0, []] }],
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
    h.kvEval.mockResolvedValue({ ok: true, value: [2, 0, '', [a, b], 0, []] });
    const intent = { metadata: { productKind: 'license' }, state: 'failed_prebroadcast', failureReason: 'ip_rate_limited', claim: { validBefore: String(NOW / 1000 - 1200) } };
    h.getIntent.mockImplementation(async (salt: string) => salt === a ? 'storage' : intent);
    h.reconcile.mockResolvedValue({ ok: false, reason: 'storage' });
    const result = await runLicenseHoldSweep({ now: NOW, deadline: deadline() });
    expect(result).toMatchObject({ ok: true, checked: 1, storageErrors: 2 });
    expect(h.reconcile).toHaveBeenCalledWith(b, { now: NOW, deadline: expect.any(Number) });
    expect(h.warn).toHaveBeenCalledWith('license.hold_sweep_failed', { reason: 'storage', storageErrors: 2 });
  });
});
