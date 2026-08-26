// JPYC Service Monitor — Japan Web3 Directory を「定期購入で差分を追う」ための監視ビュー。
//
// 商品コンセプト (2026-08-27 裁定・plans/jpyc-service-monitor.md):
//   静的一覧を売るのではなく、「JPYC 対応サービスの追加・変更・終了・再確認」を changelog として
//   継続提供し、外部エージェントの週次ジョブに組み込んでもらう。マスターデータは directory と共通
//   (data.ts が単一情報源)。changelog は本ファイルの MANUAL_CHANGELOG に週次運用で追記する。
//
// 契約 (B1 jpyc live の教訓を踏襲):
//   - mode: 'snapshot' (changedSince なし・全 published の監視ビュー) | 'delta' (以降の変更のみ)
//   - 変更なしの delta は changes: [] を明示的に返す (エージェントは「重要な変更なし」と報告できる)
//   - dedupe は slug + date + changeType で決定的
//   - changedSince は YYYY-MM-DD (その日を**含む**)。イベント date も YYYY-MM-DD で単調。

import { DIRECTORY_ENTRIES } from './data';
import { publishedDirectoryEntries } from './query';
import type {
  DirectoryEntry,
  DirectoryVerificationSnapshot,
} from './types';

export const SERVICE_MONITOR_SCHEMA_VERSION = '1.0';
export const SERVICE_MONITOR_MAX_LIMIT = 200;
export const SERVICE_MONITOR_LICENSE_NOTICE =
  'Facts summarized from official sources; source rights remain with their owners. sourceOk reports source URL reachability only, not whether the information is true.';

export const SERVICE_CHANGE_TYPES = ['added', 'updated', 'removed', 'verified'] as const;
export type ServiceChangeType = (typeof SERVICE_CHANGE_TYPES)[number];

export type ServiceChangeEvent = {
  /** YYYY-MM-DD (JST 運用日)。changedSince との比較は文字列比較 (同形式ゆえ安全)。 */
  date: string;
  slug: string;
  changeType: ServiceChangeType;
  /** 何が変わったか (英語・1 文・事実のみ)。 */
  summary: string;
  summaryJa: string;
  /** 変更の根拠 URL。省略時はエントリの sourceUrl。 */
  sourceUrl?: string;
};

// 週次運用で追記する手書き changelog (新しいものを**末尾**に追加する — 日付昇順を保つ)。
// 掟: 事実のみ・一次ソース URL 必須級・エントリ本体 (data.ts) の変更と同一 PR で追記する。
// removed の場合は data.ts の status を 'archived' にし、ここに removed イベントを足す。
const MANUAL_CHANGELOG: readonly ServiceChangeEvent[] = [
  // (運用開始後、週次でここに追記)
];

/** 初期 baseline: data.ts の各エントリを updatedAt 日の 'added' として導出する。 */
function baselineEvents(entries: readonly DirectoryEntry[]): ServiceChangeEvent[] {
  return entries.map((entry) => ({
    date: entry.updatedAt,
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
      a.slug.localeCompare(b.slug) ||
      a.changeType.localeCompare(b.changeType),
  );
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type ServiceMonitorQuery = {
  changedSince?: string;
  limit: number;
};

/** クエリ検証。不正は null (呼び元が 400)。 */
export function parseServiceMonitorQuery(
  params: URLSearchParams,
): ServiceMonitorQuery | null {
  const query: ServiceMonitorQuery = { limit: SERVICE_MONITOR_MAX_LIMIT };
  const changedSince = params.get('changedSince');
  if (changedSince !== null) {
    if (!DATE_RE.test(changedSince)) return null;
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
  const record = snapshot[entry.slug];
  const source = record?.sourceUrl === entry.sourceUrl ? record : null;
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

export type ServiceMonitorEnvelope = {
  schemaVersion: string;
  mode: 'snapshot' | 'delta';
  query: { changedSince?: string; limit: number };
  /** snapshot: 全 published / delta: changedSince 以降に変更のあったエントリの現況のみ。 */
  services: ServiceMonitorRow[];
  /** snapshot: 直近イベント (limit 件) / delta: changedSince 以降の全イベント (limit 件まで)。 */
  changes: ServiceChangeEvent[];
  totalServices: number;
  generatedAt: string;
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
  const changelog = serviceChangelog(entries);
  const mode = query.changedSince === undefined ? 'snapshot' : 'delta';

  let changes: ServiceChangeEvent[];
  let services: ServiceMonitorRow[];
  if (mode === 'snapshot') {
    changes = changelog.slice(-query.limit);
    services = published.map((entry) => toRow(entry, snapshot));
  } else {
    const since = query.changedSince as string;
    changes = changelog.filter((event) => event.date >= since).slice(0, query.limit);
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
    notice: { ...SERVICE_MONITOR_NOTICE },
    licenseNotice: SERVICE_MONITOR_LICENSE_NOTICE,
    attribution: [...attribution],
  };
}
