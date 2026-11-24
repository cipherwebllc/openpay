// /sponsors「スポンサー・広告掲載のご案内」の content SOT (ja/en 同梱・2026-11-18 user 裁定の第 1 段)。
// page (app/[locale]/sponsors/page.tsx) が locale で出し分けて描画する。
//
// ja の文は運営者の承認済み (2026-11-18)。en は同じ中身の英訳。中身から外れない・事実を足さない。
// 料金・日数・社数・入稿の数字は lib/sponsorPlans.ts の定数から差し込む (ページの文に数字を直書きしない)。
// 承認の文と一致することは tests/lib/sponsors.test.ts が固定する (つなぐと承認の文に戻る)。
//
// 書かないもの (裁定): 「税込」・計測やレポートの案内・確かめていない実績 (アクセス数・協賛企業・導入実績)・
// OpenPay 側の定期投稿や記事制作の約束・口座の情報・新しい外部フォームやメールアドレス。
// 第 1 段では掲載の欄・設定ファイル・ランダム表示を作らない (掲載イメージは「サンプル」と明記した枠だけ)。

import type { Metadata } from 'next';
import { guidePageMetadata } from './guideMetadata';
import {
  SPONSOR_ANNUAL_PLAN,
  SPONSOR_BANNER_SPEC,
  SPONSOR_BLURB_MAX_CHARS,
  SPONSOR_LOGO_MIN_WIDTH,
  SPONSOR_PLANS,
  SPONSOR_RENEWAL_INVOICE_DAYS_BEFORE,
  formatSponsorYen,
  sponsorBannerRatio,
  type SponsorPlanId,
} from './sponsorPlans';

export type SponsorsLocale = 'ja' | 'en';

/** 料金のカード。focal + focalSub が承認の文の頭 (料金・期間・社数)、body がその後ろの文。 */
export type SponsorsPlanCard = {
  readonly id: SponsorPlanId;
  readonly name: string;
  readonly focal: string;
  readonly focalSub: string;
  readonly body: string;
};

/** 年間プランのカード (法人スポンサーだけ)。name・focal + focalSub・body をつなぐと承認の文に戻る。 */
export type SponsorsAnnualCard = {
  readonly name: string;
  readonly focal: string;
  readonly focalSub: string;
  readonly body: string;
};

/** 入稿仕様の 1 行。body が無い行は label だけ (リンク先の URL)。 */
export type SponsorsSpecItem = {
  readonly label: string;
  readonly body: string | null;
};

export type SponsorsContent = {
  readonly metaTitle: string;
  readonly metaDescription: string;
  readonly backHome: string;
  readonly title: string;
  readonly lead: string;
  readonly audience: string;
  readonly contactLine: string;
  readonly contactDiscord: string;
  readonly contactX: string;

  readonly plansTitle: string;
  /** いただいた料金の使いみちと、協賛の内容 (目的)。 */
  readonly plansLead: string;
  readonly plans: readonly SponsorsPlanCard[];
  readonly annual: SponsorsAnnualCard;
  readonly priceNote: string;

  readonly samplesTitle: string;
  readonly sampleLabel: string;
  readonly sampleLogo: string;
  readonly sampleCompany: string;
  readonly sampleBannerSize: string;

  readonly specsTitle: string;
  readonly specs: readonly SponsorsSpecItem[];

  readonly termsTitle: string;
  readonly terms: string;
  readonly bannerTermsLabel: string;
  readonly bannerTerms: string;

  /** 自動の更新 (30 日のプラン・年間プラン)。 */
  readonly renewalTitle: string;
  readonly renewal: string;
  readonly renewalAnnual: string;

  readonly standardsTitle: string;
  readonly standardsIntro: string;
  readonly standards: readonly string[];
  readonly standardsNote: string;

  readonly refundTitle: string;
  readonly refund: string;

  readonly welcomeTitle: string;
  readonly welcome: string;

  readonly flowTitle: string;
  readonly flow: readonly string[];
};

const SPONSOR = SPONSOR_PLANS.sponsor;
const BANNER = SPONSOR_PLANS.banner;
const ANNUAL = SPONSOR_ANNUAL_PLAN;
const RENEW = SPONSOR_RENEWAL_INVOICE_DAYS_BEFORE;
const RATIO = sponsorBannerRatio();
const BANNER_PX = `${SPONSOR_BANNER_SPEC.width}×${SPONSOR_BANNER_SPEC.height} px`;

