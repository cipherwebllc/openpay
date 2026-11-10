// Pimlico (permissionless) 経路の UserOperation の送信を「nonce を決める → 準備 → 署名 → (保存) → 送信」に
// 分けるための primitive (第 10 回レビュー A-1)。Circle 経路の lib/smartAccount/circleAccount.ts
// (prepareAndSignCircleUserOp / broadcastCircleUserOp) と同じ型。
//
// なぜ分けるか: viem の sendUserOperation は 準備・署名・送信 を 1 回の呼び出しで行い、送信の応答が失われると
// (http の timeout・通信断。`eth_sendUserOperation` は再送されない) hash も署名済みの op も呼び出し側に残らない。
// bundler が受理していれば op は成立するのに、記録もラッチも無いので、再試行は別の nonce の op になり二重払いになる。
// 分けておけば、呼び出し側 (hooks/useBatchPayment.ts) が **送信の前に** hash・署名済みの op・nonce を保存できる。
//
// 安全の根拠は nonce の固定: EntryPoint は同じ (sender, nonce) の op を最大 1 本しか実行しない。
// 作り直しの op を必ず保存した nonce (key と seq の両方) で作れば、元の op が先に取り込まれていたときは
// 作り直しが AA25 で落ちる。hash の一致には頼らない (hash は receipt を引くための手がかり)。
//
// ここは通信と署名の素の部品だけを持つ。保存・ラッチ・分類の後の扱いは hook の側。
// 対象は permissionless の createSmartAccountClient で作った client (simple 7702・MetaMask)。
// MAv2 (lib/smartAccount/mav2.ts) は aa-sdk を包んだ facade で sendUserOperation しか無く、ここを通らない。

import type { Address, BaseError, Client, Hex } from 'viem';
import {
  formatUserOperationRequest,
  getUserOperationError,
  getUserOperationHash,
  type EntryPointVersion,
  type UserOperation,
} from 'viem/account-abstraction';
import { readContract } from 'viem/actions';
import { getAction } from 'viem/utils';

export type PimlicoCall = { to: Address; data: Hex; value?: bigint };

/** RPC 形式 (hex) の署名済み UserOperation。formatUserOperationRequest の出力で、そのまま
 * localStorage に保存でき、eth_sendUserOperation に渡せる。 */
export type PimlicoSignedUserOp = Record<string, unknown>;

/** 送信を分けられる client の、ここで使う部分だけの形 (permissionless の SmartAccountClient)。 */
export type SignedSendClient = {
  account: {
    address: Address;
    // account を作ったときの chain の client (EntryPoint の getNonce を読む)。
    client: Client;
    entryPoint: { address: Address; version: EntryPointVersion };
    getNonce: () => Promise<bigint>;
    signUserOperation: (userOperation: UserOperation) => Promise<Hex>;
  };
  chain: { id: number };
  // client の action。erc20 paymaster の独自の prepare (permissionless の
  // prepareUserOperationForErc20Paymaster) と fee の上限の検査 (ceilingCheckedStandardFee) はこの中を通る。
  prepareUserOperation: (parameters: {
    calls: readonly PimlicoCall[];
    nonce: bigint;
  }) => Promise<UserOperation>;
  request: (
    args: { method: 'eth_sendUserOperation'; params: [PimlicoSignedUserOp, Address] },
    options: { retryCount: number },
  ) => Promise<Hex>;
};

/**
 * 送信を分けられる client ならその形で返し、分けられない client (MAv2 の facade =
 * `{ sendUserOperation }` だけ) なら null を返す。null のとき呼び出し側は今までの sendUserOperation を使う。
 */
export function asSignedSendClient(client: unknown): SignedSendClient | null {
  if (client === null || typeof client !== 'object') return null;
  const candidate = client as {
    prepareUserOperation?: unknown;
    request?: unknown;
    account?: { signUserOperation?: unknown; getNonce?: unknown } | null;
  };
  if (
    typeof candidate.prepareUserOperation !== 'function' ||
    typeof candidate.request !== 'function' ||
    typeof candidate.account?.signUserOperation !== 'function' ||
    typeof candidate.account.getNonce !== 'function'
  ) {
    return null;
  }
  return client as SignedSendClient;
}

