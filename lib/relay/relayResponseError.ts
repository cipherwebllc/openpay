// relay POST 後にレスポンスを受け取れなかった場合、broadcast 済みか未送信かを client では
// 判定できない。通常の Error と区別し、standard fallback / 新しい署名による再送へ波及するのを
// 防ぐための専用状態。POST 前のローカル失敗と構造化 server error は従来どおり fallback-safe。
export class RelayResponseUnknownError extends Error {
  constructor() {
    super('response-unknown');
    this.name = 'RelayResponseUnknownError';
  }
}

// relay の早期 IP limiter は冪等チェックより前に応答するため、429 を通常の server error として
// 扱うと、応答喪失後の再送で新しい署名へ進み二重送金になりうる。同一の署名済 payload の再 POST
// だけを許可する専用状態として、fallback-safe error から除外する。
export class RelayIpRateLimitedError extends Error {
  readonly retryAfterSeconds: number | null;

  constructor(retryAfterSeconds: number | null = null) {
    super('ip_rate_limited');
    this.name = 'RelayIpRateLimitedError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function isRelayResponseUnknownError(
  error: unknown,
): error is RelayResponseUnknownError {
  return error instanceof RelayResponseUnknownError;
}

export function isRelayIpRateLimitedError(
  error: unknown,
): error is RelayIpRateLimitedError {
  return error instanceof RelayIpRateLimitedError;
}

export function isFallbackSafeRelayError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    !isRelayResponseUnknownError(error) &&
    !isRelayIpRateLimitedError(error)
  );
}

// 復旧の枠を書けない端末で、hook が送らずに止めた error (hooks/useJpycEip3009Payment・第 10 回レビュー H-R)。送っていない
// ので fallback-safe のまま (switchToStandard の二重払いの判定は変えない) だが、/pay・/checkout は通常決済への切り替えの
// banner を出さず、汎用の error の枠に出す: 通常決済 (hooks/useStandardPayment) も同じ保存に頼っていて同じ穴があり、
// 同じ穴のある経路へ案内しない (user 裁定 Q7-1・受容台帳)。
export function isIntentStorageUnavailableError(error: unknown): boolean {
  return error instanceof Error && error.message === 'intent_storage_unavailable';
}

// 束縛した注文 (/checkout) の slot を書いて読み戻せない端末で、hook が送らずに止めた error (hooks/useJpycEip3009Payment の
// saveOrderDeliveryVerified・第 10 回レビュー H-R)。上と同じく送っていないので fallback-safe のままだが、/checkout は通常決済への
// 切り替えの banner も、汎用の文 (「通常モードをご利用ください」を含む) も出さず、専用の黄色の枠
// (CheckoutForm の orderBindingStorageUnavailable) だけを出す: 保存できない端末を、同じ穴のある通常決済へ案内しない
// (user 裁定 Q8 = A・Q7-1 と同じ理由)。
export function isOrderBindingStorageUnavailableError(error: unknown): boolean {
  return error instanceof Error && error.message === 'order_binding_storage_unavailable';
}
