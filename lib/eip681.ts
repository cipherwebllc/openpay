// EIP-681 (Ethereum URI) ERC20 transfer encoder.
// 仕様: https://eips.ethereum.org/EIPS/eip-681
//
//   ethereum:<token>@<chain_id>/transfer?address=<receiver>&uint256=<amount_wei>
//
// 用途: 「OpenPay の hosted checkout (gasless / split / 1% 手数料) を経由せず、
// 任意の EIP-681 対応ウォレット (Hashport / MetaMask Mobile 等) で直接送金させる」
// 互換 QR の発行。呼出は QrGenerator 1 箇所に閉じており、tokenAddress / chainId /
// decimals は deployment 由来 (型保証)、to / amount は UI で事前検証済。ここでは
// UI が検知できない「小数桁数 > decimals」のみ guard する。
import { getAddress, parseUnits, type Address } from 'viem';

export type Eip681TransferInput = {
  tokenAddress: Address;
  chainId: number;
  to: Address;
  /** 人間可読 decimal (例: "10.5"). UI 側で `^\d+(\.\d+)?$` かつ > 0 を保証済。 */
  amount: string;
  decimals: number;
};

export function buildEip681TransferUri({
  tokenAddress,
  chainId,
  to,
  amount,
  decimals,
}: Eip681TransferInput): string {
  // parseUnits は小数桁が decimals を超えると round するため、明示拒否
  // (誤った金額が QR に焼かれるのを防ぐ — UI 側では token decimals 不明なので
  // ここがチェックの責任箇所)。
  const dotIdx = amount.indexOf('.');
  if (dotIdx !== -1 && amount.length - dotIdx - 1 > decimals) {
    throw new Error(
      `Amount has more decimal places than token decimals (${decimals})`,
    );
  }
  const amountWei = parseUnits(amount, decimals);
  // address は 0x40hex で URL-safe、chainId / amountWei は整数文字列のため、
  // URLSearchParams は不要 (encode 対象なし)。
  return `ethereum:${getAddress(tokenAddress)}@${chainId}/transfer?address=${getAddress(to)}&uint256=${amountWei}`;
}
