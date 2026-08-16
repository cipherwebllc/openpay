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
    logs: readonly {
      address: Address;
      data: Hex;
      topics: readonly Hex[];
      transactionHash?: Hex | null;
    }[];
  }>;
  getBlock: (args: { blockTag: 'safe' }) => Promise<{
    number: bigint | null;
  }>;
  getBlockNumber: () => Promise<bigint>;
  readContract: (args: {
    address: Address;
    abi: typeof AUTHORIZATION_STATE_ABI;
    functionName: 'authorizationState';
    args: readonly [Address, Hex];
  }) => Promise<boolean>;
  getLogs: (args: {
    address: Address;
    event: (typeof USDC_EVENTS_ABI)[1];
    args: { authorizer: Address; nonce: Hex };
    fromBlock: bigint;
    toBlock: 'latest';
  }) => Promise<readonly { transactionHash: Hex | null }[]>;
};

function baseClient(): StoreUsdcPublicClient {
  return createPublicClient({
    chain: base,
    transport: transportForChain(base.id),
  }) as unknown as StoreUsdcPublicClient;
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
  | { ok: true; state: 'pending'; reason: 'receipt' | 'finality' }
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

/** entitlement 発行前の Base receipt 6 条件。global claim の確定 CAS は finalizer 内で再検査する。 */
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
  client?: StoreUsdcPublicClient;
}): Promise<Hex[] | 'unavailable'> {
  try {
    const logs = await (input.client ?? baseClient()).getLogs({
      address: STORE_USDC_ADDRESS,
      event: USDC_EVENTS_ABI[1],
      args: { authorizer: input.payer, nonce: input.nonce },
      fromBlock: input.fromBlock,
      toBlock: 'latest',
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