// EntryPoint の nonce (uint256) は 上位 192 bit が key・下位 64 bit が seq。
const NONCE_SEQ_BITS = 64n;
const NONCE_SEQ_MASK = (1n << NONCE_SEQ_BITS) - 1n;

export function splitUserOpNonce(nonce: bigint): { key: bigint; seq: bigint } {
  return { key: nonce >> NONCE_SEQ_BITS, seq: nonce & NONCE_SEQ_MASK };
}

export function joinUserOpNonce(key: bigint, seq: bigint): bigint {
  return (key << NONCE_SEQ_BITS) | seq;
}

/**
 * 新しい支払いの nonce (key と seq) を決める。viem の prepareUserOperation が nonce 未指定のときに
 * 呼ぶのと同じ `account.getNonce()` (引数なし) なので、分ける前と同じ nonce の取り方になる。
 */
export async function reserveUserOpNonce(client: SignedSendClient): Promise<bigint> {
  return client.account.getNonce();
}

/**
 * 準備 → 署名 → hash。**送信はしない**。nonce は呼び出し側が決めた値をそのまま使う
 * (新しい支払い = reserveUserOpNonce の値・作り直し = 保存してある値)。
 * viem の sendUserOperation の前半 (prepareUserOperation → account.signUserOperation →
 * formatUserOperationRequest) と同じ手順。
 */
export async function prepareAndSignPimlicoUserOp(args: {
  client: SignedSendClient;
  calls: readonly PimlicoCall[];
  nonce: bigint;
}): Promise<{
  // 署名済みの op (bigint の形)。送信を断られたときの error の文脈に使う。
  signed: UserOperation;
  // 署名済みの op (RPC の形)。保存して、そのまま送る。
  signedUserOp: PimlicoSignedUserOp;
  userOpHash: Hex;
  entryPoint: Address;
  sender: Address;
}> {
  const { client, calls, nonce } = args;
  const prepared = await client.prepareUserOperation({ calls, nonce });
  const signature = await client.account.signUserOperation(prepared);
  const signed = { ...prepared, signature } as UserOperation;
  // 本番の経路 (委任済みの simple 7702・EntryPoint 0.8) は authorization が付かず、bundler の返す hash と
  // 同じ式 (EIP-712) になる。違っていた場合は呼び出し側が bundler の返した hash を正として記録を直す。
  const userOpHash = getUserOperationHash({
    chainId: client.chain.id,
    entryPointAddress: client.account.entryPoint.address,
    entryPointVersion: client.account.entryPoint.version,
    userOperation: signed,
  });
  return {
    signed,
    signedUserOp: formatUserOperationRequest(signed) as PimlicoSignedUserOp,
    userOpHash,
    entryPoint: client.account.entryPoint.address,
    sender: client.account.address,
  };
}

export type PreparedPimlicoUserOp = Awaited<
  ReturnType<typeof prepareAndSignPimlicoUserOp>
>;

/**
 * 署名済みの op を **そのまま** 送る (raw の eth_sendUserOperation・再送なし)。準備をやり直さないので、
 * 保存した op と 1 字も違わないものが届く。同じ op の送り直しにも使う (EntryPoint の nonce で二重に実行されない)。
 */
export async function broadcastPimlicoUserOp(args: {
  client: SignedSendClient;
  signedUserOp: PimlicoSignedUserOp;
  entryPoint: Address;
}): Promise<Hex> {
  return args.client.request(
    {
      method: 'eth_sendUserOperation',
      params: [args.signedUserOp, args.entryPoint],
    },
    { retryCount: 0 },
  );
}

export type BroadcastFailureKind =
  // bundler が JSON-RPC の error で答えた (この op は受け付けなかった)。
  | 'rejected'
  // bundler が JSON-RPC の error で「その op はもう持っている」と答えた (mempool にある)。
  | 'already-known'
  // それ以外 (timeout・通信断・HTTP の失敗・判別できないもの)。届いたかどうか分からない。
  | 'unknown';

