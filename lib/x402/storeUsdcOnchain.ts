import 'server-only';

import {
  createPublicClient,
  getAddress,
  isAddressEqual,
  parseAbi,
  parseEventLogs,
  type Address,
  type Hex,
} from 'viem';
import { base } from 'viem/chains';
import { transportForChain } from '@/lib/chains';
import { kvGet } from '@/lib/kv';
import { authorizationExpiredUnused } from '@/lib/x402/authorizationExpiry';
import {
  legacyBillingPaymentKey,
  paymentClaimKey,
} from '@/lib/paymentClaim';

export const STORE_USDC_CHAIN_ID = 8453;
export const STORE_USDC_ADDRESS = getAddress(
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
);
export const STORE_USDC_FINALITY_CONFIRMATIONS = 15n;

const USDC_EVENTS_ABI = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
]);
const AUTHORIZATION_STATE_ABI = parseAbi([
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
]);

export type StoreUsdcOnchainIntent = {
  intentSalt: Hex;
  chainId: number;
  payer: Address;
  merchant: Address;
  nonce: Hex;
  usdcQuoteAtomic: string;
  anchorBlock: string;
};

export type StoreUsdcPublicClient = {
  getTransactionReceipt: (args: { hash: Hex }) => Promise<{
    status: 'success' | 'reverted';
    blockNumber: bigint;
    /** receipt が属するブロックの hash。confirmed の前に同じ番号の正規ブロックと照合する (B6)。 */
    blockHash: Hex;
    logs: readonly {
      address: Address;
      data: Hex;
      topics: readonly Hex[];
      transactionHash?: Hex | null;
    }[];
  }>;
  getBlock: (args: { blockTag: 'safe' | 'finalized' } | { blockNumber: bigint }) => Promise<{
    number: bigint | null;
    hash?: Hex | null;
    timestamp?: bigint;
  }>;
  getBlockNumber: () => Promise<bigint>;
  readContract: (args: {
    address: Address;
    abi: typeof AUTHORIZATION_STATE_ABI;
    functionName: 'authorizationState';
    args: readonly [Address, Hex];
    /** 期限切れ未使用の証明 (authorizationExpiredUnused) は finalized の hash に固定して読む (EIP-1898)。 */
    blockHash?: Hex;
    requireCanonical?: true;
  }) => Promise<boolean>;
  getLogs: (args: {
    address: Address;
    event: (typeof USDC_EVENTS_ABI)[1];
    args: { authorizer: Address; nonce: Hex };
    fromBlock: bigint;
    toBlock: bigint;
  }) => Promise<readonly { transactionHash: Hex | null }[]>;
};

// budget = deadline 付き (cron) の呼び出しだけ retry なし・timeoutMs と絶対期限 deadlineAt で呼ぶ (第 7 回レビュー B4
// follow-up)。transport は RPC ごとに deadlineAt までの残り時間から signal を作る (本文受信まで効く)。
export type StoreUsdcRpcBudget = { timeoutMs: number; deadlineAt: number };
function baseClient(budget?: StoreUsdcRpcBudget): StoreUsdcPublicClient {
  return createPublicClient({
    chain: base,
    transport: budget === undefined
      ? transportForChain(base.id)
      : transportForChain(base.id, { timeout: budget.timeoutMs, retryCount: 0, deadline: budget.deadlineAt }),
  }) as unknown as StoreUsdcPublicClient;
}

/** deadline 付き reconcile の全 RPC が使う、retry なし・予算 (timeout と絶対期限) を絞った Base client。各 RPC の直前に作る。 */
export function storeUsdcBoundedClient(budget: StoreUsdcRpcBudget): StoreUsdcPublicClient {
  return baseClient(budget);
}

export function storeUsdcAuthorizationExpiredUnused(input: {
  payer: Address;
  nonce: Hex;
  validBefore: bigint;
  txHash?: Hex;
  client?: StoreUsdcPublicClient;
}): Promise<boolean> {
  return authorizationExpiredUnused({
    ...input,
    token: STORE_USDC_ADDRESS,
    client: input.client ?? baseClient(),
  });
}

export async function readStoreUsdcAnchorBlock(
  client?: StoreUsdcPublicClient,
): Promise<bigint | null> {
  try {
    return await (client ?? baseClient()).getBlockNumber();
  } catch {
    return null;
  }
}

