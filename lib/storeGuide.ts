// /guide/store 「無料サービスで始めるデジタル商品販売」(クリエイター向け) の content SOT。
// 長文を messages/*.json に置かない方針は lib/agentGuide.ts / lib/posGuide.ts と同じ。
// 出典 = user 承認済みの記事 (2026-07-31)。仕様記述 (2 タイプ・手数料・DRM なし・提供終了・
// 24 商品上限・価格帯) は本番実装と一致させること — 変えるときは実装と同時に。

import type { Metadata } from 'next';
import { guidePageMetadata } from '@/lib/guideMetadata';
import {
  DISCLOSED_STORE_USDC_PAYMENT,
  DISCLOSED_X402_FEE,
} from '@/lib/legal';

// 手数料の文言は開示済み定数から組み立てる (率の直書きを増やさない —
// plans/site-ia-guides-ruling.md N7。改定時は legal.ts 側の変更に自動追随)。
const X402_RATE_JA = `価格の ${DISCLOSED_X402_FEE.bps / 100}%・最低 ${DISCLOSED_X402_FEE.floorJpyc} JPYC`;
const X402_RATE_EN = `${DISCLOSED_X402_FEE.bps / 100}% of the price, minimum ${DISCLOSED_X402_FEE.floorJpyc} JPYC`;
const STORE_USDC_FEE_PERCENT =
  DISCLOSED_STORE_USDC_PAYMENT.openPayFeeBps / 100;
const STORE_USDC_CHAIN = DISCLOSED_STORE_USDC_PAYMENT.chainName;

export type StoreGuideMethod = {
  readonly n: number;
  readonly title: string;
  readonly tagline: string;
  readonly fits: readonly string[];
  readonly intro: string;
  readonly steps: readonly string[];
  readonly note?: string;
  readonly point?: string;
};

export type StoreGuideContent = {
  readonly metaTitle: string;
  readonly metaDescription: string;
  readonly backHome: string;

  // --- LP 前半 (P2 総合案内化・plans/site-ia-guides-ruling.md N5/N11) ---
  readonly heroTitle: string;
  readonly heroLead: string;
  readonly heroCtaProfile: string;
  readonly heroVisualAlt: string;
  readonly heroCtaStore: string;
  readonly forWhoTitle: string;
  readonly forWhoChips: readonly string[];
  readonly featuresTitle: string;
  readonly features: readonly {
    readonly title: string;
    readonly body: string;
  }[];
  readonly categoriesTitle: string;
  readonly categoriesExamples: string;
  readonly feeTitle: string;
  readonly feeBody: string;
  readonly startTitle: string;
  readonly startSteps: readonly string[];
  /** 後半 = 既存の操作ガイド (6 つの方法) の通し見出し */
  readonly opsTitle: string;

  readonly title: string;
  readonly subtitle: string;
  readonly lead: string;

  readonly basicsTitle: string;
  readonly basicsTable: {
    readonly headers: readonly [string, string, string, string];
    readonly rows: readonly (readonly [string, string, string, string])[];
  };
  readonly basicsBody: string;
  readonly basicsPoint: string;

  readonly methods: readonly StoreGuideMethod[];

  readonly commonTitle: string;
  readonly commonSections: readonly {
    readonly title: string;
    readonly body?: string;
    readonly bullets?: readonly string[];
  }[];

  /** JPYC そのものの扱い (準備・償還・会計・返金) は /guide/start へ送る導線。 */
  readonly startLinkTitle: string;
  readonly startLinkBody: string;
  readonly startLinkLabel: string;

  readonly promoTitle: string;
  readonly promoBullets: readonly string[];
  readonly promoPoint: string;

  readonly ctaTitle: string;
  readonly ctaBody: string;
  readonly ctaLabel: string;

  readonly disclaimer: string;
};

