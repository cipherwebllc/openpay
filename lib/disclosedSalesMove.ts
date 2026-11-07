// 「売上をほかのウォレットへ移す」(plans/store-sales-move.md・内部名「売上の移動」) の開示 SOT (lib/legal.ts が再 export する)。
// 規約 第 5 条 (12)・特商法 (役務の内容・役務の対価・対価以外の費用・支払時期・返品)・免責 §2/§7・料金ページと LP の
// 5 つの場合のカード (lib/pricing.ts の summary の salesMove)・料金ページの行・/transparency・public/llms.txt・README・
// docs/FEATURES.md に書いた数値そのもの (プライバシー 1-(11)・2-(13)・4. は数値を持たない)。
// 実装 (app/api/relay/jpyc/move/route.ts・lib/relay/salesMove.ts) はこの定数と一致しなければならない
// (フェンス: tests/lib/salesMoveDisclosure.test.ts)。
// ⚠️ 変える = 開示の変更ゆえ、必ず本文改定 (施行日の更新) + フェンス更新を伴うこと。
import { DISCLOSED_RECOVER_FEE } from './disclosedRecoverFee';

export const DISCLOSED_SALES_MOVE = {
  // 送金 1 回の利用料 (JPYC)。移す額に上乗せ (送り先には指定した額がそのまま届く)・決済額の 1% は適用しない。
  // route は relayGasFeeValue(137) (Polygon の relay の gas floor) を強制する。その開示値は recover の最低額と同じ源。
  // ⚠️ route はこの定数を読まない。env の上書き (NEXT_PUBLIC_RELAY_GAS_FEE_JPYC[_POLYGON]) があると実際の利用料がこれとずれる
  // (点灯の前の確認 = docs/DEPLOY_CHECKLIST.md §18.2 の 0.)。
  feeJpyc: DISCLOSED_RECOVER_FEE.floorJpyc,
  // 移す額 (送り先に届く額・利用料を含まない) の下限 (JPYC)。route の SALES_MOVE_MIN_VALUE_WEI と同じ。
  minJpyc: 1,
  // 受け付ける mainnet のチェーン (route の SALES_MOVE_CHAIN_IDS のうち testnet の Amoy を除いたもの)。
  chainIds: [137],
  chainNames: ['Polygon'],
  // 新設日 (= 提供開始日・規約 第 5 条 (12) の適用開始)。⚠️ 仮置き: flag (NEXT_PUBLIC_ENABLE_SALES_MOVE) の点灯日で確定し、
  // LEGAL_ENTITY の 4 文書の施行日と本文の日付も同じ日にそろえる (docs/DEPLOY_CHECKLIST.md §18.2)。
  effectiveDate: '2026-11-07',
} as const;

/** 本文に書く対象チェーンの並び (今は Polygon だけ)。/transparency・料金ページ・フェンスが同じ書き方を使う。 */
export function disclosedSalesMoveChains(locale: 'ja' | 'en'): string {
  const names: readonly string[] = DISCLOSED_SALES_MOVE.chainNames;
  if (locale === 'ja') return names.join('・');
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
