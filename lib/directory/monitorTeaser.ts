// 無料 teaser 2 本 (/api/jpyc/services/teaser・/api/stablecoin-payments/teaser) の共通部分 (2026-09-24 R9b)。
// 両 teaser は「直近 3 イベント + 最新の記録日 + 総数」を同じ規則で出す。応答の形 (product 名・fullFeed・
// services 数の有無) は route ごとに違うので、ここでは changes の切り出しだけを共有する。
//
// stablecoin の teaser も有料 Payment Monitor の provider 投影行 (PaymentChangeRow) ではなく、scope だけを
// 除いた **raw の changelog イベント**を返す (従来どおり)。2 つは形が違うので混ぜない。

import {
  deltaEffectiveDate,
  scopedChangelog,
  sortByDeltaEffectiveDate,
  type ServiceChangeEventOutput,
  type ServiceChangeScope,
} from './serviceMonitor';

export const MONITOR_TEASER_EVENTS = 3;

export type MonitorTeaserChanges = {
  latestChanges: ServiceChangeEventOutput[];
  latestRecordedAt: string | null;
  totalEvents: number;
};

/**
 * scope の changelog **全体**から teaser の changes を作る。有料版 snapshot の changes は limit で切られた
 * view (date 順の末尾 200 件) なので使わない — 件数が上限を超えると、date は古いが記録は最新の backfill が
 * 先に落ちて latestRecordedAt を過小に、totalEvents を過少に出してしまう。
 * 「買う前に確かめる」は記録日で判定する (有料 delta と同じ実効日 max(date, collectedAt))。date だけだと、
 * 後から記録した古い date のイベントが「新しい変更なし」に見えて買い控えが起きる (2026-09-23)。
 */
export function teaserChangesFor(scope: ServiceChangeScope): MonitorTeaserChanges {
  const recorded = sortByDeltaEffectiveDate(scopedChangelog(scope));
  return {
    latestChanges: recorded.slice(-MONITOR_TEASER_EVENTS).map(({ scopes: _scopes, ...event }) => event),
    latestRecordedAt: recorded.length > 0 ? deltaEffectiveDate(recorded[recorded.length - 1]) : null,
    totalEvents: recorded.length,
  };
}
