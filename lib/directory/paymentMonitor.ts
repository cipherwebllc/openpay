// Japan Stablecoin Payment Monitor — 共通 changelog の 'stablecoin-payments' スコープを
// 「日本の決済事業者・手数料・対応レールの監視」という仕事向けに整形するビュー (2 商品目)。
//
// 2026-08-27 裁定の横展開条件: ①週次収集と changelog は Service Monitor と共通 ②新規 DB/
// クローラーなし ③完了する仕事が異なる (JPYC 全般の変更 vs 決済事業者の監視) ④週次更新 1 回で
// 両商品が更新される ⑤3 本目は外部実績を見てから。
//
// 行の形は提案どおり provider 中心: ディレクトリエントリに紐づくイベントは entry から
// provider/assets/chains を導出し、業界イベント (実証実験・提携) はイベント自身の値を使う。

import { DIRECTORY_ENTRIES } from './data';
import {
  type ServiceChangeDiff,
  scopedChangelog,
  type ServiceChangeCategory,
  type ServiceChangeType,
  type ServiceMonitorQuery,
} from './serviceMonitor';
import type { DirectoryEntry } from './types';

export const PAYMENT_MONITOR_SCHEMA_VERSION = '1.0';
export const PAYMENT_MONITOR_LICENSE_NOTICE =
  'Events summarize what official sources state; they are not availability guarantees or endorsements. Source rights remain with their owners.';

export const PAYMENT_MONITOR_NOTICE = {
  code: 'sourced-facts-only',
  detail:
    'Events summarize official announcements about stablecoin payment services in Japan; verify with each sourceUrl before relying on a change.',
  termsUrl: 'https://open-pay.jp/en/terms',
} as const;

export type PaymentChangeRow = {
  /** YYYY-MM-DD (発表日ベース)。 */
  date: string;
  /** 事業者/主体の表示名。 */
  provider: string;
  changeType: ServiceChangeType;
  changeCategory?: ServiceChangeCategory;
  /** 対象ステーブルコイン (例 ['USDC','JPYC'])。 */
  assets: readonly string[];
  /** 対象チェーン (判明分のみ)。 */
  chains: readonly string[];
  summary: string;
  summaryJa: string;
  sourceUrl: string;
  /** 値レベルの差分 (一次ソースが前後の値を明示する場合のみ)。 */
  diffs?: readonly ServiceChangeDiff[];
};

export type PaymentMonitorEnvelope = {
  schemaVersion: string;
  mode: 'snapshot' | 'delta';
  query: { changedSince?: string; limit: number };
  /** snapshot: 全履歴 (limit 件・新しい順ではなく日付昇順) / delta: changedSince 以降のみ。 */
  changes: PaymentChangeRow[];
  /** 決済スコープの全イベント数 (limit で切っても母数が分かる)。 */
  totalEvents: number;
  generatedAt: string;
  /** 次回の delta 購入でそのまま changedSince に渡す値。 */
  nextChangedSince: string;
  notice: { code: string; detail: string; termsUrl: string };
  licenseNotice: string;
};

function toRow(
  event: ReturnType<typeof scopedChangelog>[number],
  bySlug: ReadonlyMap<string, DirectoryEntry>,
): PaymentChangeRow {
  const entry = event.slug ? bySlug.get(event.slug) : undefined;
  return {
    date: event.date,
    provider: event.provider ?? entry?.name ?? event.slug ?? 'unknown',
    changeType: event.changeType,
    ...(event.changeCategory ? { changeCategory: event.changeCategory } : {}),
    assets:
      event.assets ?? entry?.facts.tokens.map((token) => token.toUpperCase()) ?? [],
    chains: event.chains ?? entry?.facts.chains ?? [],
    summary: event.summary,
    summaryJa: event.summaryJa,
    sourceUrl: event.sourceUrl ?? entry?.sourceUrl ?? '',
    ...(event.diffs ? { diffs: event.diffs } : {}),
  };
}

export function createPaymentMonitorEnvelope(
  query: ServiceMonitorQuery,
  generatedAtIso: string,
  entries: readonly DirectoryEntry[] = DIRECTORY_ENTRIES,
): PaymentMonitorEnvelope {
  const changelog = scopedChangelog('stablecoin-payments', entries);
  const bySlug = new Map(entries.map((entry) => [entry.slug, entry]));
  const mode = query.changedSince === undefined ? 'snapshot' : 'delta';
  const filtered =
    mode === 'snapshot'
      ? changelog.slice(-query.limit)
      : changelog
          .filter((event) => event.date >= (query.changedSince as string))
          .slice(0, query.limit);

  return {
    schemaVersion: PAYMENT_MONITOR_SCHEMA_VERSION,
    mode,
    query: {
      ...(query.changedSince !== undefined ? { changedSince: query.changedSince } : {}),
      limit: query.limit,
    },
    changes: filtered.map((event) => toRow(event, bySlug)),
    totalEvents: changelog.length,
    generatedAt: generatedAtIso,
    nextChangedSince: generatedAtIso.slice(0, 10),
    notice: { ...PAYMENT_MONITOR_NOTICE },
    licenseNotice: PAYMENT_MONITOR_LICENSE_NOTICE,
  };
}
