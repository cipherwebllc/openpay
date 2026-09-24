// 決済の控え (履歴) の保存形式: localStorage key・上限・schema 版・型。値と型だけで副作用なし。
// lib/history/* の最下層。公開 import は facade (lib/history.ts) 経由で、leaf は facade を import しない。

import type { GasMode, PayMode } from '../fee';
import type {
  CircleVerificationStatus,
  PaymentFlow,
  PaymentProvider,
  PaymentResult,
} from '../paymentLog';
import type { TokenSymbol } from '../tokens';
import type { TaxCategory } from '../tax';

export const HISTORY_STORAGE_KEY = 'openpay:history:v1';
export const HISTORY_CHANGED_EVENT = 'openpay:history-changed';
// 「今日のお店」ダッシュボード用の小さな派生 summary key。LP はこの 1 key だけを
// 読み、履歴本体 (最大 1000 件) を parse しない。真実点はあくまで履歴本体で、これは
// キャッシュ (履歴変更時に当日分から再構築)。詳細は buildTodaySummary。
export const TODAY_SUMMARY_KEY = 'openpay:todaySummary:v1';
export const HISTORY_MAX_ENTRIES = 1000;
// 自由入力 (CheckoutForm の params.description 経由) を 1000 文字で truncate。
// 1000 件 × 1000 文字 ≒ 1 MB 上限 (UTF-8 換算で max ~3 MB)、LocalStorage 5 MB に
// 収まる。悪意 URL からの肥大化攻撃を構造的に防止。
export const HISTORY_NOTE_MAX_LENGTH = 1000;
// errorMessage は呼出元に依らず buildHistoryEntry で必ず cap される (Sentry / LocalStorage
// 肥大化対策、 stack trace で巨大化する error.message を抑える)。
export const HISTORY_ERROR_MESSAGE_MAX_LENGTH = 500;
// v5 記帳補助メタデータの上限 (LocalStorage 肥大化対策・自由入力の攻撃面を構造的に制限)。
export const HISTORY_PRODUCT_NAME_MAX = 80;
export const HISTORY_RECEIPT_NO_MAX = 64;
export const HISTORY_UNIT_AMOUNT_MAX = 32; // 人間可読 decimal 文字列 (token 単位)
export const HISTORY_LINE_ITEMS_MAX = 20; // 1 entry あたり明細件数 (checkout 上限 10 を内包)

// HistoryEntry は decimals / display symbol を保持しないため (raw wei + asset slug
// のみ)、UI / CSV 出力時に lookup する。lib/tokens.ts の TokenDeployment と同一
// 値を維持する必要があり、 token を増やすときは両方を更新する。
export const HISTORY_ASSET_DECIMALS: Record<TokenSymbol, number> = {
  jpyc: 18,
  usdc: 6,
};

export const HISTORY_ASSET_DISPLAY: Record<TokenSymbol, string> = {
  jpyc: 'JPYC',
  usdc: 'USDC',
};

// schema version 管理:
//
// LocalStorage に書かれた entry が将来 schema 変更を生き残るための infrastructure。
//
// 設計:
//   - すべての entry に schemaVersion field を必須 (新規 build は LATEST_SCHEMA_VERSION)。
//   - 既存 LocalStorage entry (Phase 2 初期版で schemaVersion を持たない) は
//     migrateToLatest で「unversioned = v1」と判定して v1 stamp して取込む。
//   - 将来 v2 → v3 等の schema 変更時は MIGRATIONS[from] = (entry) => migrated_entry
//     を 1 行追加するだけで chain migration が走る (migrateToLatest が低→高に repeatedly apply)。
//   - LATEST_SCHEMA_VERSION より大きい version は user の browser が我々の build より
//     新しい (= rollback 後の旧版が新版 entry を読む) ケース → 読込結果から除外し生データを保持。
//   - 不明な intermediate version (e.g. v3 がいたら v2 migration が必要だが無い) も同様。
//
// 既存 user データ救済の証拠は tests/lib/history.test.ts:「unversioned legacy 読込」群を参照。