export type StoreUsdcOnchainVerification =
  | { ok: true; state: 'confirmed'; blockNumber: bigint }
  /**
   * pending の理由は呼び出し側の分岐に使う:
   *   'receipt'   = receipt が読めない (欠落/一時障害)
   *   'finality'  = 正規チェーンとの一致を確認できた (または高さ不足で照合先に無く判別不能な) receipt が
   *                 safe 未到達・確認数不足 (同じ hash を待てばよい)
   *   'canonical' = receipt のブロックが今の正規チェーンに無い (旧フォーク)。高さに関係なく、同じ hash を待っても
   *                 解決しない — 保存済み hash なら replacement 探索へ進み、走査中の候補なら採らずに飛ばす。
   *   'unverified' = 高さが足りず、照合先のノードに同じ番号のブロックがまだ無い (旧フォークか未到達か判別不能)。
   *                 'finality' (正規と一致を確認済み) と混同しない — 保存済み hash の待ちで replacement 探索を止めない。
   */
  | { ok: true; state: 'pending'; reason: 'receipt' | 'finality' | 'canonical' | 'unverified' }
  | {
      ok: false;
      reason:
        | 'chain_mismatch'
        | 'receipt_reverted'
        | 'transfer_missing'
        | 'authorization_missing'
        | 'transaction_consumed'
        | 'rpc_unavailable';
    };

function exactUsdcEvents(input: {
  logs: readonly {
    address: Address;
    data: Hex;
    topics: readonly Hex[];
  }[];
  payer: Address;
  merchant: Address;
  nonce: Hex;
  value: bigint;
}): { transfer: boolean; authorization: boolean } {
  const tokenLogs = input.logs.filter((log) =>
    isAddressEqual(log.address, STORE_USDC_ADDRESS),
  );
  const transfers = parseEventLogs({
    abi: USDC_EVENTS_ABI,
    eventName: 'Transfer',
    logs: tokenLogs as never,
    strict: true,
  });
  const authorizations = parseEventLogs({
    abi: USDC_EVENTS_ABI,
    eventName: 'AuthorizationUsed',
    logs: tokenLogs as never,
    strict: true,
  });
  return {
    transfer: transfers.some(
      ({ args }) =>
        isAddressEqual(args.from, input.payer) &&
        isAddressEqual(args.to, input.merchant) &&
        args.value === input.value,
    ),
    authorization: authorizations.some(
      ({ args }) =>
        isAddressEqual(args.authorizer, input.payer) &&
        args.nonce.toLowerCase() === input.nonce.toLowerCase(),
    ),
  };
}

async function hasRequiredFinality(
  client: StoreUsdcPublicClient,
  receiptBlock: bigint,
): Promise<boolean | 'unavailable'> {
  try {
    const safe = await client.getBlock({ blockTag: 'safe' });
    if (safe.number !== null && safe.number >= receiptBlock) return true;
  } catch {
    // safe tag 非対応/一時障害時も、15 confirmations の独立条件で判定できる。
  }
  try {
    const latest = await client.getBlockNumber();
    return latest >= receiptBlock &&
      latest - receiptBlock + 1n >= STORE_USDC_FINALITY_CONFIRMATIONS;
  } catch {
    return 'unavailable';
  }
}

/**
 * receipt のブロックが**今の**正規チェーンに属するか (同じ番号の正規ブロックの hash と一致するか)。
 * hasRequiredFinality は高さしか見ないので、RPC が旧フォークの成功 receipt (同じ番号・別 hash) を返すと
 * safe 到達や 15 confirmations を満たしたまま confirmed にできてしまう (第 7 回レビュー B6)。license の
 * reconcile (lib/license/reconcile.ts) と同じ照合を confirmed の前に置く。不一致は terminal にしない
 * (正当な購入を失敗化しない) — pending 'canonical' として返し、保存済み hash なら reconcile が同じ nonce の
 * replacement を正規チェーンで探し、候補ならそのページから再試行する。
 */
async function receiptIsCanonical(
  client: StoreUsdcPublicClient,
  receipt: { blockNumber: bigint; blockHash: Hex },
): Promise<boolean | 'unavailable'> {
  try {
    const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
    return canonical.hash === receipt.blockHash;
  } catch {
    return 'unavailable';
  }
}