const ja: SponsorsContent = {
  metaTitle: 'スポンサー・広告掲載のご案内 | OpenPay',
  metaDescription:
    `OpenPay の開発・運営を支える法人スポンサー（${formatSponsorYen(SPONSOR.priceYen)} 円／${SPONSOR.termDays} 日・最大 ${SPONSOR.maxCompanies} 社）と、` +
    `バナー広告（${formatSponsorYen(BANNER.priceYen)} 円／${BANNER.termDays} 日・最大 ${BANNER.maxCompanies} 社で共有）の掲載企業を募集しています。` +
    'お問い合わせは LINE・Discord・X で。',
  backHome: '← OpenPay トップへ',
  title: 'スポンサー・広告掲載のご案内',
  lead: 'JPYC の利用と、AI が支払う体験を、一緒に広げませんか。OpenPay の開発・運営を支える法人スポンサーと、広告掲載企業を募集しています。',
  audience: 'ウォレット・決済・API・開発基盤など、OpenPay を使うお店・お客様・AI エージェントの開発者に関わる企業の方へ。',
  contactLine: 'LINE で問い合わせる',
  contactDiscord: 'Discord で問い合わせる',
  contactX: 'X で問い合わせる',

  plansTitle: '掲載プランと料金',
  plansLead:
    'いただいた協賛・掲載料は、OpenPay の開発と運営にあてます。協賛は、OpenPay の開発・運営の支援と、協賛企業としての掲載を内容とします。',
  plans: [
    {
      id: 'sponsor',
      name: '法人スポンサー',
      focal: `${formatSponsorYen(SPONSOR.priceYen)} 円`,
      focalSub: `／${SPONSOR.termDays} 日・最大 ${SPONSOR.maxCompanies} 社`,
      body: 'トップページ上部の「協賛企業」欄・OpenPay の案内ページ（ガイド等）の下部・このページに、ロゴ・企業名・リンク（このページでは短い紹介文も）を掲載します。掲載中の全社のロゴを、同じ大きさで並べます。',
    },
    {
      id: 'banner',
      name: 'バナー広告',
      focal: `${formatSponsorYen(BANNER.priceYen)} 円`,
      focalSub: `／${BANNER.termDays} 日・最大 ${BANNER.maxCompanies} 社で共有する枠`,
      body: 'トップページ（主な機能の紹介の後）・Store（商品一覧の手前）・AI ストア（カタログの手前）に掲載します。',
    },
  ],
  annual: {
    name: '年間プラン（法人スポンサー）',
    focal: `${formatSponsorYen(ANNUAL.priceYen)} 円`,
    focalSub: `／${ANNUAL.termDays} 日`,
    body: `${SPONSOR.termDays} 日の料金の ${ANNUAL.termsCharged} 回分で、1 年間掲載します。お支払いは期間の初めに一括です。広告主様のご都合で途中で止める場合、返金はありません。`,
  },
  priceNote:
    '表示の金額のほかに、消費税等をいただくことはありません。請求書を発行します（適格請求書ではありません）。お支払いは、日本円の銀行振込か JPYC で承ります。',

  samplesTitle: '掲載イメージ',
  sampleLabel: 'サンプル',
  sampleLogo: 'ロゴ',
  sampleCompany: '企業名',
  sampleBannerSize: BANNER_PX,

  specsTitle: '入稿仕様',
  specs: [
    {
      label: 'バナー',
      body: `${BANNER_PX}（横 ${RATIO.w}：縦 ${RATIO.h}）・PNG / JPG / WebP・${SPONSOR_BANNER_SPEC.maxKb} KB 以内・代替テキスト（画像の説明の文）`,
    },
    { label: 'ロゴ', body: `SVG か PNG（背景が透明のもの）・横 ${SPONSOR_LOGO_MIN_WIDTH} px 以上` },
    { label: 'リンク先の URL（https）', body: null },
    { label: '紹介文', body: `日本語 ${SPONSOR_BLURB_MAX_CHARS.ja} 字以内・英語 ${SPONSOR_BLURB_MAX_CHARS.en} 字以内` },
  ],

  termsTitle: '掲載条件',
  terms:
    '掲載料金は、所定の掲載場所・期間に対する料金です。バナー・ロゴ等の素材は広告主様にご用意いただきます。定期レポートの提供は含まれません。表示回数・クリック数・お問い合わせ・購入等の成果は保証いたしません。',
  bannerTermsLabel: '（バナー広告）',
  bannerTerms:
    '複数の広告主様で共有する広告枠です。ページ表示時に、掲載中の広告から 1 件をランダムに表示します。閲覧中の自動切り替えは行いません。表示回数・表示割合の保証はありません。',

  renewalTitle: '更新',
  renewal:
    `掲載は期間ごとに自動で更新します。期間の終わる ${RENEW.term} 日前までに、次の期間の請求書をお送りします。` +
    '更新しない場合は、期間の終わる日までに LINE・Discord・X でお知らせください（お送りした請求書は取り消します）。' +
    '次の期間の始まる日までにお支払いを確かめられない場合は、掲載を止めます。',
  renewalAnnual: `年間プランも同じく自動で更新し、請求書は期間の終わる ${RENEW.annual} 日前までにお送りします。`,

  standardsTitle: '掲載基準',
  standardsIntro: '次のものは掲載しません:',
  standards: [
    '法令に反するもの',
    '必要な登録の無い暗号資産の交換や電子決済手段の取引のサービス',
    '利回りや値上がりをうたう投資の勧誘',
    'ギャンブル',
    '誤解を招く表示',
    'OpenPay の決済の操作と見間違える表示',
  ],
  standardsNote: 'OpenPay の判断で、掲載をお断りしたり、掲載中でも止めたりすることがあります。',

  refundTitle: '返金',
  refund:
    '掲載基準に反するため掲載を止めた場合、掲載料はお返ししません。OpenPay の都合で掲載を止めた場合は、残りの日数分を日割りでお返しします。',

  welcomeTitle: '歓迎事項',
  welcome: '企業の公式 SNS やブログでの OpenPay の紹介や、活用事例の相互紹介を歓迎します（必須ではありません）。',

  flowTitle: 'お申し込みの流れ',
  flow: [
    'LINE・Discord・X でお問い合わせ',
    '掲載の可否・空き枠・開始日のご連絡',
    '素材のご入稿',
    '請求書の発行とお支払い',
    `掲載開始（${SPONSOR.termDays} 日・年間プランは 1 年）`,
    '期間ごとに自動で更新',
  ],
};

