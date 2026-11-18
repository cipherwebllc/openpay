// QR の会計の入金 (bill key) のテストで使う道具: 払う側が署名する nonce と、RPC が返す Settled の log。通常決済の会計の
// テストには、印の付いた transfer の calldata と、RPC が返す Transfer の log。
// nonce は払う側と同じ関数 (lib/relay/forwarderIntent の buildForwarderNonce・lib/relay/billKeySalt の billKeySalt) で作る。
// log は viem で encode した本物の形 (lib/order/agentOrderReceipt.ts の strict な decode を通る)。

import { concatHex, encodeFunctionData, erc20Abi, type Address, type Hex } from 'viem';
import { env } from '@/lib/env';
import type { QrSaleLog } from '@/lib/qrSaleRpc';
import { billKeySalt, billKeyStdMark } from '@/lib/relay/billKeySalt';
import { buildForwarderNonce } from '@/lib/relay/forwarderIntent';
import { settledLog, transferLog } from './orderSaleReceipt';

export type SignedSale = {
  from: Address;
  merchant: Address;
  merchantValue: bigint;
  feeValue: bigint;
  validBefore: bigint;
  chainId: number;
  forwarder: Address;
  /** 既定 = build の利用料の受取口 (払う側の画面と同じ)。 */
  feeReceiver?: Address;
};

/** 払う側が、この bill key の QR から署名する nonce (hooks/useJpycEip3009Payment の recover の分岐と同じ式)。 */
export function billNonce(billKey: string, sale: SignedSale): Hex {
  const intentSalt = billKeySalt(billKey);
  if (!intentSalt) throw new Error(`形の違う bill key: ${billKey}`);
  return saltNonce(intentSalt, sale);
}

/** 決まった intentSalt (乱数・注文の束縛など) で署名した nonce。 */
export function saltNonce(intentSalt: Hex, sale: SignedSale): Hex {
  return buildForwarderNonce(
    {
      from: sale.from,
      merchant: sale.merchant,
      merchantValue: sale.merchantValue,
      feeReceiver: sale.feeReceiver ?? (env.feeReceiver as Address),
      feeValue: sale.feeValue,
      validAfter: 0n,
      validBefore: sale.validBefore,
      intentSalt,
    },
    sale.chainId,
    sale.forwarder,
  );
}

/** RPC (getLogs) が返す Settled の log 1 つ。 */
export function settledRpcLog(a: {
  forwarder: Address;
  from: Address;
  merchant: Address;
  merchantValue: bigint;
  feeValue: bigint;
  nonce: Hex;
  txHash: string;
  blockNumber: bigint;
  logIndex?: number;
  feeReceiver?: Address;
}): QrSaleLog {
  return {
    ...settledLog(a.forwarder, {
      from: a.from,
      merchant: a.merchant,
      merchantValue: a.merchantValue,
      feeReceiver: a.feeReceiver ?? (env.feeReceiver as Address),
      feeValue: a.feeValue,
      nonce: a.nonce,
    }),
    transactionHash: a.txHash,
    logIndex: a.logIndex ?? 0,
    blockNumber: a.blockNumber,
  };
}

/** ERC-20 の transfer(to, value) の calldata (印なし = 今の払う側の通常決済が送る形)。 */
export function plainTransfer(to: Address, value: bigint): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, value] });
}

/** 通常決済の印の付いた transfer の calldata (transfer(to, value) + この bill key の印 32 byte)。 */
export function markedTransfer(billKey: string, to: Address, value: bigint): Hex {
  const mark = billKeyStdMark(billKey);
  if (!mark) throw new Error(`形の違う bill key: ${billKey}`);
  return concatHex([plainTransfer(to, value), mark]);
}

/** RPC (getLogs) が返す token の Transfer の log 1 つ。 */
export function transferRpcLog(a: {
  token: Address;
  from: Address;
  to: Address;
  value: bigint;
  txHash: string;
  blockNumber: bigint;
  logIndex?: number;
}): QrSaleLog {
  return {
    ...transferLog(a.token, a.from, a.to, a.value),
    transactionHash: a.txHash,
    logIndex: a.logIndex ?? 0,
    blockNumber: a.blockNumber,
  };
}
