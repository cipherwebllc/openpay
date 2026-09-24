// 法務文書で開示済みの x402 利用料 (lib/legal.ts が再 export する)。client の hosted 購入が
// lib/legal (規約本文) を丸ごと bundle しないよう、定数だけをこの小さなモジュールに置く。
// 開示済みの「x402 ファシリテーター利用料」料率 (SOT)。Terms/Disclaimer/特商法/お知らせ/README の本文に
// 書かれた数値そのもので、これらの文書はこの定数と矛盾してはならない。決済額の 1% (100bps)・下限 1 JPYC・
// **買い手上乗せ** (seller は表示額をそのまま受領)。実装は lib/x402/facilitatorConfig.ts
// (X402_FEE_BPS / X402_FEE_FLOOR_JPYC) で、既定は本定数と一致する。gas-recovery (DISCLOSED_RECOVER_FEE) /
// モバイル注文 (DISCLOSED_MOBILE_ORDER_FEE) とは独立の別対価 (managed x402 facilitator の運用対価)。
// ⚠️ 変更する = 開示の変更ゆえ、必ず本文改定 (新「改定」エントリ) + フェンス更新を伴わなければならない。
export const DISCLOSED_X402_FEE = {
  bps: 100, // 1%
  floorJpyc: 1, // 下限 1 JPYC (2026-07-05 改定で 2→1。実測 settle ガス ~0.5 円の 2 倍を確保しつつマイクロ決済の割高感を低減)
} as const;
