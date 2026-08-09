// /guide/start 「導入前チェックリスト」の content SOT (裁定 2026-08-09・plans/guide-start-draft.md)。
// 既存の /guide/qr・/guide/shop・/guide/pos が「機能の使い方」を説明するのに対し、本ページは
// 「JPYC というお金の性質と、店舗が引き受ける責任」を扱う意思決定面。3 面から相互リンクする。
// 長文を messages/*.json に置かない方針は lib/qrGuide.ts / lib/shopGuide.ts と同じ。
//
// ⚠️ 利用料の数値と対応チェーン一覧は本ファイルに書かない — page 側で掟 14 フェンス済みの
// Landing.supportFee* / Landing.faqA2 (messages) を描画する (slot: 'fee' / 'chains')。
// ⚠️ 保存期間 (72h / 200 件 / 180 日) は実装値の開示。lib/orderRelay.ts の
// ORDER_LIST_TTL_SEC・ORDER_LIST_MAX と lib/tipMessages.ts の TIP_MESSAGE_TTL_SEC を
// 変更したら本ファイルも同期する (tests/lib/startGuide.test.ts がフェンスする)。

import type { Metadata } from 'next';
import { guidePageMetadata } from '@/lib/guideMetadata';
import type { GuideImage } from '@/lib/posGuide';

export type StartGuideSection = {
  readonly n: number;
  readonly title: string;
  readonly body: readonly string[];
  /** 矢印で繋ぐ短い流れ (「お客様のウォレット → 店舗のウォレット」等)。 */
  readonly flow?: readonly string[];
  readonly bullets?: readonly string[];
  /**
   * bullets (= 決めておく運用ルール) の後に置く補足。主従を保つための構造で、
   * 「決めごとが主・技術的な手順は参考」という関係を描画側でも崩さない。
   */
  readonly afterBullets?: {
    readonly body: string;
    readonly title: string;
    readonly items: readonly string[];
  };
  readonly callout?: { readonly kind: 'warn' | 'tip'; readonly text: string };
  /** 用語 + 説明の対 (どこに何が残るか)。 */
  readonly defs?: readonly { readonly term: string; readonly desc: string }[];
  readonly externalLinks?: readonly {
    readonly label: string;
    readonly href: string;
  }[];
  /** 本文中の図版 (public/guide/*.svg・寸法は PosGuidePieces の FIGURE_DIMS)。 */
  readonly figure?: GuideImage;
  /** messages 側の開示を差し込む位置 (数値の直書きを増やさないため)。 */
  readonly slot?: 'fee' | 'chains';
};

export type StartGuideContent = {
  readonly metaTitle: string;
  readonly metaDescription: string;
  readonly backHome: string;

  readonly heroTitle: string;
  readonly heroLead: readonly string[];

  readonly checklistTitle: string;
  readonly checklistLead: string;
  readonly checklistItems: readonly string[];

  readonly sections: readonly StartGuideSection[];

  readonly guidesTitle: string;
  readonly guideLinkQr: string;
  readonly guideLinkShop: string;
  readonly guideLinkPos: string;

  readonly ctaTitle: string;
  readonly ctaBody: readonly string[];
  readonly ctaKicker: string;
  readonly ctaLabel: string;
};

const JPYC_OFFICIAL = 'https://jpyc.co.jp/';
// 運営者 (masia) が書いた JPYC 運用ガイド。ウォレット準備から換金・運用までを 1 本で追える
// 補足資料として項目 1 から案内する (トップの「なぜ今、ステーブルコインなのか」と同じ記事)。
const JPYC_NOTE_GUIDE = 'https://note.com/masia02/n/ned04a4cdb00a';

