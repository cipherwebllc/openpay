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

// 商品スコープ: 1 つの共通 changelog から用途別ビューを切り出すためのタグ (2026-08-27 裁定
// 「1 回の週次更新から複数の用途別ビューを生成」)。イベントは複数スコープに属してよい。
export const SERVICE_CHANGE_SCOPES = ['jpyc-services', 'stablecoin-payments'] as const;
export type ServiceChangeScope = (typeof SERVICE_CHANGE_SCOPES)[number];

// 決済監視ビュー用の変更分類 (何が起きたか)。changeType (ディレクトリ操作) と直交する。
export const SERVICE_CHANGE_CATEGORIES = [
  'service_launch',
  'pilot',
  'partnership',
  'fee_change',
  'assets_change',
  'chains_change',
  'closure',
  'update',
] as const;
export type ServiceChangeCategory = (typeof SERVICE_CHANGE_CATEGORIES)[number];

// 構造化差分 (変更台帳化・2026-09-02 裁定)。散文 summary に加え、一次ソースが「前の値 → 今の値」を
// 明示する場合にだけ値で書く (推測で埋めない = sourced-facts-only)。field は固定語彙 — 同じ分類
// 基準で継続監視することが商品価値なので自由文字列にしない。
export const SERVICE_DIFF_FIELDS = [
  'assets', // 対応ステーブルコイン (例 ['JPYC'] → ['JPYC','USDC'])
  'chains', // 対応チェーン
  'fee', // 手数料・料率 (正規化した文字列・例 '1.0%' / '2 JPYC min')
  'limit', // 上限・下限 (発行上限・送金上限など)
  'status', // 提供状態 (例 null → 'commercial' / 'pilot' / 'closed')
  'feature', // 機能の追加・廃止 (例 'redemption', 'pos-integration')
] as const;
export type ServiceDiffField = (typeof SERVICE_DIFF_FIELDS)[number];

export type ServiceChangeDiff = {
  field: ServiceDiffField;
  /** 変更前の値 (無かった場合は null)。 */
  previousValue: string | readonly string[] | null;
  currentValue: string | readonly string[];
  /** 適用日 (YYYY-MM-DD)。発表日 (event.date) と異なる場合のみ。 */
  effectiveAt?: string;
};

export type ServiceChangeEvent = {
  /** YYYY-MM-DD (JST 運用日)。changedSince との比較は文字列比較 (同形式ゆえ安全)。 */
  date: string;
  /** どの商品ビューに載せるか (必須・明示)。 */
  scopes: readonly ServiceChangeScope[];
  /** ディレクトリエントリに紐づくイベントのみ。業界イベント (実証実験等) は provider を使う。 */
  slug?: string;
  /** slug 無しイベントの表示名 (例: 'JCB / Digital Garage / Resona HD')。 */
  provider?: string;
  changeType: ServiceChangeType;
  /** 決済監視ビュー用の分類 (任意)。 */
  changeCategory?: ServiceChangeCategory;
  /** イベント固有の対象資産/チェーン (任意・省略時は entry の facts から導出)。 */
  assets?: readonly string[];
  chains?: readonly string[];
  /** 何が変わったか (英語・1 文・事実のみ)。 */
  summary: string;
  summaryJa: string;
  /** 変更の根拠 URL。省略時はエントリの sourceUrl。 */
  sourceUrl?: string;
  /** 値レベルの差分 (一次ソースが前後の値を明示する場合のみ・任意)。 */
  diffs?: readonly ServiceChangeDiff[];
};

