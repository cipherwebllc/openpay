// /checkout の送信後の pending / unknown と同一 payload の復旧時だけ必要な UI (PaymentStatusPanel) を First Load JS
// から外す。状態判定・再送封鎖・retry handler の選択は親 (CheckoutForm) に残す。
//
// CheckoutForm と、そこから切り出した表示だけの部品 (./RelayStatusBanners) が同じ wrapper を使うよう、ここに 1 つだけ置く
// (第 9 回レビュー F-04)。next/dynamic の読み込みの状態は wrapper ごとに持つので、部品の側で別に dynamic() を呼ぶと、
// ページの別の枠ですでに読み込んだあとでも部品の枠だけ 1 tick 遅れて出る (切り出しの前は同じ render で出ていた)。

import dynamic from 'next/dynamic';

export const PaymentStatusPanel = dynamic(
  () =>
    import('../PaymentStatusPanel').then((m) => m.PaymentStatusPanel),
  { ssr: false },
);
