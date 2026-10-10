import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hold = vi.hoisted(() => ({
  enabled: true,
  result: {
    checked: 3,
    settled: 1,
    pending: 1,
    failedPrebroadcast: 1,
    storageErrors: 0,
  } as unknown,
}));

const reconcilePendingSpy = vi.hoisted(() => vi.fn());
const reconcileUsdcSpy = vi.hoisted(() => vi.fn());

vi.mock('@/lib/env', () => ({
  env: {
    get enableCreatorStore() {
      return hold.enabled;
    },
  },
}));

vi.mock('@/lib/x402/purchaseIntent', () => ({
  reconcilePendingPurchases: reconcilePendingSpy,
}));
vi.mock('@/lib/x402/storeUsdcIntent', () => ({
  reconcilePendingStoreUsdcPurchases: reconcileUsdcSpy,
}));

import { GET, maxDuration } from '@/app/api/cron/store-reconcile/route';
import { STORE_RECONCILE_CRON_MAX_DURATION_SEC } from '@/lib/x402/reconcileBudget';

function request(token?: string): Request {
  return new Request('https://open-pay.jp/api/cron/store-reconcile', {
    headers:
      token === undefined
        ? undefined
        : { authorization: `Bearer ${token}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CRON_SECRET', 'cron-test-secret');
  hold.enabled = true;
  hold.result = {
    checked: 3,
    settled: 1,
    pending: 1,
    failedPrebroadcast: 1,
    storageErrors: 0,
  };
  reconcilePendingSpy.mockImplementation(async () => hold.result);
  reconcileUsdcSpy.mockResolvedValue({
    checked: 0,
    settled: 0,
    failed: 0,
    pending: 0,
    storageErrors: 0,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/cron/store-reconcile', () => {
  // 第 7 回レビュー C14: 他の cron と同じく認証を flag より先に見る (無認証で 404/401 を見分けて
  // server flag の状態を知られない)。
  it('creator-store flag OFF でも無認証は 401 (flag の状態を出さない)', async () => {
    hold.enabled = false;

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(reconcilePendingSpy).not.toHaveBeenCalled();
    expect(reconcileUsdcSpy).not.toHaveBeenCalled();
  });

  it('creator-store flag OFF は認証のあとに 404 + no-store で停止する', async () => {
    hold.enabled = false;

    const response = await GET(request('cron-test-secret'));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(reconcilePendingSpy).not.toHaveBeenCalled();
    expect(reconcileUsdcSpy).not.toHaveBeenCalled();
  });

  it('CRON_SECRET 未設定は bearer の有無にかかわらず 401', async () => {
    vi.stubEnv('CRON_SECRET', '');

    const missing = await GET(request());
    const guessed = await GET(request('guess'));

    expect(missing.status).toBe(401);
    expect(guessed.status).toBe(401);
    expect(await guessed.json()).toEqual({ error: 'unauthorized' });
    expect(reconcilePendingSpy).not.toHaveBeenCalled();
    expect(reconcileUsdcSpy).not.toHaveBeenCalled();
  });

  it('CRON_SECRET 不一致は 401 で reconciler を呼ばない', async () => {
    const response = await GET(request('wrong-secret'));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(reconcilePendingSpy).not.toHaveBeenCalled();
    expect(reconcileUsdcSpy).not.toHaveBeenCalled();
  });

  it('正しい bearer は pending ZSET batch の core を一度だけ呼び summary を返す', async () => {
    const response = await GET(request('cron-test-secret'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      checked: 3,
      settled: 1,
      pending: 1,
      failedPrebroadcast: 1,
      storageErrors: 0,
      usdc: {
        checked: 0,
        settled: 0,
        failed: 0,
        pending: 0,
        storageErrors: 0,
      },
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(reconcilePendingSpy).toHaveBeenCalledTimes(1);
    expect(reconcilePendingSpy).toHaveBeenCalledWith({ deadline: expect.any(Number) });
    expect(reconcileUsdcSpy).toHaveBeenCalledTimes(1);
  });

  // 第 7 回レビュー B4: 走査量の上限だけでは cron の maxDuration を守れない。両 rail に経過時間の予算
  // (deadline) を渡し、JPYC が重くても USDC の番が来る。
  it('両 rail に maxDuration 内で収まる時間予算 (deadline) を渡し、USDC には JPYC の後の予算が残る', async () => {
    const started = Date.now();
    await GET(request('cron-test-secret'));
    const jpyc = reconcilePendingSpy.mock.calls[0]![0] as { deadline: number };
    const usdc = reconcileUsdcSpy.mock.calls[0]![0] as { deadline: number };
    expect(jpyc.deadline).toBeGreaterThan(started);
    expect(usdc.deadline).toBeGreaterThan(jpyc.deadline);
    expect(usdc.deadline).toBeLessThan(started + maxDuration * 1000);
    // route の maxDuration (Next は literal を要求) と予算の前提値のドリフトを止める。
    expect(maxDuration).toBe(STORE_RECONCILE_CRON_MAX_DURATION_SEC);
  });

  it('pending ZSET の取得障害は 503', async () => {
    hold.result = 'storage';

    const response = await GET(request('cron-test-secret'));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'storage_unavailable',
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('batch 内の storage error を成功 summary に偽装せず 503 で返す', async () => {
    hold.result = {
      checked: 2,
      settled: 1,
      pending: 0,
      failedPrebroadcast: 0,
      storageErrors: 1,
    };

    const response = await GET(request('cron-test-secret'));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      checked: 2,
      settled: 1,
      pending: 0,
      failedPrebroadcast: 0,
      storageErrors: 1,
      usdc: {
        checked: 0,
        settled: 0,
        failed: 0,
        pending: 0,
        storageErrors: 0,
      },
      error: 'storage_unavailable',
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});
