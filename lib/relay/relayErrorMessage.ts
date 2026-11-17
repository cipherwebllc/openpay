// JPYC relay (/api/relay/jpyc) の error code → 顧客向け i18n キー。検証系の細かな reason や
// 技術コード (signature_mismatch/unsupported_chain/http_* 等) は generic に丸め、顧客が取れる
// アクションのあるものだけ専用キーにする (signature_invalid = 対応していないウォレット、は下の case)。namespace 非依存に「キー文字列」を返すので、
// PaymentForm / CheckoutForm / TipForm それぞれの t() で翻訳する (3 つの namespace に同名キーが必要)。

export type RelayErrorKey =
  | 'errorRelayRateLimited'
  | 'errorRelayNotConfigured'
  | 'errorRelayInsufficientBalance'
  | 'errorRelayFeePaused'
  | 'errorRelayStorageUnavailable'
  | 'errorRelayUnsupportedWallet'
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
    // 文言にする。どのフォームも通常決済へは案内せず、ブラウザの設定か別のブラウザだけを案内する (通常決済にも同じ穴がある・
    // user 裁定 Q7-1。/pay・/checkout は切り替えの banner を出さない = lib/relay/relayResponseError の
    // isIntentStorageUnavailableError)。
    case 'intent_storage_unavailable':
      return 'errorRelayStorageUnavailable';
    // server が署名から送り元を復元できなかった (lib/relay/jpycRelay.ts・forwarderRecover.ts)。JPYC の EIP-3009 は ecrecover
    // だけなので、7702 でない contract の口座 (ERC-4337 のスマートアカウント等) の署名はここで断られる。時間をおいても直らない
    // ので「一時的」の generic にせず、ウォレットが対応していないと伝える (/pay・/checkout は通常決済への切り替えの banner を
    // 払えない口座の形で出す・hooks/useGaslessUnsupportedWallet.ts)。signature_mismatch (復元できたが送り元と違う) は
    // ウォレットの種類の問題と言い切れないので generic のまま。
    case 'signature_invalid':
      return 'errorRelayUnsupportedWallet';
    default:
      return 'errorRelayGeneric';
  }
}
