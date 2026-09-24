// Service Monitor の changelog 語彙と型 (固定語彙の定数 + 型のみ・ロジックなし)。
// changelogData.ts (データ) と serviceMonitor.ts (契約・ロジック) の両方がここに依存する —
// データ module がロジック module を import しない (循環させない) ための分離 (2026-09-24 R9a)。
// 公開 export は serviceMonitor.ts から従来どおり再 export する (利用側の import 経路は不変)。

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
  /** YYYY-MM-DD = **一次ソースの発表日** (2026-09-03 統一。収集日ではない)。
   *  changedSince との比較は文字列比較 (同形式ゆえ安全)。 */
  date: string;
  /** YYYY-MM-DD = こちらが記録した日 (収集日)。発表日と乖離する場合の監査用・任意。 */
  collectedAt?: string;
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
