// Japan Stablecoin Payment Monitor の「事業者の現況行」(2026-09-02 裁定 2/2)。
// イベント (何が起きたか) に加え、**同じ固定項目で毎週確認した現況**を返す。項目が一次ソースに
// 無ければ null — null も「確認したが公表されていない」という確認結果であり、推測で埋めない
// (sourced-facts-only)。行の provider 名は changelog の provider 表示名と完全一致させる
// (tests/lib/directory/paymentMonitor.test.ts が双方向に検証する)。
//
// 週次更新の掟: 現況が変わったら (1) ここを更新 (2) changelog に diffs 付きイベントを追記 —
// 同一 PR で。verifiedAt は一次ソースを再確認した日。

export const PAYMENT_PROVIDER_STAGES = ['partnership', 'pilot', 'commercial', 'closed'] as const;
export type PaymentProviderStage = (typeof PAYMENT_PROVIDER_STAGES)[number];

export const PAYMENT_INTEGRATIONS = ['api', 'in-store', 'ec', 'wallet'] as const;
export type PaymentIntegration = (typeof PAYMENT_INTEGRATIONS)[number];

export type PaymentProviderRecord = {
  /** changelog の provider 表示名と一致 (行の結合キー)。 */
  provider: string;
  /** ディレクトリエントリに紐づく場合のみ。 */
  slug?: string;
  stage: PaymentProviderStage;
  /** 対象ステーブルコイン (例 ['USDC','JPYC'])。 */
  assets: readonly string[];
  /** 対象チェーン (判明分のみ・不明は [])。 */
  chains: readonly string[];
  /** 加盟店への精算通貨 (例 'JPY')。一次ソースが明示しない場合は null。 */
  settlementCurrency: string | null;
  /** 加盟店手数料 (正規化した文字列)。非公表は null。 */
  merchantFee: string | null;
  /** 導入方式 (固定語彙)。不明は []。 */
  integrations: readonly PaymentIntegration[];
  /** POS 連携の有無。公表が無ければ null。 */
  posIntegration: boolean | null;
  /** 対象地域 (例 'Japan' / 'Osaka')。 */
  region: string | null;
  /** 発表日 (一次ソースの日付・YYYY-MM-DD)。 */
  announcedAt: string;
  /** 商用/実証の開始日 (一次ソースが開始を明示した場合のみ)。 */
  startedAt: string | null;
  /** 予定期間 (例 '2027-01..2027-03')。実施済み/未公表は null。 */
  plannedPeriod: string | null;
  sourceUrl: string;
  /** 一次ソースを最後に再確認した日。 */
  verifiedAt: string;
};

const OSAKA_SUBSIDY_URL =
  'https://www.pref.osaka.lg.jp/o020060/kikaku/osaka-kokusaikinyu/senkuteki_hojokin.html';

export const PAYMENT_PROVIDERS: readonly PaymentProviderRecord[] = [
  {
    provider: 'TIS / JPYC',
    stage: 'partnership',
    assets: ['JPYC'],
    chains: [],
    settlementCurrency: null,
    merchantFee: null,
    integrations: [],
    posIntegration: null,
    region: 'Japan',
    announcedAt: '2025-11-14',
    startedAt: null,
    plannedPeriod: null,
    sourceUrl: 'https://www.tis.co.jp/news/2025/tis_news/20251114_1.html',
    verifiedAt: '2026-08-27',
  },
  {
    provider: 'Digital Garage / JCB / Resona HD',
    stage: 'pilot',
    assets: ['USDC', 'JPYC'],
    chains: [],
    settlementCurrency: null,
    merchantFee: null,
    integrations: ['in-store'],
    posIntegration: null,
    region: 'Japan',
    announcedAt: '2026-02-19',
    startedAt: null,
    plannedPeriod: null,
    sourceUrl: 'https://www.garage.co.jp/pr/release/20260219/',
    verifiedAt: '2026-08-27',
  },
  {
    provider: 'JCB / Circle',
    stage: 'partnership',
    assets: ['USDC'],
    chains: [],
    settlementCurrency: null,
    merchantFee: null,
    integrations: [],
    posIntegration: null,
    region: 'Japan',
    announcedAt: '2026-07-15',
    startedAt: null,
    plannedPeriod: null,
    sourceUrl: 'https://prtimes.jp/main/html/rd/p/000001423.000011361.html',
    verifiedAt: '2026-08-27',
  },
  {
    provider: 'DG Stablecoin Payment Service',
    slug: 'dg-sps',
    stage: 'commercial',
    assets: ['USDC'],
    chains: ['base'],
    settlementCurrency: null,
    merchantFee: null,
    integrations: ['api'],
    posIntegration: null,
    region: 'Japan',
    announcedAt: '2026-08-10',
    startedAt: '2026-08-10',
    plannedPeriod: null,
    sourceUrl: 'https://www.garage.co.jp/pr/release/20260810/',
    verifiedAt: '2026-08-27',
  },
  {
    provider: 'HashPort (Osaka Pref. subsidy)',
    stage: 'pilot',
    assets: ['JPYC', 'USDC'],
    chains: [],
    settlementCurrency: 'JPY',
    merchantFee: null,
    integrations: ['in-store', 'ec'],
    posIntegration: null,
    region: 'Osaka',
    announcedAt: '2026-08-26',
    startedAt: null,
    plannedPeriod: '2027-01..2027-03',
    sourceUrl: OSAKA_SUBSIDY_URL,
    verifiedAt: '2026-08-27',
  },
  {
    provider: 'Mina Wallet / Sumitomo Mitsui Card (Osaka Pref. subsidy)',
    stage: 'pilot',
    assets: ['JPYC', 'USDC'],
    chains: [],
    settlementCurrency: null,
    merchantFee: null,
    integrations: ['wallet'],
    posIntegration: null,
    region: 'Osaka',
    announcedAt: '2026-08-26',
    startedAt: null,
    plannedPeriod: '2026-10..2027-02',
    sourceUrl: OSAKA_SUBSIDY_URL,
    verifiedAt: '2026-08-27',
  },
  {
    provider: 'Mi&T (Osaka Pref. subsidy)',
    stage: 'pilot',
    assets: ['JPYC'],
    chains: [],
    settlementCurrency: null,
    merchantFee: null,
    integrations: ['in-store'],
    posIntegration: null,
    region: 'Osaka',
    announcedAt: '2026-08-26',
    startedAt: null,
    plannedPeriod: null,
    sourceUrl: OSAKA_SUBSIDY_URL,
    verifiedAt: '2026-08-27',
  },
];
