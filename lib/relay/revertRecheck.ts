// relay 自身の tx が revert した後の authorization 再確認 (free relay と forwarder recover の共用・第 8 回レビュー A-01)。
//
// relay の tx が revert しても、同じ EIP-3009 authorization を別の tx (公開 mempool から calldata を写した前走り等) が
// 先に実行していれば、支払いはチェーン上で成立している。それを 'reverted' のまま返すと、client は保存した intent を
// 捨てて新しい署名を許し、顧客が 2 回払うことになる。'reverted' は client に「新しい署名で払い直してよい」と伝える
// 応答なので、revert した tx の receipt のブロックに固定した authorizationState が「未使用」と読めたときだけ返す。
// 使用済み・固定して読めない (読み取り失敗・receipt の食い違い・hash が無い) は既存の 'pending' (送信前の既使用
// チェックと同じ txHash なし) にする。client は intent を保ったまま、既存の /api/relay/jpyc/status で解決する。
// 自分の tx の revert は自分の使用も巻き戻すので、固定したブロックで used = 別の tx が使った、と読める。
//
// 対象は店 (受取人) へ払う経路だけ。呼び元が readAuthorizationUsedAtRevert を渡したときだけ再確認する。受取人が
// OpenPay 自身の経路 (利用料・CSV パス) は前走りで得をする者がおらず、client も hash なしの pending を解決できない
// ので渡さない = 従来どおり 'reverted' (既定は従来の挙動)。relayBroadcast は触らない。

import { parseAbi, type Address, type Hex } from 'viem';
import { logger } from '@/lib/logger';
import type { RelayResult } from './relayTypes';

const AUTHORIZATION_STATE_ABI = parseAbi([
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
]);

type RevertRecheckTarget = {
  chainId: number;
  token: Address;
  from: Address;
  nonce: Hex;
  // 既存の preflight_unavailable と同じイベント名の prefix ('relay.jpyc' / 'relay.forwarder')。
  logPrefix: string;
};

// revert した tx の receipt のブロックに固定した authorizationState。使用済みなら true・未使用なら false。
// 固定して読めないときは throw する (呼び元は pending に倒す)。
type ReadAuthorizationUsedAtRevert = (
  chainId: number,
  token: Address,
  from: Address,
  nonce: Hex,
  revertTxHash: Hex,
) => Promise<boolean>;

export async function recheckRevertedAuthorization(
  result: RelayResult,
  target: RevertRecheckTarget,
  readAuthorizationUsedAtRevert: ReadAuthorizationUsedAtRevert | undefined,
): Promise<RelayResult> {
  if (result.kind !== 'reverted' || !readAuthorizationUsedAtRevert) return result;

  // お金の安全のための判断 (付帯処理の隔離ではない): 未使用と証明できない revert を 'reverted' で返すと、client は
  // 新しい署名を許す。「分からない」は「払い直して安全」ではないので、hash が無く固定できない・読み取りに失敗した
  // ときも pending にして intent を保たせる。運営が追えるよう理由は warn に残す。
  if (!result.txHash) {
    logger.warn(`${target.logPrefix}.revert_recheck_unavailable`, {
      chainId: target.chainId,
      reason: 'no_tx_hash',
    });
    return { kind: 'pending' };
  }
  let used: boolean;
  try {
    used = await readAuthorizationUsedAtRevert(
      target.chainId,
      target.token,
      target.from,
      target.nonce,
      result.txHash,
    );
  } catch (error) {
    logger.warn(`${target.logPrefix}.revert_recheck_unavailable`, {
      chainId: target.chainId,
      txHash: result.txHash,
      error,
    });
    return { kind: 'pending' };
  }
  if (!used) return result;

  // relay の tx は revert したが authorization は別の tx で使用済み (前走り等)。運営が追えるよう revert した
  // 自分の tx を残す。応答には付けない (explorer で失敗と見え、再支払いを誘うため)。
  logger.warn(`${target.logPrefix}.reverted_authorization_used`, {
    chainId: target.chainId,
    txHash: result.txHash,
  });
  return { kind: 'pending' };
}

// readAuthorizationUsedAtRevert の実装 (relayProvider が chain の PublicClient を渡す)。
type RevertReceiptClient = {
  getTransactionReceipt: (args: { hash: Hex }) => Promise<{
    status: 'success' | 'reverted';
    blockNumber: bigint | null;
    blockHash: Hex | null;
  }>;
  readContract: (args: {
    address: Address;
    abi: typeof AUTHORIZATION_STATE_ABI;
    functionName: 'authorizationState';
    args: readonly [Address, Hex];
    blockHash: Hex;
    requireCanonical: true;
  }) => Promise<boolean>;
  getBlock: (args: { blockNumber: bigint }) => Promise<{ hash: Hex | null }>;
};

const BLOCK_HASH = /^0x[0-9a-fA-F]{64}$/;

// revert した tx の receipt が載ったブロックの「hash」に固定して authorizationState を読む (EIP-1898 blockHash +
// requireCanonical・lib/x402/authorizationExpiry.ts と同じ型)。番号や latest で読むと、revert のブロックをまだ持たない
// (遅れた) RPC ノードや別フォークのノードが「未使用」と答えうる。そのブロックを持たないノードは throw する。
// 使用済みは支払いの証拠なのでそのまま true。未使用は払い直しを許す根拠になるので、読み取りの後もそのブロックが
// canonical のときだけ false を返す。receipt が revert でない・hash が無い・canonical でないときは throw。
export async function authorizationUsedAtRevert(input: {
  client: RevertReceiptClient;
  token: Address;
  from: Address;
  nonce: Hex;
  revertTxHash: Hex;
}): Promise<boolean> {
  const receipt = await input.client.getTransactionReceipt({ hash: input.revertTxHash });
  if (
    receipt.status !== 'reverted' ||
    typeof receipt.blockNumber !== 'bigint' ||
    typeof receipt.blockHash !== 'string' ||
    !BLOCK_HASH.test(receipt.blockHash)
  ) {
    throw new Error('revert_receipt_unpinnable');
  }
  const used = await input.client.readContract({
    address: input.token,
    abi: AUTHORIZATION_STATE_ABI,
    functionName: 'authorizationState',
    args: [input.from, input.nonce],
    blockHash: receipt.blockHash,
    requireCanonical: true,
  });
  if (used) return true;
  const canonical = await input.client.getBlock({ blockNumber: receipt.blockNumber });
  if (canonical.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) {
    throw new Error('revert_block_not_canonical');
  }
  return false;
}
