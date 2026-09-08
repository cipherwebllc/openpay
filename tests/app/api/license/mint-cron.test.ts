import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ auth: vi.fn(), enabled: true, run: vi.fn() }));
vi.mock('@/lib/cronAuth', () => ({ requireCronAuth: h.auth }));
vi.mock('@/lib/license/config', () => ({ licenseNftEnabled: () => h.enabled }));
vi.mock('@/lib/license/minter', () => ({ runLicenseWorker: h.run }));
import { GET, maxDuration } from '@/app/api/cron/license-mint/route';
const request = () => new Request('https://open-pay.jp/api/cron/license-mint');
beforeEach(() => { vi.clearAllMocks(); vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000); h.auth.mockReturnValue(true); h.enabled = true; });
afterEach(() => { vi.restoreAllMocks(); });
describe('license mint cron', () => {
  it('requires cron auth and honors OFF before invoking worker', async () => {
    h.auth.mockReturnValueOnce(false); expect((await GET(request())).status).toBe(401); h.enabled = false; expect((await GET(request())).status).toBe(404); expect(h.run).not.toHaveBeenCalled();
  });
  it.each([{ ok: true, processed: 1, failed: 0, status: 200 }, { ok: true, skipped: 'locked', processed: 0, failed: 0, status: 200 }, { ok: false, error: 'storage_unavailable', status: 503 }, { ok: true, processed: 1, failed: 1, status: 503 }])('surfaces worker outcomes with the unchanged 40s dispatch budget: $status', async ({ status, ...result }) => {
    h.run.mockResolvedValue(result); const started = Date.now(); const response = await GET(request()); expect(response.status).toBe(status); expect(await response.json()).toEqual(result); expect(maxDuration).toBe(60); expect(h.run).toHaveBeenCalledTimes(1); expect(h.run).toHaveBeenCalledWith({ deadline: started + 40_000 });
  });
});
