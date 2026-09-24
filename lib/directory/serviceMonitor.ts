// JPYC Service Monitor — Japan Web3 Directory を「定期購入で差分を追う」ための監視ビュー。
//
// 商品コンセプト (2026-08-27 裁定・plans/jpyc-service-monitor.md):
//   静的一覧を売るのではなく、「JPYC 対応サービスの追加・変更・終了・再確認」を changelog として
//   継続提供し、外部エージェントの週次ジョブに組み込んでもらう。マスターデータは directory と共通
//   (data.ts が単一情報源)。changelog は changelogData.ts の MANUAL_CHANGELOG に週次運用で追記する。
//
// 契約 (B1 jpyc live の教訓を踏襲):
//   - mode: 'snapshot' (changedSince なし・全 published の監視ビュー) | 'delta' (以降の変更のみ)
//   - 変更なしの delta は changes: [] を明示的に返す (エージェントは「重要な変更なし」と報告できる)
//   - dedupe は slug + date + changeType で決定的
//   - changedSince は YYYY-MM-DD (その日を**含む**)。delta の照合・並び・cursor は実効日 max(date, collectedAt)
//     (2026-09-23: 後から記録した古い date のイベントを取りこぼさない)。snapshot は date 昇順。
//   - date = 一次ソースの発表日 / collectedAt = こちらが記録した日 (2026-09-03 統一)。

import { BASELINE_DATE, MANUAL_CHANGELOG } from './changelogData';
import type { ServiceChangeEvent, ServiceChangeScope } from './changelogTypes';
import { DIRECTORY_ENTRIES } from './data';
import { directoryVerificationForEntry, publishedDirectoryEntries } from './query';
import type {
  DirectoryEntry,
  DirectoryVerificationSnapshot,
} from './types';

export const SERVICE_MONITOR_SCHEMA_VERSION = '1.0';
export const SERVICE_MONITOR_MAX_LIMIT = 200;
export const SERVICE_MONITOR_LICENSE_NOTICE =
  'Facts summarized from official sources; source rights remain with their owners. sourceOk reports source URL reachability only, not whether the information is true.';

// changelog の語彙と型は changelogTypes.ts (R9a)。利用側の import 経路を保つため従来どおりここから公開する。
export {
  SERVICE_CHANGE_CATEGORIES,
  SERVICE_CHANGE_SCOPES,
  SERVICE_CHANGE_TYPES,
  SERVICE_DIFF_FIELDS,
} from './changelogTypes';
export type {
  ServiceChangeCategory,
  ServiceChangeDiff,
  ServiceChangeEvent,
  ServiceChangeScope,
  ServiceChangeType,
  ServiceDiffField,
} from './changelogTypes';

/**
 * 初期 baseline: MANUAL_CHANGELOG に 'added' を持たないエントリを BASELINE_DATE の
 * 'added' として導出する。後から追加したエントリは手書き added が唯一の追加イベント。
 */
function baselineEvents(entries: readonly DirectoryEntry[]): ServiceChangeEvent[] {
  const manuallyAdded = new Set(
    MANUAL_CHANGELOG.filter((event) => event.changeType === 'added').map(
      (event) => event.slug,
    ),
  );
  return entries
    .filter((entry) => !manuallyAdded.has(entry.slug))
    .map((entry) => ({
      date: BASELINE_DATE,
      scopes: ['jpyc-services'] as const,
      slug: entry.slug,
      changeType: 'added' as const,
      summary: `${entry.name} added to the directory.`,
      summaryJa: `${entry.nameJa || entry.name} をディレクトリに追加。`,
      sourceUrl: entry.sourceUrl,
    }));
}

/** 全 changelog (baseline + 手書き) を日付昇順・決定的順序で返す。 */
export function serviceChangelog(
  entries: readonly DirectoryEntry[] = DIRECTORY_ENTRIES,
): ServiceChangeEvent[] {
  const all = [...baselineEvents(publishedDirectoryEntries(entries)), ...MANUAL_CHANGELOG];
  return all.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (a.slug ?? a.provider ?? '').localeCompare(b.slug ?? b.provider ?? '') ||
      a.changeType.localeCompare(b.changeType),
  );
}

