import 'server-only';

import { parseAbi, TransactionReceiptNotFoundError, type Address, type Hex } from 'viem';

const AUTHORIZATION_STATE_ABI = parseAbi([
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
]);

export type AuthorizationExpiryClient = {
  getBlock: (args: { blockTag: 'finalized' } | { blockNumber: bigint }) => Promise<{
    number: bigint | null;
    hash?: Hex | null;
    timestamp?: bigint;
  }>;
  readContract: (args: {
    address: Address;
    abi: typeof AUTHORIZATION_STATE_ABI;
    functionName: 'authorizationState';
    args: readonly [Address, Hex];
    blockNumber: bigint;
  }) => Promise<boolean>;
  getTransactionReceipt: (args: { hash: Hex }) => Promise<{ status: 'success' | 'reverted' }>;
};

/** A finalized, expired, unused EIP-3009 nonce can never settle on this chain. */
export async function authorizationExpiredUnused(input: {
  client: AuthorizationExpiryClient;
  token: Address;
  payer: Address;
  nonce: Hex;
  validBefore: bigint;
  txHash?: Hex;
}): Promise<boolean> {
  try {
    const block = await input.client.getBlock({ blockTag: 'finalized' });
    // Missing/unsupported finality must not turn an RPC gap into an unlocked payment.
    // Neither wall-clock time, a safe block nor a confirmation-count fallback proves expiry.
    if (
      typeof block.number !== 'bigint' ||
      typeof block.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(block.hash) ||
      typeof block.timestamp !== 'bigint' || block.timestamp <= input.validBefore
    ) return false;
    const used = await input.client.readContract({
      address: input.token,
      abi: AUTHORIZATION_STATE_ABI,
      functionName: 'authorizationState',
      args: [input.payer, input.nonce],
      blockNumber: block.number,
    });
    // As in license reconciliation, recheck the canonical hash after the numbered
    // state read so an orphaned unused-state response cannot release a payment lock.
    const canonical = await input.client.getBlock({ blockNumber: block.number });
    if (canonical.hash !== block.hash || used !== false) return false;
    // This exact nonce's unused state covers ALL replacement transactions, including
    // unknown hashes: a successful EIP-3009 transfer permanently consumes the nonce.
    // A contradictory successful candidate receipt still blocks failure; never discard
    // positive payment evidence because another RPC response claims the nonce is unused.
    if (input.txHash) {
      try {
        const receipt = await input.client.getTransactionReceipt({ hash: input.txHash });
        if (receipt.status !== 'reverted') return false;
      } catch (error) {
        // Only a definite missing receipt is compatible with this proof. Timeouts and
        // unreadable receipts must not spill over into freeing a live payment lock.
        if (!(error instanceof TransactionReceiptNotFoundError)) return false;
      }
    }
    return true;
  } catch {
    // Archive/finality/canonical lookup failures must not become terminal payment decisions.
    return false;
  }
}

export type AuthorizationExpiryObservation = 'expired' | 'live' | 'unknown';

/** observeAuthorizationExpiry 用。state は finalized ブロックの hash に固定して読む (EIP-1898)。 */
export type AuthorizationExpiryObserveClient = {
  getBlock: AuthorizationExpiryClient['getBlock'];
  readContract: (args: {
    address: Address;
    abi: typeof AUTHORIZATION_STATE_ABI;
    functionName: 'authorizationState';
    args: readonly [Address, Hex];
    blockHash: Hex;
    requireCanonical: true;
  }) => Promise<boolean>;
};

/**
 * relay status 用の「期限切れ未使用」の観測 (tri-state)。手順は authorizationExpiredUnused と同じ
 * (finalized ブロック → その番号に固定した authorizationState → canonical hash の再確認) で、結果を 3 値で返す:
 *   'expired' = finalized の時刻が validBefore を過ぎ、その時点で nonce は未使用 (以後どのブロックでも成立しない)
 *   'live'    = finalized の時刻がまだ validBefore 以下 (チェーン上ではまだ期限前・state は読まない)
 *   'unknown' = 読めない・揃わない・不整合 (証明にならない)
 * 端末の時計も latest ブロックも使わない (latest は used と別の読み取りになり、バックエンドの遅れや reorg で
 * 「期限後の時刻」と「期限前の unused」が混ざる・第 7 回レビュー A6 再レビュー)。txHash の照合は持たない
 * (relay status は idem に hash 記録が無い分岐でだけ呼ぶ)。
 */
export async function observeAuthorizationExpiry(input: {
  client: AuthorizationExpiryObserveClient;
  token: Address;
  payer: Address;
  nonce: Hex;
  validBefore: bigint;
}): Promise<AuthorizationExpiryObservation> {
  try {
    const block = await input.client.getBlock({ blockTag: 'finalized' });
    if (
      typeof block.number !== 'bigint' ||
      typeof block.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(block.hash) ||
      typeof block.timestamp !== 'bigint'
    ) return 'unknown';
    // authorizationExpiredUnused と同じ厳密な比較 (timestamp == validBefore はまだ期限前)。
    if (block.timestamp <= input.validBefore) return 'live';
    // state は finalized の「番号」ではなく「hash」に固定して読む (EIP-1898 blockHash + requireCanonical)。番号指定だと
    // reorg の反映が遅れた RPC ノードが混在したとき、finalized(A) → state(別フォーク B)=unused → canonical(A) が揃い、
    // A では支払い済みなのに expired と証明しうる (第 7 回レビュー #767 Codex 再レビュー P1)。非対応・非 canonical は throw → unknown。
    const used = await input.client.readContract({
      address: input.token,
      abi: AUTHORIZATION_STATE_ABI,
      functionName: 'authorizationState',
      args: [input.payer, input.nonce],
      blockHash: block.hash as Hex,
      requireCanonical: true,
    });
    const canonical = await input.client.getBlock({ blockNumber: block.number });
    if (canonical.hash !== block.hash || used !== false) return 'unknown';
    return 'expired';
  } catch {
    // finality/archive/canonical の読み取り障害は証明にしない (呼出元は従来の unused 応答を返す)。
    return 'unknown';
  }
}
