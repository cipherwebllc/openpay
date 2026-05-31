import { formatUnits, getAddress, isAddress, type Address } from 'viem';
import type { TokenDeployment } from './tokens';

// 0x... アドレスを "0x123…abcd" の形式に短縮。
// 12 文字以下の入力は変換せずそのまま返す (ENS 名前など短い文字列の保護)。
export function shortAddress(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

// 日時の 2 桁ゼロ埋め (history timestamp / CSV filename / SuccessOverlay 時刻表示で共用)。
export const pad = (n: number): string => n.toString().padStart(2, '0');

// wei 単位の bigint を "X.XX SYMBOL" にフォーマット。
export function formatTokenAmount(wei: bigint, token: TokenDeployment): string {
  return `${formatUnits(wei, token.decimals)} ${token.displaySymbol}`;
}

// 受取人アドレス入力 (0x... or .eth/.base.eth) と AddressInput が解決した Address から
// 実効的な受取先を導出。0x 直接入力は同期で確定、name 解決は AddressInput.onResolved 経由。
export function pickEffectiveAddress(
  raw: string,
  resolved: Address | null,
): Address | null {
  if (isAddress(raw)) return getAddress(raw);
  return resolved;
}