// v2 (2026-05-30): Circle Paymaster (USDC ガスレス) 対応で provider 次元と Circle 監査
// フィールドを追加。legacy(v1) は MIGRATIONS[1] で新フィールド=null backfill (drop しない)。
// v3 (2026-06-01): fee/gas データ分離 (会計精度・freee 前提)。feeAmount を OpenPay 利用
// 手数料 (= サービス料、alpha/将来とも 0) のみに純化し、ネットワーク手数料相当額を
// networkFeeEquivalent に分離。売上総額 saleAmount を追加 (split / 着金控除と区別し
// GMV 集計の基礎にする)。legacy(v2) は MIGRATIONS[2] で null backfill + 内訳不明印
// (feeBreakdownVersion=0)。
// v4 (2026-06-03): 異通貨建て決済 (FX 換算動的 QR) の anchor 記録。店主が JPYC 価格を
// USDC 建てで受領した等の「元の価格建て (anchorAmount/anchorSymbol) + 適用 FX レート
// (fxRateUsdcJpy)」を残し、freee 等で「¥1000 の品を N USDC で決済」を照合可能にする。
// 通常決済 (非換算) は null。legacy(v3) は MIGRATIONS[3] で null backfill。
// v5 (2026-06-04): 記帳補助メタデータ (商品名/メモ/税率/税区分/管理番号/売上明細) を追加。店主が
// 「何を売ったか・税率・レシート番号」を残せるようにし、CSV/freee へ補助情報として通す。会計ソフト
// そのものではなく記帳補助。非該当・legacy(v4) は MIGRATIONS[4] で null backfill。
export const LATEST_SCHEMA_VERSION = 5 as const;

// fee/gas 内訳セマンティクスの版。schemaVersion とは独立: migration は schemaVersion を
// 昇格させるが、migrate された旧 entry の feeAmount は依然 conflated (利用手数料 + ガス
// reimbursement) で内訳不明のまま。native に v3 で記録した entry のみ「分離済」とみなす。
export const FEE_BREAKDOWN_VERSION = 1 as const;
// legacy / migrated entry の印 (利用手数料・網手数料の集計から除外する判定に使う)。
export const FEE_BREAKDOWN_UNKNOWN = 0 as const;

/** どの paymaster 系統で送ったか。legacy(v1) entry は記録が無いため null。
 * SoT は lib/paymentLog.ts の PaymentProvider (history→paymentLog の一方向 import)。 */
export type HistoryProvider = PaymentProvider;

/** Circle 徴収額 (circlePaymasterNetUsdc) の検証ステータス。
 * - verified: on-chain receipt から server/offline verifier が再計算した確定値
 * - client-reported: client が receipt から算出 (改竄可能性あり・参考値)
 * - unreconciled: receipt 照合不能 (txHash 解決不可・binding 不一致 等)
 * SoT は lib/paymentLog.ts の CircleVerificationStatus。 */
export type CircleVerification = CircleVerificationStatus;

/** 売上明細 1 行 (レジ / checkout の itemized 決済)。記帳補助メタデータ。
 * unitPrice / amount は人間可読 decimal (支払トークン単位・例 "500" / "1000")。raw wei ではない。 */
export type HistoryLineItem = {
  name: string;
  /** 数量 (1〜CHECKOUT_QTY_MAX)。 */
  quantity: number;
  unitPrice: string;
  amount: string;
  /** 行ごとの税率 (%)。複数商品カートでは行ごとに異なりうる。未指定は null。 */
  taxRate: number | null;
  taxCategory: TaxCategory | null;
  memo: string | null;
  // --- 複数商品カート対応で追加 (すべて任意・古い単品 lineItem は省略可)。
  //     表示/CSV 時に entryLineItems で補完 (currency←asset / taxAmount←算出 / id←合成)。
  /** 行の安定 id (React key / 明細CSV 用)。 */
  id?: string;
  /** 行の通貨 (同一カート単一通貨。省略時は entry.asset)。 */
  currency?: TokenSymbol;
  /** 内税 (token 単位・cart 確定時に算出)。省略時は表示/CSV で taxRate から算出。 */
  taxAmount?: string;
  /** 由来プリセット id (任意)。 */
  presetId?: string;
};

