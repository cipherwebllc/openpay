import 'server-only';

// reconcile が使う on-chain 読み取りの adapter (R3d): authorizationState・AuthorizationUsed の log・Forwarder の
// Settled receipt の厳密照合と、finalized block での期限切れ未使用の証明。test は PurchaseReconcileChain を差し替える。
import {
  createPublicClient,
  isAddressEqual,
  parseAbi,
  parseEventLogs,
  type Hex,
} from 'viem';
import { chainObjectForId, transportForChain } from '@/lib/chains';
import { authorizationExpiredUnused } from '@/lib/x402/authorizationExpiry';
import type { ClaimedPurchaseIntentBase } from './types';

const AUTHORIZATION_STATE_ABI = parseAbi([
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
]);
const AUTHORIZATION_USED_EVENT = parseAbi([
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
])[0];
const FORWARDER_SETTLED_EVENT_ABI = parseAbi([
  'event Settled(address indexed from, bytes32 indexed nonce, address indexed merchant, uint256 merchantValue, address feeReceiver, uint256 feeValue)',
]);

export type PurchaseReconcileChain = {
  // An adapter without finalized evidence must never authorize a payment unlock.
  authorizationExpiredUnused?: (intent: ClaimedPurchaseIntentBase & { txHash?: Hex }) => Promise<boolean>;
  authorizationUsed: (
    intent: ClaimedPurchaseIntentBase,
  ) => Promise<boolean>;
  latestBlock: (intent: ClaimedPurchaseIntentBase) => Promise<bigint>;
  authorizationUsedTransactions: (
    intent: ClaimedPurchaseIntentBase,
    fromBlock: bigint,
    toBlock: bigint,
  ) => Promise<Hex[]>;
  receiptMatches: (
    intent: ClaimedPurchaseIntentBase,
    txHash: Hex,
  ) => Promise<boolean>;
};

function clientForIntent(intent: ClaimedPurchaseIntentBase) {
  const chain = chainObjectForId(intent.chainId);
  if (!chain) throw new Error('unsupported chain');
  return createPublicClient({
    chain,
    transport: transportForChain(intent.chainId),
  });
}

export const defaultPurchaseReconcileChain: PurchaseReconcileChain = {
  authorizationExpiredUnused: (intent) => authorizationExpiredUnused({
    client: clientForIntent(intent),
    token: intent.token,
    payer: intent.claim.payer,
    nonce: intent.claim.nonce,
    validBefore: BigInt(intent.claim.validBefore),
    ...('txHash' in intent ? { txHash: intent.txHash } : {}),
  }),
  authorizationUsed: async (intent) =>
    clientForIntent(intent).readContract({
      address: intent.token,
      abi: AUTHORIZATION_STATE_ABI,
      functionName: 'authorizationState',
      args: [intent.claim.payer, intent.claim.nonce],
    }),
  latestBlock: async (intent) =>
    clientForIntent(intent).getBlockNumber(),
  authorizationUsedTransactions: async (intent, fromBlock, toBlock) => {
    const logs = await clientForIntent(intent).getLogs({
      address: intent.token,
      event: AUTHORIZATION_USED_EVENT,
      args: {
        authorizer: intent.claim.payer,
        nonce: intent.claim.nonce,
      },
      fromBlock,
      toBlock,
    });
    return logs
      .map((log) => log.transactionHash)
      .filter((hash): hash is Hex => hash !== null);
  },
  receiptMatches: async (intent, txHash) => {
    const receipt = await clientForIntent(intent).getTransactionReceipt({
      hash: txHash,
    });
    if (receipt.status !== 'success') return false;
    return parseEventLogs({
      abi: FORWARDER_SETTLED_EVENT_ABI,
      eventName: 'Settled',
      logs: receipt.logs.filter((log) =>
        isAddressEqual(log.address, intent.forwarder),
      ),
      strict: true,
    }).some(
      ({ args }) =>
        isAddressEqual(args.from, intent.claim.payer) &&
        args.nonce === intent.claim.nonce &&
        isAddressEqual(args.merchant, intent.merchant) &&
        args.merchantValue === BigInt(intent.merchantValue) &&
        isAddressEqual(args.feeReceiver, intent.feeReceiver) &&
        args.feeValue === BigInt(intent.feeValue),
    );
  },
};
