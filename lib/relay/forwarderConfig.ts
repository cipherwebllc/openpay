// JPYC recover モード (forwarder で gas 相当額を JPYC 回収) の config。client と server が
// "同じ値" を読む必要があるため NEXT_PUBLIC で共有する (client は nonce-commit を組み、server は
// 受信値を信用せず一致を強制する)。forwarder アドレスが chain に設定されていれば recover モード、
// 無ければ free モード (Phase A・OpenPay がガス負担)。詳細は memory:gasless-legal-jp / jpyc-eip3009。

import { isAddress, getAddress, type Address } from 'viem';
import { polygon, polygonAmoy, kaia, kairos } from 'viem/chains';
import { env } from '@/lib/env';

// deploy 済 Eip3009Forwarder アドレス (chain 別)。未設定 = その chain は free モード。NEXT_PUBLIC は
// build 時に inline されるため、リテラル参照を module 直下の table に置いても挙動は同じ (chain 追加が 1 行)。
const FORWARDER_ADDRESS_ENV: Record<number, string | undefined> = {
  [polygon.id]: process.env.NEXT_PUBLIC_JPYC_FORWARDER_POLYGON,
  [polygonAmoy.id]: process.env.NEXT_PUBLIC_JPYC_FORWARDER_AMOY,
  [kaia.id]: process.env.NEXT_PUBLIC_JPYC_FORWARDER_KAIA,
  [kairos.id]: process.env.NEXT_PUBLIC_JPYC_FORWARDER_KAIROS,
};

// 設定された (= 生の env) forwarder アドレス。a1 を考慮しない素の値で、起動時の運営向け
// 診断 (route.ts の misconfig 警告) でのみ使う。決済経路の判定には jpycForwarderFor を使うこと。
export function configuredJpycForwarderFor(chainId: number): Address | null {
  const raw = FORWARDER_ADDRESS_ENV[chainId];
  return raw && isAddress(raw) ? getAddress(raw) : null;
}

// a1 利用料 (env.enableUsageFee) と recover は排他: recover 経路は a1 のゲート/メーターを
// 迂回するため両立できない。a1 を優先し、a1 が ON のときは *実効* forwarder を全箇所で null に
// 倒す → client は free payload を組み、server は free モード (a1 ゲート+メーター付き) で処理する。
// これにより client/server が payload 形で食い違うことがなく、致命的な 503 も不要になる。
// configuredJpycForwarderFor は生の値で、運営向けの起動時診断にのみ使う。
export function jpycForwarderFor(chainId: number): Address | null {
  if (env.enableUsageFee) return null;
  return configuredJpycForwarderFor(chainId);
}

// 顧客から JPYC で回収する gas 相当額 (atomic・18 decimals)。固定の開示バッファ (Polygon の
// sub-cent gas を十分賄う)。既定 2 JPYC。NEXT_PUBLIC で client/server 共有 (nonce 一致のため)。
//
// フロアは 1 wei 以上を保証する (CDX-2)。Eip3009Forwarder.settle は feeValue==0 で ZeroValue revert
// するため、NEXT_PUBLIC_RELAY_GAS_FEE_JPYC=0 (誤設定) を素通りさせると recover が「必ず revert する tx」
// を broadcast し relayer の gas を捨てる (false flow)。0 が来たら誤設定とみなし既定 2 JPYC に倒す
// (一度だけ warn)。recoverFeeValue (merchant/customer 双方) はこのフロアを下限に使うため、フロアが
// 1 wei 以上である限り expectedFeeValue も 0 にならない。
let relayGasFeeFloorWarned = false;
export function relayGasFeeValue(): bigint {
  const raw = process.env.NEXT_PUBLIC_RELAY_GAS_FEE_JPYC;
  if (raw !== undefined && /^[0-9]+$/.test(raw) && BigInt(raw) === 0n) {
    // 0 は contract が ZeroValue で必ず revert する誤設定。既定フロアへ倒して保護する。
    if (!relayGasFeeFloorWarned) {
      relayGasFeeFloorWarned = true;
      console.warn(
        'NEXT_PUBLIC_RELAY_GAS_FEE_JPYC=0 は recover の guaranteed-revert (Eip3009Forwarder ZeroValue) を招くため、既定の 2 JPYC フロアに倒しました。',
      );
    }
    return 2n * 10n ** 18n;
  }
  const human = raw && /^[0-9]+$/.test(raw) ? BigInt(raw) : 2n;
  return human * 10n ** 18n;
}
