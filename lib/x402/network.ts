// x402 v2 の network 識別は CAIP-2 (eip155:<chainId>)。chainId ⇄ CAIP-2 の純変換を
// 1 箇所に集約する (requirements 生成 / facilitator route の双方向で共有・I/O なし)。
// 例: Polygon = 'eip155:137' / Polygon Amoy = 'eip155:80002'。

const CAIP2_EIP155 = /^eip155:(\d+)$/;

/** chainId → CAIP-2 network 文字列。 */
export function caip2ForChainId(chainId: number): string {
  return `eip155:${chainId}`;
}

/** CAIP-2 network 文字列 → chainId。eip155 名前空間以外 / 不正値は null。 */
export function chainIdFromCaip2(network: string): number | null {
  const m = CAIP2_EIP155.exec(network);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
