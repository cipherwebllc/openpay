// 受注の tx の receipt (forwarder の Settled・token の Transfer) を、テストで組むための道具。
// log は viem で encode した本物の形 (lib/order/agentOrderReceipt.ts の strict な decode を通る)。

import { encodeAbiParameters, encodeEventTopics, parseAbi, type Address, type Hex } from 'viem';
import type { OrderSaleReceipt } from '@/lib/orderFeedHistory';

const ABI = parseAbi([
  'event Settled(address indexed from, bytes32 indexed nonce, address indexed merchant, uint256 merchantValue, address feeReceiver, uint256 feeValue)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

type TestLog = OrderSaleReceipt['logs'][number];

export function transferLog(token: Address, from: Address, to: Address, value: bigint): TestLog {
  return {
    address: token,
    topics: encodeEventTopics({ abi: ABI, eventName: 'Transfer', args: { from, to } }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
  };
}

export function settledLog(
  forwarder: Address,
  s: { from: Address; merchant: Address; merchantValue: bigint; feeReceiver: Address; feeValue: bigint; nonce?: Hex },
): TestLog {
  return {
    address: forwarder,
    topics: encodeEventTopics({
      abi: ABI,
      eventName: 'Settled',
      args: { from: s.from, nonce: s.nonce ?? (`0x${'ab'.repeat(32)}` as Hex), merchant: s.merchant },
    }) as Hex[],
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }],
      [s.merchantValue, s.feeReceiver, s.feeValue],
    ),
  };
}

/** forwarder.settle の receipt: お客様 → forwarder、forwarder → お店・利用料の受取先、Settled。 */
export function recoverReceipt(a: {
  token: Address;
  forwarder: Address;
  customer: Address;
  merchant: Address;
  merchantValue: bigint;
  feeReceiver: Address;
  feeValue: bigint;
  blockNumber?: bigint;
}): OrderSaleReceipt {
  return {
    status: 'success',
    blockNumber: a.blockNumber ?? 777n,
    logs: [
      transferLog(a.token, a.customer, a.forwarder, a.merchantValue + a.feeValue),
      transferLog(a.token, a.forwarder, a.merchant, a.merchantValue),
      transferLog(a.token, a.forwarder, a.feeReceiver, a.feeValue),
      settledLog(a.forwarder, {
        from: a.customer,
        merchant: a.merchant,
        merchantValue: a.merchantValue,
        feeReceiver: a.feeReceiver,
        feeValue: a.feeValue,
      }),
    ],
  };
}

/** お客様から受取先への直接の Transfer 1 本の receipt (通常決済・forwarder を通らない relay)。 */
export function directReceipt(a: {
  token: Address;
  customer: Address;
  merchant: Address;
  value: bigint;
  blockNumber?: bigint;
}): OrderSaleReceipt {
  return {
    status: 'success',
    blockNumber: a.blockNumber ?? 123n,
    logs: [transferLog(a.token, a.customer, a.merchant, a.value)],
  };
}