const JA: StoreGuideContent = {
  metaTitle: 'JPYCでチップ・デジタル商品販売 — クリエイター向け | OpenPay',
  metaDescription:
    'ウォレットアドレスだけで、プロフィール作成・チップ受付・デジタル商品販売。無料サービスと組み合わせる 6 つの販売レシピつき。売り手手数料なし・公開商品は OpenPay Store にも掲載。',
  backHome: '← OpenPay トップへ',

  heroTitle: 'プロフィールひとつで、応援もデジタル商品販売も',
  heroLead:
    'ウォレットアドレスだけで、プロフィール作成・チップ受付・デジタル商品販売を始められます。アカウント登録も月額費用も不要です。',
  heroCtaProfile: 'プロフィールを作る',
  heroVisualAlt:
    '自宅デスクでノート PC にクリエイタープロフィールとデジタル商品カードを表示し、スマホで OpenPay を開いているイラスト',
  heroCtaStore: 'Store を見る',
  forWhoTitle: 'こんな人に向いています',
  forWhoChips: [
    '個人クリエイター',
    'イラストレーター',
    '音楽・動画制作者',
    '3D・ゲーム素材制作者',
    'AI 開発者',
    '個人開発者',
    'テンプレート制作者',
    'コミュニティ運営者',
  ],
  featuresTitle: 'クリエイター機能でできること',
  features: [
    {
      title: 'プロフィール (リンクまとめ)',
      body: 'SNS や外部リンクをひとつのページにまとめ、@handle の恒久 URL で共有できます。テーマは 6 種類。',
    },
    {
      title: 'チップ・応援',
      body: 'JPYC でチップを受け取れます。メッセージ付きの応援にも対応。受け取り手数料はありません。',
    },
    {
      title: 'デジタル商品販売',
      body: 'テキスト・ファイル・外部 URL のデジタル商品を JPYC で販売。希望する商品では USDC 購入も許可できます。',
    },
    {
      title: 'OpenPay Store への掲載',
      body: '公開した商品は OpenPay Store にも並び、プロフィールの外からも見つけてもらえます。',
    },
    {
      title: '購入済みライブラリ',
      body: '買い手は購入した商品をいつでもライブラリから開き直せます。再ダウンロードの問い合わせ対応は不要です。',
    },
    {
      title: '外部クラウドで配布',
      body: 'Google ドライブ・Notion・YouTube 限定公開など、無料サービスと組み合わせて配布できます。',
    },
  ],
  categoriesTitle: '販売できる商品の例',
  categoriesExamples:
    'PDF・電子書籍・プロンプト・ソースコード・API・MCP サーバー・イラスト・NFT・動画・音源・BGM・テンプレート・3D モデル・VRM・Unity 素材・ゲーム素材 など。',
  feeTitle: '手数料',
  feeBody: `売り手手数料はありません。JPYC 購入では、買い手が商品価格に加えて x402 利用料 (${X402_RATE_JA}) を負担します。USDC 購入 (${STORE_USDC_CHAIN}) の OpenPay x402 利用料は ${STORE_USDC_FEE_PERCENT}% (無料) です。チップの受け取りにも手数料はありません。`,
  startTitle: '始め方 (3 ステップ)',
  startSteps: [
    'ウォレットを接続して、プロフィール (@handle) を作る',
    '販売者情報を登録して、商品を追加する',
    'プロフィールの URL を SNS で共有する — 公開した商品は Store にも並びます',
  ],
  opsTitle: '販売のヒント: 無料サービスで始めるデジタル商品販売',

  title: '無料サービスで始めるデジタル商品販売',
  subtitle: '6 つの方法と手順',
  lead: `サーバーも決済契約も不要。無料のクラウドサービスにコンテンツを置き、OpenPay の @handle プロフィールで販売する実践レシピ集です。価格は JPYC 建てで、支払いは JPYC (Polygon) が基本です。商品ごとに USDC (${STORE_USDC_CHAIN}) 購入も許可できます。JPYC 購入では買い手が価格の 1%・最低 1 JPYC の利用料を負担し、USDC 購入の OpenPay x402 利用料と売り手手数料はありません。`,

  basicsTitle: 'まず仕組みを 30 秒で',
  basicsTable: {
    headers: ['タイプ', '購入者が受け取るもの', '制限', '向いているもの'],
    rows: [
      [
        'テキスト型',
        '本文テキストそのもの',
        '20,000 文字まで',
        'プロンプト・テンプレ文・チェックリスト・コード片',
      ],
      [
        'URL 型',
        '秘密の URL (https のみ・512 文字まで)',
        'ファイル本体は外部サービスに置く',
        'PDF・ZIP・画像集・動画・テンプレファイル',
      ],
    ],
  },
  basicsBody:
    'OpenPay のデジタル商品は 2 タイプだけです。つまり「ファイルは無料サービスに置き、その共有リンクを商品にする」のが URL 型の基本戦略です。購入者は支払い完了と同時にリンク (または本文) を受け取り、以後もライブラリからいつでも再取得できます。',
  basicsPoint:
    '出品はすべて共通で、「受け取る」ページの「プロフ」タブ →「デジタル商品」から。初回のみ販売者情報 (氏名または名称・連絡先) の登録が必要です (特定商取引法対応)。1 ウォレットにつき 24 商品まで、価格は 1〜1,000,000 の整数 JPYC。',

  methods: [
    {
      n: 1,
      title: 'テキスト商品 — 外部サービス不要 (最速)',
      tagline: '所要 5 分 ／ 追加サービス: なし',
      fits: ['AI プロンプト', '記事テンプレ', 'チェックリスト', 'コードスニペット'],
      intro:
        '20,000 文字までの本文なら、外部サービスは一切不要です。本文は OpenPay が保管し、購入者だけに渡します。いちばん失敗が少ない始め方です。',
      steps: [
        '売り物になるテキストを用意する (例: 実際に使い込んだ AI 用プロンプト、営業メールのテンプレ 10 本、開業手続きチェックリスト)。',
        'OpenPay の「受け取る」→「プロフ」タブ →「デジタル商品」でウォレットログイン。',
        '販売者情報 (名前・連絡先) を登録する。',
        '商品タイプ「テキスト」を選び、商品名・説明・価格を入れて本文を貼り付ける。',
        '「販売開始」をオンにして登録 → 自分の @handle ページに商品カードが並んだことを確認。',
      ],
      point:
        'プロンプトは「そのままコピペで動く完成品 + 使い方の注釈」まで含めると価値が伝わりやすくなります。',
    },
    {
      n: 2,
      title: 'Google ドライブ — PDF・ZIP・画像集',
      tagline: '所要 10 分 ／ 無料枠: 15GB',
      fits: ['PDF レポート', '素材 ZIP', '壁紙・写真集', 'スプレッドシート雛形'],
      intro:
        'ファイル配布の定番。Google アカウントがあれば追加費用ゼロで始められます。',
      steps: [
        '販売するファイル (PDF・ZIP 等) を Google ドライブにアップロードする。',
        'ファイルを右クリック →「共有」→ アクセス権を「リンクを知っている全員」= 閲覧者に変更する。',
        '「リンクをコピー」で共有 URL を取得する。',
        'シークレットウィンドウで開き、ログインなしで閲覧できるか必ず確認する (ここが最重要)。',
        'OpenPay で商品タイプ「URL」を選び、コピーした共有リンクを貼って出品する。',
      ],
      note: '「制限付き」のままだと購入者が開けません。ファイルを差し替えたいときはドライブ側で同じファイルを更新すればリンクは変わりません。リンク自体を作り直した場合は、OpenPay の商品編集で新しい URL に更新してください (購入済みの人向けの提供も維持されます)。',
    },
    {
      n: 3,
      title: 'GitHub Gist — コード・長文テキスト',
      tagline: '所要 10 分 ／ 無料',
      fits: ['スクリプト一式', '設定ファイル', '20,000 字を超える長文'],
      intro:
        'コードや長文は Gist のシークレット gist (検索に出ず、URL を知る人だけが見られる) が手軽です。シンタックスハイライトも付きます。',
      steps: [
        'gist.github.com で新規 gist を作り、ファイルを貼り付ける (複数ファイル可)。',
        '作成ボタンは「Create secret gist」を選ぶ (public にしない)。',
        '作成後の URL をコピーし、シークレットウィンドウで表示確認。',
        'OpenPay で「URL」商品として出品する。ラベルは「プロンプト」や「API」など内容に合うものを選ぶ。',
      ],
      note: 'シークレット gist は「非公開」ではなく「URL を知っていれば誰でも閲覧可」です。この性質はドライブの共有リンクと同じで、デジタル商品の URL 型はすべてこの前提で成り立っています (下の共通注意を参照)。',
    },
    {
      n: 4,
      title: 'Notion 公開ページ — ガイド・教材',
      tagline: '所要 15 分 ／ 無料',
      fits: ['ノウハウ集', '手順書', 'リンク集・データベース', '継続更新する教材'],
      intro:
        '画像や表を含むリッチな教材に向きます。ページを更新すれば購入者は常に最新版を見られるので、「育てる商品」に最適です。',
      steps: [
        'Notion で教材ページを作る (見出し・画像・トグルで整理)。',
        '右上「共有」→「公開」タブで Web に公開する。',
        '公開設定で「検索エンジンのインデックス」をオフ、「複製を許可」も必要に応じてオフにする。',
        '公開 URL をコピーし、シークレットウィンドウで表示確認。',
        'OpenPay で「URL」商品として出品。説明欄に「購入後も内容はアップデートされます」と書くと訴求になります。',
      ],
    },
    {
      n: 5,
      title: 'YouTube 限定公開 — 動画講座',
      tagline: '所要 20 分〜 ／ 無料',
      fits: ['チュートリアル動画', '講座・解説', '舞台裏・メイキング'],
      intro:
        '動画ホスティングを自前で持つのは大変ですが、YouTube の限定公開 (unlisted) なら、チャンネルにも検索にも出ない動画をリンクだけで届けられます。',
      steps: [
        '動画をアップロードし、公開設定を「限定公開」にする (「非公開」ではない点に注意 — 非公開はリンクでも見られません)。',
        '動画 URL をコピーし、ログアウト状態のブラウザで再生確認。',
        'OpenPay で「URL」商品として出品。複数本ある場合は、限定公開の再生リスト URL を商品にすると 1 商品で講座全体を渡せます。',
      ],
      note: 'YouTube の規約上、動画そのものへのアクセス販売が問題になるケースもあり得ます。「動画は講座の教材の一部」という建て付け (テキスト教材 + 補助動画など) にしておくと安全度が上がります。',
    },
    {
      n: 6,
      title: 'Canva 共有リンク — デザインテンプレート',
      tagline: '所要 15 分 ／ 無料',
      fits: ['SNS 投稿テンプレ', 'スライド雛形', 'サムネイル素材'],
      intro:
        'Canva は「このデザインを複製して使ってもらう」形の販売ができます。',
      steps: [
        'Canva でテンプレートデザインを作る。',
        '「共有」→「テンプレートのリンク」を作成する (受け取った人が自分のコピーを編集できるリンク)。',
        'シークレットウィンドウでリンクを開き、複製画面になるか確認。',
        'OpenPay で「URL」商品として出品。説明に「Canva 無料アカウントで使えます」と明記する。',
      ],
    },
  ],

  commonTitle: '共通の注意点 (重要)',
  commonSections: [
    {
      title: '1. リンクの秘匿性 = 商品価値',
      body: 'URL 型はどの方法でも「URL を知っている人は誰でも開ける」仕組みです。技術的なコピー防止 (DRM) はなく、再配布の禁止は利用規約ベースの約束になります。高額商品や流出ダメージが大きいものより、「数百〜数千円相当で、買った方が探すより速い」価格帯・内容が最も相性が良いゾーンです。',
    },
    {
      title: '2. 出品前チェックリスト',
      bullets: [
        'シークレットウィンドウ (未ログイン) でリンクが開けるか',
        'リンク先に個人情報や他の非公開ファイルが見えていないか (フォルダごと共有は避け、ファイル単位で)',
        `価格は整数 JPYC か (JPYC 購入では購入者が別途 利用料 最低 1 JPYC・価格の 1% を負担し、USDC 購入では OpenPay x402 利用料は ${STORE_USDC_FEE_PERCENT}% です)`,
        '課税事業者の場合、価格は消費税を含む総額 (税込) で登録しているか',
        '無料サービス側の規約で商用利用・再配布形態が許されているか',
        '配布 URL に期限が設定されていないか (期限付きリンクは購入者が後から開けなくなります)',
        'ファイル形式と必要な環境を説明に書いたか (例: PSD・要 Photoshop / 動画は MP4・約 2GB)',
        '再配布や商用利用を認めるかを説明に明記したか',
        '商品名と説明が中身と一致しているか (説明と著しく異なると、購入者は解除・返金を求められます)',
      ],
    },
    {
      title: '3. リンクを消さない',
      body: '販売を停止しても、購入済みの人はライブラリから商品を受け取り続けられます。外部サービス側でファイルやリンクを削除すると、その購入者への提供が止まってしまいます。商品を引退させるときは「OpenPay 側で販売停止 → 外部ファイルはしばらく残す」の順で。',
    },
    {
      title: '4. 内容を更新したいとき',
      body: 'OpenPay の商品編集で URL や本文を変更すると新しい版として保存されます。Notion や Google ドライブのようにリンクはそのままで中身だけ更新できるサービスを選んでおくと、更新運用がいちばん楽です。',
    },
    {
      title: '5. 販売者としての表示義務',
      body: 'デジタル商品を継続的・反復的に販売する場合、特定商取引法にもとづく表示が必要になることがあります。OpenPay は購入画面に、販売者のウォレットアドレス・価格・提供方法・撤回の可否などを自動で表示します。これに加えて、あなた自身の氏名または名称・住所・連絡先などは、出品時の「法定表示の追加事項」欄に記載してください。事業として販売するかどうか、開示がどこまで必要かは個々の状況で変わります。判断がつかない場合は専門家にご確認ください。',
    },
    {
      title: '6. 提供開始後は自己都合の撤回ができない',
      body: 'デジタル商品の性質上、提供を開始した後の自己都合による申込みの撤回・契約解除はできません。オンチェーンの送金も技術上取り消せません。ただし、これは「売り切ったら終わり」という意味ではありません。商品が提供されない場合や、説明と著しく異なる場合、購入者は解除・返金・代替提供を求めることができます。その際の返金は、元の取引を取り消すのではなく、あなたから購入者へ別途送金する形になります。だからこそ、説明を正確に書くことが最大の防御になります。',
    },
    {
      title: '7. 購入者のライブラリを守る',
      body: '購入者は「ライブラリ」から、購入した商品をあとから何度でも受け取れます。この仕組みは、あなたが用意した外部の URL が生きていることが前提です。',
      bullets: [
        '外部サービス側でファイルやリンクを削除すると、購入済みの人への提供が止まります',
        'OpenPay 側で販売を停止しても、購入済みの人はライブラリから受け取り続けられます',
        'OpenPay のサービス自体が停止した場合、ライブラリからの受け取りはできなくなります。高額商品や長期提供を約束する商品では、購入者への直接の連絡手段も併せて用意しておくと安全です',
      ],
    },
    {
      title: '8. USDC 販売を有効にするとき',
      body: `出品フォームで「USDC での購入も許可する」を ON にすると、購入者は JPYC 建て価格から換算された USDC を ${STORE_USDC_CHAIN} チェーンで支払い、表示された受取アドレスへ直接送金します。`,
      bullets: [
        `販売開始前に、出品フォームの受取アドレスが ${STORE_USDC_CHAIN} でも自分が操作できるアドレスか確認してください`,
        `入金はウォレットのネットワークを ${STORE_USDC_CHAIN} に切り替え、同じ受取アドレスの USDC 残高と取引履歴で確認します`,
        `USDC 購入に OpenPay の x402 利用料はかかりません (${STORE_USDC_FEE_PERCENT}%・売り手手数料もありません)`,
        'レート固定中の変動では買い手・販売者のどちらにも得または損が生じる場合があります。受取後の USDC の価格変動・保有リスクは販売者が負担し、USDC の脱ペッグ時は JPYC 建て価格からの換算にずれが生じる場合があります',
      ],
    },
  ],

  startLinkTitle: 'JPYC そのものの扱いについて',
  startLinkBody:
    'ウォレットの準備、日本円への償還、会計記録の残し方、返金の考え方は、販売でも店舗決済でも共通です。',
  startLinkLabel: '導入前チェックリスト — 始める前に確認する 8 つのこと',

  promoTitle: '売れるための一工夫',
  promoBullets: [
    'プロフィールを店構えにする — @handle ページの見出し機能で「📦 販売中」「🔗 リンク」を区切り、商品の説明文 (200 字) で「誰の・何が・どう解決するか」を一行目に書く。',
    '無料版で信頼を作る — note や X に無料のダイジェスト版を出し、「完全版は @handle で」と誘導する。買う前に品質が分かる商品は強い。',
    '最初の商品は安く・具体的に — 「◯◯用プロンプト 3 本セット 5 JPYC」のような、迷わず買える価格から始めて実績と感想を集める。',
    '商品リンクを X でシェアする — 商品管理の「シェア用リンクをコピー」で商品カード付きのリンクを共有できる。更新のたびに発信すれば、既購入者の満足と新規の購入理由が同時に生まれる。',
  ],
  promoPoint:
    `価格は JPYC 建てで、支払いは JPYC (Polygon) または商品ごとに許可した USDC (${STORE_USDC_CHAIN})。購入者はウォレットだけで買えて、あなたのウォレットに直接着金します。売上の受け取りに月額費用や振込申請はありません。`,

  ctaTitle: 'さっそく出品する',
  ctaBody: '出品は無料。ウォレットがあれば 5 分で最初の商品を並べられます。',
  ctaLabel: '受け取るページで出品する',

  disclaimer:
    '本ガイドの外部サービス仕様は 2026-07 時点の一般的な無料プランに基づきます。各サービスの規約・仕様は変わることがあります。',
};

