// relay POST 後にレスポンスを受け取れなかった場合、broadcast 済みか未送信かを client では
// 判定できない。通常の Error と区別し、standard fallback / 新しい署名による再送へ波及するのを
// 防ぐための専用状態。POST 前のローカル失敗と構造化 server error は従来どおり fallback-safe。
export class RelayResponseUnknownError extends Error {
  constructor() {
    super('response-unknown');
    this.name = 'RelayResponseUnknownError';
  }
}

export function isRelayResponseUnknownError(
  error: unknown,
): error is RelayResponseUnknownError {
  return error instanceof RelayResponseUnknownError;
}

export function isFallbackSafeRelayError(error: unknown): error is Error {
  return error instanceof Error && !isRelayResponseUnknownError(error);
}
