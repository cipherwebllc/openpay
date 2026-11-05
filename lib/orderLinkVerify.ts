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
//
// 確かめられたことだけを言う (第 9 回レビュー D-3・E-6・E-7): 「届いています」は取引が確定したときだけ (確定の読み方は
// lib/jpyc/finality.ts)・使い回しはこの端末の記録で見ていて、記録できないときはそう伝える・署名の確認で RPC に
// 問い合わせできなかったときは「他人の署名」ではなく「確かめられなかった」にする。

import {
  BaseError,
  createClient,
  createPublicClient,
  erc20Abi,
  ExecutionRevertedError,
  formatUnits,
  isAddressEqual,
  parseAbi,
  parseEventLogs,
  recoverMessageAddress,
  TransactionReceiptNotFoundError,
  zeroAddress,
  type Address,
  type Chain,
  type Hex,
  type Log,
  type PublicActions,
  type PublicClient,
  type Transport,
} from 'viem';
import { call, readContract, verifyMessage } from 'viem/actions';
import { chainForSlug, chainObjectForId, transportForChain, type ChainSlug } from './chains';
import { readJpycFinality } from './jpyc/finality';
import { extractConfirmationSignature, orderConfirmationMessage, recoverableSignature } from './orderConfirmation';
import { jpycForwarderFor } from './relay/forwarderConfig';
import { deploymentForSlug } from './tokens';

/**
 * 確認の署名の照合。verified = 払ったウォレットの署名・unsigned = 署名なし・mismatch = 払った人の署名ではない・
 * unverifiable = 署名はあるが、取引に複数の支払いが入っていて払った人を 1 人に決められない・
 * unchecked = コントラクトのウォレットとして確かめる問い合わせが RPC に届かなかった (合うとも合わないとも言わない)。
 */
export type OrderConfirmationCheck = 'verified' | 'unsigned' | 'mismatch' | 'unverifiable' | 'unchecked';

/**
 * 受取ウォレットに届いた支払い (received は表示用の 10 進)。payer は払ったウォレット (分からなければ null)。
 * timestamp はブロックの時刻 (秒)。ブロックを読めなかったときは null。
 */
export type ReceivedPayment = {
  received: string;
  blockNumber: bigint;
  timestamp: number | null;
  payer: Address | null;
  confirmation: OrderConfirmationCheck;
};

export type OrderLinkPaymentCheck =
  /** 受取ウォレットに届き、取引が確定している (確定の読み方は lib/jpyc/finality.ts)。 */
  | ({ status: 'paid' } & ReceivedPayment)
  /** 受取ウォレットに届いているが、取引がまだ確定していない (チェーンの組み替えで消えることがある)。 */
  | ({ status: 'pending' } & ReceivedPayment)
  /** 受取ウォレットに届いているが、確定したかを確かめられなかった (`finalized` タグを読めない)。 */
  | ({ status: 'finalityUnchecked' } & ReceivedPayment)
  /** 取引は成功しているが、受取ウォレット宛ての JPYC が無い (別の宛先・別のトークン)。 */
  | { status: 'notToReceiver' }
  /** 取引が失敗している (支払いは届いていない)。 */
  | { status: 'failed' }
  /** この受取チェーンに無い (チェーン違い・まだブロックに入っていない)。 */
  | { status: 'notFound' }
  /** Tx Hash が読み取れない。 */
  | { status: 'invalid' }
  /** RPC に問い合わせできなかった。 */
  | { status: 'error' };

/** 受取ウォレットに届いた支払いか (確定しているかは status で分かれる)。 */
export function isReceivedPayment(
  result: OrderLinkPaymentCheck,
): result is Extract<OrderLinkPaymentCheck, ReceivedPayment> {
  return result.status === 'paid' || result.status === 'pending' || result.status === 'finalityUnchecked';
}

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

/** 記録の時刻として読める値 (Date.now() の ms)。 */
function isCheckedTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * この端末の記録で見た、同じ支払いの使い回し。number = 前に確かめた時刻 (ms)・null = この端末では初めて・
 * 'unavailable' = 記録を読めない・残せない (この端末では使い回しを確かめられない)。
 */
export type CheckedBefore = number | null | 'unavailable';

/**
 * 届いたと確かめた支払いを記録し、前に確かめていればそのときの時刻 (ms) を返す (初めてなら null)。
 * 記録を読めない・残せない環境では 'unavailable' を返し、「初めて」とは言わない (第 9 回レビュー E-6)。
 * どちらでも例外は出さず、確かめた結果そのものは出す (記録の失敗を入金の確認に波及させない・掟 13)。
 */
