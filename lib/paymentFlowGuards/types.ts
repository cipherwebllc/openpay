// Pay / Checkout / Tip の送信可否 policy が読む hook 状態の最小形 (型のみ・R14)。
// 判定式そのものは各フォームの policy (pay.ts / checkout.ts / tip.ts) に置き、ここでは共有しない:
// 3 フォームの policy は意図的に異なる (Tip の route 限定ロック・Checkout の注文受付・Pay の FX 期限)。

// useJpycEip3009Payment (EIP-3009 relay) のうち policy が読む部分。
export type RelayGuardState = {
  error: unknown;
  recoveryState: 'auto' | 'exhausted' | null;
  isRestoring: boolean;
  isPending: boolean;
  hasActiveIntent: boolean;
  data?: { success: boolean; pending?: boolean };
};

// useBatchPayment (Pimlico / Circle の UserOperation) のうち policy が読む部分。
export type GaslessGuardState = {
  isPending: boolean;
  isUnknown: boolean;
  pendingStoreUnavailable: boolean;
  data?: { success: boolean };
};

// 3 フォーム共通の送信 readiness 入力 (値の組み合わせ方はフォームごとに違う)。
export type SubmitReadinessInput = {
  isConnected: boolean;
  wrongChain: boolean;
  saData: unknown;
  breakdown: { merchantReceives: bigint; customerPays: bigint };
  insufficientBalance: boolean;
  activeQuote: { data?: unknown };
};
