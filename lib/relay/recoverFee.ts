// recover (forwarder) モードの per-tx 手数料計算。client (useJpycEip3009Payment) と
// server (handleRecover の expectedFeeValue) が **同一式** で feeValue を求める必要がある:
// feeValue は EIP-3009 の nonce (分割コミットメント・lib/relay/forwarderIntent.buildForwarderNonce)
// に焼き込まれるため、両者がずれると on-chain 署名検証が失敗する (= 決済が通らない)。
//
// feeValue = max(floor, billAmount × bps / 10000) [BigInt floor 除算]
//   - floor = relayGasFeeValue() = ガス立替の回収フロア (常に徴収・NEXT_PUBLIC_RELAY_GAS_FEE_JPYC・
//     既定 2 JPYC)。小口決済はこのフロアのみ (= 従来挙動)。
//   - bps    = サービス手数料率 (basis points・NEXT_PUBLIC_RECOVER_FEE_BPS・既定 0 = opt-in)。
//
// **既定 (bps=0) では feeValue == floor (= 固定 2 JPYC) になり、billAmount/gasMode に依らず
//   現行挙動と完全一致する → このモジュールは inert で出荷される。** operator が bps を設定した
//   ときだけ大口で 1% (等) が乗る。手数料を顧客上乗せ/店舗吸収のどちらにするかは決済 form の
//   gasMode トグルが決める (このモジュールは「いくら徴収するか」だけを司る・誰が負担するかは別)。
//
// import 注意: forwarderConfig は recoverFee を import しない (relayGasFeeValue は floor 提供側)。
// env も recoverFee を import しない (recoverFee → env の単方向のみ・循環なし)。

import { env } from '@/lib/env';
import { relayGasFeeValue } from '@/lib/relay/forwarderConfig';

// サービス手数料率 (basis points)。NEXT_PUBLIC_RECOVER_FEE_BPS。既定 0 (= ガス回収のみ / 現行挙動)。
export function recoverFeeBps(): number {
  return env.recoverFeeBps;
}

// per-tx recover 手数料 = max(ガスフロア, billAmount × bps/10000)。client & server が同式で算出する
// (nonce 一致の必須条件)。BigInt の floor 除算 (端数切り捨て)。
export function recoverFeeValue(billAmount: bigint): bigint {
  const floor = relayGasFeeValue();
  const pct = (billAmount * BigInt(recoverFeeBps())) / 10000n;
  return pct > floor ? pct : floor;
}
