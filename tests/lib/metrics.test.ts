// 月次メトリクス (運営ヒント) のフェンス: key 形式・UTC 月バケット・no-throw 隔離。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const kv = vi.hoisted(() => ({ kvIncr: vi.fn() }));
vi.mock('@/lib/kv', () => kv);
vi.mock('server-only', () => ({}));

import {
  currentMetricMonth,
  METRIC_KINDS,
  monthlyMetricKey,
  recordMetric,
  recordMetricAfterResponse,
} from '@/lib/metrics';

beforeEach(() => {
  kv.kvIncr.mockReset();
});

describe('metrics', () => {
  it('kind 一覧は scripts/metrics-report.mjs と同期 (drift 検出)', () => {
    expect([...METRIC_KINDS]).toEqual([
      'relay_jpyc',
      'x402_settle',
      'order',
      'store_purchase',
    ]);
  });

  it('key は metrics:<YYYY-MM>:<kind>・月は UTC', () => {
    expect(monthlyMetricKey('order', '2026-08')).toBe('metrics:2026-08:order');
    // 2026-08-31T23:30Z は UTC では 8 月 (JST では 9/1)
    expect(currentMetricMonth(Date.UTC(2026, 7, 31, 23, 30))).toBe('2026-08');
  });

  it('recordMetric は現在月キーへ INCR', async () => {
    kv.kvIncr.mockResolvedValue({ ok: true, value: 1 });
    await recordMetric('relay_jpyc');
    expect(kv.kvIncr).toHaveBeenCalledTimes(1);
    const key = kv.kvIncr.mock.calls[0][0] as string;
    expect(key).toMatch(/^metrics:\d{4}-\d{2}:relay_jpyc$/);
  });

  it('recordMetricAfterResponse はリクエストスコープ外 (after 不可) でも throw せず計上する', async () => {
    kv.kvIncr.mockResolvedValue({ ok: true, value: 1 });
    expect(() => recordMetricAfterResponse('store_purchase')).not.toThrow();
    await vi.waitFor(() => expect(kv.kvIncr).toHaveBeenCalledTimes(1));
    expect(kv.kvIncr.mock.calls[0][0]).toMatch(
      /^metrics:\d{4}-\d{2}:store_purchase$/,
    );
  });

  it('KV 障害 (ok:false / throw) でも throw しない', async () => {
    kv.kvIncr.mockResolvedValue({ ok: false });
    await expect(recordMetric('order')).resolves.toBeUndefined();
    kv.kvIncr.mockRejectedValue(new Error('kv down'));
    await expect(recordMetric('x402_settle')).resolves.toBeUndefined();
  });
});
