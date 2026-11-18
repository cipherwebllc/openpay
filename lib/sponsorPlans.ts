// スポンサー・広告掲載の料金と入稿の決まりの正本 (2026-11-18 user 裁定)。
// 募集ページ (/sponsors・lib/sponsors.ts の ja / en の文) はここから数字を描く。第 2 段 (掲載の欄・設定ファイル・
// バナーのランダム表示) を作るときも、枠の数と入稿の決まりはここを使う (ページと掲載の欄で値を別に持たない)。
// 値は tests/lib/sponsors.test.ts が固定する。変えるときは募集ページの文 (承認済み) も見直す。
//
// 「税込」とは書かない (インボイスの登録なし・課税事業者でない見込み・user 裁定)。金額は表示の額だけをいただく。
// この file は数字だけを持つ (client の掲載の欄から import しても、ページの文が bundle に入らない)。

export type SponsorPlanId = 'sponsor' | 'banner';

export type SponsorPlan = {
  /** 1 期間の料金 (日本円)。 */
  readonly priceYen: number;
  /** 1 期間の日数。 */
  readonly termDays: number;
  /** 同時に掲載する会社の上限 (バナー広告は、この数の会社で 1 つの枠を共有する)。 */
  readonly maxCompanies: number;
};

export const SPONSOR_PLANS: Readonly<Record<SponsorPlanId, SponsorPlan>> = {
  // 法人スポンサー: 協賛企業の欄・案内ページの下部・募集ページに、ロゴ・企業名・リンクを同じ大きさで並べる。
  // 上限 6 社 (2026-11-18 user 裁定: 表示を分け合わないので 3 から増やす・限られた枠として上限は書く)。
  sponsor: { priceYen: 33_000, termDays: 30, maxCompanies: 6 },
  // バナー広告: 最大 3 社で共有する枠 (ページ表示のたびに 1 件をランダムに出す・第 2 段)。
  banner: { priceYen: 11_000, termDays: 30, maxCompanies: 3 },
};

/**
 * 法人スポンサーの年間プラン (2026-11-18 user 裁定): 30 日の料金の 11 回分で 365 日 (12 回払いより 1 回分安い)。
 * バナー広告には無い。料金は 30 日の料金から作る (別の値を持たない)。
 */
const SPONSOR_ANNUAL_TERMS_CHARGED = 11;

export const SPONSOR_ANNUAL_PLAN = {
  termsCharged: SPONSOR_ANNUAL_TERMS_CHARGED,
  termDays: 365,
  priceYen: SPONSOR_PLANS.sponsor.priceYen * SPONSOR_ANNUAL_TERMS_CHARGED,
} as const;

/**
 * 掲載は期間ごとに自動で更新する (2026-11-18 user 裁定)。次の期間の請求書を、期間の終わる何日前までに送るか。
 * term = 30 日のプラン (法人スポンサー・バナー広告)・annual = 年間プラン。
 */
export const SPONSOR_RENEWAL_INVOICE_DAYS_BEFORE = { term: 7, annual: 30 } as const;

/** バナーの入稿の決まり (横 4：縦 1)。 */
export const SPONSOR_BANNER_SPEC = {
  width: 1200,
  height: 300,
  maxKb: 300,
} as const;

/** ロゴの横幅の下限 (px)。 */
export const SPONSOR_LOGO_MIN_WIDTH = 400;

/** 紹介文の字数の上限 (募集ページに載せる短い紹介文)。 */
export const SPONSOR_BLURB_MAX_CHARS = { ja: 80, en: 160 } as const;

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** バナーの縦横の比 (1200×300 → 横 4：縦 1)。 */
export function sponsorBannerRatio(): { readonly w: number; readonly h: number } {
  const d = gcd(SPONSOR_BANNER_SPEC.width, SPONSOR_BANNER_SPEC.height);
  return { w: SPONSOR_BANNER_SPEC.width / d, h: SPONSOR_BANNER_SPEC.height / d };
}

/** 金額の 3 桁区切り (33000 → "33,000")。ja / en とも同じ区切り。 */
export function formatSponsorYen(yen: number): string {
  return yen.toLocaleString('en-US');
}
