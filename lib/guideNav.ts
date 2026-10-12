// ガイドの目次 (PC の左サイドバー・スマホの「ガイド一覧」) と /guide ハブの content SOT (ja/en 同梱)。
// plans/guide-hub-sidebar.md (§2・§3 + 計画レビュー R7 の文言・2026-10-11 user 承認)。
//
// 既存の guide 群と同じく長文は messages に置かない。next-intl に依存しないので、
// ガイドページを直接描画する既存テスト (getTranslations を mock) を壊さない。
// ⚠️ 料率・「無料」・「0 円」・ガス・チェーン名・通貨名は入れない (掟 14 の同期面を増やさない)。
// tests/lib/guideNav.test.ts が全 leaf を検査する。料金に触れたくなったら lib/legal.ts の DISCLOSED_* 経由にする。
// 例外は JPYC の名前だけ (ガイドの主題そのもの: pay の名前・ai-pay の説明)。対応通貨の一覧 (USDC など) は入れない。
// ⚠️ トップの入口 (components/LandingEntryPoints.tsx) も start/qr/shop/store の label・summary をここから読む (文言の出どころは 1 つ)。

import type { Metadata } from 'next';
import { guidePageMetadata } from '@/lib/guideMetadata';

/** 目次とハブに並べる順 (= app/[locale]/guide/<slug>/page.tsx のディレクトリと 1:1・test で照合)。 */
export const GUIDE_SLUGS = [
  'start',
  'qr',
  'shop',
  'pos',
  'pay',
  'mobile-order',
  'agent',
  'store',
  'ai-pay',
  'sell',
  'image-url',
] as const;

export type GuideSlug = (typeof GUIDE_SLUGS)[number];

type GuideGroupId = 'shops' | 'customers' | 'creators' | 'ai' | 'more';

// グループと並びは ja/en 共通 (文言だけをロケールごとに持つ)。
const GUIDE_GROUPS: readonly { id: GuideGroupId; slugs: readonly GuideSlug[] }[] = [
  { id: 'shops', slugs: ['start', 'qr', 'shop', 'pos'] },
  { id: 'customers', slugs: ['pay', 'mobile-order', 'agent'] },
  { id: 'creators', slugs: ['store'] },
  { id: 'ai', slugs: ['ai-pay', 'sell'] },
  { id: 'more', slugs: ['image-url'] },
];

// ハブの末尾「関連ページ」に並べる、ガイドではないページ (plans/pricing-page.md §2.6)。
// GUIDE_SLUGS (ディレクトリと 1:1 のフェンス) と目次のサイドバーには入れない。path は locale なし。
type RelatedPageId = 'pricing';
const RELATED_PAGES: readonly { id: RelatedPageId; path: `/${string}` }[] = [
  { id: 'pricing', path: '/pricing' },
];

type GuideNavCopy = {
  /** 目次の名前 (PC サイドバーの見出し・スマホのバー)。nav の a11y 名もこの可視テキストから。 */
  readonly navTitle: string;
  /** 長いガイドのページの頭の下に置く「このページの内容」(components/guide/GuideToc.tsx)。 */
  readonly tocTitle: string;
  /** 目次の先頭リンク (→ /guide) とハブの h1。 */
  readonly hubTitle: string;
  readonly hubLead: string;
  /** ハブの冒頭の「はじめての方へ」(読む順のおすすめ・導入前チェックリスト → 決済QR)。 */
  readonly hubStartTitle: string;
  readonly hubStartLead: string;
  readonly backHome: string;
  readonly metaTitle: string;
  readonly metaDescription: string;
  readonly groupTitles: Readonly<Record<GuideGroupId, string>>;
  /** label = 目次とハブのカードの名前 / summary = ハブのカードの 1 行説明。 */
  readonly items: Readonly<Record<GuideSlug, { readonly label: string; readonly summary: string }>>;
  /** ハブ末尾の「関連ページ」節の見出しと、そのカードの名前 / 1 行説明。 */
  readonly relatedTitle: string;
  readonly relatedItems: Readonly<Record<RelatedPageId, { readonly label: string; readonly summary: string }>>;
};

