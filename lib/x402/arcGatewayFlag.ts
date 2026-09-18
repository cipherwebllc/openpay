// Arc rail (Circle Gateway x402) の点灯フラグを「表示用に」読むだけの純関数。
//
// lib/x402/config.ts は import 時に決済設定を検証して throw しうる (money-path の fail-fast)。表示ページが
// それを import すると、表示と無関係な env 不備でページ描画まで巻き込まれる。その波及を断つため、表示側は
// flag の真偽だけをここから読む (秘密情報なし・throw なし)。真偽の規則は parseArcGateway と同一 (trim しない・'1' / 'true' のみ) で、
// 乖離は tests/lib/x402/arcGatewayFlag.test.ts が検出する。
export function isArcGatewayFlagOn(
  raw: string | undefined = process.env.ENABLE_X402_ARC_GATEWAY,
): boolean {
  return raw === '1' || raw === 'true';
}
