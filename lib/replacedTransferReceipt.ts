// 第 7 回レビュー A1: 標準送金 (顧客 EOA の ERC-20 transfer) の receipt が、送った hash と別の tx
// (同じ nonce の置換 = wallet の高速化 / 取消) で返ったときの判定。
// viem の waitForTransactionReceipt は置換を見つけると置換 tx の receipt で resolve する
// (node_modules/viem/actions/public/waitForTransactionReceipt.ts)。status だけ見ると、取消 tx の成功を
// 「店舗への送金の成功」と取り違える。置換 tx 自身の log に同じ token・送り主・宛先・金額の Transfer が
// あるときだけ同内容 (高速化) とし、それ以外 (取消・別内容) は元の送金の成功にしない。
// /pay の First Load に載るため、ABI decoder を使わず topic と data を直接照合する。

import type { Address, Hex } from 'viem';

// keccak256('Transfer(address,address,uint256)')
const TRANSFER_TOPIC0 =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export type TransferReceiptLike = {
  transactionHash: Hex;
  from: Address;
  logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[];
};

export type ExpectedTransfer = { token: Address; to: Address; value: bigint };

export type TransferReceiptKind =
  // 送った tx 自身の receipt (従来どおり)
  | { kind: 'sent' }
  // 同内容の置換 (高速化): 実際に mine された hash で成功
  | { kind: 'replaced-same'; minedTxHash: Hex }
  // 取消・別内容の置換: 元の送金は永久に mine されない (同じ nonce を消費済み)
  | { kind: 'replaced-other'; minedTxHash: Hex };

function addressTopic(address: Address): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
}

export function classifyTransferReceipt(
  receipt: TransferReceiptLike,
  sentHash: Hex,
  expected: ExpectedTransfer,
): TransferReceiptKind {
  if (receipt.transactionHash.toLowerCase() === sentHash.toLowerCase()) {
    return { kind: 'sent' };
  }
  const token = expected.token.toLowerCase();
  // 置換は同じ送り主・同じ nonce の tx なので、Transfer の from は置換 tx の from。
  const from = addressTopic(receipt.from);
  const to = addressTopic(expected.to);
  const sameTransfer = receipt.logs.some(
    (log) =>
      log.address.toLowerCase() === token &&
      log.topics.length === 3 &&
      log.topics[0]?.toLowerCase() === TRANSFER_TOPIC0 &&
      log.topics[1]?.toLowerCase() === from &&
      log.topics[2]?.toLowerCase() === to &&
      // 任意 contract の log が混じるため、uint256 1 語でない data は BigInt に渡さない。
      /^0x[0-9a-fA-F]{64}$/.test(log.data) &&
      BigInt(log.data) === expected.value,
  );
  return sameTransfer
    ? { kind: 'replaced-same', minedTxHash: receipt.transactionHash }
    : { kind: 'replaced-other', minedTxHash: receipt.transactionHash };
}
