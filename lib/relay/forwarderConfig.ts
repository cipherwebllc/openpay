// JPYC recover モード (forwarder で gas 相当額を JPYC 回収) の config。client と server が
// "同じ値" を読む必要があるため NEXT_PUBLIC で共有する (client は nonce-commit を組み、server は
// 受信値を信用せず一致を強制する)。forwarder アドレスが chain に設定されていれば recover モード、
// 無ければ free モード (Phase A・OpenPay がガス負担)。詳細は memory:gasless-legal-jp / jpyc-eip3009。

import { isAddress, getAddress, type Address } from 'viem';
import {
  polygon,
  polygonAmoy,
  kaia,
  kairos,
  avalanche,
  avalancheFuji,
  mainnet,
} from 'viem/chains';
import { env } from '@/lib/env';

// deploy 済 Eip3009Forwarder アドレス (chain 別)。未設定 = その chain は free モード。NEXT_PUBLIC は
// build 時に inline されるため、リテラル参照を module 直下の table に置いても挙動は同じ (chain 追加が 1 行)。
const FORWARDER_ADDRESS_ENV: Record<number, string | undefined> = {
  [polygon.id]: process.env.NEXT_PUBLIC_JPYC_FORWARDER_POLYGON,
  [polygonAmoy.id]: process.env.NEXT_PUBLIC_JPYC_FORWARDER_AMOY,
  [kaia.id]: process.env.NEXT_PUBLIC_JPYC_FORWARDER_KAIA,
  [kairos.id]: process.env.NEXT_PUBLIC_JPYC_FORWARDER_KAIROS,
  // Avalanche は recover-required (forwarder 未設定なら gasless 非提供=standard へ倒す)。
  // tokens.ts の paymasterMode 計算がこの値の有無で gasless 可否を決める。
  [avalanche.id]: process.env.NEXT_PUBLIC_JPYC_FORWARDER_AVALANCHE,
  [avalancheFuji.id]: process.env.NEXT_PUBLIC_JPYC_FORWARDER_FUJI,
};

// recover-required chain: free モード (OpenPay relayer が native gas を全額負担) を **禁止** する chain。
// native が高価で free relay が赤字になるため、forwarder 設定済 (recover) でなければ relay せず standard
// へ倒す。⚠️ これは flag に依存しない server 権威の安全策: client ゲート (paymasterMode) を迂回する
// 直接 POST でも、route が isRecoverRequiredChain() で free を拒否する。Set は impl 詳細として非公開にし、
// 判定は必ず述語経由に統一する (route/relayProvider 共通)。
//   - Avalanche/Fuji: forwarder を設定すれば gasless (recover) になる。
//   - Ethereum L1 (mainnet): L1 ガスは高変動で gasless recover が不経済なため forwarder を **意図的に
//     設けない** (FORWARDER_ADDRESS_ENV に ethereum entry なし → jpycForwarderFor=null 固定 →
//     paymasterMode='unavailable' → standard 強制)。recover-required 集合に入れることで、万一の直接
//     relay POST も 503 で弾く (free relay で OpenPay が ETH を持ち出さない)。
const RECOVER_REQUIRED_CHAINS: ReadonlySet<number> = new Set([
  avalanche.id,
  avalancheFuji.id,
  mainnet.id, // Ethereum L1 = standard 固定 (forwarder 永久未設定)
]);

/** chainId が recover-required (free モード禁止) か。route / relayProvider 共通の単一判定点。 */
export function isRecoverRequiredChain(chainId: number): boolean {
  return RECOVER_REQUIRED_CHAINS.has(chainId);
}

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

