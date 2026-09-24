// JPYC Service Monitor の無料 teaser (直近 3 イベントのみ・監視ビュー行なし)。
// 「$0.01/2 JPYC でも中身が分からないものは買わない」という初回購入の壁を、実データの
// 実物で下げる (directory の無料 teaser /api/directory と同じ二層戦略・2026-08-31 裁定 B)。
// 全イベント・delta (changedSince)・services 行は有料版の価値としてここには出さない。

import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { teaserChangesFor } from '@/lib/directory/monitorTeaser';
import { JPYC_SERVICES_RESOURCE } from '@/lib/directory/paidResources';
import {
  createServiceMonitorEnvelope,
  SERVICE_MONITOR_MAX_LIMIT,
} from '@/lib/directory/serviceMonitor';
import { USDC_SERVICE_MONITOR } from '@/lib/directory/usdcResource';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
  // changes は limit で切られた snapshot view ではなく changelog 全体から (lib/directory/monitorTeaser.ts)。
  const teaser = teaserChangesFor('jpyc-services');
  return NextResponse.json(
    {
      schemaVersion: full.schemaVersion,
      product: 'jpyc-service-monitor',
      teaser: true,
      // 「買う前に確かめる」は記録日で判定する (有料 delta と同じ実効日)。
      latestChanges: teaser.latestChanges,
      latestRecordedAt: teaser.latestRecordedAt,
      // full.changes は limit で切られた view なので総数の権威にならない。changelog の実数を使う。
      totalEvents: teaser.totalEvents,
      totalServices: full.totalServices,
      generatedAt: full.generatedAt,
      fullFeed: {
        jpyc: 'https://open-pay.jp/api/paid/jpyc/services',
        usdc: 'https://open-pay.jp/api/paid/usdc/jpyc/services',
        priceJpyc: JPYC_SERVICES_RESOURCE.priceJpyc,
        priceUsd: USDC_SERVICE_MONITOR.priceUsd,
        hint: 'Check before you buy: if latestRecordedAt is before the nextChangedSince you stored from your last paid response, the paid delta would be empty — skip the purchase. Otherwise pass changedSince=<that nextChangedSince> to buy only deltas. Events are matched on the day they were recorded (max(date, collectedAt), or date when collectedAt is absent), so an event with an older date can still be new. The paid feed returns every event plus the current monitor row for each service.',
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
