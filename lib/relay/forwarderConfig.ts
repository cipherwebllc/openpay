// JPYC recover モード (forwarder で gas 相当額を JPYC 回収) の config。client と server が
// "同じ値" を読む必要があるため NEXT_PUBLIC で共有する (client は nonce-commit を組み、server は
// 受信値を信用せず一致を強制する)。forwarder アドレスが chain に設定されていれば recover モード、
// 無ければ free モード (Phase A・OpenPay がガス負担)。詳細は memory:gasless-legal-jp / jpyc-eip3009。

import { isAddress, getAddress, type Address } from 'viem';
import { polygon, polygonAmoy } from 'viem/chains';

// deploy 済 Eip3009Forwarder アドレス (chain 別)。未設定 = その chain は free モード。
export function jpycForwarderFor(chainId: number): Address | null {
  const raw =
    chainId === polygon.id
      ? process.env.NEXT_PUBLIC_JPYC_FORWARDER_POLYGON
      : chainId === polygonAmoy.id
        ? process.env.NEXT_PUBLIC_JPYC_FORWARDER_AMOY
        : undefined;
  return raw && isAddress(raw) ? getAddress(raw) : null;
}

// 顧客から JPYC で回収する gas 相当額 (atomic・18 decimals)。固定の開示バッファ (Polygon の
// sub-cent gas を十分賄う)。既定 2 JPYC。NEXT_PUBLIC で client/server 共有 (nonce 一致のため)。
export function relayGasFeeValue(): bigint {
  const raw = process.env.NEXT_PUBLIC_RELAY_GAS_FEE_JPYC;
  const human = raw && /^[0-9]+$/.test(raw) ? BigInt(raw) : 2n;
  return human * 10n ** 18n;
}
