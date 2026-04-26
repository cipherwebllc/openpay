// 0x... アドレスを "0x123…abcd" の形式に短縮。
// 12 文字以下の入力は変換せずそのまま返す (ENS 名前など短い文字列の保護)。
export function shortAddress(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}
