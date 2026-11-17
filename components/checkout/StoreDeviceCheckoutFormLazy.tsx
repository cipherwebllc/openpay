'use client';

// 「お店の端末で送る」の画面 (StoreDeviceCheckoutForm とその hook) を、submit=store の /checkout を開いたときだけ読み込む
// (bundle 予算・通常の /checkout の First Load JS に載せない)。page (server component) から呼ぶ client の入口。
//
// SSR はそのまま (next/dynamic の既定): server の HTML に今までどおり画面が入り、client は同じ chunk を読み込んでから
// hydrate する (読み込み中に別の画面を出さない)。fallback は client での遷移など、HTML に画面が無いときだけ出る空の枠。
// 支払いの流れ・状態は StoreDeviceCheckoutForm の中のままで、ここでは何も変えない。
// chunk を読み込めないときは、この画面だけが動かない (通常の /checkout はこの chunk を読まないので巻き込まない)。

import dynamic from 'next/dynamic';
import type { CheckoutParams } from '@/lib/url';

const StoreDeviceCheckoutForm = dynamic(
  () => import('../StoreDeviceCheckoutForm').then((m) => m.StoreDeviceCheckoutForm),
  { loading: () => <div className="min-h-[320px]" /> },
);

export function StoreDeviceCheckoutFormLazy({ params }: { params: CheckoutParams }) {
  return <StoreDeviceCheckoutForm params={params} />;
}