const JA: StartGuideContent = {
  metaTitle: 'OpenPay 導入前チェックリスト — JPYC決済を始める前に | OpenPay',
  metaDescription:
    '売上の受け取り方、日本円への戻し方、返金のしかた。JPYC決済を本格導入する前に店舗が確認しておきたい 8 つのことを、実際の利用料・保存期間つきでまとめました。',
  backHome: '← OpenPay トップへ',

  heroTitle: 'JPYC決済を始める前に、確認しておきたい 8 つのこと',
  heroLead: [
    'OpenPay は、専用端末も加盟店契約もなしに、ウォレットひとつで JPYC 決済を始められます。売上は OpenPay が預からず、決済と同時にあなたのウォレットへ直接届きます。導入費用は 0 円です。',
    '一方で、JPYC はブロックチェーン上のお金です。売上の受け取り方、日本円への戻し方、返金のしかたが、カードや QR コード決済とは違います。本格的に使い始める前に、次の 8 つを確認してください。',
  ],

  checklistTitle: 'まず、この 5 つを一周してみる',
  checklistLead:
    'この一周を自分で経験しておくと、相手に質問されたときに迷いません。',
  checklistItems: [
    '受け取り用のウォレットを準備する',
    '少額でテスト決済してみる',
    '返金になったときの進め方を決める',
    'JPYC EX で少額を日本円に戻してみる',
    '履歴と会計記録の残し方を決める',
  ],

  sections: [
    {
      n: 1,
      title: 'JPYC を準備する',
      body: [
        'OpenPay で JPYC を受け取るには、対応ウォレットを用意します。店舗でもクリエイターでも、受け取る側の流れは 3 ステップです。',
        'JPYC そのものを手に入れるなら、発行元の JPYC EX が使えます。本人確認のうえ発行予約をし、指定の銀行口座へ日本円を振り込むと、登録したウォレットに JPYC が届きます。',
      ],
      flow: ['ウォレットを準備', 'OpenPay に接続', '受取先を設定'],
      callout: {
        kind: 'warn',
        text: 'JPYC EX が対応するチェーンと、OpenPay が決済に対応するチェーンは同じではありません。受け取ったチェーンと決済で使うチェーンが噛み合うかは、導入時に必ず確認してください。',
      },
      externalLinks: [
        { label: 'JPYC 公式サイトで最新条件を見る', href: JPYC_OFFICIAL },
        {
          label: 'JPYC 運用ガイド (ウォレット準備〜換金・運用) — note',
          href: JPYC_NOTE_GUIDE,
        },
      ],
      slot: 'chains',
    },
    {
      n: 2,
      title: '売上はその場でウォレットへ',
      body: [
        '一般的なキャッシュレス決済は、お客様 → 決済事業者 → 後日店舗へ入金、という流れです。OpenPay は違います。',
        '商品代金を OpenPay が保管することはなく、決済と同時にあなたのウォレットへ送金されます。締め日も入金待ちもありません。',
      ],
      flow: ['お客様のウォレット', '店舗のウォレット'],
      callout: {
        kind: 'warn',
        text: '受け取った JPYC を管理する責任は店舗側にあります。秘密鍵やシードフレーズの管理は慎重に行ってください。',
      },
    },
    {
      n: 3,
      title: '必要なら日本円に戻す',
      body: [
        '1 JPYC = 1 円です。受け取った JPYC はそのまま持っていても、JPYC 対応サービスで使ってもかまいませんが、日本円に戻したいときは JPYC EX で償還できます。',
        '手数料・所要時間・上限額などの条件は変わることがあります。実際に償還するときは JPYC 公式の最新条件を確認してください。',
      ],
      flow: [
        '受け取ったウォレット',
        'JPYC EX で償還予約',
        '指定アドレスへ送付',
        '登録銀行口座へ払い戻し',
      ],
    },
    {
      n: 4,
      title: '利用料を確認する',
      body: [],
      slot: 'fee',
      callout: {
        kind: 'tip',
        text: '少額ほど最低額が効きます。たとえば 100 JPYC のガスレス決済では、1% ではなく最低額の 2 JPYC が適用され、実質 2% になります。テスト決済で「思ったより引かれた」と感じるのはこのためです。金額が大きくなるほど 1% に近づきます。',
      },
    },
    {
      n: 5,
      title: 'キャンセルと返金は「取消」ではない',
      body: [
        'ここがカード決済との一番の違いです。ブロックチェーン上で完了した送金は、後から取り消せません。OpenPay は売上を預からないため、運営が代わりに返金することもできません。',
        '決済前に、金額・受取先・チェーンを確認してから支払ってください。決済後に返金する場合は、元の決済を取り消すのではなく、店舗から顧客へ別途返金を送金します。',
        '送金先を間違えた場合、相手のウォレットを店舗が管理していなければ、技術的に取り戻せないことがあります。',
        '導入前に、次の運用ルールを決めておくことをおすすめします。',
      ],
      figure: {
        file: 'refund-not-reversal.svg',
        alt: 'カード決済は同じ取引を取り消せるのに対し、OpenPay の JPYC 決済は取り消せず、返金は別の取引として送ることを示す図',
      },
      bullets: [
        '注文キャンセルの扱い',
        '金額を間違えたとき',
        '二重払いが起きたとき',
        '決済後の返品',
        '返金時のネットワーク手数料を誰が負担するか',
      ],
      afterBullets: {
        body: '実際に返金が必要になったときは、返す金額・方法・ネットワーク手数料の負担をお客様と確認したうえで進めます。決まった手順があるわけではなく、お店のルールとお客様とのやり取りで決まります。',
        title: '参考: JPYC で返す場合',
        items: [
          '送金は OpenPay ではなく、あなたのウォレットアプリから行います (OpenPay に返金機能はありません)',
          '送り先は、受け取った取引の送金元アドレス。ウォレットの受信履歴かブロックエクスプローラで確認できます',
          'ネットワーク手数料は送る側 (お店) の負担になります',
          '会計上は元の売上が消えるのではなく、返金が別の記録として増えます',
        ],
      },
    },
    {
      n: 6,
      title: '売上と会計の記録を残す',
      body: [
        '取引履歴は CSV に出力できます。transaction hash から、ブロックチェーン上の取引をいつでも再確認できます。',
        '最低限、次を残しておくと後から追跡しやすくなります。',
        '税務・会計の具体的な処理は、法人か個人か、会計方針、取引内容によって変わります。OpenPay は特定の仕訳方法を示しません。必要に応じて税理士等の専門家にご確認ください。',
      ],
      bullets: [
        '取引日時',
        '商品・注文内容',
        'JPYC 金額',
        'OpenPay 利用料',
        'transaction hash',
        '電子レシート',
        'JPYC EX で償還した記録',
        '日本円入金の銀行明細',
      ],
    },
    {
      n: 7,
      title: 'OpenPay が止まっても、JPYC は店舗のもの',
      body: [
        'OpenPay は商品代金を預かっていません。ですから障害やサービス終了があっても、すでにあなたのウォレットに届いている JPYC が OpenPay に閉じ込められることはありません。',
        'ただし資金と運用データは別です。モバイル注文の受注データは OpenPay 側に保存されているため、サービスが止まれば参照できなくなります (保存期間は次の項目)。OpenPay 自体はサービスの継続や無停止を保証するものではなく、規約上も現状有姿での提供です。',
        '現実的な導入のしかたは、現金 + 既存決済 + OpenPay です。最初から既存の決済手段を置き換える必要はありません。',
      ],
    },
    {
      n: 8,
      title: '情報がどこに残るかを理解する',
      body: [
        'お客様が OpenPay のアカウントを作る必要はありません。ウォレットで支払う際に、住所・電話番号・メールアドレスの登録を求めることもありません。',
        'どこに何が残るかは、次のように分かれています。',
      ],
      defs: [
        {
          term: '決済履歴',
          desc: 'あなたのブラウザ (LocalStorage) にのみ保存され、OpenPay のサーバには送信されません。',
        },
        {
          term: 'モバイル注文の受注データ',
          desc: 'OpenPay のサーバに保存されます。直近 200 件までを保持し、それを超えると古い注文から一覧に出なくなります (売上はオンチェーンに残ります)。一覧全体は最後の注文から 72 時間で消えます。お客様の個人情報は保存しません。',
        },
        {
          term: 'チップに添えられたメッセージ',
          desc: 'OpenPay のサーバに保存されます。保存期間は 180 日です。',
        },
        {
          term: 'ブロックチェーン上の記録',
          desc: '送金の事実・金額・アドレスは公開台帳に永続的に残ります。',
        },
      ],
    },
  ],

  guidesTitle: '機能ごとの使い方',
  guideLinkQr: '決済QR — スマホでかんたん受取',
  guideLinkShop: 'レジ・モバイル注文 — 商品登録から注文受付まで',
  guideLinkPos: '今お使いの POS レジと併用する運用ガイド',

  ctaTitle: '最初は少額で',
  ctaBody: [
    '導入したその日から、すべての売上を JPYC に切り替える必要はありません。まず JPYC で払いたいお客様のために、選択肢をひとつ増やす。そのくらいから始めてください。',
    '実際に使われるようになったら、決済QR からレジ、モバイル注文へ広げられます。',
  ],
  ctaKicker: '導入費用 0 円、契約不要。売上はあなたのウォレットへ直接届きます。',
  ctaLabel: '決済QRを作ってみる',
};