// 週次運用で追記する手書き changelog (新しいものを**末尾**に追加する — 日付昇順を保つ)。
// 掟: 事実のみ・一次ソース URL 必須級・エントリ本体 (data.ts) の変更と同一 PR で追記する。
// removed の場合は data.ts の status を 'archived' にし、ここに removed イベントを足す。
// 新規エントリは必ず 'added' イベントをここに書く (baseline の自動 added から除外される)。
const MANUAL_CHANGELOG: readonly ServiceChangeEvent[] = [
  // ── stablecoin-payments backfill (2026-08-27 収集・一次ソース確認済み。初回購入者が
  //     空フィードを掴まないよう、決済スコープの過去イベントを遡って積む) ──
  {
    date: '2025-11-14',
    scopes: ['stablecoin-payments'],
    provider: 'TIS / JPYC',
    changeType: 'added',
    changeCategory: 'partnership',
    assets: ['JPYC'],
    summary:
      'TIS and JPYC signed a basic agreement toward real-world deployment of JPY-stablecoin payments.',
    summaryJa: 'TIS と JPYC が、日本円ステーブルコイン決済の社会実装に向けた基本合意書を締結。',
    sourceUrl: 'https://www.tis.co.jp/news/2025/tis_news/20251114_1.html',
  },
  {
    date: '2026-02-19',
    scopes: ['stablecoin-payments'],
    provider: 'Digital Garage / JCB / Resona HD',
    changeType: 'added',
    changeCategory: 'pilot',
    assets: ['USDC', 'JPYC'],
    summary:
      'Digital Garage, JCB and Resona HD announced an in-store stablecoin payment pilot using USDC and JPYC.',
    summaryJa:
      'デジタルガレージ・JCB・りそな HD が、USDC と JPYC を用いた実店舗ステーブルコイン決済の実証実験を発表。',
    sourceUrl: 'https://www.garage.co.jp/pr/release/20260219/',
  },
  {
    date: '2026-07-15',
    scopes: ['stablecoin-payments'],
    provider: 'JCB / Circle',
    changeType: 'added',
    changeCategory: 'partnership',
    assets: ['USDC'],
    summary:
      'JCB signed an MOU with a Circle affiliate to explore stablecoin-based collaboration, starting with internal USDC transfers and looking at cross-border and merchant payments.',
    summaryJa:
      'JCB が Circle 関連会社とステーブルコイン活用の協業検討に関する基本合意書 (MOU) を締結。社内 USDC 資金移動の実証から、クロスボーダー・加盟店決済も検討対象に。',
    sourceUrl: 'https://prtimes.jp/main/html/rd/p/000001423.000011361.html',
  },
  {
    date: '2026-08-10',
    scopes: ['stablecoin-payments'],
    slug: 'dg-sps',
    changeType: 'added',
    changeCategory: 'service_launch',
    assets: ['USDC'],
    chains: ['base'],
    summary:
      'Digital Garage started commercial rollout of DG Stablecoin Payment Service (API-based merchant integration; initially USDC on Base, first offered to JCB and DGFT).',
    summaryJa:
      'デジタルガレージが DG Stablecoin Payment Service の商用展開を開始 (API 接続の加盟店向け・当初は Base 上の USDC・JCB/DGFT へ先行提供)。',
    sourceUrl: 'https://www.garage.co.jp/pr/release/20260810/',
    diffs: [{ field: 'status', previousValue: null, currentValue: 'commercial' }],
  },
  // ── 2026-08-26 大阪府「先駆的金融市場等形成支援事業補助金」採択 (公式発表・4 事業のうち
  //     ステーブルコイン決済関連 3 件。一次ソース = 大阪府公式ページ) ──
  {
    date: '2026-08-26',
    scopes: ['stablecoin-payments'],
    provider: 'HashPort (Osaka Pref. subsidy)',
    changeType: 'added',
    changeCategory: 'pilot',
    assets: ['JPYC', 'USDC'],
    summary:
      'Osaka Prefecture selected HashPort for its financial-pilot subsidy: a stablecoin payment and settlement pilot accepting JPYC/USDC at retail and restaurants with JPY settlement to merchants, plus an escrow-style EC payment API (planned Jan-Mar 2027).',
    summaryJa:
      '大阪府の先駆的金融市場等形成支援事業補助金に HashPort が採択。JPYC/USDC を受け付け加盟店へ日本円で清算する決済・清算システムと、EC 向けエスクロー型決済 API の実証 (2027 年 1〜3 月予定)。',
    sourceUrl:
      'https://www.pref.osaka.lg.jp/o020060/kikaku/osaka-kokusaikinyu/senkuteki_hojokin.html',
  },
  {
    date: '2026-08-26',
    scopes: ['stablecoin-payments'],
    provider: 'Mina Wallet / Sumitomo Mitsui Card (Osaka Pref. subsidy)',
    changeType: 'added',
    changeCategory: 'pilot',
    assets: ['JPYC', 'USDC'],
    summary:
      'Osaka Prefecture selected Mina Wallet (with Sumitomo Mitsui Card) for a stablecoin payment pilot using My Number Card identity verification (planned Oct 2026 - Feb 2027).',
    summaryJa:
      '大阪府補助にマイナウォレット (三井住友カードと共同) が採択。マイナンバーカードによる本人確認とステーブルコイン決済の実証 (2026 年 10 月〜2027 年 2 月頃予定)。',
    sourceUrl:
      'https://www.pref.osaka.lg.jp/o020060/kikaku/osaka-kokusaikinyu/senkuteki_hojokin.html',
  },
  {
    date: '2026-08-26',
    scopes: ['stablecoin-payments'],
    provider: 'Mi&T (Osaka Pref. subsidy)',
    changeType: 'added',
    changeCategory: 'pilot',
    assets: ['JPYC'],
    summary:
      'Osaka Prefecture selected Mi&T (Osaka Metropolitan University venture) for an in-store JPYC payment pilot at shops and restaurants around the university campus.',
    summaryJa:
      '大阪府補助に大阪公立大学発ベンチャーの Mi&T が採択。大学キャンパス周辺の飲食店・小売店での JPYC 実店舗決済の実証。',
    sourceUrl:
      'https://www.pref.osaka.lg.jp/o020060/kikaku/osaka-kokusaikinyu/senkuteki_hojokin.html',
  },
  // ── 2026-08-27 (第 1 回週次更新・初回は 2026-07-13 baseline 以降の 6 週分) ──
  {
    date: '2026-08-27',
    scopes: ['jpyc-services'],
    slug: 'jpyc',
    changeType: 'updated',
    changeCategory: 'chains_change',
    summary:
      'JPYC now also circulates on Kaia; issuance and circulation cover 4 chains (Polygon, Ethereum, Avalanche, Kaia).',
    summaryJa:
      'JPYC が Kaia にも対応し、発行・流通は 4 チェーン (Polygon/Ethereum/Avalanche/Kaia) に。',
    sourceUrl: 'https://prtimes.jp/main/html/rd/p/000000315.000054018.html',
    diffs: [
      {
        field: 'chains',
        previousValue: ['polygon', 'ethereum', 'avalanche'],
        currentValue: ['polygon', 'ethereum', 'avalanche', 'kaia'],
      },
    ],
  },
  {
    date: '2026-08-27',
    scopes: ['jpyc-services'],
    slug: 'jpyc-ex',
    changeType: 'updated',
    changeCategory: 'chains_change',
    summary:
      'JPYC EX added Kaia support (issuance, redemption, wallet-address registration) and changed the issuance cap from 1M JPY per day to 1M JPY per transaction.',
    summaryJa:
      'JPYC EX が Kaia に対応 (発行・償還・アドレス登録)。発行上限を「1日100万円」から「1回100万円」へ変更。',
    sourceUrl: 'https://prtimes.jp/main/html/rd/p/000000315.000054018.html',
    diffs: [
      {
        field: 'chains',
        previousValue: ['avalanche', 'ethereum', 'polygon'],
        currentValue: ['avalanche', 'ethereum', 'polygon', 'kaia'],
      },
      {
        field: 'limit',
        previousValue: '1,000,000 JPY per day (issuance)',
        currentValue: '1,000,000 JPY per transaction (issuance)',
      },
    ],
  },
  {
    date: '2026-08-27',
    scopes: ['jpyc-services'],
    slug: 'aegis-ai',
    changeType: 'updated',
    changeCategory: 'assets_change',
    summary:
      'Aegis now also sells its briefing API in USDC on Base via standard x402, alongside JPYC.',
    summaryJa: 'Aegis が JPYC に加えて USDC (Base・標準 x402) での販売を開始。',
    sourceUrl: 'https://aegis-ai.xyz/',
    diffs: [{ field: 'assets', previousValue: ['JPYC'], currentValue: ['JPYC', 'USDC'] }],
  },
  {
    date: '2026-08-27',
    scopes: ['jpyc-services'],
    slug: 'dg-sps',
    changeType: 'added',
    summary:
      'DG Stablecoin Payment Service (Digital Garage) added: a merchant stablecoin payment platform, initially USDC on Base, first offered to JCB and DGFT.',
    summaryJa:
      'デジタルガレージの DG Stablecoin Payment Service を追加。加盟店向けステーブルコイン決済基盤 (当初は Base 上の USDC・JCB/DGFT へ先行提供)。',
    sourceUrl: 'https://www.garage.co.jp/pr/release/20260810/',
  },
];