export function rememberCheckedPayment(
  input: { chain: ChainSlug; receiver: Address; hash: Hex; now: number },
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = browserStorage(),
): CheckedBefore {
  if (!storage) return 'unavailable';
  const key = `${input.chain}:${input.receiver.toLowerCase()}:${input.hash.toLowerCase()}`;
  let raw: string | null;
  try {
    raw = storage.getItem(CHECKED_KEY);
  } catch {
    // 読めない保存領域: 前に確かめたかが分からない。書き込みもしない (読めない記録を上書きで消さない)。
    return 'unavailable';
  }
  // 記録が無い (null) のは初めて。空文字・JSON でない・オブジェクトでない・時刻でない値 (文字列の "1000" 等) は
  // 壊れた記録: 壊れた値は捨てて作り直し、その回は「初めて」と言わない (Codex SHOULD)。
  const checked: Record<string, number> = {};
  let intact = true;
  try {
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [entryKey, value] of Object.entries(parsed)) {
        if (isCheckedTime(value)) checked[entryKey] = value;
        else intact = false;
      }
    } else {
      intact = false;
    }
  } catch {
    intact = false;
  }
  const previous = typeof checked[key] === 'number' ? checked[key] : null;
  if (previous !== null) return previous;
  checked[key] = input.now;
  // 古いものから捨てて上限を保つ (端末の保存領域を食い続けない)。
  const kept = Object.entries(checked)
    .sort((x, y) => y[1] - x[1])
    .slice(0, CHECKED_MAX);
  try {
    storage.setItem(CHECKED_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // 満杯・使えない: 次に同じ Tx Hash を貼られても気づけないので、それを画面で伝える。
    return 'unavailable';
  }
  // 壊れていた記録は作り直した (次からは見られる) が、今回は前に確かめたかが分からない。
  return intact ? null : 'unavailable';
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
 * 問い合わせが例外になったら (RPC に届かない・断られた) 'unchecked': 確かめられなかった署名を、一致とも
 * 「他人の署名」とも言わない (第 9 回レビュー E-7)。
 */
export async function checkOrderConfirmation(input: {
  client: Pick<PublicClient, 'verifyMessage'>;
  payer: Address;
  message: string;
  signature: Hex;
}): Promise<'verified' | 'mismatch' | 'unchecked'> {
  try {
    const signer = await recoverMessageAddress({ message: input.message, signature: recoverableSignature(input.signature) });
    if (isAddressEqual(input.payer, signer)) return 'verified';
  } catch {
    // 65 バイトでない (コントラクトのウォレットの) 署名は ecrecover できない: 下の 1271 で確かめる。
  }
  try {
    const valid = await input.client.verifyMessage({
      address: input.payer,
      message: input.message,
      signature: input.signature,
    });
    return valid ? 'verified' : 'mismatch';
  } catch {
    return 'unchecked';
  }
}

/** 確認の署名を確かめる問い合わせ (eth_call) が、取り消し以外で失敗した (RPC に届かない・断られた)。 */
class ConfirmationCallError extends Error {}

/** 問い合わせが取り消された (= 確かめるコントラクトが署名を受け付けなかった) か。 */
function isExecutionReverted(error: unknown): boolean {
  return error instanceof BaseError && error.walk((cause) => cause instanceof ExecutionRevertedError) !== null;
}

/** viem が包み直した失敗の中の ConfirmationCallError。 */
function confirmationCallErrorIn(error: unknown): ConfirmationCallError | null {
  if (error instanceof ConfirmationCallError) return error;
  if (!(error instanceof BaseError)) return null;
  const found = error.walk((cause) => cause instanceof ConfirmationCallError);
  return found instanceof ConfirmationCallError ? found : null;
}

/**
 * 確認の署名をコントラクトのウォレット (ERC-1271/6492/8010) として確かめる関数。確かめ方 (ERC-6492 の validator・
 * ecrecover の予備) は viem の verifyMessage のまま。ただし viem は、確かめる問い合わせ (eth_call) の失敗を、
 * 取り消し (署名を受け付けない) も RPC に届かない・断られたのもまとめて false にする。そのままだと RPC の失敗が
 * 「他人の署名」(mismatch) に見えるので、取り消し以外の失敗は例外のまま verifyMessage の外へ出す (第 9 回レビュー E-7)。
 * お客様が決めたコントラクトのウォレットが、お店のブラウザを外の URL へ取りに行かせないよう CCIP-Read は使わない
 * (第 9 回レビュー C-1 と同じ)。
 */
function confirmationVerifier(chain: Chain, transport: Transport): ReadClient['verifyMessage'] {
  const client = createClient({ chain, transport, ccipRead: false })
    .extend((base) => ({
      call: async (args: Parameters<typeof call>[1]) => {
        try {
          return await call(base, args);
        } catch (error) {
          if (isExecutionReverted(error)) throw error;
          throw new ConfirmationCallError('order confirmation call failed', { cause: error });
        }
      },
    }))
    .extend((withCall) => {
      // ERC-8010 の経路は readContract が呼び出しの失敗を包み直すので、包みを外して verifyMessage の外へ出す。
      const strictReadContract: PublicActions<Transport, Chain>['readContract'] = async (args) => {
        try {
          return await readContract(withCall, args);
        } catch (error) {
          throw confirmationCallErrorIn(error) ?? error;
        }
      };
      return { readContract: strictReadContract };
    });
  return (args) => verifyMessage(client, args);
}

/** 入金を確かめるときに読む RPC (受取の取引・ブロック・確認の署名)。transport はテストで差し替える。 */
export function orderLinkReadClient(chain: Chain, transport: Transport): ReadClient {
  const client = createPublicClient({ chain, transport });
  return {
    getTransactionReceipt: client.getTransactionReceipt,
    getBlock: client.getBlock,
    verifyMessage: confirmationVerifier(chain, transport),
  };
}

function defaultClient(chain: ChainSlug): ReadClient | null {
  const chainObject = chainObjectForId(chainForSlug(chain).id);
  if (!chainObject) return null;
  return orderLinkReadClient(chainObject, transportForChain(chainObject.id));
}

/** 2 つのブロックの hash が同じか。どちらかが読めなければ null (同じとも違うとも言わない)。 */
function sameBlockHash(a: unknown, b: unknown): boolean | null {
  if (typeof a !== 'string' || typeof b !== 'string') return null;
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * 届いた支払いの状態。「届いています」(paid) は、確定していて (lib/jpyc/finality)、かつ receipt のブロックが同じ高さの
 * 今の正規のブロックと同じときだけ。receipt が組み替えで外れたブロック (別のフォーク) のものなら、確定の高さに届いて
 * いても確定ではない (Codex MUST)。どちらかが「まだ・違う」なら pending、どちらかを確かめられなければ finalityUnchecked。
 */
function receivedStatus(finalized: boolean | null, canonical: boolean | null): 'paid' | 'pending' | 'finalityUnchecked' {
  if (finalized === false || canonical === false) return 'pending';
  if (finalized === null || canonical === null) return 'finalityUnchecked';
  return 'paid';
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
    // 確定する前の取引はチェーンの組み替えで消えることがある (第 9 回レビュー D-3)。確定の高さを先に読み、その後で
    // 同じ高さの今の正規のブロックを読む (確定した後も receipt のブロックが正規なら、その取引はもう消えない)。
    const finality = await readJpycFinality({
      slug: input.chain,
      blockNumber: receipt.blockNumber,
      readFinalizedBlock: () => client.getBlock({ blockTag: 'finalized' }),
    });
    // ノードの追従の遅れ等で同じ高さのブロックを読めなくても、見つかった支払い (額・払った人・署名) は隠さない。
    // そのときは正規のブロックか確かめられないので確定とも言わない (finalityUnchecked・Codex SHOULD)。
    const block = await client.getBlock({ blockNumber: receipt.blockNumber }).catch(() => null);
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
    const payment: ReceivedPayment = {
      received: formatUnits(received, decimals),
      blockNumber: receipt.blockNumber,
      timestamp: block ? Number(block.timestamp) : null,
      payer,
      confirmation,
    };
    return { status: receivedStatus(finality.finalized, sameBlockHash(block?.hash, receipt.blockHash)), ...payment };
  } catch (error) {
    // まだ確定していない・別のチェーンの取引は「見つからない」と伝える (届いたとは言わない)。
    if (error instanceof TransactionReceiptNotFoundError) return { status: 'notFound' };
    return { status: 'error' };
  }
}

/** 受け付けるチェーンを全部探した結果。chain = 取引が見つかったチェーン (見つからなければ null)。 */
export type OrderLinkMultiChainCheck = {
  chain: ChainSlug | null;
  result: OrderLinkPaymentCheck;
  /** 問い合わせできなかったチェーン (見つからなかった・確かめられなかったを分けて伝える)。 */
  unreachable: ChainSlug[];
};

/**
 * 全部のチェーンを探す時間の予算 (ms)。既定の RPC は時間切れと再試行で 1 つのチェーンに数十秒かかることがあるので、
 * 止まっている (関係のない) チェーンを待ち続けない (Codex SHOULD)。
 */
export const ORDER_LINK_SEARCH_BUDGET_MS = 8_000;

/**
 * 見つかった結果の優先順 (小さいほど優先): 確定した支払い > 確定していない・確定を確かめられない支払い > 届いていない
 * (失敗・別の宛先)。notFound と error は見つかった結果ではない。
 */
const FOUND_RANK: Partial<Record<OrderLinkPaymentCheck['status'], number>> = {
  paid: 0,
  pending: 1,
  finalityUnchecked: 1,
  failed: 2,
  notToReceiver: 2,
};

/**
 * 答えたチェーンの中で採る結果の位置 (無ければ -1)。優先順が上の結果、同じなら chains の順 (設定の順) で前のチェーン。
 * 応答の速さでは決めない (先に答えた別フォークの pending が、後から答えた paid を隠さないように・Codex SHOULD)。
 */
function bestFoundIndex(results: ReadonlyArray<OrderLinkPaymentCheck | undefined>): number {
  let best = -1;
  results.forEach((result, index) => {
    const rank = result ? FOUND_RANK[result.status] : undefined;
    if (rank === undefined) return;
    const bestRank = best === -1 ? undefined : FOUND_RANK[results[best]?.status ?? 'error'];
    if (bestRank === undefined || rank < bestRank) best = index;
  });
  return best;
}

/**
 * 受け付けるチェーンを並べて読み、取引が見つかったチェーンで判定する (plans/order-link-multichain.md)。
 * 確定した支払い (paid) が出たら、ほかのチェーンを待たずにすぐ出す: Tx Hash は chainId を含めて署名した取引
 * (EIP-155) の hash なので、同じ Tx Hash が 2 つのチェーンでどちらも paid になることは事実上なく、待っても結果は
 * 変わらない。それ以外は全部のチェーンが答えるか、時間の予算が尽きるまで待ち、bestFoundIndex の決まった規則で選ぶ
 * (先に答えた別フォークの pending が、後から答える paid を隠さないように)。どこでも見つからず、読めなかったチェーン・
 * 予算の間に答えなかったチェーンがあれば「見つからない」ではなく「確かめられない」にし、そのチェーンを unreachable で
 * 伝える (払われていないように見せない)。確認の署名の文は、見つかったチェーンで組み立てる。
 */
export function checkOrderLinkPaymentOnChains(input: {
  chains: readonly ChainSlug[];
  receiver: Address;
  text: string;
  /** テスト用。省略時はそのチェーンの RPC。 */
  clientFor?: (chain: ChainSlug) => ReadClient | undefined;
  /** テスト用。省略時は ORDER_LINK_SEARCH_BUDGET_MS。 */
  budgetMs?: number;
}): Promise<OrderLinkMultiChainCheck> {
  if (!extractTxHash(input.text)) return Promise.resolve({ chain: null, result: { status: 'invalid' }, unreachable: [] });
  const { chains } = input;
  // 答えたチェーンの結果 (まだ答えていなければ undefined)。
  const results: Array<OrderLinkPaymentCheck | undefined> = chains.map(() => undefined);
  const decide = (): OrderLinkMultiChainCheck => {
    const best = bestFoundIndex(results);
    const found = best === -1 ? undefined : results[best];
    if (found) return { chain: chains[best], result: found, unreachable: [] };
    const unreachable = chains.filter((_, index) => results[index] === undefined || results[index].status === 'error');
    return { chain: null, result: { status: unreachable.length > 0 ? 'error' : 'notFound' }, unreachable };
  };
  // もう答えが変わらないか: 全部のチェーンが答えた・または paid が出た (paid は一番上で、2 つのチェーンでは出ない)。
  const decided = () =>
    results.every((result) => result !== undefined) || results.some((result) => result?.status === 'paid');
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: OrderLinkMultiChainCheck) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => finish(decide()), input.budgetMs ?? ORDER_LINK_SEARCH_BUDGET_MS);
    if (decided()) finish(decide());
    chains.forEach((chain, index) => {
      checkOrderLinkPayment({ chain, receiver: input.receiver, text: input.text, client: input.clientFor?.(chain) })
        // 1 つのチェーンの思わぬ例外で、ほかのチェーンの答えを止めない (そのチェーンは「問い合わせできなかった」)。
        .catch((): OrderLinkPaymentCheck => ({ status: 'error' }))
        .then((result) => {
          results[index] = result;
          if (decided()) finish(decide());
        });
    });
  });
}
