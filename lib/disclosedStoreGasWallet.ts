// 「お店がガス代を肩代わりして送る」(内部名「お店の端末で送る」) の開示 SOT (lib/legal.ts が再 export する)。
// Terms 第 2 条 (6)(c)・第 3 条・第 5 条 (1)(11)・特商法 (サービス内容・役務の対価・その他の費用・返品)・免責 intro/§7・
// プライバシー (1)(10)・(2)(12)・4. 保管期間・LP (supportFeeRegisterBody/supportFeePayBody/faqA1)・public/llms.txt・
// /guide/shop・/guide/qr・/guide/start に書いた数値そのもの。実装 (lib/storeDevicePayment.ts) はこの定数と一致しなければ
// ならない (フェンス: tests/lib/storeGasWalletDisclosure.test.ts)。
// ⚠️ 変える = 開示の変更ゆえ、必ず本文改定 (施行日の更新) + フェンス更新を伴うこと。
export const DISCLOSED_STORE_GAS_WALLET = {
  // OpenPay 利用料は 0 円。仕組み上 (既存の分割用コントラクト) 送金 1 回につき 1 wei をお客様の支払いに上乗せし当社指定ウォレットへ。
  feeWei: 1,
  // 点灯するチェーン (mainnet・lib/storeDevicePayment.ts の storeDeviceChainIds がここから導く = ここに足す開示の
  // merge がそのチェーンの点灯)。Polygon で新設し、同日 Kaia・Avalanche を追加 (P5-2・user 承認 2026-10-08)。
  chainIds: [137, 8217, 43114],
  chainNames: ['Polygon', 'Kaia', 'Avalanche'],
  // ネットワーク手数料は店主の端末のガス用ウォレットが払う (当社は肩代わりしない・送信もしない)。
  gasPayer: 'merchant',
  // お客様の署名を店主の端末へ受け渡すための保管は最長 10 分。
  handoffRetentionSec: 600,
  // 新設日 (= 提供開始日・規約 第 5 条 (11) の適用開始)。Kaia・Avalanche の追加も同日。
  effectiveDate: '2026-10-08',
} as const;

/**
 * 本文に書く対象チェーンの並び (ja: 「Polygon・Kaia・Avalanche」・en: 「Polygon, Kaia and Avalanche」)。
 * /transparency とフェンスが同じ書き方を使う (本文の書き方とフェンスの期待がずれないように)。
 */
export function disclosedStoreGasChains(locale: 'ja' | 'en'): string {
  const names: readonly string[] = DISCLOSED_STORE_GAS_WALLET.chainNames;
  if (locale === 'ja') return names.join('・');
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
