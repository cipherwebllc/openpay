// AI ストアのカードに出す更新型商品の鮮度 (lib/directory/monitorFreshness.ts)。
// 柱: (1) 4 path 全てに載る・JPYC 面と USDC 面は同じ値、(2) 値は共通 changelog の
// 末尾日付と件数から導出 (teaser / 有料版と同じ事実)、(3) スコープ分離 (決済ビューの
// 件数 ≠ サービスビューの件数)。

import { describe, expect, it } from 'vitest';
import { monitorFreshnessByPath } from '@/lib/directory/monitorFreshness';
import {
  JPYC_PAYMENTS_RESOURCE,
  JPYC_SERVICES_RESOURCE,
} from '@/lib/directory/paidResources';
import { scopedChangelog } from '@/lib/directory/serviceMonitor';
import { USDC_PAYMENT_MONITOR, USDC_SERVICE_MONITOR } from '@/lib/directory/usdcResource';

describe('monitorFreshnessByPath', () => {
  const byPath = monitorFreshnessByPath();

  it('Monitor 4 path すべてに鮮度が載り、JPYC 面と USDC 面は同一', () => {
    expect(Object.keys(byPath).sort()).toEqual(
      [
        JPYC_SERVICES_RESOURCE.path,
        USDC_SERVICE_MONITOR.path,
        JPYC_PAYMENTS_RESOURCE.path,
        USDC_PAYMENT_MONITOR.path,
      ].sort(),
    );
    expect(byPath[JPYC_SERVICES_RESOURCE.path]).toEqual(byPath[USDC_SERVICE_MONITOR.path]);
    expect(byPath[JPYC_PAYMENTS_RESOURCE.path]).toEqual(byPath[USDC_PAYMENT_MONITOR.path]);
  });

  it('値は共通 changelog の末尾日付 + 件数 (teaser と同じ事実)', () => {
    for (const [path, scope] of [
      [JPYC_SERVICES_RESOURCE.path, 'jpyc-services'],
      [JPYC_PAYMENTS_RESOURCE.path, 'stablecoin-payments'],
    ] as const) {
      const events = scopedChangelog(scope);
      expect(byPath[path]).toEqual({
        latestEventDate: events[events.length - 1].date,
        totalEvents: events.length,
      });
      expect(byPath[path].latestEventDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(byPath[path].totalEvents).toBeGreaterThan(0);
    }
  });

  it('スコープ分離: 決済ビューの件数はサービスビューと異なる', () => {
    expect(byPath[JPYC_PAYMENTS_RESOURCE.path].totalEvents).not.toBe(
      byPath[JPYC_SERVICES_RESOURCE.path].totalEvents,
    );
  });
});
