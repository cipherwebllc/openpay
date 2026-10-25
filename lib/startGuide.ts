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
  /** サイト内のガイドへのリンク (path は locale なし・同じタブで開く)。外部リンクより前に出す。 */
  readonly guideLinks?: readonly { readonly label: string; readonly path: `/${string}` }[];
  /**
   * 「くわしく」でたたむ補足 (前提・条件の細部)。本文 (body) に主張を残し、細部だけをここへ入れる
   * (plans/guide-ux-polish-2.md P3・引き算しても情報は消さない)。
   */
  readonly details?: { readonly summary: string; readonly body: readonly string[] };
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
  /** slot 'chains' (対応チェーンと通貨の開示) をたたむ「くわしく」の名前。 */
  readonly chainsDetailsLabel: string;


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
    'ウォレットひとつで、専用端末も加盟店契約もなしに JPYC 決済を始められます。',
    'ただし JPYC はブロックチェーン上のお金です。受け取り方・日本円への戻し方・返金のしかたがカードと違うので、始める前に次の 8 つを確認してください。',
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
        '受け取り用のウォレットを用意して OpenPay に接続し、受取先を設定します。',
        'ウォレットは MetaMask が基本です。初めての方には、アプリの中で JPYC の発行・償還ができるマイナウォレットや HashPort Wallet もおすすめです。',
        'JPYC そのものは、発行元の JPYC EX で手に入ります (本人確認 → 発行予約 → 銀行振込)。',
      ],
      callout: {
        kind: 'warn',
        text: 'JPYC EX が扱うチェーンと、OpenPay が決済に対応するチェーンは同じではありません。使うチェーンが両方で使えるか、導入時に確認してください。',
      },
      guideLinks: [{ label: 'ウォレットを選ぶ', path: '/guide/wallet' }],
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
        '一般的なキャッシュレス決済は、決済事業者を経て後日入金されます。OpenPay は代金を預からず、決済と同時にあなたのウォレットへ届けます。締め日も入金待ちもありません。',
      ],
      flow: ['お客様のウォレット', '店舗のウォレット'],
      callout: {
        kind: 'warn',
        text: '受け取った JPYC の管理は店舗の責任です。秘密鍵とシードフレーズは慎重に管理してください。',
      },
    },
    {
      n: 3,
      title: '必要なら日本円に戻す',
      body: [
        '日本円に戻したいときは、JPYC EX で 1 JPYC を 1 円として払い戻せます。',
        '手数料・所要時間・上限額は変わることがあります。償還の前に JPYC 公式の最新条件を確認してください。',
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
        text: '少額ほど最低額が効きます。たとえば 100 JPYC のガスレス決済では、1% ではなく最低額の 2 JPYC (実質 2%) がかかります。金額が大きいほど 1% に近づきます。',
      },
    },
    {
      n: 5,
      title: 'キャンセルと返金は「取消」ではない',
      body: [
        'カード決済との一番の違いです。ブロックチェーン上で完了した送金は取り消せず、OpenPay は売上を預からないため、運営が代わりに返金することもできません。',
        '返金は元の決済の取消ではなく、お店からお客様への別の送金です。お店が管理していないアドレスへ送ってしまうと、取り戻せないことがあります。',
        '支払いの前に金額・受取先・チェーンを確かめてもらうのが一番の予防です。そのうえで、次の運用ルールを決めておきましょう。',
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
        '取引履歴は CSV に出力でき、transaction hash からいつでもブロックチェーン上の取引を確かめられます。',
        '税務・会計の処理は、法人か個人か・会計方針・取引内容で変わります。OpenPay は特定の仕訳方法を示しません。必要に応じて税理士等の専門家にご確認ください。',
        '最低限、次を残しておくと後から追跡しやすくなります。',
      ],
      details: {
        summary: 'インボイス (適格簡易請求書) について',
        body: [
          'インボイス登録番号を設定すると、お客様の控えに適格簡易請求書の記載事項 (店名・登録番号・税率ごとの金額と消費税) が出ます。控えはお客様の端末に保存されます。',
          '適格簡易請求書を交付できるのは、小売・飲食・写真・旅行・タクシー・駐車場など、不特定多数を相手にする事業です。それ以外の事業では、宛名などを書いた適格請求書が必要です。店舗側も交付した内容の写しの保存が必要です。',
          '履歴 CSV の消費税は商品ごとに計算するため、控えの税率ごとの消費税と差が出ることがあります (明細の数や金額によります)。',
        ],
      },
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
        'OpenPay は代金を預かっていないので、障害やサービス終了があっても、ウォレットに届いた JPYC が閉じ込められることはありません。',
        'ただし、モバイルオーダーの受注データは OpenPay のサーバにあるため、止まれば見られなくなります (保存期間は次の項目)。OpenPay はサービスの継続を保証せず、規約上も現状有姿での提供です。',
        '最初は、現金と今の決済に OpenPay を足す形がおすすめです。置き換える必要はありません。',
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
          term: 'モバイルオーダーの受注データ',
          desc: 'OpenPay のサーバに保存されます。直近 200 件までを保持し、それを超えると古い注文から一覧に出なくなります (売上はオンチェーンに残ります)。一覧全体は最後の注文から 72 時間で消えます。お客様の個人情報は保存しません。',
        },
        {
          term: 'チップに添えられたメッセージ',
          desc: 'OpenPay のサーバに保存されます。保存期間は 180 日です。',
        },
        {
          term: 'お店がガス代を肩代わりして送るときの受け渡し',
          desc: 'お客様の署名などを、お店の端末へ渡すために OpenPay のサーバに一時保存します。最長 10 分で消えます。',
        },
        {
          term: 'ブロックチェーン上の記録',
          desc: '送金の事実・金額・アドレスは公開台帳に永続的に残ります。',
        },
      ],
    },
  ],

  chainsDetailsLabel: '対応しているチェーンと通貨',


  ctaTitle: '最初は少額で',
  ctaBody: [
    'すべての売上を JPYC に切り替える必要はありません。まずは、JPYC で払いたいお客様のために選択肢をひとつ増やすところから。',
  ],
  ctaKicker: '導入費用 0 円、契約不要。売上はあなたのウォレットへ直接届きます。',
  ctaLabel: '決済QRを作る',
};

