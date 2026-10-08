// 署名有効窓の最大 (validBefore - now がこれを超える far-future を弾く)。中継 (recover) と x402 facilitator の両 route
// 共通 (lib/relay/forwarderSettleService.ts が再 export)。tx 探し (AuthorizationUsed) の範囲の下限にも使う。
export const MAX_VALIDITY_WINDOW_SEC = 20 * 60;
