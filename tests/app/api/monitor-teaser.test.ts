// 無料 teaser 2 本 (/api/jpyc/services/teaser・/api/stablecoin-payments/teaser)。
// 柱: (1) flag OFF は 404、(2) 直近 3 イベントのみ・有料版の価値 (services 行/全件) を漏らさない、
// (3) fullFeed の価格は SoT (paidResources/usdcResource) と一致、(4) edge キャッシュヘッダ。

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  JPYC_PAYMENTS_RESOURCE,
  JPYC_SERVICES_RESOURCE,
} from '@/lib/directory/paidResources';
import { scopedChangelog } from '@/lib/directory/serviceMonitor';
import {
  USDC_PAYMENT_MONITOR,
  USDC_SERVICE_MONITOR,
} from '@/lib/directory/usdcResource';

type StaticRoute = { GET: () => Promise<Response> };

async function load(flag = '1'): Promise<{
  services: StaticRoute;
  payments: StaticRoute;
}> {
  vi.stubEnv('NEXT_PUBLIC_ENABLE_WEB3_DIRECTORY', flag);
  vi.resetModules();
  return {
    services: (await import('@/app/api/jpyc/services/teaser/route')) as StaticRoute,
    payments: (await import(
      '@/app/api/stablecoin-payments/teaser/route'
    )) as StaticRoute,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('monitor teasers', () => {
  it('flag OFF は両方 404', async () => {
    const { services, payments } = await load('');
    expect((await services.GET()).status).toBe(404);
    expect((await payments.GET()).status).toBe(404);
  });

  it('services teaser: 直近 3 イベントのみ・監視ビュー行なし・価格は SoT と一致', async () => {
    const { services } = await load();
    const res = await services.GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(
      'public, s-maxage=300, stale-while-revalidate=600',
    );
    const body = await res.json();
    expect(body.product).toBe('jpyc-service-monitor');
    expect(body.teaser).toBe(true);
    expect(body.latestChanges).toHaveLength(3);
    expect(body.totalEvents).toBeGreaterThan(3); // teaser が全量でないことの開示
    // E28: totalEvents は limit で切られた view (envelope.changes) ではなく changelog の実数。
    // limit 上限を超えて成長したときに開示が過少にならないよう SoT に固定する。
    expect(body.totalEvents).toBe(scopedChangelog('jpyc-services').length);
    // 有料版の価値をここに出さない。
    expect(body).not.toHaveProperty('services');
    expect(body).not.toHaveProperty('changes');
    expect(body.fullFeed.priceJpyc).toBe(JPYC_SERVICES_RESOURCE.priceJpyc);
    expect(body.fullFeed.priceUsd).toBe(USDC_SERVICE_MONITOR.priceUsd);
    expect(body.fullFeed.hint).toContain('nextChangedSince');
    // 「買う前に確かめる」契約: latestChanges は日付昇順の末尾 (= 最大日付) なので、
    // 最終日付 < 保存済み nextChangedSince なら有料 delta は空 = 買わなくてよい。
    expect(body.fullFeed.hint).toContain('skip the purchase');
    const dates = body.latestChanges.map((e: { date: string }) => e.date);
    expect([...dates].sort()).toEqual(dates);
    expect(body.notice.code).toBe('sourced-facts-only');
    // teaser の各行も一次ソース必須の契約を保つ。
    for (const event of body.latestChanges) {
      expect(event.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(event.summary.length).toBeGreaterThan(0);
    }
  });

  it('payments teaser: 直近 3 イベントのみ・価格は SoT と一致', async () => {
    const { payments } = await load();
    const res = await payments.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.product).toBe('japan-stablecoin-payment-monitor');
    expect(body.latestChanges).toHaveLength(3);
    expect(body.totalEvents).toBeGreaterThan(3);
    expect(body).not.toHaveProperty('changes');
    expect(body.fullFeed.priceJpyc).toBe(JPYC_PAYMENTS_RESOURCE.priceJpyc);
    expect(body.fullFeed.priceUsd).toBe(USDC_PAYMENT_MONITOR.priceUsd);
    expect(body.fullFeed.hint).toContain('nextChangedSince');
    expect(body.fullFeed.hint).toContain('skip the purchase');
  });
});