const JA: GuideNavCopy = {
  navTitle: 'ガイド一覧',
  tocTitle: 'このページの内容',
  hubTitle: 'OpenPay でできること',
  hubLead: 'やりたいことに合わせて、ガイドを選んでください。',
  hubStartTitle: 'はじめての方へ',
  hubStartLead: 'お店で受け取るなら、この順に読むと迷わず始められます。',
  backHome: '← OpenPay トップへ',
  metaTitle: 'OpenPay でできること — ガイド一覧',
  metaDescription:
    'お店での受け取り、お客様の注文、チップやデジタル商品の販売、AI による支払いと API の販売まで。OpenPay の使い方を、やりたいことごとのガイドで案内します。',
  groupTitles: {
    shops: 'お店向け',
    customers: 'お客様向け',
    creators: 'クリエイター向け',
    ai: 'AI・開発者向け',
    more: '補足',
  },
  items: {
    start: {
      label: '導入前チェックリスト',
      summary: '売上の受け取り方、日本円への戻し方、返金のしかたなど、始める前に確かめること。',
    },
    qr: {
      label: '決済QR',
      summary: '金額を入れて QR を出すだけ。いちばんシンプルな受け取り方です。',
    },
    shop: {
      label: 'レジ・モバイルオーダー',
      summary: '商品を一度登録すれば、店頭のレジでもスマホ注文でも使えます。',
    },
    pos: {
      label: '今お使いの POS レジと併用',
      summary: 'システム連携なしで、今お使いのレジに「OpenPay」決済を足す 2 台持ちの運用。',
    },
    pay: {
      label: 'JPYC で支払う',
      summary: 'お店の QR を読み取って、自分のウォレットで支払う。いちばん基本の支払い方です。',
    },
    'mobile-order': {
      label: 'モバイルオーダーのやり方',
      summary: 'お店の QR を読み取って、スマホで注文・支払い。アプリのインストールは要りません。',
    },
    agent: {
      label: 'AI に頼んで注文（訪日客向け）',
      summary: '日本語が読めなくても、自分の AI に頼んで注文。支払いは自分のウォレットで。',
    },
    store: {
      label: 'チップ・デジタル商品販売',
      summary: 'プロフィールでチップを受け付け、デジタル商品を販売。クリエイター向け。',
    },
    'ai-pay': {
      label: 'AI が支払う',
      summary: 'Claude などの AI に、データや API を JPYC で買う力を持たせる設定。',
    },
    sell: {
      label: 'API を売る',
      summary: '今ある API に 402 ゲートを付けて、AI が買える商品にする。',
    },
    'image-url': {
      label: '画像 URL の用意のしかた',
      summary: 'プロフィール・商品・お店のアイコンに使う画像の URL を用意する方法。',
    },
  },
  relatedTitle: '関連ページ',
  relatedItems: {
    pricing: {
      label: '料金',
      summary: '機能ごとに、だれが払うかと計算例をまとめています。',
    },
  },
};