const en: SponsorsContent = {
  metaTitle: 'Sponsorship and advertising | OpenPay',
  metaDescription:
    `We are looking for corporate sponsors (¥${formatSponsorYen(SPONSOR.priceYen)} / ${SPONSOR.termDays} days, up to ${SPONSOR.maxCompanies} companies) ` +
    `and banner advertisers (¥${formatSponsorYen(BANNER.priceYen)} / ${BANNER.termDays} days, shared by up to ${BANNER.maxCompanies} companies) ` +
    "to support OpenPay's development and operation. Contact us on LINE, Discord or X.",
  backHome: '← Back to OpenPay',
  title: 'Sponsorship and advertising',
  lead: "Would you like to help spread the use of JPYC and the experience of AI that pays, together with us? We are looking for corporate sponsors who support OpenPay's development and operation, and for companies to advertise with us.",
  audience:
    'For companies in wallets, payments, APIs, developer platforms and other fields related to the shops, customers and AI-agent developers who use OpenPay.',
  contactLine: 'Contact us on LINE',
  contactDiscord: 'Contact us on Discord',
  contactX: 'Contact us on X',

  plansTitle: 'Plans and pricing',
  plansLead:
    "Sponsorship and advertising fees go toward OpenPay's development and operation. A sponsorship consists of supporting OpenPay's development and operation, and being listed as a sponsor.",
  plans: [
    {
      id: 'sponsor',
      name: 'Corporate sponsor',
      focal: `¥${formatSponsorYen(SPONSOR.priceYen)}`,
      focalSub: `/ ${SPONSOR.termDays} days · up to ${SPONSOR.maxCompanies} companies`,
      body: 'Your logo, company name and link (plus a short introduction on this page) appear in the "Sponsors" section near the top of the home page, at the bottom of OpenPay\'s information pages (such as the guides), and on this page. The logos of all current sponsors are shown side by side at the same size.',
    },
    {
      id: 'banner',
      name: 'Banner ad',
      focal: `¥${formatSponsorYen(BANNER.priceYen)}`,
      focalSub: `/ ${BANNER.termDays} days · one slot shared by up to ${BANNER.maxCompanies} companies`,
      body: 'Shown on the home page (after the overview of the main features), the Store (before the product list) and the AI Store (before the catalog).',
    },
  ],
  annual: {
    name: 'Annual plan (corporate sponsors)',
    focal: `¥${formatSponsorYen(ANNUAL.priceYen)}`,
    focalSub: `/ ${ANNUAL.termDays} days`,
    body: `One year of placement for the price of ${ANNUAL.termsCharged} terms of ${SPONSOR.termDays} days. Paid in full at the start of the term. No refund if you end the placement early for your own reasons.`,
  },
  priceNote:
    "We do not charge consumption tax or any other amount on top of the prices shown. We issue an invoice (it is not a qualified invoice under Japan's invoice system). You can pay by bank transfer in Japanese yen or in JPYC.",

  samplesTitle: 'Sample placements',
  sampleLabel: 'Sample',
  sampleLogo: 'Logo',
  sampleCompany: 'Company name',
  sampleBannerSize: BANNER_PX,

  specsTitle: 'Material specifications',
  specs: [
    {
      label: 'Banner',
      body: `${BANNER_PX} (${RATIO.w}:${RATIO.h}, width to height) · PNG / JPG / WebP · up to ${SPONSOR_BANNER_SPEC.maxKb} KB · alt text (a sentence describing the image)`,
    },
    { label: 'Logo', body: `SVG or PNG (with a transparent background) · at least ${SPONSOR_LOGO_MIN_WIDTH} px wide` },
    { label: 'Link URL (https)', body: null },
    {
      label: 'Introduction',
      body: `up to ${SPONSOR_BLURB_MAX_CHARS.ja} characters in Japanese · up to ${SPONSOR_BLURB_MAX_CHARS.en} characters in English`,
    },
  ],

  termsTitle: 'Placement terms',
  terms:
    'The fee is for the specified placement locations and period. Advertisers provide their own materials, such as banners and logos. Regular reports are not included. We do not guarantee results such as impressions, clicks, inquiries or purchases.',
  bannerTermsLabel: '(Banner ads)',
  bannerTerms:
    'The ad slot is shared by multiple advertisers. Each time a page is displayed, one of the current ads is shown at random. Ads do not switch automatically while the page is being viewed. The number of impressions and the share of impressions are not guaranteed.',

  renewalTitle: 'Renewal',
  renewal:
    `Placements renew automatically each term. We send the invoice for the next term at least ${RENEW.term} days before the current term ends. ` +
    'If you do not wish to renew, let us know on LINE, Discord or X by the last day of the term (we will cancel the invoice). ' +
    'If we cannot confirm payment by the first day of the next term, the placement stops.',
  renewalAnnual: `The annual plan also renews automatically; we send its invoice at least ${RENEW.annual} days before the term ends.`,

  standardsTitle: 'Placement standards',
  standardsIntro: 'We do not accept the following:',
  standards: [
    'Anything that violates laws or regulations',
    'Crypto-asset exchange or electronic payment instrument trading services without the required registration',
    'Investment solicitations that promise yields or price increases',
    'Gambling',
    'Misleading content',
    "Content that could be mistaken for OpenPay's payment controls",
  ],
  standardsNote: 'OpenPay may, at its discretion, decline an ad or stop it even while it is running.',

  refundTitle: 'Refunds',
  refund:
    "If we stop a placement because it violates our placement standards, the fee is not refunded. If we stop a placement for OpenPay's own reasons, we refund the remaining days on a pro-rata basis.",

  welcomeTitle: 'What we welcome',
  welcome:
    "We welcome introductions of OpenPay on your company's official social media or blog, and mutual introductions of use cases (not required).",

  flowTitle: 'How to apply',
  flow: [
    'Contact us on LINE, Discord or X',
    'We let you know whether we can accept the placement, which slots are open, and the start date',
    'You send us your materials',
    'We issue an invoice and you pay',
    `Your placement starts (${SPONSOR.termDays} days, or one year on the annual plan)`,
    'Renews automatically each term',
  ],
};

export const SPONSORS: Readonly<Record<SponsorsLocale, SponsorsContent>> = { ja, en };

/** 未知ロケールは ja (ガイド群・料金ページと同じ規約)。 */
export function sponsorsContentFor(locale: string): SponsorsContent {
  return locale === 'en' ? SPONSORS.en : SPONSORS.ja;
}

/** canonical /{locale}/sponsors・hreflang ja/en・OG 画像は既定の og-home.webp (料金を焼き込んだ画像は作らない)。 */
export function sponsorsMetadata(locale: string): Metadata {
  const content = sponsorsContentFor(locale);
  return guidePageMetadata({
    locale,
    path: '/sponsors',
    title: content.metaTitle,
    description: content.metaDescription,
  });
}
