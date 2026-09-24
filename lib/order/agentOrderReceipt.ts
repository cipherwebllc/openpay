import { decodeEventLog, isAddressEqual, parseAbi, type Address, type Hex } from 'viem';
import type { FeeReceiptLog } from '@/lib/feeVerify';

const AUTHORIZATION_ABI = parseAbi([
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
]);
const SETTLED_ABI = parseAbi([
  'event Settled(address indexed from, bytes32 indexed nonce, address indexed merchant, uint256 merchantValue, address feeReceiver, uint256 feeValue)',
]);
const TRANSFER_ABI = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);

// Human checkout and agent finalization share strict event decoding and emitter checks.
export function receiptSettlements(logs: readonly FeeReceiptLog[], forwarder: Address) {
  return logs.flatMap((log) => {
    if (log.address.toLowerCase() !== forwarder.toLowerCase()) return [];
    try {
      return [decodeEventLog({ abi: SETTLED_ABI, eventName: 'Settled', topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex, strict: true }).args];
    } catch {
      // Unrelated/malformed logs must not become settlement evidence.
      return [];
    }
  });
}

export function receiptTokenTransfers(logs: readonly FeeReceiptLog[], token: Address) {
  return logs.flatMap((log) => {
    if (log.address.toLowerCase() !== token.toLowerCase()) return [];
    try {
      return [decodeEventLog({ abi: TRANSFER_ABI, eventName: 'Transfer', topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex, strict: true }).args];
    } catch {
      // Unrelated/malformed logs must not establish payment attribution.
      return [];
    }
  });
}

export type AgentSettlementTuple = {
  chainId: number;
  token: Address;
  forwarder: Address;
  authorizer: Address;
  nonce: Hex;
  merchant: Address;
  merchantValue: string;
  feeReceiver: Address;
  feeValue: string;
};

// Analyze the already fetched receipt: a batch can consume more than one authorization.
export function receiptAuthorizations(logs: readonly FeeReceiptLog[], token: Address) {
  const authorizations: { authorizer: Address; nonce: Hex }[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== token.toLowerCase()) continue;
    try {
      const event = decodeEventLog({ abi: AUTHORIZATION_ABI, eventName: 'AuthorizationUsed', topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex, strict: true });
      authorizations.push(event.args);
    } catch {
      // Other token events / malformed lookalikes must not become authorization evidence.
    }
  }
  return authorizations;
}

export function matchesAgentSettlement(logs: readonly FeeReceiptLog[], tuple: AgentSettlementTuple): boolean {
  return receiptSettlements(logs, tuple.forwarder).some((args) => {
    try {
      return isAddressEqual(args.from, tuple.authorizer) && args.nonce.toLowerCase() === tuple.nonce.toLowerCase() &&
        isAddressEqual(args.merchant, tuple.merchant) && args.merchantValue === BigInt(tuple.merchantValue) &&
        isAddressEqual(args.feeReceiver, tuple.feeReceiver) && args.feeValue === BigInt(tuple.feeValue);
    } catch {
      // Preserve A2b's fail-closed tuple matching: malformed amounts must not unlock an agent order.
      return false;
    }
  });
}
