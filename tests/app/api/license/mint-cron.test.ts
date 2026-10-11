import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ auth: vi.fn(), enabled: true, run: vi.fn(), sweep: vi.fn() }));
vi.mock('@/lib/cronAuth', () => ({ requireCronAuth: h.auth }));
vi.mock('@/lib/license/config', () => ({ licenseNftEnabled: () => h.enabled }));
vi.mock('@/lib/license/minter', () => ({ runLicenseWorker: h.run }));
vi.mock('@/lib/license/holdSweep', () => ({ LICENSE_HOLD_SWEEP_DEADLINE_MS: 50_000, runLicenseHoldSweep: h.sweep }));
import { GET, maxDuration } from '@/app/api/cron/license-mint/route';
const request = () => new Request('https://open-pay.jp/api/cron/license-mint');
const SWEPT = { ok: true, checked: 0, released: 0, settled: 0, pending: 0, skipped: 0, storageErrors: 0, deferred: 0, backlog: { pendingCount: 0, pendingOldestWaitMs: 0, holdCount: 0, stuckHolds: 0 }, exceeded: [] };
beforeEach(() => { vi.clearAllMocks(); vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000); h.auth.mockReturnValue(true); h.enabled = true; h.sweep.mockResolvedValue(SWEPT); });
afterEach(() => { vi.restoreAllMocks(); });
describe('license mint cron', () => {
  it('requires cron auth and honors OFF before invoking worker', async () => {
    h.auth.mockReturnValueOnce(false); expect((await GET(request())).status).toBe(401); h.enabled = false; expect((await GET(request())).status).toBe(404); expect(h.run).not.toHaveBeenCalled();
    expect(h.sweep).not.toHaveBeenCalled();
  });
  // 押さえの掃除 (holdSweep) は worker の結果に `holds` として足すだけで、worker の結果・40 秒の予算・status は従来どおり。
  it.each([{ ok: true, processed: 1, failed: 0, status: 200 }, { ok: true, skipped: 'locked', processed: 0, failed: 0, status: 200 }, { ok: false, error: 'storage_unavailable', status: 503 }, { ok: true, processed: 1, failed: 1, status: 503 }])('surfaces worker outcomes with the unchanged 40s dispatch budget: $status', async ({ status, ...result }) => {
    h.run.mockResolvedValue(result); const started = Date.now(); const response = await GET(request()); expect(response.status).toBe(status); expect(await response.json()).toEqual({ ...result, holds: SWEPT }); expect(maxDuration).toBe(60); expect(h.run).toHaveBeenCalledTimes(1); expect(h.run).toHaveBeenCalledWith({ deadline: started + 40_000 });
  });
  it('sweeps expired license holds after the worker within the 60s maxDuration', async () => {
    const order: string[] = [];
    h.run.mockImplementation(async () => { order.push('worker'); return { ok: true, processed: 0, failed: 0 }; });
    h.sweep.mockImplementation(async () => { order.push('sweep'); return SWEPT; });
    const started = Date.now();
    await GET(request());
    expect(order).toEqual(['worker', 'sweep']);
    expect(h.sweep).toHaveBeenCalledWith({ deadline: started + 50_000 });
    expect(started + 50_000).toBeLessThan(started + maxDuration * 1000);
  });
  it.each([{ ok: false, error: 'storage_unavailable' }, { ok: false, error: 'sweep_failed' }])('a failed sweep ($error) does not change the worker status', async (swept) => {
    h.run.mockResolvedValue({ ok: true, processed: 1, failed: 0 }); h.sweep.mockResolvedValue(swept);
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, processed: 1, failed: 0, holds: swept });
  });
});
