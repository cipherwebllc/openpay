// EIP-681 ERC20 transfer URI encoder.
// 仕様: https://eips.ethereum.org/EIPS/eip-681
//   ethereum:<token>@<chain_id>/transfer?address=<receiver>&uint256=<amount_wei>
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
  // (誤った金額が QR に焼かれるのを防ぐ)。
  const dotIdx = amount.indexOf('.');
  if (dotIdx !== -1 && amount.length - dotIdx - 1 > decimals) {
    throw new Error(
      `Amount has more decimal places than token decimals (${decimals})`,
    );
  }
  const amountWei = parseUnits(amount, decimals);
  return `ethereum:${getAddress(tokenAddress)}@${chainId}/transfer?address=${getAddress(to)}&uint256=${amountWei}`;
}
