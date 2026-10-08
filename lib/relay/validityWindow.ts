// 署名有効窓の最大 (validBefore - now がこれを超える far-future を弾く)。中継 (recover) と x402 facilitator の両 route
// 共通 (lib/relay/forwarderSettleService.ts が再 export)。tx 探し (AuthorizationUsed) の範囲の下限にも使う。
export const MAX_VALIDITY_WINDOW_SEC = 20 * 60;

/**
 * tx 探しの範囲の下限 (validBefore − これ) に使う秒数。受け付けたときのサーバの時計とブロックの時刻のずれの分、
 * 有効窓の上限に余裕を足す (受け渡しの 180 + 30 秒と同じ考え方)。
 */
export const AUTHORIZATION_LOOKUP_WINDOW_SEC = MAX_VALIDITY_WINDOW_SEC + 30;