// ディレクトリ初期公開日。baseline の 'added' はこの固定日に立てる — entry.updatedAt 由来に
// すると週次更新で updatedAt を進めた瞬間に「追加日」まで動いてしまう (第 1 回運用で発覚)。
const BASELINE_DATE = '2026-07-13';

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
 * delta の切り出し (2026-09-03 裁定・E3 の残欠陥の修正)。**同一 date のグループを分割しない**。
 *
 * 何を防ぐ防御か: 「打ち切り時の nextChangedSince = 最後に返したイベントの date」だけでは、
 * **1 つの date に limit より多いイベントがある**と次回も同じ日の同じ先頭 limit 件が返り、
 * hasMore:true のまま永久に前進しない (毎回課金される)。実データで現実に起こる —
 * baseline 19 件は全て 2026-07-13、決済スコープの 2026-08-26 は 3 件。
 *
 * 規則: date 昇順のイベントを日付グループ単位で取り、累計が limit 以下の間だけ含める。
 * **先頭グループだけで limit を超える場合はそのグループ全体を含める** (limit を超過する)
 * = 「limit は日付境界に切り上げられる。1 日が分割されることはない」。
 * こうすると未返却の先頭イベントの date は**必ず**返した最後の date より後になるので、
 * 次回の changedSince は前進し (無限ループなし)、inclusive でも再配信が発生しない。
 */
