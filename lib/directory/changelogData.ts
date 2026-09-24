// JPYC Service Monitor / Japan Stablecoin Payment Monitor の共通 changelog データ (データのみ・2026-09-24 R9a)。
// 契約とロジック (baseline の導出・並び・delta) は serviceMonitor.ts。ここには手書きの changelog と
// baseline の固定日だけを置き、型は changelogTypes.ts から type-only で読む。

import type { ServiceChangeEvent } from './changelogTypes';

// 週次運用で追記する手書き changelog (新しいものを**末尾**に追加する — 日付昇順を保つ)。
// 掟: 事実のみ・一次ソース URL 必須級・エントリ本体 (data.ts) の変更と同一 PR で追記する。
// removed の場合は data.ts の status を 'archived' にし、ここに removed イベントを足す。
// 新規エントリは必ず 'added' イベントをここに書く (baseline の自動 added から除外される)。
// 記入ルール (2026-09-23): 2026-09-24 以降の行は collectedAt 必須 (テストがフェンス)。collectedAt は「本番に
// merge した日 (JST)」以上。merge が遅れたら merge 直前に更新する — delta の cursor (generatedAt の UTC 日付) が
// 実効日を追い越すと、その買い手には永久に届かなくなる。
export const MANUAL_CHANGELOG: readonly ServiceChangeEvent[] = [
  // ── stablecoin-payments backfill (2026-08-27 収集・一次ソース確認済み。初回購入者が
  //     空フィードを掴まないよう、決済スコープの過去イベントを遡って積む) ──
  {
    date: '2025-11-14',
    scopes: ['stablecoin-payments'],
    provider: 'TIS / JPYC',
    changeType: 'added',
    changeCategory: 'partnership',
    assets: ['JPYC'],
    summary:
      'TIS and JPYC signed a basic agreement toward real-world deployment of JPY-stablecoin payments.',
    summaryJa: 'TIS と JPYC が、日本円ステーブルコイン決済の社会実装に向けた基本合意書を締結。',
    sourceUrl: 'https://www.tis.co.jp/news/2025/tis_news/20251114_1.html',
  },
  {
    date: '2026-02-19',
    scopes: ['stablecoin-payments'],
    provider: 'Digital Garage / JCB / Resona HD',
    changeType: 'added',
    changeCategory: 'pilot',
    assets: ['USDC', 'JPYC'],
    summary:
      'Digital Garage, JCB and Resona HD announced an in-store stablecoin payment pilot using USDC and JPYC.',
    summaryJa:
      'デジタルガレージ・JCB・りそな HD が、USDC と JPYC を用いた実店舗ステーブルコイン決済の実証実験を発表。',
    sourceUrl: 'https://www.garage.co.jp/pr/release/20260219/',
  },
  // ── JPYC / JPYC EX の Kaia 対応 (PR TIMES 2026-05-15 発表・2026-08-27 に第 1 回週次更新で
  //     収集。2026-09-03 の日付訂正で date を収集日から発表日へ直し collectedAt を分離) ──
  {
    date: '2026-05-15',
    collectedAt: '2026-08-27',
    scopes: ['jpyc-services'],
    slug: 'jpyc',
    changeType: 'updated',
    changeCategory: 'chains_change',
    summary:
      'JPYC now also circulates on Kaia; issuance and circulation cover 4 chains (Polygon, Ethereum, Avalanche, Kaia).',
    summaryJa:
      'JPYC が Kaia にも対応し、発行・流通は 4 チェーン (Polygon/Ethereum/Avalanche/Kaia) に。',
    sourceUrl: 'https://prtimes.jp/main/html/rd/p/000000315.000054018.html',
    diffs: [
      {
        field: 'chains',
        previousValue: ['polygon', 'ethereum', 'avalanche'],
        currentValue: ['polygon', 'ethereum', 'avalanche', 'kaia'],
      },
    ],
  },
  {
    date: '2026-05-15',
    collectedAt: '2026-08-27',
    scopes: ['jpyc-services'],
    slug: 'jpyc-ex',
    changeType: 'updated',
    changeCategory: 'chains_change',
    summary:
      'JPYC EX added Kaia support (issuance, redemption, wallet-address registration) and changed the issuance cap from 1M JPY per day to 1M JPY per transaction.',
    summaryJa:
      'JPYC EX が Kaia に対応 (発行・償還・アドレス登録)。発行上限を「1日100万円」から「1回100万円」へ変更。',
    sourceUrl: 'https://prtimes.jp/main/html/rd/p/000000315.000054018.html',
    diffs: [
      {
        field: 'chains',
        previousValue: ['avalanche', 'ethereum', 'polygon'],
        currentValue: ['avalanche', 'ethereum', 'polygon', 'kaia'],
      },
      {
        field: 'limit',
        previousValue: '1,000,000 JPY per day (issuance)',
        currentValue: '1,000,000 JPY per transaction (issuance)',
      },
    ],
  },
  {
    // 第 2 回週次更新 (2026-09-04) で未追跡だった商用サービスを backfill。発表日 = PR TIMES。
    date: '2026-07-13',
    collectedAt: '2026-09-04',
    scopes: ['stablecoin-payments'],
    provider: 'NetStars Stablecoin Pay',
    changeType: 'added',
    changeCategory: 'service_launch',
    assets: ['USDC', 'USDT', 'JPYC'],
    chains: ['solana', 'polygon'],
    summary:
      'NetStars launched Stablecoin Pay for its StarPay merchants: USDC, USDT and JPYC accepted via one app on Solana and Polygon (Aptos planned for summer 2026), merchant fee 0.98% (tax-exempt).',
    summaryJa:
      'ネットスターズが StarPay 加盟店向けに「Stablecoin Pay」を本格始動。USDC・USDT・JPYC を 1 つのアプリで受け付け (Solana/Polygon・Aptos は 2026 年夏予定)、加盟店手数料 0.98% (非課税)。',
    sourceUrl: 'https://prtimes.jp/main/html/rd/p/000000185.000019526.html',
    diffs: [
      { field: 'status', previousValue: null, currentValue: 'commercial' },
      { field: 'fee', previousValue: null, currentValue: '0.98% (tax-exempt)' },
    ],
  },
  {
    date: '2026-07-15',
    scopes: ['stablecoin-payments'],
    provider: 'JCB / Circle',
    changeType: 'added',
    changeCategory: 'partnership',
    assets: ['USDC'],
    summary:
      'JCB signed an MOU with a Circle affiliate to explore stablecoin-based collaboration, starting with internal USDC transfers and looking at cross-border and merchant payments.',
    summaryJa:
      'JCB が Circle 関連会社とステーブルコイン活用の協業検討に関する基本合意書 (MOU) を締結。社内 USDC 資金移動の実証から、クロスボーダー・加盟店決済も検討対象に。',
    sourceUrl: 'https://prtimes.jp/main/html/rd/p/000001423.000011361.html',
  },
  {
    date: '2026-08-10',
    scopes: ['stablecoin-payments'],
    slug: 'dg-sps',
    changeType: 'added',
    changeCategory: 'service_launch',
    assets: ['USDC'],
    chains: ['base'],
    summary:
      'Digital Garage started commercial rollout of DG Stablecoin Payment Service (API-based merchant integration; initially USDC on Base, first offered to JCB and DGFT).',
    summaryJa:
      'デジタルガレージが DG Stablecoin Payment Service の商用展開を開始 (API 接続の加盟店向け・当初は Base 上の USDC・JCB/DGFT へ先行提供)。',
    sourceUrl: 'https://www.garage.co.jp/pr/release/20260810/',
    diffs: [{ field: 'status', previousValue: null, currentValue: 'commercial' }],
  },
  {
    // 発表日は同じ一次ソース (garage.co.jp/pr/release/20260810) の上の決済スコープ行と同一。
    // ディレクトリ追加として記録したのは 2026-08-27 (第 1 回週次更新)。
    date: '2026-08-10',
    collectedAt: '2026-08-27',
    scopes: ['jpyc-services'],
    slug: 'dg-sps',
    changeType: 'added',
    summary:
      'DG Stablecoin Payment Service (Digital Garage) added: a merchant stablecoin payment platform, initially USDC on Base, first offered to JCB and DGFT.',
    summaryJa:
      'デジタルガレージの DG Stablecoin Payment Service を追加。加盟店向けステーブルコイン決済基盤 (当初は Base 上の USDC・JCB/DGFT へ先行提供)。',
    sourceUrl: 'https://www.garage.co.jp/pr/release/20260810/',
  },
  // ── 2026-08-26 大阪府「先駆的金融市場等形成支援事業補助金」採択 (公式発表・4 事業のうち
  //     ステーブルコイン決済関連 3 件。一次ソース = 大阪府公式ページ) ──
  {
    date: '2026-08-26',
    scopes: ['stablecoin-payments'],
    provider: 'HashPort (Osaka Pref. subsidy)',
    changeType: 'added',
    changeCategory: 'pilot',
    assets: ['JPYC', 'USDC'],
    summary:
      'Osaka Prefecture selected HashPort for its financial-pilot subsidy: a stablecoin payment and settlement pilot accepting JPYC/USDC at retail and restaurants with JPY settlement to merchants, plus an escrow-style EC payment API (planned Jan-Mar 2027).',
    summaryJa:
      '大阪府の先駆的金融市場等形成支援事業補助金に HashPort が採択。JPYC/USDC を受け付け加盟店へ日本円で清算する決済・清算システムと、EC 向けエスクロー型決済 API の実証 (2027 年 1〜3 月予定)。',
    sourceUrl:
      'https://www.pref.osaka.lg.jp/o020060/kikaku/osaka-kokusaikinyu/senkuteki_hojokin.html',
  },
  {
    date: '2026-08-26',
    scopes: ['stablecoin-payments'],
    provider: 'Mina Wallet / Sumitomo Mitsui Card (Osaka Pref. subsidy)',
    changeType: 'added',
    changeCategory: 'pilot',
    assets: ['JPYC', 'USDC'],
    summary:
      'Osaka Prefecture selected Mina Wallet (with Sumitomo Mitsui Card) for a stablecoin payment pilot using My Number Card identity verification (planned Oct 2026 - Feb 2027).',
    summaryJa:
      '大阪府補助にマイナウォレット (三井住友カードと共同) が採択。マイナンバーカードによる本人確認とステーブルコイン決済の実証 (2026 年 10 月〜2027 年 2 月頃予定)。',
    sourceUrl:
      'https://www.pref.osaka.lg.jp/o020060/kikaku/osaka-kokusaikinyu/senkuteki_hojokin.html',
  },
  {
    date: '2026-08-26',
    scopes: ['stablecoin-payments'],
    provider: 'Mi&T (Osaka Pref. subsidy)',
    changeType: 'added',
    changeCategory: 'pilot',
    assets: ['JPYC'],
    summary:
      'Osaka Prefecture selected Mi&T (Osaka Metropolitan University venture) for an in-store JPYC payment pilot at shops and restaurants around the university campus.',
    summaryJa:
      '大阪府補助に大阪公立大学発ベンチャーの Mi&T が採択。大学キャンパス周辺の飲食店・小売店での JPYC 実店舗決済の実証。',
    sourceUrl:
      'https://www.pref.osaka.lg.jp/o020060/kikaku/osaka-kokusaikinyu/senkuteki_hojokin.html',
  },
  // ── 2026-08-27 (第 1 回週次更新)。自社面の観測 = 発表日 == 収集日 ──
  {
    date: '2026-08-27',
    collectedAt: '2026-08-27',
    scopes: ['jpyc-services'],
    slug: 'aegis-ai',
    changeType: 'updated',
    changeCategory: 'assets_change',
    summary:
      'Aegis now also sells its briefing API in USDC on Base via standard x402, alongside JPYC.',
    summaryJa: 'Aegis が JPYC に加えて USDC (Base・標準 x402) での販売を開始。',
    sourceUrl: 'https://aegis-ai.xyz/',
    diffs: [{ field: 'assets', previousValue: ['JPYC'], currentValue: ['JPYC', 'USDC'] }],
  },
  // ── 第 2 回週次更新 (収集 2026-09-04・収集窓 2026-08-27〜09-04) ──
  {
    // 一次ソース = 金融庁「電子決済手段等取引業者登録一覧」(令和 8 年 8 月 27 日現在)。
    date: '2026-08-27',
    collectedAt: '2026-09-04',
    scopes: ['jpyc-services'],
    slug: 'coincheck',
    changeType: 'updated',
    changeCategory: 'update',
    assets: ['USDC'],
    summary:
      'Coincheck was registered as an Electronic Payment Instruments Exchange Service Provider (Kanto Local Finance Bureau No. 00002; handled instrument: USDC), the second such registrant in Japan after SBI VC Trade.',
    summaryJa:
      'コインチェックが電子決済手段等取引業者として登録 (関東財務局長第00002号・取扱電子決済手段: USDC)。国内 2 社目 (1 社目は SBI VC トレード)。',
    sourceUrl: 'https://www.fsa.go.jp/menkyo/menkyoj/denshikessaisyudan.pdf',
    diffs: [
      {
        field: 'status',
        previousValue: null,
        currentValue: 'registered Electronic Payment Instruments Exchange Service Provider (USDC)',
      },
    ],
  },
  {
    // 大阪府採択 (8/26) の後、Mi&T 自身の PR TIMES で手数料・期間・規模が初めて数値開示された。
    date: '2026-08-31',
    collectedAt: '2026-09-04',
    scopes: ['stablecoin-payments'],
    provider: 'Mi&T (Osaka Pref. subsidy)',
    changeType: 'updated',
    changeCategory: 'fee_change',
    assets: ['JPYC'],
    summary:
      'Mi&T disclosed details of its Osaka-subsidized in-store JPYC pilot: merchant fee 1.0% of the payment amount, about 5 restaurants and shops around Osaka Metropolitan University, planned mid-November 2026 to mid-March 2027.',
    summaryJa:
      'Mi&T が大阪府補助の JPYC 実店舗決済実証の詳細を公表: 店舗側の決済手数料は決済額の 1.0% のみ、大阪公立大学キャンパス周辺の飲食店・小売店 5 店舗程度、2026 年 11 月中旬〜2027 年 3 月中旬 (予定)。',
    sourceUrl: 'https://prtimes.jp/main/html/rd/p/000000003.000187870.html',
    diffs: [{ field: 'fee', previousValue: null, currentValue: '1.0%' }],
  },
  {
    date: '2026-09-04',
    scopes: ['jpyc-services'],
    slug: 'sbi-vc-trade',
    changeType: 'verified',
    summary:
      'Re-verified against the FSA registry (as of 2026-08-27): SBI VC Trade remains registrant No. 00001 handling USDC, RLUSD and JPYSC.',
    summaryJa:
      '金融庁の登録一覧 (令和 8 年 8 月 27 日現在) で再確認: SBI VC トレードは第00001号として USDC・RLUSD・JPYSC を取扱い。',
    sourceUrl: 'https://www.fsa.go.jp/menkyo/menkyoj/denshikessaisyudan.pdf',
  },
  {
    date: '2026-09-04',
    scopes: ['jpyc-services'],
    slug: 'jpyc',
    changeType: 'verified',
    summary:
      'Re-verified: no new official JPYC announcement found for 2026-08-27 to 2026-09-04; facts unchanged.',
    summaryJa:
      '再確認: 2026-08-27〜09-04 に JPYC の新規公式発表は見つからず、記載事実に変更なし。',
  },
  {
    date: '2026-09-04',
    scopes: ['jpyc-services'],
    slug: 'jpyc-ex',
    changeType: 'verified',
    summary:
      'Re-verified: no new official JPYC EX announcement found for 2026-08-27 to 2026-09-04; facts unchanged.',
    summaryJa:
      '再確認: 2026-08-27〜09-04 に JPYC EX の新規公式発表は見つからず、記載事実に変更なし。',
  },
  {
    date: '2026-09-04',
    scopes: ['jpyc-services'],
    slug: 'aegis-ai',
    changeType: 'verified',
    summary:
      'Re-verified: the x402 briefing endpoint still answers 402 (JPYC and USDC sales continue); the landing page was redesigned but the paid API is unchanged.',
    summaryJa:
      '再確認: x402 ブリーフィング API は引き続き 402 応答 (JPYC/USDC 販売継続)。LP は刷新されたが有料 API は変更なし。',
  },
  {
    date: '2026-09-04',
    scopes: ['stablecoin-payments'],
    provider: 'HashPort (Osaka Pref. subsidy)',
    changeType: 'verified',
    assets: ['JPYC', 'USDC'],
    summary:
      'Re-verified on the Osaka Prefecture page (last updated 2026-08-26): 12 applications, 4 grants, JPY 28,890 thousand in total; HashPort pilot schedule unchanged.',
    summaryJa:
      '大阪府公式ページ (更新 2026-08-26) で再確認: 応募 12 件・交付決定 4 件・総額 28,890 千円。HashPort の実証予定に変更なし。',
    sourceUrl:
      'https://www.pref.osaka.lg.jp/o020060/kikaku/osaka-kokusaikinyu/senkuteki_hojokin.html',
  },
  {
    date: '2026-09-04',
    scopes: ['stablecoin-payments'],
    provider: 'Mina Wallet / Sumitomo Mitsui Card (Osaka Pref. subsidy)',
    changeType: 'verified',
    assets: ['JPYC', 'USDC'],
    summary:
      'Re-verified on the Osaka Prefecture page (last updated 2026-08-26): Mina Wallet / Sumitomo Mitsui Card pilot schedule unchanged.',
    summaryJa:
      '大阪府公式ページ (更新 2026-08-26) で再確認: マイナウォレット / 三井住友カードの実証予定に変更なし。',
    sourceUrl:
      'https://www.pref.osaka.lg.jp/o020060/kikaku/osaka-kokusaikinyu/senkuteki_hojokin.html',
  },
  {
    // 週次更新 第 3 回 (2026-09-11)。Kaia × ネットスターズ MOU = 両商品にまたがる 1 事実 (Kaia 側 / StarPay 側)。
    date: '2026-09-11',
    collectedAt: '2026-09-11',
    scopes: ['jpyc-services'],
    slug: 'kaia',
    changeType: 'updated',
    changeCategory: 'partnership',
    assets: ['JPYC'],
    summary:
      'KAIA DLT Foundation signed an MOU with NetStars (operator of StarPay) to study integrating Kaia-based stablecoins — JPYC, IDRX and native USDT — into StarPay\'s roughly 700,000 payment locations in Japan, using Kaia\'s FX orchestration layer "Ratio" so merchants receive yen. Launch timing and fees are not disclosed.',
    summaryJa:
      'KAIA DLT Foundation がネットスターズ (StarPay 運営) と MOU を締結。Kaia 上の JPYC・IDRX・ネイティブ USDT を StarPay の国内約 70 万決済拠点へ統合する検討を開始し、FX 層「Ratio」で加盟店は円で受け取る構想。稼働時期・手数料は未公表。',
    sourceUrl: 'https://prtimes.jp/main/html/rd/p/000000028.000154579.html',
  },
  {
    date: '2026-09-11',
    collectedAt: '2026-09-11',
    scopes: ['stablecoin-payments'],
    provider: 'NetStars Stablecoin Pay',
    changeType: 'updated',
    changeCategory: 'partnership',
    assets: ['JPYC', 'USDT'],
    summary:
      'NetStars signed an MOU with KAIA DLT Foundation to study accepting Kaia-based stablecoins (JPYC, IDRX, native USDT) across StarPay\'s roughly 700,000 payment locations, with yen settlement to merchants via Kaia\'s "Ratio" FX layer. This is a study-phase agreement; no launch date, fee or chain change has been announced for Stablecoin Pay.',
    summaryJa:
      'ネットスターズが KAIA DLT Foundation と MOU を締結。StarPay の国内約 70 万決済拠点で Kaia 系ステーブルコイン (JPYC・IDRX・ネイティブ USDT) の受け入れを検討し、Kaia の FX 層「Ratio」で加盟店へ円で精算する構想。検討段階の合意で、Stablecoin Pay の稼働日・手数料・対応チェーンの変更は未発表。',
    sourceUrl: 'https://www.netstars.co.jp/news/9737/',
  },
  {
    date: '2026-09-11',
    scopes: ['stablecoin-payments'],
    provider: 'HashPort (Osaka Pref. subsidy)',
    changeType: 'verified',
    assets: ['JPYC', 'USDC'],
    summary:
      'Re-verified on the Osaka Prefecture page (still last updated 2026-08-26): 4 grants, JPY 28,890 thousand in total, implementation through 2027-03-31; HashPort pilot schedule unchanged.',
    summaryJa:
      '大阪府公式ページ (更新日 2026-08-26 のまま) で再確認: 交付決定 4 件・総額 28,890 千円・実施期間 2027-03-31 まで。HashPort の実証予定に変更なし。',
    sourceUrl:
      'https://www.pref.osaka.lg.jp/o020060/kikaku/osaka-kokusaikinyu/senkuteki_hojokin.html',
  },
  {
    date: '2026-09-11',
    scopes: ['stablecoin-payments'],
    provider: 'Mina Wallet / Sumitomo Mitsui Card (Osaka Pref. subsidy)',
    changeType: 'verified',
    assets: ['JPYC', 'USDC'],
    summary:
      'Re-verified on the Osaka Prefecture page (still last updated 2026-08-26): Mina Wallet / Sumitomo Mitsui Card pilot schedule unchanged.',
    summaryJa:
      '大阪府公式ページ (更新日 2026-08-26 のまま) で再確認: マイナウォレット / 三井住友カードの実証予定に変更なし。',
    sourceUrl:
      'https://www.pref.osaka.lg.jp/o020060/kikaku/osaka-kokusaikinyu/senkuteki_hojokin.html',
  },
  {
    date: '2026-09-11',
    scopes: ['stablecoin-payments'],
    provider: 'Mi&T (Osaka Pref. subsidy)',
    changeType: 'verified',
    assets: ['JPYC'],
    summary:
      'Re-verified on the Osaka Prefecture page (still last updated 2026-08-26): Mi&T pilot (merchant fee 1.0%, planned mid-November 2026 to mid-March 2027) unchanged.',
    summaryJa:
      '大阪府公式ページ (更新日 2026-08-26 のまま) で再確認: Mi&T の実証 (手数料 1.0%・2026 年 11 月中旬〜2027 年 3 月中旬予定) に変更なし。',
    sourceUrl:
      'https://www.pref.osaka.lg.jp/o020060/kikaku/osaka-kokusaikinyu/senkuteki_hojokin.html',
  },
  {
    // 週次更新 第 4 回 (2026-09-18)。Circle の原文は "active or onboarding" — JPYC が Arc 上で稼働中とは
    // 書いていないので、稼働を断定せず chains (発行チェーン) も変えない (sourced-facts-only)。
    date: '2026-09-16',
    collectedAt: '2026-09-18',
    scopes: ['jpyc-services'],
    slug: 'jpyc',
    changeType: 'updated',
    changeCategory: 'partnership',
    assets: ['JPYC'],
    summary:
      'Circle\'s Arc mainnet launch announcement (2026-09-16) names JPYC among the local stablecoins that are "active or onboarding" to Circle StableFX, its 24/7 FX engine on Arc. The announcement does not say which of the two applies to JPYC, and gives no date for JPYC availability on Arc.',
    summaryJa:
      'Circle の Arc メインネット公開発表 (2026-09-16) が、Arc 上の 24 時間 FX エンジン「Circle StableFX」で「稼働中または導入手続き中 (active or onboarding)」の現地通貨ステーブルコインの 1 つとして JPYC を挙げた。JPYC がどちらの段階かと、Arc での提供時期は発表に記載なし。',
    sourceUrl:
      'https://www.circle.com/pressroom/circle-launches-arc-mainnet-an-economic-operating-system-for-the-internet',
  },
  {
    // 週次更新 第 4 回 (2026-09-18)。Upbit の告知は取引所自身の一次ソース。価格・出来高・「初の上場」等の
    // 評価は一次ソースに無いので書かない (sourced-facts-only)。JPYC 側の facts (発行チェーン) は不変。
    // 第 5 回 (2026-09-23) で同日 19:23 KST の別告知 (ID 6585・Kaia/Polygon 入金開始) を本イベントに統合。
    // 同日同 slug の updated は dedupe キーが衝突するため別イベントにできない。「置き換え済み」を summary に明記。
    date: '2026-09-17',
    collectedAt: '2026-09-23',
    scopes: ['jpyc-services'],
    slug: 'jpyc',
    changeType: 'updated',
    changeCategory: 'update',
    assets: ['JPYC'],
    chains: ['ethereum', 'kaia', 'polygon'],
    summary:
      'Upbit (South Korea) announced new trading support for JPYC in its KRW, BTC and USDT markets on 2026-09-17, with deposits and withdrawals on Ethereum only at launch (contract 0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29); the trading start was rescheduled twice on the day, to 18:00 KST. Updated 2026-09-23: a second Upbit notice (ID 6585, 2026-09-17 19:23 KST) opened JPYC deposits over Kaia and Polygon (minimum deposit 500 JPYC; 36 / 200 confirmations; withdrawal fee 1 JPYC / 0.2 JPYC), with withdrawals on those networks to follow in a later notice.',
    summaryJa:
      '韓国の取引所 Upbit が 2026-09-17、JPYC の新規取引支援 (KRW・BTC・USDT マーケット) を告知。開始時点の入出金は Ethereum のみ (コントラクト 0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29) で、取引開始時刻は当日 2 回変更され 18:00 KST となった。2026-09-23 更新: 同日 19:23 KST の別告知 (ID 6585) で Kaia・Polygon ネットワーク経由の JPYC 入金を開始 (最小入金 500 JPYC・確認数 36 / 200・出金手数料 1 JPYC / 0.2 JPYC)。両ネットワークの出金は後日の告知で対応予定。',
    sourceUrl: 'https://upbit.com/service_center/notice?id=6585',
  },
  {
    // 週次更新 第 4 回 follow-up (2026-09-18)。発行予約は JPYC EX の機能なので slug は jpyc-ex
    // (同日の jpyc/updated = Upbit 告知と dedupe キーが衝突しない)。時刻は JPYC EX 公式お知らせの
    // 追記時刻を採用 (報道の時刻とは食い違うため使わない)。原因・Upbit 上場との関係は公式に記載が
    // 無いので書かない (sourced-facts-only)。
    date: '2026-09-17',
    collectedAt: '2026-09-18',
    scopes: ['jpyc-services'],
    slug: 'jpyc-ex',
    changeType: 'updated',
    changeCategory: 'update',
    assets: ['JPYC'],
    chains: ['ethereum', 'polygon'],
    summary:
      'JPYC EX temporarily suspended JPYC issuance reservations: Ethereum from around 19:15 JST on 2026-09-17 (cause under investigation), Polygon added at 21:30 JST. Ethereum reservations were restored at 23:20 JST the same day and Polygon at 00:15 JST on 2026-09-18, after which the service returned to normal. JPYC has not published a cause. Redemption was not mentioned as affected.',
    summaryJa:
      'JPYC EX が JPYC の発行予約を一時停止: Ethereum は 2026-09-17 19:15 頃から (原因調査中)、Polygon は同日 21:30 追記で対象に追加。Ethereum は同日 23:20、Polygon は 2026-09-18 0:15 に復旧し、通常どおり利用可能に。原因は公表なし。償還への影響は記載なし。',
    sourceUrl: 'https://faq.jpyc.co.jp/s/article/announce-0036',
  },
  {
    date: '2026-09-18',
    scopes: ['stablecoin-payments'],
    provider: 'HashPort (Osaka Pref. subsidy)',
    changeType: 'verified',
    assets: ['JPYC', 'USDC'],
    summary:
      'Re-verified on the Osaka Prefecture page (still last updated 2026-08-26): 4 grants, JPY 28,890 thousand in total; HashPort pilot schedule unchanged.',
    summaryJa:
      '大阪府公式ページ (更新日 2026-08-26 のまま) で再確認: 交付決定 4 件・総額 28,890 千円。HashPort の実証予定に変更なし。',
    sourceUrl:
      'https://www.pref.osaka.lg.jp/o020060/kikaku/osaka-kokusaikinyu/senkuteki_hojokin.html',
  },
  {
    date: '2026-09-18',
    scopes: ['stablecoin-payments'],
    provider: 'Mina Wallet / Sumitomo Mitsui Card (Osaka Pref. subsidy)',
    changeType: 'verified',
    assets: ['JPYC', 'USDC'],
    summary:
      'Re-verified on the Osaka Prefecture page (still last updated 2026-08-26): Mina Wallet / Sumitomo Mitsui Card pilot schedule unchanged.',
    summaryJa:
      '大阪府公式ページ (更新日 2026-08-26 のまま) で再確認: マイナウォレット / 三井住友カードの実証予定に変更なし。',
    sourceUrl:
      'https://www.pref.osaka.lg.jp/o020060/kikaku/osaka-kokusaikinyu/senkuteki_hojokin.html',
  },
  {
    date: '2026-09-18',
    scopes: ['stablecoin-payments'],
    provider: 'Mi&T (Osaka Pref. subsidy)',
    changeType: 'verified',
    assets: ['JPYC'],
    summary:
      'Re-verified on the Osaka Prefecture page (still last updated 2026-08-26): Mi&T pilot (merchant fee 1.0%, planned mid-November 2026 to mid-March 2027) unchanged.',
    summaryJa:
      '大阪府公式ページ (更新日 2026-08-26 のまま) で再確認: Mi&T の実証 (手数料 1.0%・2026 年 11 月中旬〜2027 年 3 月中旬予定) に変更なし。',
    sourceUrl:
      'https://www.pref.osaka.lg.jp/o020060/kikaku/osaka-kokusaikinyu/senkuteki_hojokin.html',
  },
  {
    date: '2026-09-18',
    scopes: ['stablecoin-payments'],
    provider: 'NetStars Stablecoin Pay',
    changeType: 'verified',
    assets: ['JPYC', 'USDT'],
    summary:
      'Re-verified on the NetStars news list: no announcement after the 2026-09-11 Kaia MOU; no launch date, fee or chain change published for Stablecoin Pay.',
    summaryJa:
      'ネットスターズ公式ニュース一覧で再確認: 2026-09-11 の Kaia MOU 以降の発表なし。Stablecoin Pay の稼働日・手数料・対応チェーンの変更は未公表のまま。',
    sourceUrl: 'https://www.netstars.co.jp/news/',
  },
  {
    // 週次更新 第 5 回 (2026-09-23)。累計発行額は JPYC 社の自社発表 (PR TIMES 一次配信)。
    // 発行チェーン (4) と facts は不変なので diffs は付けない。
    date: '2026-09-18',
    collectedAt: '2026-09-23',
    scopes: ['jpyc-services'],
    slug: 'jpyc',
    changeType: 'updated',
    changeCategory: 'update',
    assets: ['JPYC'],
    summary:
      'JPYC Inc. announced on 2026-09-18 that cumulative issuance of the JPYC yen stablecoin has passed JPY 10 billion. Issuance chains are unchanged: Avalanche, Ethereum, Polygon and Kaia (4 chains).',
    summaryJa:
      'JPYC 株式会社が 2026-09-18、日本円ステーブルコイン JPYC の累計発行額が 100 億円を突破したと発表。発行チェーンは Avalanche・Ethereum・Polygon・Kaia の 4 チェーンで変更なし。',
    sourceUrl: 'https://prtimes.jp/main/html/rd/p/000000331.000054018.html',
  },
  {
    // 週次更新 第 5 回 (2026-09-23)。金融庁の登録一覧 PDF で再確認。
    date: '2026-09-23',
    collectedAt: '2026-09-23',
    scopes: ['jpyc-services'],
    slug: 'coincheck',
    changeType: 'verified',
    assets: ['USDC'],
    summary:
      'Re-verified against the FSA registry of Electronic Payment Instruments Exchange Service Providers (still as of 2026-08-27): two registrants, SBI VC Trade (No. 00001) and Coincheck (No. 00002, USDC); no new registration.',
    summaryJa:
      '金融庁の電子決済手段等取引業者登録一覧 (令和 8 年 8 月 27 日現在のまま) で再確認: 登録は SBI VC トレード (第00001号) とコインチェック (第00002号・USDC) の 2 社で、新規登録なし。',
    sourceUrl: 'https://www.fsa.go.jp/menkyo/menkyoj/denshikessaisyudan.pdf',
  },
  {
    date: '2026-09-23',
    scopes: ['stablecoin-payments'],
    provider: 'HashPort (Osaka Pref. subsidy)',
    changeType: 'verified',
    assets: ['JPYC', 'USDC'],
    summary:
      'Re-verified on the Osaka Prefecture page (still last updated 2026-08-26): HashPort pilot schedule unchanged.',
    summaryJa:
      '大阪府公式ページ (更新日 2026-08-26 のまま) で再確認: HashPort の実証予定に変更なし。',
    sourceUrl:
      'https://www.pref.osaka.lg.jp/o020060/kikaku/osaka-kokusaikinyu/senkuteki_hojokin.html',
  },
  {
    date: '2026-09-23',
    scopes: ['stablecoin-payments'],
    provider: 'Mina Wallet / Sumitomo Mitsui Card (Osaka Pref. subsidy)',
    changeType: 'verified',
    assets: ['JPYC', 'USDC'],
    summary:
      'Re-verified on the Osaka Prefecture page (still last updated 2026-08-26): Mina Wallet / Sumitomo Mitsui Card pilot schedule unchanged.',
    summaryJa:
      '大阪府公式ページ (更新日 2026-08-26 のまま) で再確認: マイナウォレット / 三井住友カードの実証予定に変更なし。',
    sourceUrl:
      'https://www.pref.osaka.lg.jp/o020060/kikaku/osaka-kokusaikinyu/senkuteki_hojokin.html',
  },
  {
    date: '2026-09-23',
    scopes: ['stablecoin-payments'],
    provider: 'Mi&T (Osaka Pref. subsidy)',
    changeType: 'verified',
    assets: ['JPYC'],
    summary:
      'Re-verified on the Osaka Prefecture page (still last updated 2026-08-26): Mi&T pilot (merchant fee 1.0%, planned mid-November 2026 to mid-March 2027) unchanged.',
    summaryJa:
      '大阪府公式ページ (更新日 2026-08-26 のまま) で再確認: Mi&T の実証 (手数料 1.0%・2026 年 11 月中旬〜2027 年 3 月中旬予定) に変更なし。',
    sourceUrl:
      'https://www.pref.osaka.lg.jp/o020060/kikaku/osaka-kokusaikinyu/senkuteki_hojokin.html',
  },
  {
    date: '2026-09-23',
    scopes: ['stablecoin-payments'],
    provider: 'NetStars Stablecoin Pay',
    changeType: 'verified',
    assets: ['JPYC', 'USDT'],
    summary:
      'Re-verified on the NetStars news list: no announcement after the 2026-09-11 Kaia MOU; no launch date, fee or chain change published for Stablecoin Pay.',
    summaryJa:
      'ネットスターズ公式ニュース一覧で再確認: 2026-09-11 の Kaia MOU 以降の発表なし。Stablecoin Pay の稼働日・手数料・対応チェーンの変更は未公表のまま。',
    sourceUrl: 'https://www.netstars.co.jp/news/',
  },
];

// ディレクトリ初期公開日。baseline の 'added' はこの固定日に立てる — entry.updatedAt 由来に
// すると週次更新で updatedAt を進めた瞬間に「追加日」まで動いてしまう (第 1 回運用で発覚)。
export const BASELINE_DATE = '2026-07-13';