// 顧客から JPYC で回収する gas 相当額 (atomic・18 decimals) の **chain 別** フロア。チェーンごとに
// native gas の価値が桁違い (POL/KAIA ~$0.1〜0.5 vs AVAX ~$15〜40) のため、ガス相当を賄うフロアも
// chain 別に決める (チップ=フロアのみ・決済=max(フロア, 1%))。既定 2 JPYC (Polygon の sub-cent gas を
// 十分賄う)。NEXT_PUBLIC で client/server 共有 (feeValue は nonce にコミットされ、両者が同一 chainId で
// 同式算出する必要がある — chainId は EIP-3009 署名にも焼き込まれるため改竄は署名検証失敗で fail-safe)。
//
// per-chain floor 上書き env。⚠️ NEXT_PUBLIC は build 時に **リテラル参照のみ** inline されるため、
// 動的キー (process.env['NEXT_PUBLIC_'+slug]) ではなく静的テーブルで列挙する (FORWARDER_ADDRESS_ENV と
// 同型)。未設定 = 下位段 (per-chain 既定 → グローバル env → 2) へフォールバック。
const PER_CHAIN_FLOOR_ENV: Record<number, string | undefined> = {
  [polygon.id]: process.env.NEXT_PUBLIC_RELAY_GAS_FEE_JPYC_POLYGON,
  [kaia.id]: process.env.NEXT_PUBLIC_RELAY_GAS_FEE_JPYC_KAIA,
  [avalanche.id]: process.env.NEXT_PUBLIC_RELAY_GAS_FEE_JPYC_AVALANCHE,
  [polygonAmoy.id]: process.env.NEXT_PUBLIC_RELAY_GAS_FEE_JPYC_AMOY,
  [kairos.id]: process.env.NEXT_PUBLIC_RELAY_GAS_FEE_JPYC_KAIROS,
  [avalancheFuji.id]: process.env.NEXT_PUBLIC_RELAY_GAS_FEE_JPYC_FUJI,
};

// per-chain 既定フロア (human JPYC)。env 未設定時の chain 別ベースライン。**現状は空** = 全 chain が
// グローバル env か 2 にフォールバック → 挙動は per-chain 化前と完全一致 (inert)。Avalanche を relay
// チェーンに昇格する際 (Phase 2)、実測 gas の 2〜3× バッファで avalanche.id を追加する。
const PER_CHAIN_FLOOR_DEFAULT: Record<number, bigint> = {};

const DEFAULT_FLOOR_HUMAN = 2n;

// human JPYC 文字列 → atomic (18 decimals)。0 / 非数値 / 未設定は null を返し、呼び元が下位段へ
// フォールバックする。0 は Eip3009Forwarder.settle が feeValue==0 で ZeroValue revert する誤設定のため
// 採用しない (CDX-2: フロアは常に 1 wei 以上を保証)。
function parseHumanFloor(raw: string | undefined): bigint | null {
  if (raw === undefined || !/^[0-9]+$/.test(raw)) return null;
  const human = BigInt(raw);
  if (human === 0n) return null;
  return human * 10n ** 18n;
}

// chainId に対する gas 相当フロア。解決順:
//   1. per-chain env (NEXT_PUBLIC_RELAY_GAS_FEE_JPYC_<SLUG>)
//   2. per-chain 既定テーブル (PER_CHAIN_FLOOR_DEFAULT)
//   3. グローバル env (NEXT_PUBLIC_RELAY_GAS_FEE_JPYC・後方互換)
//   4. 既定 2 JPYC
// いずれの段でも 0 は採用せず次段へ倒す (ZeroValue revert 回避)。グローバル env=0 のときだけ従来どおり
// 一度 warn する (誤設定の可視化・後方互換)。recoverFeeValue (merchant/customer 双方) がこのフロアを
// 下限に使うため、フロアが 1 wei 以上である限り expectedFeeValue も 0 にならない。
let relayGasFeeFloorWarned = false;
export function relayGasFeeValue(chainId: number): bigint {
  const perChain = parseHumanFloor(PER_CHAIN_FLOOR_ENV[chainId]);
  if (perChain !== null) return perChain;

  const perChainDefault = PER_CHAIN_FLOOR_DEFAULT[chainId];
  if (perChainDefault !== undefined && perChainDefault > 0n) return perChainDefault;

  const globalRaw = process.env.NEXT_PUBLIC_RELAY_GAS_FEE_JPYC;
  if (
    globalRaw !== undefined &&
    /^[0-9]+$/.test(globalRaw) &&
    BigInt(globalRaw) === 0n
  ) {
    if (!relayGasFeeFloorWarned) {
      relayGasFeeFloorWarned = true;
      console.warn(
        'NEXT_PUBLIC_RELAY_GAS_FEE_JPYC=0 は recover の guaranteed-revert (Eip3009Forwarder ZeroValue) を招くため、既定の 2 JPYC フロアに倒しました。',
      );
    }
    return DEFAULT_FLOOR_HUMAN * 10n ** 18n;
  }
  const global = parseHumanFloor(globalRaw);
  if (global !== null) return global;

  return DEFAULT_FLOOR_HUMAN * 10n ** 18n;
}
