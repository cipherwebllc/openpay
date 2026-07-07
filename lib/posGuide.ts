// /guide/pos「無料POS × OpenPay 手動2台持ち」運用ガイドの content SOT (ja/en 同梱)。
// page (app/[locale]/guide/pos/page.tsx) が locale で出し分けて描画する。
//
// 設計方針:
// - 長文コンテンツは messages/*.json でなく本モジュールに置く (lib/explore.ts / lib/news.ts と同方針)。
//   → 新規 i18n namespace を増やさず parity test の対象を汚さない。ja/en は本モジュールに同梱。
// - 図版は public/guide/<image>.svg に配置済み (Codex 生成・docs/guides/pos-combo-image-prompts.md 参照)。
// - 数値 (手数料率/カード料率/POS プラン詳細) は本文に断定で書かない: 正確な値は利用規約・特商法表記へ誘導する。
//   景表法 (比較広告/ステマ規制) の配慮 + 料金改定での陳腐化回避のため。
// - POS アフィリエイトは affiliate=true のとき 景表法「広告」開示が要る (lib/explore.ts と同じ思想)。
//   承認前は posExamples を非広告の参考列挙にとどめる。

export type GuideLocale = 'ja' | 'en';

export type GuideStep = { readonly n: number; readonly title: string; readonly body: string };
export type GuideFaq = { readonly q: string; readonly a: string };
/** public/guide/<file> に置く図版。alt は必須。未配置時はプレースホルダを出す。 */
export type GuideImage = { readonly file: string; readonly alt: string };
export type GuideCostRow = {
  readonly label: string;
  readonly card: string;
  readonly openpay: string;
};

export type GuideContent = {
  readonly metaTitle: string;
  readonly metaDescription: string;
  readonly title: string;
  readonly subtitle: string;
  readonly lead: string;
  readonly audience: string;
  readonly heroImage: GuideImage;

  readonly canDoTitle: string;
  readonly canDo: readonly string[];
  readonly cannotTitle: string;
  readonly cannot: readonly string[];

  readonly needTitle: string;
  readonly need: readonly string[];

  readonly overviewTitle: string;
  readonly overviewBody: string;
  readonly overviewImage: GuideImage;

  readonly setupTitle: string;
  readonly setupSteps: readonly GuideStep[];
  readonly setupImage: GuideImage;

  readonly flowTitle: string;
  readonly flowSteps: readonly GuideStep[];
  readonly flowImage: GuideImage;
  readonly successImage: GuideImage;
  readonly successCaption: string;
  readonly safetyNote: string;

  readonly reconcileTitle: string;
  readonly reconcileBody: string;
  readonly reconcileBullets: readonly string[];
  readonly reconcileImage: GuideImage;

  readonly posTitle: string;
  readonly posBody: string;
  readonly posExamples: readonly string[];
  readonly posCaveat: string;
  /** 景表法「広告」開示ラベル。アフィリエイトリンク設置時に表示する。 */
  readonly affiliateAdLabel: string;
  /** POS アフィリエイト (承認済)。景表法対応で affiliateAdLabel「広告」を併記し rel=sponsored で描画。 */
  readonly posAffiliate: {
    readonly name: string;
    readonly href: string;
    readonly blurb: string;
    readonly cta: string;
  };

  readonly costTitle: string;
  readonly costColCard: string;
  readonly costColOpenpay: string;
  readonly costRows: readonly GuideCostRow[];
  readonly costNote: string;
  readonly feeNote: string;
  readonly costImage: GuideImage;

  readonly faqTitle: string;
  readonly faqs: readonly GuideFaq[];

  readonly ctaTitle: string;
  readonly ctaBody: string;
  readonly ctaButton: string;
  readonly ctaButtonHref: string;

  readonly backHome: string;
};

// スマレジ (クラウド POS) の A8.net アフィリエイトリンク。ja/en 共通。クリック計測は a8mat 付き
// リンクで成立する。impression beacon (0.gif の 1x1 pixel) は外部 pixel を読まない privacy 方針ゆえ
// 意図的に貼らない (クリック計測は維持される)。
const SMAREGI_AFFILIATE_URL =
  'https://px.a8.net/svt/ejp?a8mat=4B5X8A+18NQ3E+4Z10+NVWSI';

