import 'server-only';

import { isAddressEqual, parseAbi, parseEventLogs, TransactionReceiptNotFoundError, type Address, type Hex, type Log } from 'viem';

// EIP-3009 の cancelAuthorization が出す event。JPYC v3 (Polygon・Kaia・Avalanche の実装) は取り消しで
// AuthorizationCanceled(authorizer, nonce) だけを出し、authorizationState を true にする (JPYC は動かない)。
// 取り消しと使用 (AuthorizationUsed) は同じ nonce では両立しない (どちらも「未使用」を確かめてから state を立てる)。
export const AUTHORIZATION_CANCELED_EVENT = parseAbi([
  'event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)',
])[0];
const AUTHORIZATION_USED_EVENT = parseAbi([
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
])[0];
const FORWARDER_SETTLED_EVENT = parseAbi([
  'event Settled(address indexed from, bytes32 indexed nonce, address indexed merchant, uint256 merchantValue, address feeReceiver, uint256 feeValue)',
])[0];
const HASH_RE = /^0x[0-9a-f]{64}$/;

/** finalized・canonical な AuthorizationCanceled(payer, nonce) の在りか (決済状態の真実は on-chain の event だけ)。 */
export type AuthorizationCancelEvidence = { blockNumber: string; blockHash: Hex; transactionHash: Hex };

type CancelLog = {
  blockNumber: bigint | null;
  blockHash: Hex | null;
  transactionHash: Hex | null;
  removed?: boolean;
};

/** 取り消しの証明が読む RPC (viem の public client の部分集合・test は差し替える)。 */
export type AuthorizationCancelClient = {
  getBlock: (args: { blockTag: 'finalized' } | { blockNumber: bigint }) => Promise<{ number: bigint | null; hash?: Hex | null }>;
  getLogs: (args: {
    address: Address;
    event: typeof AUTHORIZATION_CANCELED_EVENT;
    args: { authorizer: Address; nonce: Hex };
    fromBlock: bigint;
    toBlock: bigint;
  }) => Promise<readonly CancelLog[]>;
  getTransactionReceipt: (args: { hash: Hex }) => Promise<{
    status: 'success' | 'reverted';
    blockNumber: bigint;
    blockHash: Hex;
    transactionHash: Hex;
    logs: readonly Log[];
  }>;
};

/**
 * [fromBlock, toBlock] に finalized・canonical な AuthorizationCanceled(payer, nonce) があれば、その在りかを返す。
 * 読めない・揃わない・確定前 (finalized より後)・同じ tx に AuthorizationUsed / Settled がある・保存済みの支払い tx が
 * 成功している (または読めない) ときは null (= 証拠にしない)。null は「取り消されていない」ではなく「証明できない」。
 * finalized を渡すとき (license の observe) は、呼出側がその hash を canonical と確認済みであること。
 */
export async function findFinalizedAuthorizationCancel(input: {
  client: AuthorizationCancelClient;
  token: Address;
  forwarder: Address;
  payer: Address;
  nonce: Hex;
  fromBlock: bigint;
  toBlock: bigint;
  finalized?: { number: bigint; hash: Hex };
  txHash?: Hex;
}): Promise<AuthorizationCancelEvidence | null> {
  try {
    if (input.fromBlock > input.toBlock) return null;
    const logs = await input.client.getLogs({
      address: input.token,
      event: AUTHORIZATION_CANCELED_EVENT,
      args: { authorizer: input.payer, nonce: input.nonce },
      fromBlock: input.fromBlock,
      toBlock: input.toBlock,
    });
    const log = logs.find((l) =>
      l.removed !== true && typeof l.blockNumber === 'bigint' &&
      typeof l.blockHash === 'string' && HASH_RE.test(l.blockHash) &&
      typeof l.transactionHash === 'string' && HASH_RE.test(l.transactionHash));
    if (!log || log.blockNumber === null || log.blockHash === null || log.transactionHash === null) return null;
    let finalized = input.finalized;
    if (!finalized) {
      const block = await input.client.getBlock({ blockTag: 'finalized' });
      if (typeof block.number !== 'bigint' || typeof block.hash !== 'string' || !HASH_RE.test(block.hash)) return null;
      finalized = { number: block.number, hash: block.hash };
    }
    // 確定前 (finalized より後) の取り消しは判定しない (reorg で消えうる)。
    if (log.blockNumber > finalized.number) return null;
    const receipt = await input.client.getTransactionReceipt({ hash: log.transactionHash });
    if (
      receipt.status !== 'success' || receipt.transactionHash !== log.transactionHash ||
      receipt.blockNumber !== log.blockNumber || receipt.blockHash !== log.blockHash
    ) return null;
    const tokenLogs = receipt.logs.filter((l) => isAddressEqual(l.address, input.token));
    const matches = ({ args }: { args: { authorizer: Address; nonce: Hex } }) =>
      isAddressEqual(args.authorizer, input.payer) && args.nonce === input.nonce;
    if (!parseEventLogs({ abi: [AUTHORIZATION_CANCELED_EVENT], logs: tokenLogs, strict: true }).some(matches)) return null;
    // 同じ tx で使用・決済が起きていれば取り消しではない (両立しないので、出たら RPC の応答を信じない)。
    if (parseEventLogs({ abi: [AUTHORIZATION_USED_EVENT], logs: tokenLogs, strict: true }).some(matches)) return null;
    if (parseEventLogs({
      abi: [FORWARDER_SETTLED_EVENT],
      logs: receipt.logs.filter((l) => isAddressEqual(l.address, input.forwarder)),
      strict: true,
    }).some(({ args }) => isAddressEqual(args.from, input.payer) && args.nonce === input.nonce)) return null;
    // log の block が canonical であること (別 fork のノードの応答で在庫を戻さない)。
    const canonical = await input.client.getBlock({ blockNumber: log.blockNumber });
    if (canonical.hash !== log.blockHash) return null;
    if (!input.finalized) {
      const stillFinal = await input.client.getBlock({ blockNumber: finalized.number });
      if (stillFinal.hash !== finalized.hash) return null;
    }
    // 保存済みの支払い tx が成功していれば (使用と取り消しは両立しない) 矛盾なので証拠にしない。
    // authorizationExpiredUnused と同じく、確かに無い receipt と revert だけを取り消しと両立するとみなす。
    if (input.txHash) {
      try {
        const stored = await input.client.getTransactionReceipt({ hash: input.txHash });
        if (stored.status !== 'reverted') return null;
      } catch (error) {
        if (!(error instanceof TransactionReceiptNotFoundError)) return null;
      }
    }
    return { blockNumber: log.blockNumber.toString(), blockHash: log.blockHash, transactionHash: log.transactionHash };
  } catch {
    // RPC の読み取り障害を「取り消し済み」と解釈して在庫・rail の解放へ波及させない (証明しない = 保持のまま)。
    return null;
  }
}
