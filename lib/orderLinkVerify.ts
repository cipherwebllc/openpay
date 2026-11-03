// 注文リンクの「入金を確かめる」: お客様から届いた Tx Hash で、受取ウォレットに JPYC が届いたかをチェーンから読む。
// OpenPay のサーバーには何も送らず、ブラウザからチェーンの RPC を読むだけ (注文の内容を受け取らない・2026-11-03)。
//
// 発送の判断に使うので、数えるのは「成功した取引の、その受取チェーンの JPYC の Transfer のうち、受取ウォレット宛て」
// だけ。別のトークン・別の宛先・失敗した取引は届いた額に入れない (偽の Tx Hash や他人宛ての取引で発送させない)。
// 受付番号はチェーンに残らないので、注文との照合は額と時刻でお店がする (画面で伝える)。
//
// Tx Hash は誰でも Explorer で見られるので、それだけでは「この文を送った人が払った」証明にならない。お客様の完了画面は
// 払ったウォレットで決まった文に署名する (lib/orderConfirmation.ts)。ここではその署名が、この支払いをした
// ウォレットのものかを確かめる。払った人は 1 人に決まるときだけ使う: 「JPYC の AuthorizationUsed の authorizer」
// (ガス代不要の支払い・forwarder の settle は 1 回 1 件) が 1 つで、受取ウォレットか forwarder へ JPYC を送った人と同じか、
// AuthorizationUsed が無ければ「受取ウォレットか forwarder へ 0 より多い JPYC を送った人」がちょうど 1 人。
// 誰でも settle を呼べるので、他人の支払いと自分の支払いを 1 つの取引にまとめて自分の署名を通す手口がある
// (2026-11-03 Codex P1) — 払った人が 1 人に決まらない取引は「確かめられない」にする。
// 取引の送り主 (tx.from) は使わない: ガス代不要の支払いでは OpenPay の relayer で、払った人ではない。

import {
  createPublicClient,
  erc20Abi,
  formatUnits,
  isAddressEqual,
  parseAbi,
  parseEventLogs,
  recoverMessageAddress,
  TransactionReceiptNotFoundError,
  zeroAddress,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from 'viem';
import { chainForSlug, chainObjectForId, transportForChain, type ChainSlug } from './chains';
import { extractConfirmationSignature, orderConfirmationMessage, recoverableSignature } from './orderConfirmation';
import { jpycForwarderFor } from './relay/forwarderConfig';
import { deploymentForSlug } from './tokens';

/**
 * 確認の署名の照合。verified = 払ったウォレットの署名・unsigned = 署名なし・mismatch = 払った人の署名ではない・
 * unverifiable = 署名はあるが、取引に複数の支払いが入っていて払った人を 1 人に決められない。
 */
export type OrderConfirmationCheck = 'verified' | 'unsigned' | 'mismatch' | 'unverifiable';

export type OrderLinkPaymentCheck =
  /** 受取ウォレットに届いた (received は表示用の 10 進)。payer は払ったウォレット (分からなければ null)。 */
  | {
      status: 'paid';
      received: string;
      blockNumber: bigint;
      timestamp: number;
      payer: Address | null;
      confirmation: OrderConfirmationCheck;
    }
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

// ちょうど 32 バイト。前後が 16 進の続き (確認の署名の頭 64 桁など) は Tx Hash として取らない。
const TX_HASH = /(?<![0-9a-fA-Fx])0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/;

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

const AUTHORIZATION_USED = parseAbi(['event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)']);

function uniqueAddresses(addresses: readonly Address[]): Address[] {
  const seen: Address[] = [];
  for (const address of addresses) {
    if (!seen.some((other) => isAddressEqual(other, address))) seen.push(address);
  }
  return seen;
}

/**
 * この支払いをしたウォレット。1 人に決まらなければ null (署名では確かめられない)。
 * - 受取ウォレットか forwarder へ 0 より多い JPYC を送った人 (forwarder 自身とゼロアドレスを除く) がちょうど 1 人
 * - JPYC の AuthorizationUsed があるなら 1 つだけで、その authorizer が上の 1 人と同じ
 */
export function paymentPayer(
  logs: readonly Log[],
  token: Address,
  receiver: Address,
  forwarder: Address | null,
): Address | null {
  const authorizers = parseEventLogs({ abi: AUTHORIZATION_USED, logs: [...logs], strict: true })
    .filter((log) => isAddressEqual(log.address, token))
    .map((log) => log.args.authorizer);
  const senders = uniqueAddresses(
    parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: [...logs], strict: true })
      .filter(
        (log) =>
          isAddressEqual(log.address, token) &&
          log.args.value > 0n &&
          (isAddressEqual(log.args.to, receiver) || (forwarder !== null && isAddressEqual(log.args.to, forwarder))) &&
          !isAddressEqual(log.args.from, zeroAddress) &&
          !(forwarder !== null && isAddressEqual(log.args.from, forwarder)),
      )
      .map((log) => log.args.from),
  );
  if (senders.length !== 1 || authorizers.length > 1) return null;
  if (authorizers.length === 1 && !isAddressEqual(authorizers[0], senders[0])) return null;
  return senders[0];
}

type ReadClient = Pick<PublicClient, 'getTransactionReceipt' | 'getBlock' | 'verifyMessage'>;

/**
 * 確認の署名が候補のどれかのものか。先に ecrecover (EOA・7702 化した EOA もここで通る)、合わなければ
 * コントラクトのウォレット (ERC-1271/6492) として RPC で確かめる。viem の検証はコードのあるアドレスを 1271 に
 * 回すので、7702 の EOA を先に ecrecover で拾う (reference_viem_7702_erc7739_incompat)。
 */
export async function checkOrderConfirmation(input: {
  client: Pick<PublicClient, 'verifyMessage'>;
  payer: Address;
  message: string;
  signature: Hex;
}): Promise<'verified' | 'mismatch'> {
  try {
    const signer = await recoverMessageAddress({ message: input.message, signature: recoverableSignature(input.signature) });
    if (isAddressEqual(input.payer, signer)) return 'verified';
  } catch {
    // 65 バイトでない (コントラクトのウォレットの) 署名は ecrecover できない: 下の 1271 で確かめる。
  }
  try {
    if (await input.client.verifyMessage({ address: input.payer, message: input.message, signature: input.signature })) {
      return 'verified';
    }
  } catch {
    // RPC の失敗やコードの無いアドレスは「一致しない」に倒す (確かめられない署名を一致と言わない)。
  }
  return 'mismatch';
}

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
    const payer = paymentPayer(receipt.logs, token, input.receiver, jpycForwarderFor(chainForSlug(input.chain).id));
    const signature = extractConfirmationSignature(input.text);
    const confirmation: OrderConfirmationCheck = !signature
      ? 'unsigned'
      : payer === null
        ? 'unverifiable'
        : await checkOrderConfirmation({
            client,
            payer,
            message: orderConfirmationMessage({ chain: input.chain, shop: input.receiver, txHash: hash }),
            signature,
          });
    return {
      status: 'paid',
      received: formatUnits(received, decimals),
      blockNumber: receipt.blockNumber,
      timestamp: Number(block.timestamp),
      payer,
      confirmation,
    };
  } catch (error) {
    // まだ確定していない・別のチェーンの取引は「見つからない」と伝える (届いたとは言わない)。
    if (error instanceof TransactionReceiptNotFoundError) return { status: 'notFound' };
    return { status: 'error' };
  }
}
