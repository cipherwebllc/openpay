// x402 facilitator の手数料計算。resource server (requirements 生成) と facilitator
// (/verify・/settle の server 権威照合) が **同一式** で feeValue を求める必要がある:
// feeValue は EIP-3009 の nonce (分割コミットメント・lib/relay/forwarderIntent.buildForwarderNonce)
// に焼き込まれるため、両者がずれると署名検証が失敗する。
//
// 既存 recover (lib/relay/recoverFee.ts) と同型だが、x402 は常に「率スケジュール」
// (gasMode の customer/merchant 区別なし) で、料率/floor は x402FacilitatorConfig から取る。
// 買い手上乗せモデル: 買い手は merchantValue(=price)+feeValue を署名し、seller は price を、
// feeReceiver は fee を受領する。

import { x402FacilitatorConfig } from './facilitatorConfig';

// price (atomic JPYC wei) に対する x402 手数料 = max(floor, price × bps/10000)。
// price<=0 は 0 を返す (呼び元が price>0 を別途必須化する)。BigInt の floor 除算 (端数切り捨て)。
export function x402FeeValue(priceWei: bigint): bigint {
  if (priceWei <= 0n) return 0n;
  const { feeBps, feeFloorWei } = x402FacilitatorConfig;
  const pct = (priceWei * BigInt(feeBps)) / 10000n;
  return pct > feeFloorWei ? pct : feeFloorWei;
}

export type X402FeeBreakdown = {
  merchantValue: bigint; // = price (seller 受領)
  feeValue: bigint; // = x402FeeValue(price) (feeReceiver 受領)
  total: bigint; // = merchantValue + feeValue (買い手が署名する総額)
};

// price から分割内訳を一括算出する単一情報源。requirements 生成 / verify / settle / receipt が共用する。
export function x402FeeBreakdown(priceWei: bigint): X402FeeBreakdown {
  const merchantValue = priceWei;
  const feeValue = x402FeeValue(priceWei);
  return { merchantValue, feeValue, total: merchantValue + feeValue };
}