/** entitlement 発行前の Base receipt 7 条件。global claim の確定 CAS は finalizer 内で再検査する。 */
export async function verifyStoreUsdcOnchain(input: {
  intent: StoreUsdcOnchainIntent;
  txHash: Hex;
  client?: StoreUsdcPublicClient;
}): Promise<StoreUsdcOnchainVerification> {
  if (input.intent.chainId !== STORE_USDC_CHAIN_ID) {
    return { ok: false, reason: 'chain_mismatch' };
  }
  const client = input.client ?? baseClient();
  let receipt: Awaited<ReturnType<StoreUsdcPublicClient['getTransactionReceipt']>>;
  try {
    receipt = await client.getTransactionReceipt({ hash: input.txHash });
  } catch {
    return { ok: true, state: 'pending', reason: 'receipt' };
  }
  if (receipt.status !== 'success') {
    return { ok: false, reason: 'receipt_reverted' };
  }
  const events = exactUsdcEvents({
    logs: receipt.logs,
    payer: input.intent.payer,
    merchant: input.intent.merchant,
    nonce: input.intent.nonce,
    value: BigInt(input.intent.usdcQuoteAtomic),
  });
  if (!events.transfer) return { ok: false, reason: 'transfer_missing' };
  if (!events.authorization) {
    return { ok: false, reason: 'authorization_missing' };
  }
  const finality = await hasRequiredFinality(client, receipt.blockNumber);
  if (finality === 'unavailable') {
    return { ok: false, reason: 'rpc_unavailable' };
  }
  // 条件7 (B6): receipt が今の正規チェーンのブロックに属すること。高さの判定 (finality 待ちの早期 return) より
  // **前**に置く — 旧フォークの保存済み receipt が高さの条件を満たさないまま (safe の応答が停滞する等) だと
  // 'finality' で同じ hash を待ち続け、正規チェーンで確定済みの replacement の探索へ進めない (Codex 3 回目 P2)。
  // 'finality' を返すのは正規チェーンと一致を確認できた receipt だけ。
  const canonical = await receiptIsCanonical(client, receipt);
  if (canonical === 'unavailable') {
    // 高さが足りない receipt のブロックは、照合先のノードにまだ無いことがある (旧フォークか未到達か判別不能)
    // → 'unverified' (通常の finality 待ちとは別の理由・採らない・terminal にしない)。高さを満たしているのに
    // 照会できないのは読み取り障害 → rpc_unavailable (呼び出し側がそのページから再試行)。
    return finality
      ? { ok: false, reason: 'rpc_unavailable' }
      : { ok: true, state: 'pending', reason: 'unverified' };
  }
  // 通常の finality 待ちと区別する (同じ hash を待ち続けると、同じ nonce の replacement が正規チェーンで
  // 支払い済みでも、古い receipt を返し続ける RPC のせいに解錠できない)。高さに関係なく・terminal にはしない。
  if (!canonical) return { ok: true, state: 'pending', reason: 'canonical' };
  if (!finality) return { ok: true, state: 'pending', reason: 'finality' };

  const [claim, legacyBilling] = await Promise.all([
    kvGet(paymentClaimKey(STORE_USDC_CHAIN_ID, input.txHash)),
    kvGet(legacyBillingPaymentKey(STORE_USDC_CHAIN_ID, input.txHash)),
  ]);
  if (!claim.ok || !legacyBilling.ok) {
    return { ok: false, reason: 'rpc_unavailable' };
  }
  if (
    legacyBilling.value !== null ||
    claim.value !== null &&
    claim.value !== `r:store:${input.intent.intentSalt}`
  ) {
    return { ok: false, reason: 'transaction_consumed' };
  }
  return { ok: true, state: 'confirmed', blockNumber: receipt.blockNumber };
}

export async function readStoreUsdcAuthorizationState(input: {
  payer: Address;
  nonce: Hex;
  client?: StoreUsdcPublicClient;
}): Promise<boolean | 'unavailable'> {
  try {
    return await (input.client ?? baseClient()).readContract({
      address: STORE_USDC_ADDRESS,
      abi: AUTHORIZATION_STATE_ABI,
      functionName: 'authorizationState',
      args: [input.payer, input.nonce],
    });
  } catch {
    return 'unavailable';
  }
}

export async function findStoreUsdcAuthorizationTransactions(input: {
  payer: Address;
  nonce: Hex;
  fromBlock: bigint;
  toBlock: bigint;
  client?: StoreUsdcPublicClient;
  // deadline 付き (cron) のページ取得の RPC 予算。client を渡す呼出 (テスト) はそのまま使う。
  budget?: StoreUsdcRpcBudget;
}): Promise<Hex[] | 'unavailable'> {
  try {
    const logs = await (input.client ?? baseClient(input.budget)).getLogs({
      address: STORE_USDC_ADDRESS,
      event: USDC_EVENTS_ABI[1],
      args: { authorizer: input.payer, nonce: input.nonce },
      fromBlock: input.fromBlock,
      toBlock: input.toBlock,
    });
    return [
      ...new Set(
        logs.flatMap((log) =>
          log.transactionHash ? [log.transactionHash.toLowerCase() as Hex] : [],
        ),
      ),
    ];
  } catch {
    return 'unavailable';
  }
}
