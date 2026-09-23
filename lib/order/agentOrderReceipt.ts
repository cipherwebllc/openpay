import { decodeEventLog, isAddressEqual, parseAbi, type Address, type Hex } from 'viem';
import type { FeeReceiptLog } from '@/lib/feeVerify';

const AUTHORIZATION_ABI = parseAbi([
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
]);
const SETTLED_ABI = parseAbi([
  'event Settled(address indexed from, bytes32 indexed nonce, address indexed merchant, uint256 merchantValue, address feeReceiver, uint256 feeValue)',
]);

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
  return logs.some((log) => {
    if (log.address.toLowerCase() !== tuple.forwarder.toLowerCase()) return false;
    try {
      const { args } = decodeEventLog({ abi: SETTLED_ABI, eventName: 'Settled', topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex, strict: true });
      return isAddressEqual(args.from, tuple.authorizer) && args.nonce.toLowerCase() === tuple.nonce.toLowerCase() &&
        isAddressEqual(args.merchant, tuple.merchant) && args.merchantValue === BigInt(tuple.merchantValue) &&
        isAddressEqual(args.feeReceiver, tuple.feeReceiver) && args.feeValue === BigInt(tuple.feeValue);
    } catch {
      // Transfer / unrelated logs must not unlock a reserved order as a Settled event.
      return false;
    }
  });
}
