// モバイル注文システム利用料の純ロジック (client/server 共有・決定論)。
//
// gas-recovery 料金 (lib/relay/recoverFee.ts) とは **別物**: モバイル注文という付加価値システム
// (店舗ページ・メニュー・注文管理・受注リレー) の利用料であり、決済経路 (relay/standard) に依存
// せず一律 % を頂く。よって gas を肩代わりしない standard 経路でも素通りしない。料金根拠は
// 「gas 肩代わりの対価」ではなく「本サービス (モバイル注文) 利用の対価」(開示は lib/legal.ts)。
//
// 料率はユーザ仕様で **一律** (フロア無し):
//   storefront (店頭/券売機)         = 1% ・常に店舗負担
//   preorder   (事前モバイルオーダー) = 3% ・feePayer で 店舗負担/顧客上乗せ を選択
//
// 決定論が要件: recover 経路では feeValue が EIP-3009 署名の nonce にコミットされるため、
// client (useJpycEip3009Payment) と server (handleRecover) が **同一式** で feeValue を求めないと
// 署名検証が落ちる。よってここは KV/handle に依存しない純関数 (= サーバは feeKind だけを受け取り
// 定数表から % を再計算する → client が率を下げられない・サーバ権威)。
//
// flag ゲートは **呼び出し側** で行う (env.enableMobileOrderFee)。本モジュールは純数学に徹し、
// flag OFF のときは呼び出し側 (CheckoutForm / MobileOrderView / handleRecover / useRelayGaslessSnapshot)
// がそもそもこの経路に入らない → 本番完全 inert。これにより単体テストが env を介さず率を直接検証できる。

import type { GasMode } from './fee';
import type { FeePayer, MobileOrderMode } from './mobileOrder';

// 料率 (basis points)。店頭/券売機 = 1%、事前モバイルオーダー = 3% (一律)。
export const STOREFRONT_FEE_BPS = 100; // 1%
export const PREORDER_FEE_BPS = 300; // 3%
const BPS_DENOM = 10_000n;

// 料金の種別 = 店舗モード (storefront=店頭1% / preorder=事前3%)。checkout URL に載せ、server が
// 定数表から率を再計算する (client 申告の率は信用しない)。MobileOrderMode と同一値域 (単一情報源)。
export type MobileOrderFeeKind = MobileOrderMode;
export type { FeePayer };

export function isMobileOrderFeeKind(v: unknown): v is MobileOrderFeeKind {
  return v === 'storefront' || v === 'preorder';
}

export function mobileOrderFeeBps(kind: MobileOrderFeeKind): number {
  return kind === 'preorder' ? PREORDER_FEE_BPS : STOREFRONT_FEE_BPS;
}

/**
 * 注文額 (wei) からシステム利用料 (wei) を算出。**純関数・フロア無し** (一律 %)。
 * BigInt 床除算。orderWei<=0 は 0n。極小注文で 1% が立替 gas を下回る差は OpenPay が飲む
 * (= 開示「一律 1%/3%」を正直に保つ)。flag ゲートは呼び出し側。
 */
export function mobileOrderFeeValue(
  orderWei: bigint,
  kind: MobileOrderFeeKind,
): bigint {
  if (orderWei <= 0n) return 0n;
  return (orderWei * BigInt(mobileOrderFeeBps(kind))) / BPS_DENOM;
}

/**
 * 負担者 → gasMode。storefront は常に店舗負担 (merchant)。preorder は feePayer で分岐
 * (merchant=店舗負担 / customer=顧客上乗せ)。recover (forwarder.settle) / standard (2tx) 双方の
 * split を駆動する gasMode の単一情報源。既存 gasMode 意味論 (lib/fee 参照) と一致:
 *   merchant: 顧客は表示額ちょうど・店舗が受取から手数料を吸収
 *   customer: 顧客が手数料を上乗せ・店舗は満額受領
 */
export function mobileOrderGasMode(
  kind: MobileOrderFeeKind,
  feePayer: FeePayer | undefined,
): GasMode {
  if (kind === 'preorder' && feePayer === 'customer') return 'customer';
  return 'merchant';
}

export type MobileOrderBreakdown = {
  customerPays: bigint;
  merchantReceives: bigint;
  /** システム利用料 (= feeReceiver へ分割される額)。gas ではなくサービス利用料。 */
  feeAmount: bigint;
};

/**
 * 経路非依存の breakdown。relay でも standard でも **同一の分割**。feeAmount はシステム利用料
 * (gas ではない) として返す → 履歴/CSV/控えで会計ラベルが自然に正しくなる。
 *   店舗負担 (merchant): 客=order,      店舗=order-fee, fee=fee
 *   顧客上乗せ (customer): 客=order+fee, 店舗=order,     fee=fee
 *
 * 注: lib/fee.calcBreakdown は standard モードで gasAmount を無視する設計のため、システム利用料を
 * gas 項に載せると standard で消える。よってモバイル注文は本関数で経路非依存に分割を確定し、
 * CheckoutForm 側で paymentBreakdown を **置換** する。
 */
export function mobileOrderBreakdown(
  orderWei: bigint,
  kind: MobileOrderFeeKind,
  feePayer: FeePayer | undefined,
): MobileOrderBreakdown {
  const fee = mobileOrderFeeValue(orderWei, kind);
  const gasMode = mobileOrderGasMode(kind, feePayer);
  if (gasMode === 'customer') {
    return {
      customerPays: orderWei + fee,
      merchantReceives: orderWei,
      feeAmount: fee,
    };
  }
  return {
    customerPays: orderWei,
    merchantReceives: orderWei > fee ? orderWei - fee : 0n,
    feeAmount: fee,
  };
}