const EN: StartGuideContent = {
  metaTitle: 'Before you start — an OpenPay readiness checklist | OpenPay',
  metaDescription:
    'How sales reach you, how to convert back to yen, and how refunds work. Eight things to check before rolling out JPYC payments, with real fees and data retention periods.',
  backHome: '← Back to OpenPay',

  heroTitle: 'Eight things to check before you start accepting JPYC',
  heroLead: [
    'Accept JPYC with nothing but a wallet — no dedicated terminal, no merchant contract.',
    'JPYC is money on a blockchain, though. How sales reach you, how you convert back to yen and how refunds work all differ from cards, so check these eight things before you start.',
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
        'Set up a wallet to receive into, connect it to OpenPay, and set it as your receiving address.',
        'MetaMask is the standard wallet. If you are new to wallets, MynaWallet and HashPort Wallet are good choices too: you can issue and redeem JPYC inside these apps.',
        'You can obtain JPYC itself from JPYC EX, run by the issuer (identity check → reserve issuance → bank transfer).',
      ],
      callout: {
        kind: 'warn',
        text: 'The chains JPYC EX supports and the chains OpenPay settles on are not the same set. Before you start, confirm that the chain you plan to use works on both.',
      },
      guideLinks: [{ label: 'Choosing a wallet', path: '/guide/wallet' }],
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
        'Ordinary cashless payments pass through a processor and pay out days later. OpenPay never holds the purchase amount: it reaches your wallet as the payment completes. No cut-off dates, no waiting for payouts.',
      ],
      flow: ['Customer wallet', 'Shop wallet'],
      callout: {
        kind: 'warn',
        text: 'Custody of the JPYC you receive is your responsibility. Handle private keys and seed phrases with care.',
      },
    },
    {
      n: 3,
      title: 'Convert back to yen when you need to',
      body: [
        'When you want yen, you can redeem 1 JPYC for 1 yen through JPYC EX.',
        'Fees, processing time and limits can change. Check the current terms on JPYC official channels before you redeem.',
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
        text: 'The floor dominates at small amounts. A 100 JPYC gasless payment is charged the 2 JPYC floor rather than 1% (effectively 2%); the rate approaches 1% as amounts grow.',
      },
    },
    {
      n: 5,
      title: 'Refunds are not reversals',
      body: [
        'This is the biggest difference from cards. A completed blockchain transfer cannot be undone, and because OpenPay never holds your sales, there is no operator balance to refund from either.',
        'A refund is not a reversal: the shop sends a separate transfer to the customer. Funds sent to an address the shop does not control may be impossible to recover.',
        'Having customers check the amount, recipient and chain before paying is the best prevention. On top of that, decide these operational rules.',
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
        'Tax and accounting treatment depends on whether you are incorporated, your accounting policy and each transaction. OpenPay does not prescribe a bookkeeping treatment; consult a tax professional as needed.',
        'At minimum, keeping the following makes later reconciliation straightforward.',
      ],
      details: {
        summary: 'About invoices (simplified qualified invoices)',
        body: [
          "If you set your invoice registration number, customer receipts show the items required for a simplified qualified invoice (shop name, registration number, and the amount and consumption tax for each tax rate). The receipt is stored on the customer's device.",
          "Simplified qualified invoices can be issued by businesses that serve many unspecified customers, such as retail, restaurants, photo studios, travel, taxis and parking. Other businesses need a qualified invoice that includes the buyer's name and other details. You also need to keep a copy of what you issued.",
          'The history CSV calculates consumption tax per item, so it can differ from the per-rate tax on the receipt depending on the number and amounts of items.',
        ],
      },
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
        'OpenPay does not hold the purchase amount, so even in an outage or if the service ends, JPYC already in your wallet cannot be locked inside OpenPay.',
        'Mobile-order intake data does live on OpenPay servers, though, so it becomes unavailable if the service stops (retention periods are in the next section). OpenPay does not guarantee continuity, and the terms provide it as-is.',
        'Start by adding OpenPay alongside cash and your existing methods. You do not have to replace anything.',
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
          term: 'Hand-off for “The shop pays the gas”',
          desc: 'The customer’s signature and related details are kept on OpenPay servers only to pass them to the shop’s device, and are deleted within 10 minutes.',
        },
        {
          term: 'On-chain records',
          desc: 'The fact of a transfer, its amount, and the addresses remain permanently on a public ledger.',
        },
      ],
    },
  ],

  chainsDetailsLabel: 'Supported chains and currencies',


  ctaTitle: 'Start small',
  ctaBody: [
    'You do not have to move every sale to JPYC. Start by adding one option for the customers who want to pay in JPYC.',
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
    // 専用 OG (チェックリスト意匠)。既定の og-home.webp はトップや他の guide と共用のため、
    // 共有時にどちらの面か見分けがつかない — この面は「送って読んでもらう」用途が主。
    ogImage: {
      url: '/og-start.webp',
      width: 1200,
      height: 630,
      alt: c.metaTitle,
    },
  });
}