const ja: GuideContent = {
  metaTitle: '今お使いのPOSレジでJPYC（円ステーブルコイン）を受け取る運用ガイド',
  metaDescription:
    'システム連携なしで今日から。既存の無料POSレジに「OpenPay」決済を足して、JPYC（円ステーブルコイン）で受け取る2台持ち運用の手順。',
  title: '今お使いのPOSレジで、JPYC（円ステーブルコイン）を受け取る',
  subtitle: 'システム連携なしで“今日から”始める「2台持ち」運用ガイド',
  lead: 'いまのPOSレジはそのまま、OpenPay を“横に置くだけ”。開発も連携も不要。設定は一度だけ、慣れれば会計は約10秒です。',
  audience:
    '対象：POSレジ（無料アプリ可）を使っている／これから使う店舗オーナーさん（小売・飲食・サロン・ポップアップなど）。',
  heroImage: { file: 'hero.webp', alt: 'OpenPay のレジ画面と、店名・金額入りの会計 QR コード (スマホ 2 台の実画面)' },

  canDoTitle: 'できること',
  canDo: [
    '既存POSの売上データに「OpenPay決済」を残しながら、JPYC（円ステーブルコイン）で受け取れる',
    '着金はあなたのウォレットに直接・即時（OpenPayは預かりません＝ノンカストディ）',
    '会計ソフト向けのCSVは「履歴」からいつでも出力できる',
  ],
  cannotTitle: 'できないこと / 注意',
  cannot: [
    'レジとOpenPayは自動連携しません。金額はOpenPayにもう一度入力します（＝「2台持ち」）',
    '会計を締める前に、OpenPay画面で「支払い完了」を必ず目視確認してください（ブロックチェーン決済は完了後の取り消しができません）',
    'お客様側にウォレットとJPYCが必要です（暗号資産に慣れたお客様・常連さんから始めるのがおすすめ）',
  ],

  needTitle: '必要なもの',
  need: [
    'POSレジ（無料アプリで可）… 会計・売上記録用',
    'スマホ or タブレット1台 … OpenPayの決済QRを表示（レジと別端末が楽。同じ端末でも可）',
    'あなたの受取ウォレット（MetaMask等のアドレス）… JPYCの着金先',
    'お客様 … ウォレット＋JPYC（Polygon / Kaia / Avalanche のいずれか）',
  ],

  overviewTitle: '仕組み（全体像）',
  overviewBody:
    'レジは「売上の記録」係、OpenPayは「JPYCの受け取り」係。別々に動かして、閉店後に突き合わせるだけです。',
  overviewImage: { file: 'overview-flow.svg', alt: 'POSレジ→OpenPay→突合 の3ステップ全体像' },

  setupTitle: 'STEP 0 ― 最初の一度だけの準備（約5分）',
  setupSteps: [
    {
      n: 1,
      title: 'OpenPay で受取先を設定',
      body: 'open-pay.jp で受取ウォレットを接続し、「決済QR」で受取先と通貨（JPYC）を確認。よく使う金額はプリセット登録が速いです。',
    },
    {
      n: 2,
      title: 'POSレジに「OpenPay」決済ボタンを追加',
      body: 'レジの「その他決済」枠に名称「OpenPay」のボタンを1つ追加します（ほとんどの無料POSにあります）。これでレジ側に売上が残ります。',
    },
  ],
  setupImage: { file: 'pos-add-method.svg', alt: 'POSレジの支払い方法に「OpenPay」を追加した設定画面の模式図' },

  flowTitle: '毎回の会計フロー（4ステップ・慣れれば約10秒）',
  flowSteps: [
    {
      n: 1,
      title: 'レジで会計 →「OpenPay」で通す',
      body: '合計を確定し、支払い方法で「OpenPay」を選んで会計を完了。これでレジの売上データが残ります。',
    },
    {
      n: 2,
      title: 'OpenPay で同じ金額のQRを表示',
      body: '別端末（またはレジ端末）でOpenPayに同じ金額を入力してQRを表示。厳密に合わせたい場合はレシート番号を「メモ」へ（任意）。',
    },
    {
      n: 3,
      title: 'お客様がスキャンして支払い',
      body: '画面のQRを提示。お客様はご自分のウォレットで読み取り、JPYCで支払います（ガス代はかかりません）。',
    },
    {
      n: 4,
      title: '着金を確認してからレジを締める',
      body: 'QR画面に「着金を確認しました ✓」が出たら、商品をお渡し・レジを締めます。これは目安表示のため、確実を期すときは取引履歴やブロックチェーン Explorer でもご確認を。',
    },
  ],
  flowImage: { file: 'four-steps.svg', alt: '会計→QR表示→スキャン→完了確認 の4ステップ' },
  successImage: { file: 'payment-success.svg', alt: 'お客様のスマホに表示される支払い完了画面' },
  successCaption:
    '※お客様側の完了画面の例です。店舗側はQR画面に「着金を確認しました ✓」が出ます。',
  safetyNote:
    '重要：着金を確認する前に商品を渡さないでください。逆に、一度完了した決済は取り消せません（直接あなたのウォレットに着金済みです）。',

  reconcileTitle: '閉店後 ― 売上の付け合わせ',
  reconcileBody:
    'レジの「OpenPay決済」合計と、OpenPayの着金記録を突き合わせます。',
  reconcileBullets: [
    '基本：POS の売上額と時刻で照合（例：14:32 の ¥1,200）。※履歴の表示はご利用料（約 1%・最低 約 2 JPYC）差引後の純額（例：1,188 JPYC）。行を開くと売上総額（1,200 JPYC）を確認できます',
    '厳密：会計時にメモへ入れたレシート番号で1対1照合',
    'まとめて：「履歴」のCSVをレジの「その他決済」明細と突合。freee／マネーフォワード／弥生の取込形式に対応しています',
  ],
  reconcileImage: { file: 'history-reconcile.svg', alt: 'POSの明細とOpenPayの履歴を時刻・番号で突き合わせる図（履歴一覧は純額表示）' },

  posTitle: 'どのPOSレジを使えばいい？（無料で始められるレジ）',
  posBody:
    'いまのレジのままでOK。これから選ぶなら、「その他決済」枠のある無料POSアプリと相性抜群です。',
  posExamples: ['Square POS', 'Airレジ', 'スマレジ', 'ユビレジ'],
  posCaveat:
    '※各POSの無料プランの有無・条件・手数料は変わることがあります。導入前に各社の最新の公式情報をご確認ください。',
  affiliateAdLabel: '広告',
  posAffiliate: {
    name: 'スマレジ',
    href: SMAREGI_AFFILIATE_URL,
    blurb:
      '国内で広く使われるクラウド POS。レジ会計はスマレジ、JPYC の受け取りは OpenPay の2台持ちで、無理なく始められます。',
    cta: 'スマレジを見る',
  },

  costTitle: 'コストのイメージ',
  costColCard: '一般的なカード決済',
  costColOpenpay: '無料POS × OpenPay',
  costRows: [
    { label: '決済手数料', card: '約3%程度（例）', openpay: 'ご利用料 約1%（最低 約2 JPYC）・着金から自動差引（最新は利用規約参照）' },
    { label: '入金', card: '数日後・締めあり', openpay: '即時・直接あなたのウォレットへ' },
    { label: '預かり', card: '決済会社が一旦預かる', openpay: 'ノンカストディ（誰も預からない）' },
  ],
  costNote:
    '※手数料の最新・正確な条件は OpenPay の利用規約・特定商取引法に基づく表記をご確認ください。比較は一般的な例であり、契約条件により異なります。',
  feeNote:
    '着金額について：ガスレス決済ではご利用料（決済額の約 1%・最低 約 2 JPYC）が自動で差し引かれ、残りが着金します（例：¥1,200 → 約 ¥1,188）。POS に記録されるのは売上額のため、着金額はそれより少なくなります。正確な料率は利用規約・特定商取引法に基づく表記をご確認ください。',
  costImage: { file: 'cost-compare.svg', alt: 'カード決済と無料POS×OpenPayのコスト比較イメージ' },

  faqTitle: 'よくある質問',
  faqs: [
    {
      q: 'レジとOpenPayが自動でつながらないのは面倒では？',
      a: '金額の再入力という一手間の代わりに、開発も審査も待ち時間もゼロで今日から。利用が増えたらシステム連携も検討できます。',
    },
    {
      q: 'お客様にウォレットがないと使えない？',
      a: 'はい。まずは暗号資産に慣れた常連さんから。「JPYCで払える店」を少しずつ広げていくのがおすすめです。',
    },
    {
      q: '二重に売上が記録されない？',
      a: 'レジは「売上の記録」、OpenPayは「実際の着金」を担います。閉店時に金額（またはレシート番号）で突き合わせれば、ズレを防げます。',
    },
    {
      q: '返金したいときは？',
      a: 'ブロックチェーン決済は自動の取り消しがありません。返金はお客様のウォレットへ手動で送金してください（レジ側も通常の返金処理を）。',
    },
    {
      q: 'ネットが繋がらない場所でも使える？',
      a: '着金の確認にはオンライン接続が必要です。圏外では決済確認ができないためご注意ください。',
    },
  ],

  ctaTitle: 'まずは試してみる',
  ctaBody: '決済QRの作成は無料・登録不要です。受取ウォレットを接続して、最初のQRを作ってみましょう。',
  ctaButton: '決済QRを作成する',
  ctaButtonHref: '/create',

  backHome: '← トップにもどる',
};

