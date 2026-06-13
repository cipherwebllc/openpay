// 決済経路の単一情報源 (discriminated union)。決済フォーム (CheckoutForm/PaymentForm/TipForm)
// に散在していた isStandard / useRelay / useRecover / isCircle の boolean soup を 1 つの値に
// 集約し、経路追加時に exhaustive switch がコンパイルエラーになるようにする (Phase 1.1)。
//
// ⚠️ これは **挙動不変リファクタ** の土台。resolvePaymentRoute は現行 CheckoutForm の経路判定を
// **そのまま** 再現する純関数で、新しいポリシーは一切入れない (同じ短絡・同じ優先順位)。
// 経路解決の実体 (env flag / chain allowlist / forwarder 設定) は引き続き
// resolveJpycGaslessProvider / resolveUsdcGaslessProvider / jpycForwarderFor が持ち、本関数は
// それらの **解決済み結果** を受け取って union 形に正規化するだけ (= テスト mock が引き続き経路を
// 駆動でき、判定が二重定義にならない)。
//
// recover かどうかは「relay かつ forwarder 設定済み chain」で決まる (free = forwarder 無し =
// OpenPay がガス全額負担、recover = forwarder 設定済み = JPYC でガス相当額を回収)。
// 詳細・段階計画は memory:jpyc-eip3009 / memory:recover-monetization-pivot。

import type { JpycGaslessProvider } from './jpycGaslessProvider';
import type { UsdcGaslessProvider } from './circlePaymaster';

// 決済経路。kind が判別子。
//   - standard: 顧客 wallet がネイティブガスを自前で払う通常送金 (merchant + fee の 2 tx)。
//   - relay:    JPYC EIP-3009 transferWithAuthorization を自前 relayer が中継 (gasless)。
//               recover=true は forwarder 設定済み chain で gas 相当額を JPYC 回収する本番経路、
//               recover=false は forwarder 未設定の free 経路 (OpenPay がガス全額負担)。
//   - gasless:  Pimlico smart account 経路。provider='pimlico' は従来の erc20/sponsorship、
//               provider='circle' は USDC を Circle Paymaster v0.8 で支払う経路。
export type PaymentRoute =
  | { kind: 'standard' }
  | { kind: 'relay'; recover: boolean }
  | { kind: 'gasless'; provider: 'pimlico' | 'circle' };

// resolvePaymentRoute の入力。すべて呼出側 (CheckoutForm / PaymentForm) が現行どおりに算出する
// **解決済み値**で、ここで env / chain を再解決しない (= 判定の単一情報源を resolver 群に保つ)。
export type PaymentRouteInput = {
  // params.mode === 'standard' || modeOverride === 'standard' (SA fallback 後の override 込み)。
  isStandard: boolean;
  // resolveJpycGaslessProvider(deployment, chainId) の結果。'eip3009-relay' のとき relay 経路。
  jpycGaslessProvider: JpycGaslessProvider;
  // resolveUsdcGaslessProvider(deployment, chainId) の結果。'circle' のとき Circle Paymaster 経路。
  usdcGaslessProvider: UsdcGaslessProvider;
  // jpycForwarderFor(chainId) !== null。relay 経路で recover (回収) か free かを分ける。
  hasJpycForwarder: boolean;
  // relay (EIP-3009) 経路を無効化して非 relay 経路 (gasless/pimlico|circle) に倒すか。
  // PaymentForm の split 決済専用ガード: Phase 1 relay は単発 transfer のみのため、split 指定時は
  // 従来の Pimlico 7702 経路で複数受取人をバッチ送金する (= 現行 PaymentForm の
  // `useRelay = !isStandard && !hasSplit && provider==='eip3009-relay'` の `!hasSplit`)。
  // 省略時は false で relay 抑止なし (CheckoutForm は split 非対応なので渡さない = 現行挙動を維持)。
  disableRelay?: boolean;
};

/**
 * 現行 CheckoutForm / PaymentForm の経路判定を**そのまま**再現する純関数。優先順位・短絡は
 * 現行コードと一致:
 *   1. isStandard が最優先 (現行の useRelay / isCircle は両方 `!isStandard` で gate されているため、
 *      standard のときは relay も circle も成立しない)。
 *   2. 非 standard かつ relay 無効化なし (disableRelay !== true) かつ JPYC provider='eip3009-relay'
 *      → relay。recover は forwarder 設定の有無で決まる
 *      (現行: useRecover = useRelay && jpycForwarderFor(...) !== null)。disableRelay は PaymentForm の
 *      split 専用ガードで、現行 `useRelay = !isStandard && !hasSplit && ...` の `!hasSplit` に対応する
 *      (CheckoutForm は split 非対応で渡さない = relay 抑止なし)。
 *   3. 非 standard かつ非 relay かつ USDC provider='circle' → gasless/circle
 *      (現行: isCircle = !isStandard && resolveUsdcGaslessProvider(...) === 'circle')。
 *   4. それ以外 → gasless/pimlico (従来の Pimlico erc20 / sponsorship 経路)。
 *
 * 注: relay と circle は現行コードでは独立フラグだが、JPYC deployment では USDC provider が常に
 * 'pimlico'、USDC deployment では JPYC provider が常に 'pimlico-7702' になるため実際には排他で、
 * relay を circle より先に評価しても挙動は変わらない (token が両者を同時に満たすことはない)。
 * disableRelay も同様に排他性を崩さない: JPYC split では relay を抑止して pimlico に倒れ
 * (USDC provider は JPYC で常に 'pimlico')、USDC split では relay は元々成立しないため circle 判定は
 * 不変 (現行 isCircle が split を gate しないのと一致)。
 */
export function resolvePaymentRoute(input: PaymentRouteInput): PaymentRoute {
  if (input.isStandard) return { kind: 'standard' };
  if (!input.disableRelay && input.jpycGaslessProvider === 'eip3009-relay') {
    return { kind: 'relay', recover: input.hasJpycForwarder };
  }
  if (input.usdcGaslessProvider === 'circle') {
    return { kind: 'gasless', provider: 'circle' };
  }
  return { kind: 'gasless', provider: 'pimlico' };
}

// ---- 導出ヘルパ (exhaustive switch で経路追加をコンパイルエラー化) -----------------
// 散在していた boolean を route 1 値から導出する。default 句を置かず、kind を網羅することで
// PaymentRoute に新 kind を足したとき switch が `never` 漏れでコンパイルエラーになる。

/** 現行 isStandard 相当。 */
export function isStandardRoute(route: PaymentRoute): boolean {
  return route.kind === 'standard';
}

/** 現行 useRelay 相当 (JPYC EIP-3009 relay 経路かどうか)。 */
export function isRelayRoute(route: PaymentRoute): boolean {
  return route.kind === 'relay';
}

/** 現行 useRecover 相当 (relay かつ forwarder 設定済み = gas 回収)。 */
export function isRecoverRoute(route: PaymentRoute): boolean {
  switch (route.kind) {
    case 'relay':
      return route.recover;
    case 'standard':
    case 'gasless':
      return false;
  }
}

/** 現行 isCircle 相当 (USDC を Circle Paymaster で払う gasless 経路かどうか)。 */
export function isCircleRoute(route: PaymentRoute): boolean {
  switch (route.kind) {
    case 'gasless':
      return route.provider === 'circle';
    case 'standard':
    case 'relay':
      return false;
  }
}
