// QR の会計の入金の見張り (lib/qrSaleWatch.ts) が、お店の端末から RPC で読むもの (今ある transport = lib/chains.ts の
// transportForChain・受注の receipt の読み取り lib/orderFeedReceipt.ts と同じ型の client)。server は通らない。
// ガスレスの会計は forwarder の Settled、通常決済の会計は JPYC の Transfer と、その tx の input を読む。
// 読めないときは throw する (その回を飛ばすのは見張りの側)。送り直しはしない。
// テストの既定は「読めない」スタブ (tests/setup.ts): テストが外の RPC を叩かない。

import { createPublicClient, parseAbiItem, type Address, type Hash, type PublicClient } from 'viem';
import { chainObjectForId, transportForChain } from './chains';

/** RPC 1 回の待ち時間の上限。 */
export const QR_SALE_RPC_TIMEOUT_MS = 6_000;

// 絞り込み (topic) に使う event の形。読み解きは見張りの側が lib/order/agentOrderReceipt.ts の receiptSettlements・
// receiptTokenTransfers で行う。
const SETTLED_EVENT = parseAbiItem(
  'event Settled(address indexed from, bytes32 indexed nonce, address indexed merchant, uint256 merchantValue, address feeReceiver, uint256 feeValue)',
);
const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

/** 読んだ log のうち、見張りが使う部分 (どの欄も RPC の応答のまま・確かめるのは見張りの側)。 */
export type QrSaleLog = {
  address: string;
  topics: readonly string[];
  data: string;
  transactionHash: string | null;
  logIndex: number | null;
  blockNumber: bigint | null;
  removed?: boolean;
};

const clients = new Map<number, PublicClient>();

function clientFor(chainId: number): PublicClient {
  let client = clients.get(chainId);
  if (!client) {
    const chain = chainObjectForId(chainId);
    if (!chain) throw new Error('qr_sale_unsupported_chain');
    client = createPublicClient({
      chain,
      transport: transportForChain(chainId, { timeout: QR_SALE_RPC_TIMEOUT_MS, retryCount: 0 }),
    });
    clients.set(chainId, client);
  }
  return client;
}

/** いまの先頭の block の番号。 */
export function readChainHead(chainId: number): Promise<bigint> {
  return clientFor(chainId).getBlockNumber({ cacheTime: 0 });
}

/** forwarder が出した、この受取先 (merchants のどれか) 宛ての Settled の log (fromBlock から toBlock まで・両端を含む)。 */
export async function readSettledLogs(
  chainId: number,
  forwarder: Address,
  merchants: readonly Address[],
  fromBlock: bigint,
  toBlock: bigint,
): Promise<QrSaleLog[]> {
  return clientFor(chainId).getLogs({
    address: forwarder,
    event: SETTLED_EVENT,
    args: { merchant: [...merchants] },
    fromBlock,
    toBlock,
  });
}

/** block の時刻 (unix 秒)。 */
export async function readBlockTime(chainId: number, blockNumber: bigint): Promise<bigint> {
  return (await clientFor(chainId).getBlock({ blockNumber })).timestamp;
}

/** token (JPYC) の、この受取先 (merchants のどれか) 宛ての Transfer の log (fromBlock から toBlock まで・両端を含む)。 */
export async function readTransferLogs(
  chainId: number,
  token: Address,
  merchants: readonly Address[],
  fromBlock: bigint,
  toBlock: bigint,
): Promise<QrSaleLog[]> {
  return clientFor(chainId).getLogs({
    address: token,
    event: TRANSFER_EVENT,
    args: { to: [...merchants] },
    fromBlock,
    toBlock,
  });
}

/** 読んだ tx のうち、見張りが使う部分 (どの欄も RPC の応答のまま・確かめるのは見張りの側)。 */
export type QrSaleTx = {
  from: string;
  /** 宛先 (contract を作る tx は null)。 */
  to: string | null;
  input: string;
};

/** tx の送り手・宛先・input。tx が見つからない (null) ときも throw する (viem の getTransaction)。 */
export async function readTransaction(chainId: number, hash: Hash): Promise<QrSaleTx> {
  const tx = await clientFor(chainId).getTransaction({ hash });
  return { from: tx.from, to: tx.to ?? null, input: tx.input };
}