const en: GuideContent = {
  metaTitle: 'Accept JPYC payments with your existing POS register',
  metaDescription:
    'Start today, no system integration. Add an “OpenPay” tender to your existing free POS and receive JPYC (a JPY stablecoin) with a simple two-device workflow.',
  title: 'Accept JPYC payments with the POS register you already use',
  subtitle: 'A “two-device” workflow you can start today — no system integration',
  lead: 'Keep your current POS and simply place OpenPay beside it. No development, no integration. Set up once — checkout takes about 10 seconds with practice.',
  audience:
    'For shop owners who use (or can start using) a POS register (a free app is fine) — retail, food, salons, pop-ups.',
  heroImage: { file: 'hero.webp', alt: 'OpenPay register screen and a checkout QR code with shop name and amount (two real phone screens)' },

  canDoTitle: 'What you can do',
  canDo: [
    'Keep an “OpenPay payment” in your existing POS sales data while receiving JPYC (a JPY stablecoin)',
    'Funds settle directly and instantly to your wallet (OpenPay never custodies them)',
    'Export accounting CSV anytime from “History”',
  ],
  cannotTitle: 'What it does not do / notes',
  cannot: [
    'The POS and OpenPay are not auto-connected. You re-enter the amount in OpenPay (the “two-device” part)',
    'Before closing the sale, always visually confirm “Payment complete” on the OpenPay screen (blockchain payments cannot be reversed once complete)',
    'Your customer needs a wallet and JPYC (start with crypto-savvy regulars)',
  ],

  needTitle: 'What you need',
  need: [
    'A POS register (a free app works) — for checkout and sales records',
    'One phone or tablet — to show the OpenPay payment QR (a separate device is easiest; the same device also works)',
    'Your receiving wallet (e.g. a MetaMask address) — where JPYC settles',
    'The customer — a wallet + JPYC (on Polygon, Kaia, or Avalanche)',
  ],

  overviewTitle: 'How it works',
  overviewBody:
    'The POS records the sale; OpenPay receives the JPYC. They run separately — you just reconcile after closing.',
  overviewImage: { file: 'overview-flow.svg', alt: 'Overview: POS register → OpenPay → reconcile' },

  setupTitle: 'STEP 0 — One-time setup (about 5 minutes)',
  setupSteps: [
    {
      n: 1,
      title: 'Set your receiving wallet in OpenPay',
      body: 'Connect your receiving wallet at open-pay.jp and confirm the address and currency (JPYC) in “Payment QR”. Preset common amounts to speed up checkout.',
    },
    {
      n: 2,
      title: 'Add an “OpenPay” tender to your POS',
      body: 'Add one “OpenPay” button in your POS “other payment” slot (almost every free POS has one). Sales stay recorded on the POS side.',
    },
  ],
  setupImage: { file: 'pos-add-method.svg', alt: 'A POS settings mockup adding an “OpenPay” payment method' },

  flowTitle: 'Every checkout (4 steps, ~10 seconds once used to it)',
  flowSteps: [
    {
      n: 1,
      title: 'Ring it up → choose “OpenPay”',
      body: 'Finalize the total and select “OpenPay” as the tender to complete the sale. Your POS sales data is now recorded.',
    },
    {
      n: 2,
      title: 'Show the same amount as an OpenPay QR',
      body: 'On a separate device (or the POS device), enter the same amount in OpenPay and show the QR. For precise books, put the receipt number in “memo” (optional).',
    },
    {
      n: 3,
      title: 'The customer scans and pays',
      body: 'Show the QR. The customer scans it with their wallet and pays in JPYC (no gas fee for them).',
    },
    {
      n: 4,
      title: 'Confirm the payment, then close',
      body: 'When “Payment received ✓” appears, hand over the goods and close the sale. It is an approximate hint — for certainty, also check your history or a blockchain explorer.',
    },
  ],
  flowImage: { file: 'four-steps.svg', alt: 'Four steps: ring up → show QR → scan → confirm' },
  successImage: { file: 'payment-success.svg', alt: 'The payment-complete screen shown on the customer’s phone' },
  successCaption:
    '* Example of the customer’s completion screen. Your side shows “Payment received ✓” on the QR screen.',
  safetyNote:
    'Important: do not hand over goods before confirming receipt. Conversely, a completed payment cannot be reversed (it has settled directly to your wallet).',

  reconcileTitle: 'After closing — reconciling sales',
  reconcileBody:
    'Match your POS “OpenPay” total against OpenPay’s received records.',
  reconcileBullets: [
    'Basic: match by POS sale amount and time (e.g. ¥1,200 at 14:32). History shows the net after the usage fee (~1%, min ~2 JPYC) — e.g. 1,188 JPYC. Open the entry to see the gross sale amount (1,200 JPYC)',
    'Precise: one-to-one match by the receipt number you put in the memo',
    'In bulk: export CSV from “History” and match against POS “other payment” entries. Supports freee / Money Forward / Yayoi import formats',
  ],
  reconcileImage: { file: 'history-reconcile.svg', alt: 'Matching POS entries with OpenPay history by time and receipt number (history lists the net amount)' },

  posTitle: 'Which POS should you use? (POS apps you can start free)',
  posBody:
    'Keep your current POS if you have one. Choosing new? Free POS apps with an “other payment” slot pair best.',
  posExamples: ['Square POS', 'Airレジ', 'スマレジ (Smaregi)', 'ユビレジ (Ubiregi)'],
  posCaveat:
    '* Free plans, terms, and fees of each POS can change. Please check each provider’s latest official information before adopting.',
  affiliateAdLabel: 'Ad',
  posAffiliate: {
    name: 'Smaregi',
    href: SMAREGI_AFFILIATE_URL,
    blurb:
      'A widely used cloud POS in Japan. Checkout on Smaregi, JPYC on OpenPay — an easy two-device combo.',
    cta: 'See Smaregi',
  },

  costTitle: 'Cost at a glance',
  costColCard: 'Typical card payment',
  costColOpenpay: 'Free POS × OpenPay',
  costRows: [
    { label: 'Payment fee', card: 'about 3% (example)', openpay: 'Usage fee ~1% (min ~2 JPYC), auto-deducted (see Terms)' },
    { label: 'Settlement', card: 'days later, with cutoffs', openpay: 'instant, directly to your wallet' },
    { label: 'Custody', card: 'the processor holds funds first', openpay: 'non-custodial (no one holds funds)' },
  ],
  costNote:
    '* For the latest, exact fee terms, see OpenPay’s Terms / legal notice. The comparison is a general example and varies by contract.',
  feeNote:
    'About the amount received: the usage fee (about 1%, minimum about 2 JPYC) is auto-deducted at settlement and the rest settles to your wallet (e.g. ¥1,200 → about ¥1,188). Your POS records the sale amount, so the wallet receipt is slightly less. See the Terms / legal notice for exact rates.',
  costImage: { file: 'cost-compare.svg', alt: 'Cost comparison: card payment vs free POS × OpenPay' },

  faqTitle: 'FAQ',
  faqs: [
    {
      q: 'Isn’t it inconvenient that the POS and OpenPay aren’t auto-connected?',
      a: 'You re-enter the amount — in exchange, zero development, zero review, zero waiting. As usage grows, an integration can be considered.',
    },
    {
      q: 'Can it be used if the customer has no wallet?',
      a: 'No. Start with crypto-savvy regulars, and gradually grow “this shop accepts JPYC”.',
    },
    {
      q: 'Won’t sales be double-counted?',
      a: 'The POS records the sale; OpenPay records the actual receipt. Reconcile by amount (or receipt number) at closing to avoid drift.',
    },
    {
      q: 'How do refunds work?',
      a: 'Blockchain payments have no automatic reversal. Refund by manually sending back to the customer’s wallet (and process the refund in your POS as usual).',
    },
    {
      q: 'Does it work offline?',
      a: 'Confirming settlement requires an online connection. Note that you cannot confirm payment without connectivity.',
    },
  ],

  ctaTitle: 'Try it first',
  ctaBody: 'Creating a payment QR is free and needs no signup. Connect your receiving wallet and make your first QR.',
  ctaButton: 'Create a payment QR',
  ctaButtonHref: '/create',

  backHome: '← Back to home',
};

export const POS_GUIDE: Record<GuideLocale, GuideContent> = { ja, en };

/** locale 文字列を GuideLocale へ正規化 (未知は ja)。 */
export function guideContentFor(locale: string): GuideContent {
  return locale === 'en' ? POS_GUIDE.en : POS_GUIDE.ja;
}

/** /guide/pos の <title>/<description> を組み立てる (page の generateMetadata が利用)。 */
export function guidePosMetadata(locale: string): {
  title: string;
  description: string;
} {
  const c = guideContentFor(locale);
  return { title: `${c.metaTitle} · OpenPay`, description: c.metaDescription };
}
