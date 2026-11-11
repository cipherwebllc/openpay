// JPYC relay (/api/relay/jpyc) の error code → 顧客向け i18n キー。検証系の細かな reason や
// 技術コード (signature_*/unsupported_chain/http_* 等) は generic に丸め、顧客が取れる
// アクションのある 3 種のみ専用キーにする。namespace 非依存に「キー文字列」を返すので、
// PaymentForm / CheckoutForm / TipForm それぞれの t() で翻訳する (3 つの namespace に同名キーが必要)。

export type RelayErrorKey =
  | 'errorRelayRateLimited'
  | 'errorRelayNotConfigured'
  | 'errorRelayInsufficientBalance'
  | 'errorRelayFeePaused'
  | 'errorRelayStorageUnavailable'
  | 'errorRelayGeneric';

export function relayErrorKey(err: Error): RelayErrorKey {
  switch (err.message) {
    case 'rate_limited':
      return 'errorRelayRateLimited';
    case 'relay_not_configured':
      return 'errorRelayNotConfigured';
    case 'insufficient_balance':
      return 'errorRelayInsufficientBalance';
    // a1 関所: 店主の利用料が延滞でガスレスが停止中。一過性でないので「再試行」案内は出さず、
    // 店主への確認 / 通常モードへ誘導する (顧客に店主の未払いは明かさない)。
    case 'fee_required':
      return 'errorRelayFeePaused';
    // この端末に復旧の枠 (公開 metadata) を書けないので、hook が送らずに止めた (hooks/useJpycEip3009Payment・
    // 第 10 回レビュー H-R)。server の応答ではない。時間をおいても直らないので「時間をおいて再度」の generic とは別の
    // 文言にする (/pay・/checkout は通常決済か別のブラウザ、/tip は通常決済へ切り替えられないので別のブラウザだけを案内する)。
    case 'intent_storage_unavailable':
      return 'errorRelayStorageUnavailable';
    default:
      return 'errorRelayGeneric';
  }
}
