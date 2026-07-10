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
