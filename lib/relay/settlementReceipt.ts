import 'server-only';

import { isAddressEqual, parseAbi, parseEventLogs, type Address, type Hex, type Log } from 'viem';
import type { ForwarderSettleParams } from '@/lib/relay/forwarderIntent';

const FORWARDER_SETTLED_EVENT_ABI = parseAbi([
  'event Settled(address indexed from, bytes32 indexed nonce, address indexed merchant, uint256 merchantValue, address feeReceiver, uint256 feeValue)',
]);

export function hasMatchingForwarderSettlement(
  logs: Log[],
  forwarder: Address,
  payer: Address,
  nonce: Hex,
  split?: Pick<ForwarderSettleParams, 'merchant' | 'merchantValue' | 'feeReceiver' | 'feeValue'>,
): boolean {
  // Eip3009Forwarder は merchant / feeReceiver 双方への safeTransfer が成功した後にだけ
  // Settled を emit し、失敗時は tx 全体が revert する。そのため expected forwarder 発火かつ
  // 6 field 完全一致の event が対象 settle の成立証明になる。同一 batch の別 settle を
  // nonce だけで誤帰属させず、receipt 全体の Transfer 合算で正規 batch を拒否もしない。
  // nonce-only lookup では分割値を再送しないが、nonce 自体が chain / forwarder / 全分割値への
  // commitment。信頼する forwarder の payer + nonce 一致で、その分割の成功を確認できる。
  return parseEventLogs({
    abi: FORWARDER_SETTLED_EVENT_ABI,
    eventName: 'Settled',
    logs: logs.filter((log) => isAddressEqual(log.address, forwarder)),
    strict: true,
  }).some(
    ({ args }) =>
      isAddressEqual(args.from, payer) &&
      args.nonce.toLowerCase() === nonce.toLowerCase() &&
      (!split || (
        isAddressEqual(args.merchant, split.merchant) &&
        args.merchantValue === split.merchantValue &&
        isAddressEqual(args.feeReceiver, split.feeReceiver) &&
        args.feeValue === split.feeValue
      )),
  );
}
