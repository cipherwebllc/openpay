// JPYC relay (/api/relay/jpyc) の error code → 顧客向け i18n キー。検証系の細かな reason や
// 技術コード (signature_*/unsupported_chain/http_* 等) は generic に丸め、顧客が取れる
// アクションのある 3 種のみ専用キーにする。namespace 非依存に「キー文字列」を返すので、
// PaymentForm / CheckoutForm それぞれの t() で翻訳する (両 namespace に同名キーが必要)。

export type RelayErrorKey =
  | 'errorRelayRateLimited'
  | 'errorRelayNotConfigured'
  | 'errorRelayInsufficientBalance'
  | 'errorRelayGeneric';

export function relayErrorKey(err: Error): RelayErrorKey {
  switch (err.message) {
    case 'rate_limited':
      return 'errorRelayRateLimited';
    case 'relay_not_configured':
      return 'errorRelayNotConfigured';
    case 'insufficient_balance':
      return 'errorRelayInsufficientBalance';
    default:
      return 'errorRelayGeneric';
  }
}