const EN: GuideNavCopy = {
  navTitle: 'Guides',
  tocTitle: 'On this page',
  hubTitle: 'What you can do with OpenPay',
  hubLead: 'Pick the guide that matches what you want to do.',
  hubStartTitle: 'New here?',
  hubStartLead: 'To start taking payments in a shop, read these in order.',
  backHome: '← Back to OpenPay',
  metaTitle: 'What you can do with OpenPay — all guides',
  metaDescription:
    'From getting paid in your shop and customer ordering to tips, digital sales, payments by AI agents and selling APIs — OpenPay guides organized by what you want to do.',
  groupTitles: {
    shops: 'For shops',
    customers: 'For customers',
    creators: 'For creators',
    ai: 'For AI & developers',
    more: 'More',
  },
  items: {
    start: {
      label: 'Before-you-start checklist',
      summary: 'How sales reach you, converting back to yen, refunds — what to check before you start.',
    },
    qr: {
      label: 'Payment QR',
      summary: 'Enter an amount and show the QR. The simplest way to get paid.',
    },
    shop: {
      label: 'POS & mobile ordering',
      summary: 'Register products once and use them at the counter and for phone orders.',
    },
    pos: {
      label: 'Use with your current POS',
      summary: 'Add OpenPay as a payment method on the register you already use — two devices, no integration.',
    },
    pay: {
      label: 'Pay with JPYC',
      summary: "Scan the shop's QR code and pay from your own wallet. The most basic way to pay.",
    },
    'mobile-order': {
      label: 'How to use mobile order',
      summary: "Scan the shop's QR code, then order and pay on your phone. No app to install.",
    },
    agent: {
      label: 'Order with your AI (for visitors to Japan)',
      summary: "Can't read Japanese? Ask your AI to place the order, then pay from your own wallet.",
    },
    store: {
      label: 'Tips & digital product sales',
      summary: 'Take tips and sell digital products from your profile. For creators.',
    },
    'ai-pay': {
      label: 'Let your AI pay',
      summary: 'Set up Claude or another AI agent to buy data and APIs with JPYC.',
    },
    sell: {
      label: 'Sell your API',
      summary: 'Add a 402 gate to your existing API and turn it into a product AI can buy.',
    },
    'image-url': {
      label: 'How to prepare an image URL',
      summary: 'How to get an image URL for your profile, products and shop icon.',
    },
  },
  relatedTitle: 'Related',
  relatedItems: {
    pricing: {
      label: 'Pricing',
      summary: 'Who pays what for each feature, with worked examples.',
    },
  },
};

export type GuideNavItem = {
  readonly slug: GuideSlug;
  readonly label: string;
  readonly summary: string;
};

export type GuideNavGroup = {
  readonly id: GuideGroupId;
  readonly title: string;
  readonly items: readonly GuideNavItem[];
};

export type GuideRelatedItem = {
  readonly id: RelatedPageId;
  /** locale なしのパス (描画側で `/${locale}` を前に付ける)。 */
  readonly path: `/${string}`;
  readonly label: string;
  readonly summary: string;
};

export type GuideNav = Omit<GuideNavCopy, 'groupTitles' | 'relatedTitle' | 'relatedItems'> & {
  readonly groups: readonly GuideNavGroup[];
  /** ハブ末尾の「関連ページ」(目次のサイドバーには出さない)。 */
  readonly related: { readonly title: string; readonly items: readonly GuideRelatedItem[] };
};

function build(copy: GuideNavCopy): GuideNav {
  const { groupTitles, items, relatedTitle, relatedItems, ...frame } = copy;
  return {
    ...frame,
    items,
    groups: GUIDE_GROUPS.map(({ id, slugs }) => ({
      id,
      title: groupTitles[id],
      items: slugs.map((slug) => ({ slug, ...items[slug] })),
    })),
    related: {
      title: relatedTitle,
      items: RELATED_PAGES.map(({ id, path }) => ({ id, path, ...relatedItems[id] })),
    },
  };
}

const NAV_JA = build(JA);
const NAV_EN = build(EN);

/** 未知ロケールは ja (既存 guide の contentFor と同じ規約)。 */
export function guideNavFor(locale: string): GuideNav {
  return locale === 'en' ? NAV_EN : NAV_JA;
}

/** /guide ハブの metadata (canonical /{locale}/guide・hreflang ja/en・OG は既定の og-home.webp)。 */
export function guideHubMetadata(locale: string): Metadata {
  const nav = guideNavFor(locale);
  return guidePageMetadata({
    locale,
    path: '/guide',
    title: nav.metaTitle,
    description: nav.metaDescription,
  });
}