const EN: StartGuideContent = {
  metaTitle: 'Before you start — an OpenPay readiness checklist | OpenPay',
  metaDescription:
    'How sales reach you, how to convert back to yen, and how refunds work. Eight things to check before rolling out JPYC payments, with real fees and data retention periods.',
  backHome: '← Back to OpenPay',

  heroTitle: 'Eight things to check before you start accepting JPYC',
  heroLead: [
    'OpenPay lets you accept JPYC with nothing but a wallet — no dedicated terminal, no merchant contract. OpenPay never holds your money: payments settle straight to your wallet. Setup costs nothing.',
    'That said, JPYC is money on a blockchain. How sales reach you, how you convert back to yen, and how refunds work all differ from cards and QR-code payments. Check these eight things before you roll it out.',
  ],

  checklistTitle: 'Start by doing these five once',
  checklistLead:
    'Going through the loop yourself means you will not be caught out when someone asks.',
  checklistItems: [
    'Set up a wallet to receive into',
    'Make a small test payment',
    'Decide how you will handle refunds',
    'Convert a small amount back to yen via JPYC EX',
    'Decide how you will keep history and accounting records',
  ],

  sections: [
    {
      n: 1,
      title: 'Get JPYC ready',
      body: [
        'To receive JPYC through OpenPay you need a supported wallet. Whether you run a shop or sell as a creator, receiving is three steps.',
        'To obtain JPYC itself, you can use JPYC EX, run by the issuer. After identity verification you reserve an issuance and wire yen to the specified bank account; JPYC then arrives in your registered wallet.',
      ],
      flow: ['Set up a wallet', 'Connect to OpenPay', 'Set the receiving address'],
      callout: {
        kind: 'warn',
        text: 'The chains JPYC EX supports and the chains OpenPay settles on are not the same set. Before you roll out, confirm that the chain you receive on matches the chain you intend to accept payments on.',
      },
      externalLinks: [
        {
          label: 'Check current terms on the JPYC official site',
          href: JPYC_OFFICIAL,
        },
        {
          label: 'JPYC handling guide (wallet setup to redemption) — note (Japanese)',
          href: JPYC_NOTE_GUIDE,
        },
      ],
      slot: 'chains',
    },
    {
      n: 2,
      title: 'Sales land in your wallet immediately',
      body: [
        'Ordinary cashless payments flow customer → payment processor → payout to the shop days later. OpenPay does not work that way.',
        'OpenPay never custodies the purchase amount; it transfers to your wallet as the payment completes. There are no cut-off dates and no waiting for payouts.',
      ],
      flow: ['Customer wallet', 'Shop wallet'],
      callout: {
        kind: 'warn',
        text: 'In exchange, custody of the JPYC you receive is your responsibility. Handle private keys and seed phrases with care.',
      },
    },
    {
      n: 3,
      title: 'Convert back to yen when you need to',
      body: [
        '1 JPYC = 1 yen. You can hold the JPYC you receive or spend it with JPYC-accepting services, and when you want yen you can redeem through JPYC EX.',
        'Fees, processing time, and limits can change. Check the current terms on JPYC official channels when you actually redeem.',
      ],
      flow: [
        'Your wallet',
        'Reserve redemption on JPYC EX',
        'Send JPYC to the given address',
        'Yen paid out to your bank account',
      ],
    },
    {
      n: 4,
      title: 'Know the fees',
      body: [],
      slot: 'fee',
      callout: {
        kind: 'tip',
        text: 'The floor dominates at small amounts. On a 100 JPYC gasless payment the 2 JPYC floor applies rather than 1%, so the effective rate is 2%. That is why a test payment can feel more expensive than expected; the rate converges toward 1% as amounts grow.',
      },
    },
    {
      n: 5,
      title: 'Refunds are not reversals',
      body: [
        'This is the biggest difference from card payments. A transfer completed on a blockchain cannot be undone afterwards, and because OpenPay never holds your sales, there is no operator balance we could refund from either.',
        'Check the amount, the recipient, and the chain before paying. To refund after the fact, you do not reverse the original payment — the shop sends a separate refund transfer to the customer.',
        'If funds go to the wrong address and the shop does not control that wallet, recovery may be technically impossible.',
        'Decide these operational rules before you roll out.',
      ],
      figure: {
        file: 'refund-not-reversal.svg',
        alt: 'Diagram showing that a card payment can reverse the same transaction while a JPYC payment on OpenPay cannot, so a refund is sent as a separate transaction',
      },
      bullets: [
        'How order cancellations are handled',
        'What to do when an amount is wrong',
        'What to do about double payments',
        'Returns after payment',
        'Who absorbs the network fee on a refund',
      ],
      afterBullets: {
        body: 'When a refund actually comes up, you agree the amount, the method, and who absorbs the network fee with the customer before proceeding. There is no fixed procedure — it follows your own rules and the conversation with the buyer.',
        title: 'For reference: refunding in JPYC',
        items: [
          'You send from your own wallet app, not from OpenPay (OpenPay has no refund function)',
          'The destination is the sender address of the payment you received — check your wallet’s incoming history or a block explorer',
          'The network fee is paid by the sender, which is the shop',
          'In your books the original sale is not erased; the refund is added as a separate record',
        ],
      },
    },
    {
      n: 6,
      title: 'Keep sales and accounting records',
      body: [
        'Transaction history exports to CSV, and any transaction hash lets you re-check the on-chain record at any time.',
        'At minimum, keeping the following makes later reconciliation straightforward.',
        'How this is treated for tax and accounting depends on whether you are incorporated, your accounting policy, and the nature of each transaction. OpenPay does not prescribe a bookkeeping treatment; consult a tax professional as needed.',
      ],
      bullets: [
        'Date and time',
        'Item or order contents',
        'JPYC amount',
        'OpenPay fee',
        'Transaction hash',
        'Digital receipt',
        'Records of JPYC EX redemptions',
        'Bank statements for yen deposits',
      ],
    },
    {
      n: 7,
      title: 'Your JPYC is yours even if OpenPay stops',
      body: [
        'OpenPay does not hold the purchase amount. So even in an outage or if the service ends, JPYC that has already reached your wallet cannot be locked inside OpenPay.',
        'Funds and operational data are separate, though. Mobile-order intake data lives on OpenPay servers, so it becomes unavailable if the service stops (retention periods are in the next section). OpenPay itself does not guarantee continuity or uninterrupted service, and the terms provide it as-is.',
        'The realistic way to adopt it is cash + your existing methods + OpenPay. You do not have to replace anything on day one.',
      ],
    },
    {
      n: 8,
      title: 'Understand where information is kept',
      body: [
        'Customers never need an OpenPay account. Paying from a wallet does not require an address, phone number, or email address.',
        'Here is where each kind of information lives.',
      ],
      defs: [
        {
          term: 'Payment history',
          desc: 'Stored only in your browser (LocalStorage) and never sent to OpenPay servers.',
        },
        {
          term: 'Mobile-order intake data',
          desc: 'Stored on OpenPay servers. The list keeps the most recent 200 entries; beyond that the oldest orders drop off the list (the sales themselves remain on-chain). The whole list expires 72 hours after the most recent order. No customer personal data is stored.',
        },
        {
          term: 'Messages attached to tips',
          desc: 'Stored on OpenPay servers and retained for 180 days.',
        },
        {
          term: 'On-chain records',
          desc: 'The fact of a transfer, its amount, and the addresses remain permanently on a public ledger.',
        },
      ],
    },
  ],

  guidesTitle: 'How each feature works',
  guideLinkQr: 'Payment QR — accept payments from your phone',
  guideLinkShop: 'POS & mobile ordering — from product setup to order intake',
  guideLinkPos: 'Running alongside your current POS register',

  ctaTitle: 'Start small',
  ctaBody: [
    'You do not have to move every sale to JPYC on day one. Add one option for the customers who want to pay in JPYC. Starting there is enough.',
    'Once it is genuinely being used, you can extend from payment QRs to the register and mobile ordering.',
  ],
  ctaKicker:
    'Zero setup cost, no contract. Sales land straight in your wallet.',
  ctaLabel: 'Create a payment QR',
};

export function startGuideContentFor(locale: string): StartGuideContent {
  return locale === 'en' ? EN : JA;
}

export function startGuideMetadata(locale: string): Metadata {
  const c = startGuideContentFor(locale);
  return guidePageMetadata({
    locale,
    path: '/guide/start',
    title: c.metaTitle,
    description: c.metaDescription,
    // 専用 OG (チェックリスト意匠)。既定の og-image.png は /guide/qr と共用のため、
    // 共有時にどちらの面か見分けがつかない — この面は「送って読んでもらう」用途が主。
    ogImage: {
      url: '/og-start.webp',
      width: 1200,
      height: 630,
      alt: c.metaTitle,
    },
  });
}
