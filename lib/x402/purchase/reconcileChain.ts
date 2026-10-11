import 'server-only';

// reconcile が使う on-chain 読み取りの adapter (R3d): authorizationState・AuthorizationUsed の log・Forwarder の
// Settled receipt の厳密照合 (finalized・canonical なブロックのものだけ) と、finalized block での期限切れ未使用の証明・
// 取り消し (AuthorizationCanceled) の証明。test は PurchaseReconcileChain を差し替える。
import {
  createPublicClient,
  isAddressEqual,
  parseAbi,
  parseEventLogs,
  type Hex,
} from 'viem';
import { chainObjectForId, transportForChain } from '@/lib/chains';
import { findFinalizedAuthorizationCancel, type AuthorizationCancelEvidence } from '@/lib/x402/authorizationCancel';
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
  // 一致する Settled を持つ成功 receipt が finalized・canonical なブロックにあるときだけ true。一致しないときは false。
  // 一致したがまだ確定と確かめられないときは PurchaseReceiptNotFinalizedError を投げる (reconcile は確定させず pending の
  // まま、候補のページから次の照合で再試行する)。
  receiptMatches: (
    intent: ClaimedPurchaseIntentBase,
    txHash: Hex,
    options?: PageFetchOptions,
  ) => Promise<boolean>;
  // [fromBlock, toBlock] の finalized・canonical な AuthorizationCanceled(payer, nonce)。証拠を返せない adapter
  // (この method が無いもの) は、取り消された購入を終端にしない (従来どおり pending のまま)。
  authorizationCanceled?: (
    intent: ClaimedPurchaseIntentBase & { txHash?: Hex },
    fromBlock: bigint,
    toBlock: bigint,
    options?: PageFetchOptions,
  ) => Promise<AuthorizationCancelEvidence | null>;
};

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * 照合の経路 (reconcile) で、一致した receipt をまだ確定と確かめられないときに receiptMatches が投げる。
 * 2026-10-12 (Grok 再レビュー・user 承認): 以前は latest の receipt で確定させていた。USDC rail の reconcile
 * (lib/x402/storeUsdcOnchain.ts) と同じく、確定前の receipt で購入を確定させない (reorg で消えうる支払いで解錠しない)。
 * false (= 一致しない) にしないのは、走査の cursor が候補のページを越えて支払いを再発見できなくなるため。reconcile は
 * receipt の一時障害と同じに扱い、pending のまま候補のページ (保存済み hash なら次回の読み直し) から再試行する。
 * 決済直後の通常経路 (facilitator の settle 成功で確定する) はこの adapter を通らない。
 */
export class PurchaseReceiptNotFinalizedError extends Error {
  constructor(readonly reason: 'finalized_unavailable' | 'not_finalized' | 'not_canonical' | 'finality_changed') {
    super(`purchase receipt not finalized: ${reason}`);
    this.name = 'PurchaseReceiptNotFinalizedError';
  }
}

type FinalityClient = {
  getBlock: (args: { blockTag: 'finalized' } | { blockNumber: bigint }) => Promise<{ number: bigint | null; hash?: Hex | null }>;
};

/**
 * receipt のブロックが finalized 以下で、今の正規チェーンに属することを確かめる (確かめられなければ throw)。
 * finalized の取り方は取り消しの証明 (findFinalizedAuthorizationCancel) と license の reconcile にそろえる:
 * finalized tag のブロック (番号と hash の形を検査) → receipt のブロックの canonical hash → finalized の hash の再確認
 * (別 fork のノードの応答で確定させない)。
 */
async function assertReceiptFinalized(
  client: FinalityClient,
  receipt: { blockNumber: bigint | null; blockHash: Hex | null },
): Promise<void> {
  const finalized = await client.getBlock({ blockTag: 'finalized' });
  if (typeof finalized.number !== 'bigint' || typeof finalized.hash !== 'string' || !HASH_RE.test(finalized.hash)) {
    throw new PurchaseReceiptNotFinalizedError('finalized_unavailable');
  }
  // ブロックの無い receipt (RPC の不正な応答) は、番号の比較で 0 扱いになって確定と読まれないよう、ここで止める。
  if (typeof receipt.blockNumber !== 'bigint' || typeof receipt.blockHash !== 'string' || receipt.blockNumber > finalized.number) {
    throw new PurchaseReceiptNotFinalizedError('not_finalized');
  }
  const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (canonical.hash !== receipt.blockHash) throw new PurchaseReceiptNotFinalizedError('not_canonical');
  // receipt が finalized のブロックそのものなら、canonical の読み取りが finalized の再確認を兼ねる。
  const stillFinal = receipt.blockNumber === finalized.number
    ? canonical
    : await client.getBlock({ blockNumber: finalized.number });
  if (stillFinal.hash !== finalized.hash) throw new PurchaseReceiptNotFinalizedError('finality_changed');
}

function clientForIntent(intent: ClaimedPurchaseIntentBase, options?: PageFetchOptions) {
  const chain = chainObjectForId(intent.chainId);
  if (!chain) throw new Error('unsupported chain');
  return createPublicClient({
    chain,
    // deadline = この呼び出しの絶対期限。transport は RPC ごとに残り時間から signal を作る (作成時の signal で後続を切らない)。
    transport: options
      ? transportForChain(intent.chainId, { timeout: options.timeoutMs, retryCount: 0, deadline: options.deadlineAt })
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
    const client = clientForIntent(intent, options);
    const receipt = await client.getTransactionReceipt({
      hash: txHash,
    });
    if (receipt.status !== 'success') return false;
    const matches = parseEventLogs({
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
    if (!matches) return false;
    // 一致した receipt だけ確定を確かめる (一致しないものに finality の RPC を使わない)。確定前は throw。
    await assertReceiptFinalized(client, receipt);
    return true;
  },
  authorizationCanceled: (intent, fromBlock, toBlock, options) => findFinalizedAuthorizationCancel({
    client: clientForIntent(intent, options),
    token: intent.token,
    forwarder: intent.forwarder,
    payer: intent.claim.payer,
    nonce: intent.claim.nonce,
    fromBlock,
    toBlock,
    ...(intent.txHash ? { txHash: intent.txHash } : {}),
  }),
};