type RpcRequestErrorLike = { name: 'RpcRequestError'; details?: unknown; message?: unknown };

// viem の http transport は、応答の本文に JSON-RPC の error があるときだけ RpcRequestError を投げる
// (node_modules/viem/clients/transports/http.ts)。client はそれを code ごとの RpcError で包むので cause をたどる。
// timeout (TimeoutError)・HTTP の失敗 (HttpRequestError)・fetch の失敗には RpcRequestError が無い。
function findRpcRequestError(error: unknown): RpcRequestErrorLike | null {
  let current: unknown = error;
  while (current !== null && typeof current === 'object') {
    if ((current as { name?: unknown }).name === 'RpcRequestError') {
      return current as RpcRequestErrorLike;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

const ALREADY_KNOWN_RE = /already known|already in (?:the )?mempool/i;

/**
 * 送信の失敗を分ける。「受理していない」と言えるのは bundler が JSON-RPC の error で答えたときだけで、
 * 判別できないものは必ず 'unknown' に倒す (取り違えたときの被害が非対称: unknown を rejected と読むと
 * 取り込まれうる op の上に通常の再試行が開く)。
 */
export function classifyBroadcastError(error: unknown): BroadcastFailureKind {
  const rpc = findRpcRequestError(error);
  if (!rpc) return 'unknown';
  const text = `${String(rpc.details ?? '')} ${String(rpc.message ?? '')}`;
  return ALREADY_KNOWN_RE.test(text) ? 'already-known' : 'rejected';
}

/**
 * bundler に断られた送信の error を、viem の sendUserOperation が投げるのと同じ形
 * (UserOperationExecutionError) にする。フォームの error の表示を分ける前と変えないため。
 */
export function toUserOperationRejection(
  error: unknown,
  context: { signed: UserOperation; calls: readonly PimlicoCall[] },
): Error {
  return getUserOperationError(error as BaseError, {
    ...context.signed,
    calls: context.calls,
  });
}

const ENTRY_POINT_GET_NONCE_ABI = [
  {
    type: 'function',
    name: 'getNonce',
    stateMutability: 'view',
    inputs: [
      { name: 'sender', type: 'address' },
      { name: 'key', type: 'uint192' },
    ],
    outputs: [{ name: 'nonce', type: 'uint256' }],
  },
] as const;

/**
 * EntryPoint の getNonce(sender, key) を読み、保存した nonce がもう使われたかを返す。
 * true = その nonce の op が 1 本取り込まれた (同じ nonce の op はもう実行されない)。
 * account の getNonce ではなく EntryPoint を直接読む (account によっては key を無視する: MetaMask は常に key 0)。
 */
export async function isUserOpNonceConsumed(args: {
  client: SignedSendClient;
  entryPoint: Address;
  sender: Address;
  nonce: bigint;
}): Promise<boolean> {
  const { key } = splitUserOpNonce(args.nonce);
  const current = await getAction(
    args.client.account.client,
    readContract,
    'readContract',
  )({
    address: args.entryPoint,
    abi: ENTRY_POINT_GET_NONCE_ABI,
    functionName: 'getNonce',
    args: [args.sender, key],
  });
  return current > args.nonce;
}

/**
 * hash の列を順に bundler に尋ね、最初に見つかった receipt を返す (1 回ずつの照会・待たない)。
 * 「まだ無い」(UserOperationReceiptNotFoundError) は次の hash へ進み、それ以外の失敗は投げる
 * (照会できなかったことを「無い」と読まない)。
 */
export async function findUserOperationReceipt<Receipt>(
  bundler: { getUserOperationReceipt: (args: { hash: Hex }) => Promise<Receipt> },
  hashes: readonly Hex[],
): Promise<{ userOpHash: Hex; receipt: Receipt } | null> {
  for (const hash of hashes) {
    try {
      return { userOpHash: hash, receipt: await bundler.getUserOperationReceipt({ hash }) };
    } catch (error) {
      if ((error as { name?: unknown } | null)?.name !== 'UserOperationReceiptNotFoundError') {
        throw error;
      }
    }
  }
  return null;
}
