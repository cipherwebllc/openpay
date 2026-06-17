'use client';

// 決済成功時の PayPay 風 大型 overlay (SuccessOverlay) の「描画するか / どの値で出すか」を
// 1 箇所に集約した薄いラッパ (Phase 1.4)。PaymentForm / CheckoutForm / TipForm がそれぞれ
// gasless / relay / standard の各経路ごとに `{!overlayDismissed && <経路ガード> && <SuccessOverlay .../>}`
// を 3 連 (tip は 1) で複製していたのを、mode 中立に正規化した overlay payload 1 個 + dismissed
// フラグへ寄せる。
//
// 各 form 側で経路に応じた payload (= 表示額 / 各 hash / block / explorer / 店舗アドレス) を
// 解決して渡し、未成功 (txHash 無し等) のときは payload=null にする。描画条件・SuccessOverlay へ
// 渡す props は従来と byte 一致 (relay は userOpHash/blockNumber を省く = undefined、standard は
// userOpHash を省く、tip は merchantAddress を省く — いずれも payload に該当フィールドを載せない
// ことで再現する)。
//
// SuccessOverlay は従来どおり next/dynamic (ssr:false) で遅延ロードする (bundle 予算)。各 form は
// 個別に dynamic import していたが、本ラッパ内に 1 度だけ集約する。ラッパ自身は描画選択のみで
// 重い依存を持たないため、各 form は静的 import して良い (SuccessOverlay の重いグラフは dynamic
// chunk に残る = First Load JS は不変)。

import dynamic from 'next/dynamic';

const SuccessOverlay = dynamic(
  () => import('./SuccessOverlay').then((m) => m.SuccessOverlay),
  { ssr: false },
);

/**
 * mode 中立に正規化した overlay 表示 payload。各経路の差異 (relay は userOpHash/blockNumber 無し、
 * standard は userOpHash 無し、tip は merchantAddress 無し) は該当フィールドを省く (undefined) ことで
 * 表現し、SuccessOverlay 側の「undefined なら行を省く」挙動でそのまま再現する。
 */
export type PaymentSuccessOverlayPayload = {
  /** 巨大表示する支払額 (各 form が fmt 済の文字列。tip は submit 時点の固定値)。 */
  amountDisplay: string;
  txHash: string;
  userOpHash?: string;
  blockNumber?: bigint;
  explorerBase?: string;
  merchantAddress?: string;
  /** 受注番号 (受け渡し照合用)。checkout で order_id があるときのみ。無ければ行を省く。 */
  orderNo?: string;
};

export function PaymentSuccessOverlay({
  dismissed,
  payload,
  onDismiss,
}: {
  /** ユーザが 1 度閉じたか (閉じたら以降は inline panel のみ)。 */
  dismissed: boolean;
  /** 成功時の正規化 payload。未成功 (txHash 未確定等) のときは null で何も描画しない。 */
  payload: PaymentSuccessOverlayPayload | null;
  onDismiss: () => void;
}) {
  if (dismissed || !payload) return null;
  return (
    <SuccessOverlay
      amountDisplay={payload.amountDisplay}
      txHash={payload.txHash}
      userOpHash={payload.userOpHash}
      blockNumber={payload.blockNumber}
      explorerBase={payload.explorerBase}
      merchantAddress={payload.merchantAddress}
      orderNo={payload.orderNo}
      onDismiss={onDismiss}
    />
  );
}
