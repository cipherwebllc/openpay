import { describe, expect, it, vi } from 'vitest';
import { pageScopedLicenseRightsAdmission } from '@/lib/license/rightsAdmission';

// 第 7 回レビュー B9 (follow-up): 1 ページ 1 枠。最初の RPC の直前に 1 回だけ取り、項目ごとの release は
// 何もせず、close で実体へ返す。
describe('page-scoped license rights admission', () => {
  it('acquires the underlying slot once, hands the same lease to every item and releases only on close', async () => {
    const base = { acquire: vi.fn(async () => 'lease'), release: vi.fn(async () => undefined) };
    const page = pageScopedLicenseRightsAdmission(base);
    expect(await page.admission.acquire()).toBe('lease');
    await page.admission.release('lease');
    expect(await page.admission.acquire()).toBe('lease');
    expect(base.acquire).toHaveBeenCalledTimes(1); expect(base.release).not.toHaveBeenCalled();
    await page.close(); await page.close();
    expect(base.release).toHaveBeenCalledTimes(1); expect(base.release).toHaveBeenCalledWith('lease');
  });
  it('a failed first acquisition is not retried within the page and close releases nothing', async () => {
    const base = { acquire: vi.fn(async () => null), release: vi.fn(async () => undefined) };
    const page = pageScopedLicenseRightsAdmission(base);
    expect(await page.admission.acquire()).toBeNull(); expect(await page.admission.acquire()).toBeNull();
    expect(base.acquire).toHaveBeenCalledTimes(1);
    await page.close(); expect(base.release).not.toHaveBeenCalled();
  });
  it('never touches the underlying slot when no item asked for it', async () => {
    const base = { acquire: vi.fn(async () => 'lease'), release: vi.fn(async () => undefined) };
    const page = pageScopedLicenseRightsAdmission(base);
    await page.close(); expect(base.acquire).not.toHaveBeenCalled(); expect(base.release).not.toHaveBeenCalled();
  });
});