export function takeDeltaByDateGroups<T extends { date: string }>(
  events: readonly T[],
  limit: number,
): { taken: T[]; hasMore: boolean; nextChangedSince: string | null } {
  let count = 0;
  while (count < events.length) {
    const date = events[count].date;
    let end = count;
    while (end < events.length && events[end].date === date) end += 1;
    // 2 つ目以降のグループは limit を超えるなら足さない (先頭グループだけは必ず含める)。
    if (end > limit && count > 0) break;
    count = end;
  }
  return {
    taken: events.slice(0, count),
    hasMore: count < events.length,
    nextChangedSince: count < events.length ? events[count].date : null,
  };
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
   * hasMore=true の delta では**最初の未返却イベントの date** (返した最後の date より必ず後 =
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
  // 既定は UTC 日付。イベント date (JST 運用日) 以下になるため inclusive 比較で取りこぼしなし
  // (同日イベントの重複は slug+date+changeType の dedupe が吸収する)。打ち切られた delta だけは
  // 下で「最初の未返却イベントの date」に差し替える (打ち切り分の永久ロス防止・前進の保証)。
  let nextChangedSince = generatedAtIso.slice(0, 10);
  if (mode === 'snapshot') {
    hasMore = changelog.length > query.limit;
    changes = changelog.slice(-query.limit);
    services = published.map((entry) => toRow(entry, snapshot));
  } else {
    const since = query.changedSince as string;
    const matched = changelog.filter((event) => event.date >= since);
    const page = takeDeltaByDateGroups(matched, query.limit);
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