const EN: StoreGuideContent = {
  metaTitle: 'Tips & digital product sales with JPYC — for creators | OpenPay',
  metaDescription:
    'All you need is a wallet address: create a profile, receive tips, and sell digital products for JPYC. Includes 6 practical recipes using free services. No seller fee; published products also appear in the OpenPay Store.',
  backHome: '← Back to OpenPay',

  heroTitle: 'One profile for tips and digital product sales',
  heroLead:
    'All you need is a wallet address: create a profile, receive tips, and sell digital products. No account signup, no monthly fee.',
  heroCtaProfile: 'Create your profile',
  heroVisualAlt:
    'Illustration of a creator at a home desk with a laptop showing a creator profile and digital product cards, holding a phone with OpenPay open',
  heroCtaStore: 'Browse the Store',
  forWhoTitle: 'Who this is for',
  forWhoChips: [
    'Independent creators',
    'Illustrators',
    'Music & video makers',
    '3D & game asset artists',
    'AI developers',
    'Indie developers',
    'Template makers',
    'Community organizers',
  ],
  featuresTitle: 'What creator features can do',
  features: [
    {
      title: 'Profile (link in bio)',
      body: 'Gather your social and external links on one page and share it with a permanent @handle URL. Six themes available.',
    },
    {
      title: 'Tips & support',
      body: 'Receive tips in JPYC, including support with messages. No fee on receiving tips.',
    },
    {
      title: 'Digital product sales',
      body: 'Sell text, files, and external-URL products for JPYC, with optional USDC purchases for selected products.',
    },
    {
      title: 'Listed on the OpenPay Store',
      body: 'Published products also appear in the OpenPay Store, so buyers can discover them beyond your profile.',
    },
    {
      title: 'Buyer library',
      body: 'Buyers can reopen purchased products anytime from their library — no re-download support needed.',
    },
    {
      title: 'Deliver via free cloud services',
      body: 'Combine with free services such as Google Drive, Notion, or unlisted YouTube for delivery.',
    },
  ],
  categoriesTitle: 'Examples of what you can sell',
  categoriesExamples:
    'PDFs, e-books, prompts, source code, APIs, MCP servers, illustrations, NFTs, videos, music, BGM, templates, 3D models, VRM, Unity assets, game assets, and more.',
  feeTitle: 'Fees',
  feeBody: `No seller fee. For JPYC purchases, buyers pay an x402 usage fee (${X402_RATE_EN}) on top of the product price. For USDC purchases on ${STORE_USDC_CHAIN}, the OpenPay x402 usage fee is ${STORE_USDC_FEE_PERCENT}% (free). Receiving tips is also free of fees.`,
  startTitle: 'Get started in 3 steps',
  startSteps: [
    'Connect a wallet and create your profile (@handle)',
    'Register seller information and add products',
    'Share your profile URL on social media — published products also appear in the Store',
  ],
  opsTitle: 'Selling tips: digital product sales with free services',

  title: 'Sell digital goods with free services',
  subtitle: '6 methods, step by step',
  lead: `No server, no merchant contract. Put your content on a free cloud service and sell it on your OpenPay @handle profile. Prices remain denominated in JPYC and JPYC on Polygon is the primary payment method; you can also allow USDC purchases on ${STORE_USDC_CHAIN} per product. Buyers pay 1% (min 1 JPYC) for JPYC purchases, while the OpenPay x402 usage fee for USDC purchases and the seller fee are both ${STORE_USDC_FEE_PERCENT}%.`,

  basicsTitle: 'The mechanics in 30 seconds',
  basicsTable: {
    headers: ['Type', 'What the buyer receives', 'Limits', 'Best for'],
    rows: [
      [
        'Text',
        'The text itself',
        'Up to 20,000 characters',
        'Prompts, templates, checklists, code snippets',
      ],
      [
        'URL',
        'A secret URL (https only, up to 512 chars)',
        'The file itself lives on an external service',
        'PDFs, ZIPs, image packs, videos, template files',
      ],
    ],
  },
  basicsBody:
    'OpenPay digital products come in just two types. The core strategy for URL products: host the file on a free service and sell the share link. Buyers receive the link (or text) the moment payment completes, and can re-fetch it anytime from their library.',
  basicsPoint:
    'All listings start from the Create page → Profile tab → Digital products. First-time sellers register seller information (name and contact — required by the Specified Commercial Transactions Act). Up to 24 products per wallet; prices are whole JPYC from 1 to 1,000,000.',

  methods: [
    {
      n: 1,
      title: 'Text products — no external service (fastest)',
      tagline: '~5 minutes / no extra service',
      fits: ['AI prompts', 'Article templates', 'Checklists', 'Code snippets'],
      intro:
        'If your content fits in 20,000 characters, you need nothing else. OpenPay stores the text and delivers it only to buyers. The most failure-proof way to start.',
      steps: [
        'Prepare text worth selling (battle-tested AI prompts, 10 sales-email templates, a business-registration checklist).',
        'Open OpenPay Create → Profile tab → Digital products, and sign in with your wallet.',
        'Register your seller information (name and contact).',
        'Choose the Text type, enter title, description and price, then paste the content.',
        'Turn on “On sale” and save. Confirm the product card appears on your @handle page.',
      ],
      point:
        'For prompts, include both a copy-paste-ready final version and usage notes — the value is much easier to see.',
    },
    {
      n: 2,
      title: 'Google Drive — PDFs, ZIPs, image packs',
      tagline: '~10 minutes / 15GB free',
      fits: ['PDF reports', 'Asset ZIPs', 'Wallpaper packs', 'Spreadsheet templates'],
      intro:
        'The standard for file delivery. If you have a Google account, it costs nothing extra.',
      steps: [
        'Upload the file (PDF, ZIP, …) to Google Drive.',
        'Right-click → Share → change access to “Anyone with the link” as Viewer.',
        'Copy the share URL.',
        'Open it in a private window and confirm it loads without login (this is the critical step).',
        'On OpenPay, choose the URL type and paste the share link.',
      ],
      note: 'If access stays “Restricted”, buyers cannot open it. Updating the same file in Drive keeps the link stable; if you recreate the link, update the product URL on OpenPay (delivery to existing buyers is preserved).',
    },
    {
      n: 3,
      title: 'GitHub Gist — code and long text',
      tagline: '~10 minutes / free',
      fits: ['Script bundles', 'Config files', 'Text beyond 20,000 chars'],
      intro:
        'For code and long documents, a secret gist (unlisted; visible only to those who know the URL) is the easy option, with syntax highlighting included.',
      steps: [
        'Create a new gist at gist.github.com and paste your files (multiple files OK).',
        'Click “Create secret gist” (not public).',
        'Copy the URL and verify it in a private window.',
        'List it on OpenPay as a URL product with a fitting label such as Prompt or API.',
      ],
      note: 'A secret gist is not private — anyone with the URL can view it. That is the same property as a Drive share link, and every URL product works on this premise (see the common cautions below).',
    },
    {
      n: 4,
      title: 'Notion public page — guides and courses',
      tagline: '~15 minutes / free',
      fits: ['Know-how collections', 'Manuals', 'Link databases', 'Living courses'],
      intro:
        'Great for rich material with images and tables. Because buyers always see the latest version when you update the page, it suits products you keep growing.',
      steps: [
        'Build the course page in Notion (headings, images, toggles).',
        'Share → Publish tab → publish to the web.',
        'Turn off search-engine indexing, and turn off “Allow duplicating” if you prefer.',
        'Copy the public URL and verify it in a private window.',
        'List it on OpenPay as a URL product. Mentioning “content keeps getting updated after purchase” is a strong selling point.',
      ],
    },
    {
      n: 5,
      title: 'YouTube unlisted — video courses',
      tagline: '20+ minutes / free',
      fits: ['Tutorials', 'Courses and commentary', 'Behind-the-scenes'],
      intro:
        'Hosting video yourself is hard; YouTube unlisted videos appear in no channel or search results and can be delivered by link alone.',
      steps: [
        'Upload the video and set visibility to “Unlisted” (not “Private” — private videos cannot be opened even with the link).',
        'Copy the URL and confirm playback in a logged-out browser.',
        'List it on OpenPay as a URL product. For multi-part courses, sell an unlisted playlist URL to deliver the whole course as one product.',
      ],
      note: 'Selling raw access to a video can conflict with YouTube’s terms in some cases. Framing the video as one part of a course (text material plus supplementary video) is the safer structure.',
    },
    {
      n: 6,
      title: 'Canva template link — design templates',
      tagline: '~15 minutes / free',
      fits: ['Social-post templates', 'Slide decks', 'Thumbnail kits'],
      intro:
        'Canva supports selling in the “duplicate this design and use it” style.',
      steps: [
        'Create the template design in Canva.',
        'Share → create a “Template link” (recipients edit their own copy).',
        'Open the link in a private window and confirm the duplicate screen appears.',
        'List it on OpenPay as a URL product, noting “works with a free Canva account”.',
      ],
    },
  ],

  commonTitle: 'Common cautions (important)',
  commonSections: [
    {
      title: '1. Link secrecy is the product value',
      body: 'With every method, a URL product means anyone who knows the URL can open it. There is no technical copy protection (DRM); redistribution is prohibited by terms, not by technology. The sweet spot is content priced in the few-hundred-to-few-thousand-yen range where buying is faster than hunting — not high-ticket items where a leak would hurt badly.',
    },
    {
      title: '2. Pre-listing checklist',
      bullets: [
        'Does the link open in a private window (no login)?',
        'Does the destination expose personal data or other private files? (Share single files, not folders.)',
        `Is the price whole JPYC? (For JPYC purchases, buyers additionally pay 1%, min 1 JPYC; for USDC purchases, the OpenPay x402 usage fee is ${STORE_USDC_FEE_PERCENT}%.)`,
        'If you are a taxable business for Japanese consumption tax, is the price tax-inclusive?',
        'Do the free service’s terms allow commercial use in this form?',
        'Does the delivery URL have an expiry? (Expiring links stop working for buyers later.)',
        'Did you state the file format and what is needed to open it? (e.g. PSD, requires Photoshop / MP4 video, ~2GB)',
        'Did you state whether redistribution and commercial use are allowed?',
        'Do the title and description match the contents? (If they differ materially, buyers can seek cancellation or a refund.)',
      ],
    },
    {
      title: '3. Never delete the link',
      body: 'Even after you stop selling, existing buyers keep receiving the product from their library. Deleting the file or link on the external service cuts them off. To retire a product: stop the sale on OpenPay first, and keep the external file up for a while.',
    },
    {
      title: '4. When updating content',
      body: 'Editing the URL or text on OpenPay saves a new revision. Services like Notion or Google Drive, where the link stays stable while the content changes, make update operations easiest.',
    },
    {
      title: '5. Your disclosure duties as a seller',
      body: 'Selling digital products on a continuing, repeated basis may require disclosures under Japan’s Act on Specified Commercial Transactions. OpenPay automatically shows the seller wallet address, price, delivery method, and withdrawal terms on the purchase screen. Beyond that, your own name or business name, address, and contact details go in the "additional statutory disclosures" field when you list. Whether you are selling as a business, and how much disclosure is required, depends on your situation — consult a professional if you are unsure.',
    },
    {
      title: '6. No change of mind after delivery starts',
      body: 'Given the nature of digital products, a buyer cannot withdraw or cancel for their own convenience once delivery has started, and on-chain transfers cannot be reversed. That does not mean the sale is the end of your obligations: if the product is not delivered, or differs materially from its description, buyers can seek cancellation, a refund, or a replacement. Such a refund is not a reversal of the original transaction — you send a separate transfer to the buyer. Writing an accurate description is therefore your best protection.',
    },
    {
      title: '7. Protect your buyers’ library',
      body: 'Buyers can re-download what they purchased from their library at any time. That depends on the external URL you provided staying alive.',
      bullets: [
        'Deleting the file or link on the external service cuts off buyers who already paid',
        'Stopping the sale on OpenPay does not affect existing buyers — they keep receiving from the library',
        'If the OpenPay service itself stops, library retrieval stops with it. For high-value products or long-term commitments, keep a direct channel to reach your buyers as well',
      ],
    },
    {
      title: '8. When enabling USDC sales',
      body: `When you turn on “Also allow purchases with USDC” in the listing form, the buyer pays the USDC amount converted from the JPYC-denominated price on ${STORE_USDC_CHAIN}, directly to the displayed receiving address.`,
      bullets: [
        `Before publishing, confirm that you control the receiving address on ${STORE_USDC_CHAIN}`,
        `To verify payment, switch your wallet network to ${STORE_USDC_CHAIN} and check the USDC balance and transaction history for the same receiving address`,
        `OpenPay charges no x402 usage fee for a USDC purchase (${STORE_USDC_FEE_PERCENT}%); there is no seller fee either`,
        'Rate movements while a quote is fixed may benefit or disadvantage either the buyer or the seller. The seller bears USDC price and holding risk after receipt, and a USDC de-peg may cause the converted amount to diverge from the JPYC-denominated price',
      ],
    },
  ],

  startLinkTitle: 'About handling JPYC itself',
  startLinkBody:
    'Setting up a wallet, redeeming to yen, keeping accounting records, and how refunds work are the same whether you sell products or accept payments in a shop.',
  startLinkLabel: 'Before you start — eight things to check',

  promoTitle: 'Small moves that sell',
  promoBullets: [
    'Make your profile a storefront — use @handle headings to separate “📦 For sale” and “🔗 Links”, and open each 200-char description with who it is for, what it is, and what it solves.',
    'Build trust with a free version — publish a free digest on your blog or X and point to the full version on your @handle. Products whose quality is visible before purchase sell.',
    'Start cheap and concrete — something like “3 prompts for X, 5 JPYC” collects sales and reviews without buyer hesitation.',
    'Share product links on X — “Copy share link” in product management gives you a link with a product card. Announcing each update satisfies existing buyers and creates new reasons to buy at once.',
  ],
  promoPoint:
    `Prices are denominated in JPYC, with payment in JPYC on Polygon or, where enabled per product, USDC on ${STORE_USDC_CHAIN}. Buyers pay with just a wallet, and sales land directly in your wallet — no monthly fees, no payout requests.`,

  ctaTitle: 'List your first product',
  ctaBody: 'Listing is free. With a wallet, your first product can be live in five minutes.',
  ctaLabel: 'Open the Create page',

  disclaimer:
    'External-service details in this guide reflect common free plans as of July 2026. Terms and features of each service may change.',
};

export function storeGuideContentFor(locale: string): StoreGuideContent {
  return locale === 'en' ? EN : JA;
}

export function storeGuideMetadata(locale: string): Metadata {
  const c = storeGuideContentFor(locale);
  // OG/Twitter/canonical/hreflang は guide 共通ビルダーで (P5・N9)。
  return guidePageMetadata({
    locale,
    path: '/guide/store',
    title: c.metaTitle,
    description: c.metaDescription,
    ogImage: {
      url: '/og-creator.webp',
      width: 1200,
      height: 630,
      alt: c.heroTitle,
    },
  });
}