export type HistoryEntry = {
  /** schema version. 新規 entry は常に LATEST_SCHEMA_VERSION を持つ。 */
  schemaVersion: number;
  /** dedupe 用一意キー。tx hash があれば `${flow}-${hash}`、無ければ uuid。 */
  id: string;
  /** 取込時刻 (Date.now())。チェーン上 block time とは別物 (UI 表示用)。 */
  ts: number;
  flow: PaymentFlow;
  status: PaymentResult;
  chainId: number;
  /** "base" | "arbitrum" | "optimism" | "polygon"。URL 復元等で使う。 */
  chainSlug: string;
  asset: TokenSymbol;
  tokenAddress: string;
  /** 「JPYC ガスレス決済 (customer 負担)」等の表示識別子に。 */
  payMode: PayMode;
  /** standard モードでは概念がないため null。gasless のみ意味あり。 */
  gasMode: GasMode | null;
  merchant: string;
  /** bigint 文字列化 (raw wei)。decimal 化は表示時に formatTokenAmount。 */
  merchantAmount: string;
  customer: string | null;
  feeReceiver: string | null;
  feeAmount: string | null;
  txHash: string | null;
  userOpHash: string | null;
  /** receipt の blockNumber を文字列化したもの (UI 表示 + Explorer リンク用)。 */
  blockNumber: string | null;
  errorMessage: string | null;
  /**
   * 店舗名。 **現状は常に空文字** (`''`)。
   * - PaymentForm / CheckoutForm から append される時点で URL params に
   *   店舗名 key が無いため、parent component から空文字で渡される。
   * - 将来 `?name=` 等の URL 拡張で乗せる前提で field は予約してある。
   * - CSV 列 / UI 表示は空欄になる。schema 互換性のため field は削除しない。
   */
  storeName: string;
  /** 任意メモ (将来の inline edit 用、Phase 2 投入時は空)。 */
  note: string;
  // --- v2 追加 (Circle Paymaster 監査・legacy は null backfill) ---
  /** paymaster 系統。gasless で 'pimlico' | 'circle'、standard / legacy は null。 */
  provider: HistoryProvider | null;
  /** Circle Paymaster (permit spender) アドレス。circle 経路のみ、他は null。 */
  circlePaymasterAddress: string | null;
  /** Circle が postOp で徴収した net USDC (raw・customer→paymaster − refund)。
   * circle + 算出済のみ、他は null。 */
  circlePaymasterNetUsdc: string | null;
  /** circlePaymasterNetUsdc の検証ステータス。circle 経路のみ、他は null。 */
  circleVerification: CircleVerification | null;
  // --- v3 追加 (fee/gas 分離・会計精度。legacy は MIGRATIONS[2] で null/0 backfill) ---
  /** 売上総額 (請求額・raw)。利用手数料 / ガス / split 控除前の gross で、GMV 集計の
   * 基礎。standard / gasless とも設定する。legacy(v2 以前) は記録が無く null。
   * 注: 売上を伴わない leg (standard-fee = 手数料徴収 tx) も null。 */
  saleAmount: string | null;
  /** ネットワーク手数料相当額 (raw・支払トークン単位)。全 gasless 経路横断の統一項目:
   * JPYC sponsorship の立替回収 / USDC Pimlico erc20 で paymaster が顧客から徴収する gas
   * 見積。circle 経路のみ検証ステータス付きで circlePaymasterNetUsdc 側に保持するため
   * null とし、表示/集計は networkFeeEquivalentOf で coalesce する。standard / legacy は null。 */
  networkFeeEquivalent: string | null;
  /** fee/gas 内訳セマンティクスの版。native v3 = FEE_BREAKDOWN_VERSION、
   * legacy / migrated = FEE_BREAKDOWN_UNKNOWN (集計で利用手数料 / 網手数料 total から除外)。 */
  feeBreakdownVersion: number;
  // --- v4 追加 (異通貨建て決済の anchor。非換算 / legacy は null) ---
  /** 元の価格建て金額 (人間可読・例 "1000")。raw wei ではなく URL refAmt と同じ表示値。
   * FX 換算で生成された QR の決済のみ非 null、通常決済は null。 */
  anchorAmount: string | null;
  /** 価格を建てたトークン (anchorAmount の単位)。settled の asset の counterpart。
   * 例: USDC で受領したが元は JPYC 建て → 'jpyc'。非換算は null。 */
  anchorSymbol: TokenSymbol | null;
  /** 生成時に適用した usdcJpy (例 "156.32")。非換算は null。 */
  fxRateUsdcJpy: string | null;
  // --- v5 追加 (記帳補助メタデータ: 商品/税/明細。非該当・legacy は null backfill) ---
  /** 商品名 / 用途名 (= ユーザ仕様の description)。記帳補助。未指定は null。 */
  productName: string | null;
  /** 会計補助メモ。既存 note (checkout の description/orderId) とは別系統で温存する。 */
  memo: string | null;
  /** 税率 (%) 10 / 8 / 0(非課税·対象外) / 任意(custom)。未指定は null (CSV では既存デフォルト扱い)。 */
  taxRate: number | null;
  /** 内部税区分。CSV / freee へのマッピング鍵。未指定は null。 */
  taxCategory: TaxCategory | null;
  /** 管理番号 / レシート番号。未指定は null。 */
  receiptNo: string | null;
  /** 売上明細。単一 QR は null か 1 要素、レジ/checkout は N 要素。明細なしは null。 */
  lineItems: HistoryLineItem[] | null;
};
