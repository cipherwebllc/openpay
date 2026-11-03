// 注文リンクの「入金を確かめる」: お客様から届いた Tx Hash で、受取ウォレットに JPYC が届いたかをチェーンから読む。
// OpenPay のサーバーには何も送らず、ブラウザからチェーンの RPC を読むだけ (注文の内容を受け取らない・2026-11-03)。
//
// 発送の判断に使うので、数えるのは「成功した取引の、その受取チェーンの JPYC の Transfer のうち、受取ウォレット宛て」
// だけ。別のトークン・別の宛先・失敗した取引は届いた額に入れない (偽の Tx Hash や他人宛ての取引で発送させない)。
// 受付番号はチェーンに残らないので、注文との照合は額と時刻でお店がする (画面で伝える)。

import {
  createPublicClient,
  erc20Abi,
  formatUnits,
  isAddressEqual,
  parseEventLogs,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from 'viem';
import { chainForSlug, chainObjectForId, transportForChain, type ChainSlug } from './chains';
import { deploymentForSlug } from './tokens';

export type OrderLinkPaymentCheck =
  /** 受取ウォレットに届いた (received は表示用の 10 進)。 */
  | { status: 'paid'; received: string; blockNumber: bigint; timestamp: number }
  /** 取引は成功しているが、受取ウォレット宛ての JPYC が無い (別の宛先・別のトークン)。 */
  | { status: 'notToReceiver' }
  /** 取引が失敗している (支払いは届いていない)。 */
  | { status: 'failed' }
  /** この受取チェーンに無い (チェーン違い・まだ確定していない)。 */
  | { status: 'notFound' }
  /** Tx Hash が読み取れない。 */
  | { status: 'invalid' }
  /** RPC に問い合わせできなかった。 */
  | { status: 'error' };

const TX_HASH = /0x[0-9a-fA-F]{64}/;

// 確かめた支払いの記録 (この端末だけ)。同じ Tx Hash を 2 つの注文に使い回されて 2 回発送しないよう、2 回目に知らせる。
const CHECKED_KEY = 'openpay:order-link-checked:v1';
const CHECKED_MAX = 300;

// localStorage は読むだけで例外になる環境がある (プライベートモード等)。使えなければ記録しない (掟 13)。
function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * 届いたと確かめた支払いを記録し、前に確かめていればそのときの時刻 (ms) を返す (初めてなら null)。
 * localStorage が使えない環境では記録せず null (確かめる機能そのものは止めない・掟 13)。
 */
export function rememberCheckedPayment(
  input: { chain: ChainSlug; receiver: Address; hash: Hex; now: number },
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = browserStorage(),
): number | null {
  if (!storage) return null;
  const key = `${input.chain}:${input.receiver.toLowerCase()}:${input.hash.toLowerCase()}`;
  let checked: Record<string, number> = {};
  try {
    const raw = storage.getItem(CHECKED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) checked = parsed as Record<string, number>;
  } catch {
    // 壊れた記録・読めない保存領域は空として扱い、下で作り直す (確かめる機能そのものは止めない・掟 13)。
  }
  const previous = typeof checked[key] === 'number' ? checked[key] : null;
  if (previous !== null) return previous;
  checked[key] = input.now;
  // 古いものから捨てて上限を保つ (端末の保存領域を食い続けない)。
  const kept = Object.entries(checked)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .sort((x, y) => y[1] - x[1])
    .slice(0, CHECKED_MAX);
  try {
    storage.setItem(CHECKED_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // 満杯・使えない: 記録は諦め、確かめた結果はそのまま出す (掟 13)。
  }
  return null;
}

/** 貼られた文から最初の Tx Hash を取り出す (「お店に知らせる」の文や Explorer の URL をそのまま貼れる)。 */
export function extractTxHash(text: string): Hex | null {
  const match = TX_HASH.exec(text);
  return match ? (match[0].toLowerCase() as Hex) : null;
}

/** 受取ウォレット宛ての、そのトークンの Transfer の合計 (wei)。 */
export function receivedByReceiver(logs: readonly Log[], token: Address, receiver: Address): bigint {
  const transfers = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: [...logs], strict: true });
  return transfers
    .filter((log) => isAddressEqual(log.address, token) && isAddressEqual(log.args.to, receiver))
    .reduce((sum, log) => sum + log.args.value, 0n);
}

type ReadClient = Pick<PublicClient, 'getTransactionReceipt' | 'getBlock'>;

function defaultClient(chain: ChainSlug): ReadClient | null {
  const chainObject = chainObjectForId(chainForSlug(chain).id);
  if (!chainObject) return null;
  return createPublicClient({ chain: chainObject, transport: transportForChain(chainObject.id) });
}

export async function checkOrderLinkPayment(input: {
  chain: ChainSlug;
  receiver: Address;
  text: string;
  /** テスト用。省略時はその受取チェーンの RPC。 */
  client?: ReadClient;
}): Promise<OrderLinkPaymentCheck> {
  const hash = extractTxHash(input.text);
  if (!hash) return { status: 'invalid' };
  const client = input.client ?? defaultClient(input.chain);
  if (!client) return { status: 'error' };
  const { address: token, decimals } = deploymentForSlug('jpyc', input.chain);
  try {
    const receipt = await client.getTransactionReceipt({ hash });
    if (receipt.status !== 'success') return { status: 'failed' };
    const received = receivedByReceiver(receipt.logs, token, input.receiver);
    if (received === 0n) return { status: 'notToReceiver' };
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    return {
      status: 'paid',
      received: formatUnits(received, decimals),
      blockNumber: receipt.blockNumber,
      timestamp: Number(block.timestamp),
    };
  } catch (error) {
    // まだ確定していない・別のチェーンの取引は「見つからない」と伝える (届いたとは言わない)。
    if (error instanceof TransactionReceiptNotFoundError) return { status: 'notFound' };
    return { status: 'error' };
  }
}
