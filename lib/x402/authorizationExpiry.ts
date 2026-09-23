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
