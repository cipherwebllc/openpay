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
import type { PageFetchOptions } from '@/lib/x402/reconcilePaging';
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

// options.timeoutMs = deadline 付き (cron) の呼び出しだけ、retry なし・この timeout (本文受信まで) で RPC を呼ぶ
// (第 7 回レビュー B4 follow-up)。省略時は既定の transport (status route 等)。全 method が受ける。
export type PurchaseReconcileChain = {
  // An adapter without finalized evidence must never authorize a payment unlock.
  authorizationExpiredUnused?: (intent: ClaimedPurchaseIntentBase & { txHash?: Hex }, options?: PageFetchOptions) => Promise<boolean>;
  authorizationUsed: (
    intent: ClaimedPurchaseIntentBase,
    options?: PageFetchOptions,
  ) => Promise<boolean>;
  latestBlock: (intent: ClaimedPurchaseIntentBase, options?: PageFetchOptions) => Promise<bigint>;
  authorizationUsedTransactions: (
    intent: ClaimedPurchaseIntentBase,
    fromBlock: bigint,
    toBlock: bigint,
    options?: PageFetchOptions,
  ) => Promise<Hex[]>;
  receiptMatches: (
    intent: ClaimedPurchaseIntentBase,
    txHash: Hex,
    options?: PageFetchOptions,
  ) => Promise<boolean>;
};

function clientForIntent(intent: ClaimedPurchaseIntentBase, options?: PageFetchOptions) {
  const chain = chainObjectForId(intent.chainId);
  if (!chain) throw new Error('unsupported chain');
  return createPublicClient({
    chain,
    transport: options
      ? transportForChain(intent.chainId, { timeout: options.timeoutMs, retryCount: 0 })
      : transportForChain(intent.chainId),
  });
}

export const defaultPurchaseReconcileChain: PurchaseReconcileChain = {
  authorizationExpiredUnused: (intent, options) => authorizationExpiredUnused({
    client: clientForIntent(intent, options),
    token: intent.token,
    payer: intent.claim.payer,
    nonce: intent.claim.nonce,
    validBefore: BigInt(intent.claim.validBefore),
    ...('txHash' in intent ? { txHash: intent.txHash } : {}),
  }),
  authorizationUsed: async (intent, options) =>
    clientForIntent(intent, options).readContract({
      address: intent.token,
      abi: AUTHORIZATION_STATE_ABI,
      functionName: 'authorizationState',
      args: [intent.claim.payer, intent.claim.nonce],
    }),
  latestBlock: async (intent, options) =>
    clientForIntent(intent, options).getBlockNumber(),
  authorizationUsedTransactions: async (intent, fromBlock, toBlock, options) => {
    const logs = await clientForIntent(intent, options).getLogs({
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
  receiptMatches: async (intent, txHash, options) => {
    const receipt = await clientForIntent(intent, options).getTransactionReceipt({
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
