// QR の会計の入金 (bill key) のテストで使う道具: 払う側が署名する nonce と、RPC が返す Settled の log。
// nonce は払う側と同じ関数 (lib/relay/forwarderIntent の buildForwarderNonce・lib/relay/billKeySalt の billKeySalt) で作る。
// log は viem で encode した本物の形 (lib/order/agentOrderReceipt.ts の strict な decode を通る)。

import type { Address, Hex } from 'viem';
import { env } from '@/lib/env';
import type { QrSaleLog } from '@/lib/qrSaleRpc';
import { billKeySalt } from '@/lib/relay/billKeySalt';
import { buildForwarderNonce } from '@/lib/relay/forwarderIntent';
import { settledLog } from './orderSaleReceipt';

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