/** 指定スコープのイベントだけを返す (共通 changelog → 用途別ビュー)。 */
export function scopedChangelog(
  scope: ServiceChangeScope,
  entries: readonly DirectoryEntry[] = DIRECTORY_ENTRIES,
): ServiceChangeEvent[] {
  return serviceChangelog(entries).filter((event) => event.scopes.includes(scope));
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type ServiceMonitorQuery = {
  changedSince?: string;
  limit: number;
};

const SERVICE_MONITOR_QUERY_KEYS = new Set(['changedSince', 'limit']);

/** YYYY-MM-DD が暦上の実在日か (2026-02-30 等を弾く・Date.UTC の round-trip で判定)。 */
function isCalendarDate(raw: string): boolean {
  const [y, m, d] = raw.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d);
  const check = new Date(ms);
  return (
    check.getUTCFullYear() === y &&
    check.getUTCMonth() === m - 1 &&
    check.getUTCDate() === d
  );
}

/** クエリ検証。不正は null (呼び元が 400)。openapi/Bazaar が宣言する引数以外は拒否する
 * (未知キーを黙って無視すると、宣言と実装がずれても気づけない)。 */
export function parseServiceMonitorQuery(
  params: URLSearchParams,
): ServiceMonitorQuery | null {
  for (const key of params.keys()) {
    if (!SERVICE_MONITOR_QUERY_KEYS.has(key)) return null;
  }
  const query: ServiceMonitorQuery = { limit: SERVICE_MONITOR_MAX_LIMIT };
  const changedSince = params.get('changedSince');
  if (changedSince !== null) {
    if (!DATE_RE.test(changedSince) || !isCalendarDate(changedSince)) return null;
    query.changedSince = changedSince;
  }
  const limit = params.get('limit');
  if (limit !== null) {
    if (!/^[1-9][0-9]{0,2}$/.test(limit)) return null;
    const n = Number(limit);
    if (n > SERVICE_MONITOR_MAX_LIMIT) return null;
    query.limit = n;
  }
  return query;
}

/**
 * delta の照合に使う実効日 = max(date, collectedAt)。date は一次ソースの発表日で、週次収集では
 * 発表から数日〜数か月遅れて記録する (backfill)。買い手の cursor は「前回の購入日」なので、date だけで
 * 照合すると **後から記録した古い date のイベントはその買い手に永久に届かない** (2026-09-23 実機で発覚:
 * cursor 9/21 に対し 9/23 収集の 9/17・9/18 イベントが漏れた)。collectedAt が無い行 (初期分) は date。
 * delta の並びと打ち切り cursor もこの実効日で揃える (実効日昇順・安定ソート・cursor = 最初の未返却
 * イベントの実効日)。並びと cursor の鍵を揃えないと、cursor を回したとき再配信か取りこぼしのどちらかが
 * 起きる。snapshot の並び (date 昇順) は不変。
 */
export function deltaEffectiveDate(event: { date: string; collectedAt?: string }): string {
  return event.collectedAt !== undefined && event.collectedAt > event.date ? event.collectedAt : event.date;
}

