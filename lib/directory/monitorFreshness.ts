// 更新型商品 (JPYC Service Monitor / Japan Stablecoin Payment Monitor) の「生きている」証拠。
// 更新型商品の最大の不安は「放置されていないか」なので、AI ストアのカードに最終イベント日と
// 総イベント数を出す (改善提案 #4・2026-09-01)。共通 changelog (純関数・KV 不使用) から
// 導出するだけで、数値や日付をここに持たない。無料 teaser (/api/*/teaser) と同じ事実。

import {
  JPYC_PAYMENTS_RESOURCE,
  JPYC_SERVICES_RESOURCE,
} from '@/lib/directory/paidResources';
import { scopedChangelog, type ServiceChangeScope } from '@/lib/directory/serviceMonitor';
import { USDC_PAYMENT_MONITOR, USDC_SERVICE_MONITOR } from '@/lib/directory/usdcResource';

export type MonitorFreshness = {
  /** 最終イベント日 (YYYY-MM-DD・changelog は日付昇順なので末尾)。 */
  latestEventDate: string;
  totalEvents: number;
};

/** 商品 path → スコープ。JPYC 面と USDC 面は同一データなので同じ鮮度を指す。 */
const SCOPE_BY_PATH: Readonly<Record<string, ServiceChangeScope>> = {
  [JPYC_SERVICES_RESOURCE.path]: 'jpyc-services',
  [USDC_SERVICE_MONITOR.path]: 'jpyc-services',
  [JPYC_PAYMENTS_RESOURCE.path]: 'stablecoin-payments',
  [USDC_PAYMENT_MONITOR.path]: 'stablecoin-payments',
};

/** /discovery が server 側で 1 回計算してカードへ渡す (path キー・絶対 URL は pathname で引く)。 */
export function monitorFreshnessByPath(): Readonly<Record<string, MonitorFreshness>> {
  const byScope = new Map<ServiceChangeScope, MonitorFreshness>();
  const out: Record<string, MonitorFreshness> = {};
  for (const [path, scope] of Object.entries(SCOPE_BY_PATH)) {
    let freshness = byScope.get(scope);
    if (!freshness) {
      // 両スコープとも baseline/backfill で常に ≥1 件 (契約テストで固定) なので末尾は必ずある。
      const events = scopedChangelog(scope);
      freshness = {
        latestEventDate: events[events.length - 1].date,
        totalEvents: events.length,
      };
      byScope.set(scope, freshness);
    }
    out[path] = freshness;
  }
  return out;
}
