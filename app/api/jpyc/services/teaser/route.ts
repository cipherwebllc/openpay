// JPYC Service Monitor の無料 teaser (直近 3 イベントのみ・監視ビュー行なし)。
// 「$0.01/2 JPYC でも中身が分からないものは買わない」という初回購入の壁を、実データの
// 実物で下げる (directory の無料 teaser /api/directory と同じ二層戦略・2026-08-31 裁定 B)。
// 全イベント・delta (changedSince)・services 行は有料版の価値としてここには出さない。

import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { JPYC_SERVICES_RESOURCE } from '@/lib/directory/paidResources';
import {
  createServiceMonitorEnvelope,
  SERVICE_MONITOR_MAX_LIMIT,
} from '@/lib/directory/serviceMonitor';
import { USDC_SERVICE_MONITOR } from '@/lib/directory/usdcResource';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TEASER_EVENTS = 3;

export async function GET(): Promise<NextResponse> {
  if (!env.enableWeb3Directory) {
    return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  }
  // 検証スナップショット (KV) は使わない — teaser は changes のみで services 行を出さないため
  // 空スナップショットで足り、無料エンドポイントに KV 読取コストを載せない。
  const full = createServiceMonitorEnvelope(
    { limit: SERVICE_MONITOR_MAX_LIMIT },
    {},
    new Date().toISOString(),
  );
  return NextResponse.json(
    {
      schemaVersion: full.schemaVersion,
      product: 'jpyc-service-monitor',
      teaser: true,
      latestChanges: full.changes.slice(-TEASER_EVENTS),
      totalEvents: full.changes.length,
      totalServices: full.totalServices,
      generatedAt: full.generatedAt,
      fullFeed: {
        jpyc: 'https://open-pay.jp/api/paid/jpyc/services',
        usdc: 'https://open-pay.jp/api/paid/usdc/jpyc/services',
        priceJpyc: JPYC_SERVICES_RESOURCE.priceJpyc,
        priceUsd: USDC_SERVICE_MONITOR.priceUsd,
        hint: 'Check before you buy: if the latest date in latestChanges is before the nextChangedSince you stored from your last paid response, the paid delta would be empty — skip the purchase. Otherwise pass changedSince=<that nextChangedSince> to buy only deltas. The paid feed returns every event plus the current monitor row for each service.',
      },
      notice: full.notice,
      licenseNotice: full.licenseNotice,
    },
    {
      // 無料 teaser はポーリングされ得るので edge で短期キャッシュ (/api/directory と同じ判断)。
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
    },
  );
}
