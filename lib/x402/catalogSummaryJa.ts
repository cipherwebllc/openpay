// AI ストアの日本語ページで、公式商品のカードに出す日本語の要約 (表示専用・2026-10-21 磨き上げ)。
// /api/discovery・402・Bazaar の英語の description はエージェント向けの正本なので変えない。
// key = 商品の path (JPYC 面と USDC 面の双子は同じ文)。全公式商品に項目があり余分が無いことは
// tests/lib/x402/catalogSummaryJa.test.ts が検査する。client から import するので依存を持たない。
export const FIRST_PARTY_SUMMARY_JA: Readonly<Record<string, string>> = {
  '/api/paid/stores': 'JPYC を使える取引所・dApps・ブリッジの出典つき一覧 (JSON)。',
  '/api/paid/usdc/stores': 'JPYC を使える取引所・dApps・ブリッジの出典つき一覧 (JSON)。',
  '/api/paid/japan-web3-directory':
    '日本の JPYC・USDC・Web3・AI エージェント関連サービスの出典つき構造化データ (全件)。',
  '/api/paid/usdc/japan-web3-directory':
    '日本の JPYC・USDC・Web3・AI エージェント関連サービスの出典つき構造化データ (全件)。',
  '/api/paid/japan-web3-directory/search': '同じデータを種類・トークン・チェーン・機能で絞り込んで取得。',
  '/api/paid/usdc/japan-web3-directory/search': '同じデータを種類・トークン・チェーン・機能で絞り込んで取得。',
  '/api/paid/usdc/japan-web3-directory/licensed':
    '全件に商用利用ライセンスと、購入者のアドレスを結び付けた署名 (EIP-712) が付く版。',
  '/api/paid/jpyc/services':
    '日本の JPYC・Web3 サービスの追加・変更・終了を週次で追う差分フィード。前回の日付を渡すと差分だけ返る。',
  '/api/paid/usdc/jpyc/services':
    '日本の JPYC・Web3 サービスの追加・変更・終了を週次で追う差分フィード。前回の日付を渡すと差分だけ返る。',
  '/api/paid/stablecoin-payments':
    '日本のステーブルコイン決済サービスの開始・実証・提携・手数料の変更を週次で追う差分フィード。',
  '/api/paid/usdc/stablecoin-payments':
    '日本のステーブルコイン決済サービスの開始・実証・提携・手数料の変更を週次で追う差分フィード。',
  '/api/paid/jpyc-shops/search': 'いま JPYC で注文できる OpenPay の店舗を検索。',
  '/api/paid/usdc/jpyc/supply': 'チェーン別の JPYC の発行量 (totalSupply) を、観測したブロック番号つきで返す。',
  '/api/paid/usdc/jpyc/balance': '任意のアドレスの JPYC 残高を、チェーン別・ブロック番号つきで返す。',
  '/api/paid/usdc/jpyc/transfers': '直近約 1 時間の JPYC の送金イベント。前回の続きから差分だけ取ることもできる。',
  '/api/paid/usdc/jpyc/activity': 'Polygon の JPYC の 24 時間の送金件数・送受信者数・金額などの集計。',
  '/api/paid/usdc/jpyc/attest': '1 件の取引に含まれる JPYC の送金を、取得時点の記録として署名つきで返す。',
};
