// 「お店の端末で送る」(レジ・plans/store-gas-wallet.md) の共有定数と純関数 (client / server 共通)。
//
// お客様は今の回収モードと同じ形 (ReceiveWithAuthorization・to = 既存 forwarder・nonce = commit) に署名し、
// 手数料欄だけ 1 wei にする (お客様の送金に上乗せ・店の受取 = 請求額ちょうど)。お店の端末のガス用ウォレットが
// forwarder.settle を自分のガスで呼ぶ。OpenPay は署名を短時間受け渡すだけで、送信もガスもしない。

import { polygon, polygonAmoy } from 'viem/chains';
import { env } from './env';

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

/** 対応チェーン (Polygon と testnet の Amoy だけ)。 */
export const STORE_DEVICE_CHAIN_IDS: readonly number[] = [polygon.id, polygonAmoy.id];

export function isStoreDeviceChain(chainId: number): boolean {
  return STORE_DEVICE_CHAIN_IDS.includes(chainId);
}

/** この環境で使うチェーン (mainnet = Polygon・testnet = Amoy)。鍵の生成コードを読み込まずに済む軽い版。 */
export function storeDeviceChainId(): number {
  return env.networkEnv === 'mainnet' ? polygon.id : polygonAmoy.id;
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
