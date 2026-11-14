'use client';

// 決済フォームの経路の決定 (第 10 回レビュー PR-16)。components/PaymentForm.tsx の「経路を決める 6 文」を、式を変えずに移した。
// 決済経路の単一情報源 (Phase 1.1)。isStandard / useRelay / useRecover / isCircle を route の 1 値から導出する。
// resolver 3 つに聞いた解決済みの値を resolvePaymentRoute に渡す。判定の優先順位・短絡は resolvePaymentRoute
// (lib/paymentRoute.ts) が持つ。
//   - JPYC ガスレスを EIP-3009 relay に倒すか (flag ON + JPYC + relay 対応 chain)。OFF / 非対応 / disableRelay は
//     'pimlico-7702' 同等で従来挙動 (Pimlico fallback)。relay は smart account / gas quote 不要で、顧客が署名するだけ・
//     自前 relayer がガス負担 (memory:jpyc-eip3009)。
//   - recover: forwarder 設定済 chain は gas 相当額を JPYC 回収 (gasMode で顧客上乗せ/店主吸収)。
//     未設定は free (OpenPay 負担)。
//   - USDC ガスレスが Circle に解決される場合は surcharge 込み quote + permit allowance。
// 中に React の hook は無い (state・ref・effect・memo を持たない) ので、呼ぶ側の hook の並びは変わらない。
// 金額・ガス代の負担 (effectiveGasMode)・支払いの hook の enabled は入れていない (フォームに残る)。

import { resolveUsdcGaslessProvider } from '@/lib/circlePaymaster';
import { resolveJpycGaslessProvider } from '@/lib/jpycGaslessProvider';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import {
  resolvePaymentRoute,
  isStandardRoute,
  isRelayRoute,
  isRecoverRoute,
  isCircleRoute,
  type PaymentRoute,
} from '@/lib/paymentRoute';
import type { TokenDeployment } from '@/lib/tokens';

// どの欄も省けない (フォームごとの違いを、呼び出しの所に全部書かせる)。
export type UsePaymentRouteArgs = {
  deployment: TokenDeployment;
  // 接続中のウォレットの chain。JPYC の resolver と forwarder はこの chain で聞く (undefined なら deployment の chain)。
  // USDC の resolver は常に deployment の chain で聞く。
  walletChainId: number | undefined;
  // 通常決済を求められているか (URL の mode・SA fallback の override・保存済みの通常決済の試み)。
  standardRequested: boolean;
  // relay (EIP-3009) を外して非 relay 経路へ倒すか (lib/paymentRoute.ts の disableRelay)。
  disableRelay: boolean;
  // 送信で固定した経路。null なら毎回決め直す。固定があっても resolver は毎回聞く (移す前と同じ)。
  pinnedRoute: PaymentRoute | null;
};

export function usePaymentRoute({
  deployment,
  walletChainId,
  standardRequested,
  disableRelay,
  pinnedRoute,
}: UsePaymentRouteArgs) {
  const resolvedRoute = resolvePaymentRoute({
    isStandard: standardRequested,
    jpycGaslessProvider: resolveJpycGaslessProvider(
      deployment,
      walletChainId ?? deployment.chainId,
    ),
    usdcGaslessProvider: resolveUsdcGaslessProvider(
      deployment,
      deployment.chainId,
    ),
    hasJpycForwarder: jpycForwarderFor(walletChainId ?? deployment.chainId) !== null,
    disableRelay,
  });
  const route = pinnedRoute ?? resolvedRoute;
  const isStandard = isStandardRoute(route);
  const useRelay = isRelayRoute(route);
  // recover: relay かつ forwarder 設定済 chain (gas 相当額を JPYC 回収)。
  const useRecover = isRecoverRoute(route);
  const isCircle = isCircleRoute(route);
  return { route, isStandard, useRelay, useRecover, isCircle };
}