/** delta 用: 実効日の安定ソート (同じ実効日の中は changelog の宣言順 = date 昇順のまま)。 */
export function sortByDeltaEffectiveDate<T extends { date: string; collectedAt?: string }>(events: readonly T[]): T[] {
  return events
    .map((event, index) => ({ event, index, key: deltaEffectiveDate(event) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index))
    .map(({ event }) => event);
}

/**
 * delta の切り出し (2026-09-03 裁定・E3 の残欠陥の修正)。**同一の実効日のグループを分割しない**。
 *
 * 何を防ぐ防御か: 「打ち切り時の nextChangedSince = 最後に返したイベントの日」だけでは、
 * **1 つの日に limit より多いイベントがある**と次回も同じ日の同じ先頭 limit 件が返り、
 * hasMore:true のまま永久に前進しない (毎回課金される)。実データで現実に起こる —
 * baseline 19 件は全て 2026-07-13、決済スコープの 2026-08-26 は 3 件。
 *
 * 規則: 実効日 (keyOf・既定 = max(date, collectedAt)) 昇順のイベントを日付グループ単位で取り、累計が
 * limit 以下の間だけ含める。**先頭グループだけで limit を超える場合はそのグループ全体を含める**
 * = 「limit は日付境界に切り上げられる。1 日が分割されることはない」。
 * こうすると未返却の先頭イベントの実効日は**必ず**返した最後の実効日より後になるので、
 * 次回の changedSince は前進し (無限ループなし)、inclusive でも再配信が発生しない。
 */
export function takeDeltaByDateGroups<T extends { date: string; collectedAt?: string }>(
  events: readonly T[],
  limit: number,
  keyOf: (event: T) => string = deltaEffectiveDate,
): { taken: T[]; hasMore: boolean; nextChangedSince: string | null } {
  let count = 0;
  while (count < events.length) {
    const date = keyOf(events[count]);
    let end = count;
    while (end < events.length && keyOf(events[end]) === date) end += 1;
    // 2 つ目以降のグループは limit を超えるなら足さない (先頭グループだけは必ず含める)。
    if (end > limit && count > 0) break;
    count = end;
  }
  return {
    taken: events.slice(0, count),
    hasMore: count < events.length,
    nextChangedSince: count < events.length ? keyOf(events[count]) : null,
  };
}

/**
 * delta の 1 ページ = 実効日 ≥ since のイベントを実効日順に並べ、日付グループ単位で切り出す
 * (Service Monitor・Payment Monitor の共通手順・R9b)。照合・並び・cursor の鍵を同じ実効日に揃える
 * (揃えないと cursor を回したとき再配信か取りこぼしが起きる — deltaEffectiveDate の説明)。
 */
export function takeDeltaSince<T extends { date: string; collectedAt?: string }>(
  events: readonly T[],
  since: string,
  limit: number,
): { taken: T[]; hasMore: boolean; nextChangedSince: string | null } {
  const matched = sortByDeltaEffectiveDate(events.filter((event) => deltaEffectiveDate(event) >= since));
  return takeDeltaByDateGroups(matched, limit);
}

/** 監視ビュー 1 行 (editorial の全文は含めない — 詳細は directory 本体商品の領分)。 */
export type ServiceMonitorRow = {
  slug: string;
  name: string;
  nameJa: string;
  status: string;
  category: string;
  supportsJpyc: boolean;
  supportsUsdc: boolean;
  supportsX402: boolean;
  chains: readonly string[];
  sourceUrl: string;
  verifiedAt: string;
  sourceCheckedAt: string | null;
  sourceOk: boolean | null;
};

function toRow(
  entry: DirectoryEntry,
  snapshot: DirectoryVerificationSnapshot,
): ServiceMonitorRow {
  const source = directoryVerificationForEntry(entry, snapshot);
  return {
    slug: entry.slug,
    name: entry.name,
    nameJa: entry.nameJa,
    status: entry.status,
    category: entry.facts.category,
    supportsJpyc: entry.facts.supportsJpyc,
    supportsUsdc: entry.facts.supportsUsdc,
    supportsX402: entry.facts.supportsX402,
    chains: entry.facts.chains,
    sourceUrl: entry.sourceUrl,
    verifiedAt: entry.verifiedAt,
    sourceCheckedAt: source?.checkedAt ?? null,
    sourceOk: source?.ok ?? null,
  };
}

/** 応答に載せるイベント形 (内部ルーティング用の scopes を除いたもの)。 */
export type ServiceChangeEventOutput = Omit<ServiceChangeEvent, 'scopes'>;

export type ServiceMonitorEnvelope = {
  schemaVersion: string;
  mode: 'snapshot' | 'delta';
  query: { changedSince?: string; limit: number };
  /** snapshot: 全 published / delta: changedSince 以降に変更のあったエントリの現況のみ。 */
  services: ServiceMonitorRow[];
  /** snapshot: 直近イベント (limit 件) / delta: changedSince 以降のイベント。
   * delta の limit は**日付境界に切り上げ**られる (1 日が分割されることはない) ため、
   * 1 日の件数が limit を超える場合だけ changes.length > limit になり得る。 */
  changes: ServiceChangeEventOutput[];
  totalServices: number;
  generatedAt: string;
  /** まだ返していないイベントが残っている (snapshot: 全イベント数 > limit・
   * delta: 日付境界で切り上げても入り切らないイベントがある)。 */
  hasMore: boolean;
  /** 次回の delta 購入でそのまま changedSince に渡す値 (当日含む契約なので取りこぼしなし)。
   * hasMore=true の delta では**最初の未返却イベントの deltaEffectiveDate = max(date, collectedAt ?? date)** (返した最後の deltaEffectiveDate より必ず後 =
   * 前進が保証され、再配信も起きない)。それ以外は generatedAt の UTC 日付。 */
  nextChangedSince: string;
  notice: { code: string; detail: string; termsUrl: string };
  licenseNotice: string;
  attribution: string[];
};

export const SERVICE_MONITOR_NOTICE = {
  code: 'sourced-facts-only',
  detail:
    'Change events and rows summarize what official sources state; they are not availability guarantees or endorsements. Verify with the sourceUrl before relying on a change.',
  termsUrl: 'https://open-pay.jp/en/terms',
} as const;

export function createServiceMonitorEnvelope(
  query: ServiceMonitorQuery,
  snapshot: DirectoryVerificationSnapshot,
  generatedAtIso: string,
  entries: readonly DirectoryEntry[] = DIRECTORY_ENTRIES,
): ServiceMonitorEnvelope {
  const published = publishedDirectoryEntries(entries);
  // 本ビューは 'jpyc-services' スコープのみ (決済スコープ専用イベントを混ぜない)。
  // scopes は内部ルーティング用のため応答から外す。
  const changelog = scopedChangelog('jpyc-services', entries).map(
    ({ scopes: _scopes, ...event }) => event,
  );
  const mode = query.changedSince === undefined ? 'snapshot' : 'delta';

  let changes: ServiceChangeEventOutput[];
  let services: ServiceMonitorRow[];
  let hasMore: boolean;
  // 既定は UTC 日付。取りこぼしゼロが成り立つのは「後から本番に載るイベントの実効日 ≥ その本番反映日の
  // UTC 日付」のとき = **collectedAt は本番 merge 日の JST 日付以上で書く** (merge が遅れたら merge 直前に
  // 更新する・runbook)。同日イベントの重複は slug+date+changeType の dedupe が吸収する。打ち切られた delta
  // だけは下で「最初の未返却イベントの実効日」に差し替える (打ち切り分の永久ロス防止・前進の保証)。
  let nextChangedSince = generatedAtIso.slice(0, 10);
  if (mode === 'snapshot') {
    hasMore = changelog.length > query.limit;
    changes = changelog.slice(-query.limit);
    services = published.map((entry) => toRow(entry, snapshot));
  } else {
    const page = takeDeltaSince(changelog, query.changedSince as string, query.limit);
    changes = page.taken;
    hasMore = page.hasMore;
    if (page.nextChangedSince !== null) nextChangedSince = page.nextChangedSince;
    const changedSlugs = new Set(changes.map((event) => event.slug));
    // removed (archived) は published に居ないので現況行は出ない — イベント側が真実を運ぶ。
    services = published
      .filter((entry) => changedSlugs.has(entry.slug))
      .map((entry) => toRow(entry, snapshot));
  }

  const attribution = new Set<string>();
  for (const entry of published) attribution.add(entry.attribution);

  return {
    schemaVersion: SERVICE_MONITOR_SCHEMA_VERSION,
    mode,
    query: {
      ...(query.changedSince !== undefined ? { changedSince: query.changedSince } : {}),
      limit: query.limit,
    },
    services,
    changes,
    totalServices: published.length,
    generatedAt: generatedAtIso,
    hasMore,
    nextChangedSince,
    notice: { ...SERVICE_MONITOR_NOTICE },
    licenseNotice: SERVICE_MONITOR_LICENSE_NOTICE,
    attribution: [...attribution],
  };
}
