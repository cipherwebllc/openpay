// 「お店の端末で送る」(レジ・plans/store-gas-wallet.md) の共有定数と純関数 (client / server 共通)。
//
// 呼び名: コード・計画・テストでは仕組みの名前「お店の端末で送る」(store device / store-device・handoff) を使う。
// 店員に見せる名前は「お店がガス代を肩代わりして送る」(messages RegisterMode.storeDevice・2026-10-07 user 裁定)。
// どちらも同じ機能 = お客様は署名だけ、レジ端末のガス用ウォレット (POL・KAIA・AVAX) がガス代を払って送る、OpenPay 利用料 0 円
// (仕組み上 1 wei)。今の既定のガスレス (OpenPay の中継がガス代を払い、利用料 1%・最低 2 JPYC) とは別の選択肢。
//
// お客様は今の回収モードと同じ形 (ReceiveWithAuthorization・to = 既存 forwarder・nonce = commit) に署名し、
// 手数料欄だけ 1 wei にする (お客様の送金に上乗せ・店の受取 = 請求額ちょうど)。お店の端末のガス用ウォレットが
// forwarder.settle を自分のガスで呼ぶ。OpenPay は署名を短時間受け渡すだけで、送信もガスもしない。

import { formatUnits, getAddress, isAddress, type Address } from 'viem';
import { avalanche, avalancheFuji, kaia, kairos, polygon, polygonAmoy } from 'viem/chains';
import { env } from './env';
import { JPYC_CHAINS, chainNameForId, slugForChain } from './chains';
import { DISCLOSED_STORE_GAS_WALLET } from './disclosedStoreGasWallet';
import { jpycForwarderFor } from './relay/forwarderConfig';
import { resolveDeployment } from './tokens';

/** 手数料欄 (forwarder は feeValue == 0 を拒否するので最小単位の 1 wei)。お客様の送金に上乗せする。 */
export const STORE_DEVICE_FEE_WEI = 1n;

/**
 * 受け渡しできる最低額 (1 JPYC)。モバイル注文手数料はフロアなしの床除算なので、極小額だと期待手数料が
 * 1 wei になり、同じ署名が OpenPay の中継 (/api/relay/jpyc) を通ってしまう (OpenPay がガスを払う)。
 * 1 JPYC 以上なら、中継側の期待手数料は必ず 1 wei より大きく fee_value_mismatch で拒否される。
 */
export const STORE_DEVICE_MIN_AMOUNT_WEI = 10n ** 18n;

/** お客様の署名の有効窓 (秒)。対面のレジなので短く (既定の中継 300 秒より短い)。 */
export const STORE_DEVICE_VALIDITY_SEC = 150;

/** サーバが受け付ける署名の有効窓の上限 (秒・時計のずれの余裕込み)。 */
export const STORE_DEVICE_MAX_VALIDITY_SEC = 180;

/** サーバが署名を預かるのに要る残り時間 (秒)。端末の読み取り間隔 (最大 6 秒) と送信の余裕を見込む。 */
export const STORE_DEVICE_MIN_CLAIM_REMAINING_SEC = 60;

/** 端末が送らない残り時間 (秒)。ブロック時刻とのずれで期限切れの revert にガスを払わない。 */
export const STORE_DEVICE_MIN_REMAINING_SEC = 15;

/** 受け渡しセッションの寿命 (秒)。 */
export const STORE_HANDOFF_TTL_SEC = 600;

// --- チェーン (plans/store-gas-wallet.md §20) ---
// 使えるチェーンは開示の SOT (lib/disclosedStoreGasWallet.ts の chainIds) から導く: mainnet は開示したチェーンのうち
// 設定がそろったものだけ (= チェーンを増やす開示の merge がそのまま点灯)。testnet は対応する testnet を全部 (公開の
// 約束ではないため・実機確認用)。どのチェーンで送るかは会計 (受け渡しセッション・送った印) が持ち、端末の状態は 1 つ。

/** mainnet のチェーンに対応する testnet。 */
const TESTNET_FOR: Readonly<Record<number, number>> = {
  [polygon.id]: polygonAmoy.id,
  [kaia.id]: kairos.id,
  [avalanche.id]: avalancheFuji.id,
};

export type StoreDeviceChainConfig = {
  chainId: number;
  token: Address;
  forwarder: Address;
  feeReceiver: Address;
};

/**
 * このチェーンで送るための値 (JPYC・forwarder・手数料受取口)。いまのネットワーク (mainnet / testnet) の JPYC
 * チェーンで、どれもそろっているときだけ。開示の集合とは別 (送った支払いの結果の確認は、開示から外したチェーンでも続ける)。
 */
