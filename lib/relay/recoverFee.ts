// recover (forwarder) モードの per-tx 手数料計算。client (useJpycEip3009Payment) と
// server (handleRecover の expectedFeeValue) が **同一式** で feeValue を求める必要がある:
// feeValue は EIP-3009 の nonce (分割コミットメント・lib/relay/forwarderIntent.buildForwarderNonce)
// に焼き込まれるため、両者がずれると on-chain 署名検証が失敗する (= 決済が通らない)。
//
// 料金スケジュールは gasMode で選択される (確定モデル 2026-06-12):
//   merchant (決済 /pay・/checkout・レジ): 店舗が常に手数料を吸収する固定モデル。
//     feeValue = max(floor, billAmount × bps / 10000) [BigInt floor 除算]
//       - floor = relayGasFeeValue() = ガス相当のフロア (常に徴収・NEXT_PUBLIC_RELAY_GAS_FEE_JPYC・
//         既定 2 JPYC)。小口決済はこのフロアのみ (= 従来挙動)。
//       - bps    = サービス手数料率 (basis points・NEXT_PUBLIC_RECOVER_FEE_BPS・既定 0 = opt-in)。
//   customer (チップ /tip・@handle): チッパーが「チップ + フロア (= ガス相当・約 2 JPYC)」を負担。
//     feeValue = floor (= フラットなガス相当のみ)。bps は **適用しない** (7 月に bps=100 に
//     なっても チップはフロアのまま 1% を乗せない・確定モデル)。
//
// **既定 (bps=0) では merchant/customer いずれも feeValue == floor (= 固定 2 JPYC) になり、
//   billAmount に依らず現行挙動と完全一致する → このモジュールは inert で出荷される。**
//   operator が bps を設定したとき *決済 (merchant)* のみ大口で 1% (等) が乗り、チップ
//   (customer) はフロアのまま。
//
// gasMode の安全性: gasMode は EIP-712 署名対象ではない (= unsigned hint) が、その偽造は
// 有界である。'customer' を主張する payload も少なくともフロア (= floor) を払い、署名済の
// 分割 (merchantValue/feeValue・nonce にコミット) は forwarderRecover が強制する。既知の残余
// リスクは「店主がチップリンク経由で売上を流して 1% を回避する」経路だが、現在の規模では許容
// (全 settle は on-chain で監査可能)。client/server は同一 payload の gasMode を鍵に同式で
// feeValue を再計算するため nonce が一致する (両者がずれない)。
//
// import 注意: forwarderConfig は recoverFee を import しない (relayGasFeeValue は floor 提供側)。
// env も recoverFee を import しない (recoverFee → env の単方向のみ・循環なし)。

import { env } from '@/lib/env';
import { relayGasFeeValue } from '@/lib/relay/forwarderConfig';
import type { GasMode } from '@/lib/fee';

// サービス手数料率 (basis points)。NEXT_PUBLIC_RECOVER_FEE_BPS。既定 0 (= ガス回収のみ / 現行挙動)。
export function recoverFeeBps(): number {
  return env.recoverFeeBps;
}

// per-tx recover 手数料。gasMode で料金スケジュールを選ぶ (client & server が同 gasMode で同式
// 算出する = nonce 一致の必須条件)。BigInt の floor 除算 (端数切り捨て)。
//   merchant (決済): max(ガスフロア, billAmount × bps/10000) — 大口は bps が乗る。
//   customer (チップ): フロアのみ (bps を無視・フラットなガス相当)。
export function recoverFeeValue(billAmount: bigint, gasMode: GasMode): bigint {
  const floor = relayGasFeeValue();
  // チップ (customer 固定) は bps を適用しない: 常にフラットなガス相当フロア。
  if (gasMode === 'customer') return floor;
  const pct = (billAmount * BigInt(recoverFeeBps())) / 10000n;
  return pct > floor ? pct : floor;
}