export function storeDeviceChainConfig(chainId: number): StoreDeviceChainConfig | null {
  const slug = slugForChain(chainId);
  if (!slug || !(JPYC_CHAINS as readonly string[]).includes(slug)) return null;
  const deployment = resolveDeployment('jpyc', chainId);
  const forwarder = jpycForwarderFor(chainId);
  const feeReceiver = isAddress(env.feeReceiver ?? '') ? getAddress(env.feeReceiver as string) : null;
  if (!deployment || deployment.chainId !== chainId || !forwarder || !feeReceiver) return null;
  return { chainId, token: deployment.address, forwarder, feeReceiver };
}

/** 新しい会計 (受け渡しの作成) に使えるチェーン。mainnet = 開示したチェーン ∩ 設定済み・testnet = 対応 testnet ∩ 設定済み。 */
export function storeDeviceChainIds(): number[] {
  const candidates =
    env.networkEnv === 'mainnet' ? [...DISCLOSED_STORE_GAS_WALLET.chainIds] : Object.values(TESTNET_FOR);
  return candidates.filter((id) => storeDeviceChainConfig(id) !== null);
}

export function isStoreDeviceChain(chainId: number): boolean {
  return storeDeviceChainIds().includes(chainId);
}

/** 状態の表示に出す請求額 (wei の 10 進文字列)。JPYC v3 はどのチェーンでも 18 桁。 */
export function formatStoreDeviceAmount(wei: string): string {
  return `${formatUnits(BigInt(wei), 18)} JPYC`;
}

/** 画面の案内に出すチェーン名の並び (例: 「Polygon・Kaia・Avalanche」)。 */
export function storeDeviceChainNames(chainIds: readonly number[], separator = '・'): string {
  return chainIds.map((id) => chainNameForId(id) ?? String(id)).join(separator);
}

/** 受け渡しセッション id (16 byte を base64url = 22 文字)。 */
export const STORE_HANDOFF_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function isStoreHandoffId(value: unknown): value is string {
  return typeof value === 'string' && STORE_HANDOFF_ID_PATTERN.test(value);
}

/** 端末だけが持つ読み取りトークン (32 byte hex)。ヘッダで渡す (URL に載せない)。 */
export const STORE_HANDOFF_TOKEN_HEADER = 'x-store-handoff-token';
export const STORE_HANDOFF_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/** 受け渡しできる金額か (最低 1 JPYC・上限は呼び出し側の中継上限)。 */
export function isStoreDeviceAmount(amountWei: bigint, maxWei: bigint): boolean {
  return amountWei >= STORE_DEVICE_MIN_AMOUNT_WEI && amountWei <= maxWei;
}

/** 端末が settle に使うガスの上限 (relayer と同じ・実測 約 25〜30 万)。見積 × 1.2 がこれを超えたら送らない。 */
export const STORE_DEVICE_SETTLE_GAS_CAP = 500_000n;

/**
 * 1 回の送信のガス代の上限 (ネイティブ通貨・チェーンごと)。超えたら送らない。ガス上限 50 万 × 想定の最高単価:
 * Polygon 0.2 POL (サーバの RELAY_MAX_GAS_COST_WEI の本番値と同じ)・Kaia 0.5 KAIA (base fee 上限 750 gkei)・
 * Avalanche 0.05 AVAX (100 nAVAX)。表に無いチェーンは送らない (集合の導出とずれたまま黙って送らない)。
 */
const MAX_GAS_COST_WEI: Readonly<Record<number, bigint>> = {
  [polygon.id]: 2n * 10n ** 17n,
  [polygonAmoy.id]: 2n * 10n ** 17n,
  [kaia.id]: 5n * 10n ** 17n,
  [kairos.id]: 5n * 10n ** 17n,
  [avalanche.id]: 5n * 10n ** 16n,
  [avalancheFuji.id]: 5n * 10n ** 16n,
};

export function storeDeviceMaxGasCostWei(chainId: number): bigint | null {
  return MAX_GAS_COST_WEI[chainId] ?? null;
}

/** 署名の期限の上限を確かめるときの時計のずれの余裕 (秒)。 */
export const STORE_DEVICE_CLOCK_SKEW_SEC = 30;

/**
 * QR を見せてよいセッションの残り (秒)。お客様の署名窓 (150 秒) と、サーバが預かる最低残り (60 秒) が
 * 収まらないセッションの QR は読ませない (読んでも「期限が切れています」になる)。
 */
export const STORE_DEVICE_QR_MIN_REMAINING_SEC =
  STORE_DEVICE_VALIDITY_SEC + STORE_DEVICE_MIN_CLAIM_REMAINING_SEC;
