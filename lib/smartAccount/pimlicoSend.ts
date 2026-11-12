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

import {
  createClient,
  http,
  type Address,
  type BaseError,
  type Client,
  type Hex,
  type HttpTransportConfig,
} from 'viem';
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
  // bundler の http transport の設定 (viem の client.transport = 設定 + 値)。送信はこの URL へ、HTTP の status が
  // 見える形で行う (broadcastPimlicoUserOp)。
  transport: {
    url: string;
    timeout?: number;
    fetchOptions?: HttpTransportConfig['fetchOptions'];
  };
};

/**
 * 送信を分けられる client ならその形で返し、分けられない client (MAv2 の facade =
 * `{ sendUserOperation }` だけ) なら null を返す。null のとき呼び出し側は今までの sendUserOperation を使う。
 */
export function asSignedSendClient(client: unknown): SignedSendClient | null {
  if (client === null || typeof client !== 'object') return null;
  const candidate = client as {
    prepareUserOperation?: unknown;
    transport?: { url?: unknown } | null;
    account?: { signUserOperation?: unknown; getNonce?: unknown } | null;
  };
  if (
    typeof candidate.prepareUserOperation !== 'function' ||
    typeof candidate.transport?.url !== 'string' ||
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
  // 準備が済み、ウォレットへ署名を求める直前に呼ぶ (任意)。投げると、署名を求めずにその error で終わる。
  // 呼び出し側 (pimlicoIntent.ts の buildAndSend) が、画面を離れた試みの署名の要求を出さないために使う。
  beforeSign?: () => void;
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
  args.beforeSign?.();
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

export type BroadcastFailureKind =
  // HTTP 2xx の応答で、bundler が ERC-4337 の検証の拒否 (下の allowlist の code) を返した = **この送信** を受け付けなかった。
  // 同じ op の前の配送 (送信が途中で 2 回届いたときの 1 回目) が受理されていないことまでは言えない (下の readBundlerOpStatus)。
  | 'validation-rejected'
  // bundler が JSON-RPC の error で「その op はもう持っている」と答えた (mempool にある)。
  | 'already-known'
  // それ以外 (timeout・通信断・HTTP の失敗・HTTP 5xx に載った JSON-RPC の error・allowlist に無い code・
  // 判別できないもの)。届いたかどうか分からない。
  | 'unknown';

export type BroadcastOutcome =
  | { kind: 'accepted'; userOpHash: Hex }
  | { kind: BroadcastFailureKind; error: unknown };

/**
 * 署名済みの op を **そのまま** 送る (raw の eth_sendUserOperation・再送なし)。準備をやり直さないので、
 * 保存した op と 1 字も違わないものが届く。同じ op の送り直しにも使う (EntryPoint の nonce で二重に実行されない)。
 *
 * 失敗は投げずに分類して返す。分類には HTTP の status が要るので、client の bundler の transport と同じ URL・timeout で、
 * この 1 回の送信のためだけの http transport を作り、その応答の status を受け取る。理由: viem 2.56 の http の実装
 * (node_modules/viem/utils/rpc/http.ts の `if (!response.ok)` の枝) は、HTTP 5xx でも本文が JSON-RPC の error なら
 * 本文をそのまま返し、transport (node_modules/viem/clients/transports/http.ts) はそれを HTTP 200 のときと同じ
 * RpcRequestError にする。RpcRequestError は status を持たないので、error の object からは HTTP 200 と 5xx を
 * 見分けられない (proxy や上流の障害の 5xx に、受理済みの op の error が載ることがある)。
 * error の包み方は client.request と同じ (buildRequest を通る) なので、断られたときの error は viem の
 * sendUserOperation が投げる形 (toUserOperationRejection) にそのまま包める。
 */
export async function broadcastPimlicoUserOp(args: {
  client: SignedSendClient;
  signedUserOp: PimlicoSignedUserOp;
  entryPoint: Address;
}): Promise<BroadcastOutcome> {
  const { url, timeout, fetchOptions } = args.client.transport;
  let httpStatus: number | undefined;
  const sender = createClient({
    transport: http(url, {
      retryCount: 0,
      timeout,
      fetchOptions,
      onFetchResponse: (response) => {
        httpStatus = response.status;
      },
    }),
  });
  const request = sender.request as unknown as (
    parameters: {
      method: 'eth_sendUserOperation';
      params: [PimlicoSignedUserOp, Address];
    },
    options: { retryCount: number },
  ) => Promise<Hex>;
  try {
    const userOpHash = await request(
      {
        method: 'eth_sendUserOperation',
        params: [args.signedUserOp, args.entryPoint],
      },
      { retryCount: 0 },
    );
    return { kind: 'accepted', userOpHash };
  } catch (error) {
    return { kind: classifyBroadcastError(error, httpStatus), error };
  }
}

export type RpcRequestErrorLike = {
  name: 'RpcRequestError';
  code?: unknown;
  // bundler が返した JSON-RPC の error の message そのもの (viem の RpcRequestError の details)。
  details?: unknown;
  // viem が組み立てた文。**送った request の本文 (署名済みの op) と URL を含む** ので、bundler の言い分として読まない。
  message?: unknown;
  // bundler が返した JSON-RPC の error の data。
  data?: unknown;
};

// viem の http transport は、応答の本文に JSON-RPC の error があるときだけ RpcRequestError を投げる
// (node_modules/viem/clients/transports/http.ts)。client はそれを code ごとの RpcError で包むので cause をたどる。
// timeout (TimeoutError)・本文が JSON-RPC の error でない HTTP の失敗 (HttpRequestError)・fetch の失敗には
// RpcRequestError が無い。
// export は Circle の経路 (lib/smartAccount/circleAccount.ts) が、同じ error から拒否の code と bundler の文を読むため。
export function findRpcRequestError(error: unknown): RpcRequestErrorLike | null {
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

// 「bundler がこの送信を受け付けなかった」と言える JSON-RPC の error の code (allowlist)。
// 根拠: ERC-7769 (ERC-4337 の JSON-RPC の API) が eth_sendUserOperation の検証の失敗に割り当てる code で、
// -32602 = UserOperation の形・値が不正、-32500 = EntryPoint の検証 (account の validateUserOp・作成) で拒否、
// -32501 = paymaster の validatePaymasterUserOp で拒否、-32502 = opcode の規則に違反、-32503 = 有効期間の外、
// -32504 = paymaster (または aggregator) が throttle / ban されている、-32505 = paymaster の stake が足りない、
// -32506 = 対応していない aggregator、-32507 = 署名の検証に失敗。どれも mempool に入れる前の検証で返す code。
// viem 2.56 も同じ code を bundler の error として持ち、cause の code から UserOperationRejectedByEntryPointError 等へ
// 包む (node_modules/viem/account-abstraction/utils/errors/getBundlerError.ts の err.walk と code の比較)。
// permissionless 0.2.57 はこの送信の error を分類しない (raw の request をそのまま返す)。
// ここに無い code (-32603 internal・-32005 rate limit・-32601・viem が持つ -32508 / -32521 等) は、受理の後に
// 失敗した可能性を否定できないので 'unknown' に倒す。
const BUNDLER_VALIDATION_REJECTION_CODES: ReadonlySet<number> = new Set([
  -32500, -32501, -32502, -32503, -32504, -32505, -32506, -32507, -32602,
]);

/**
 * 送信の失敗を分ける。「受け付けていない」と言えるのは、HTTP が 2xx で、JSON-RPC の error の code が
 * allowlist にあるときだけ。判別できないものは必ず 'unknown' に倒す (取り違えたときの被害が非対称:
 * unknown を「受け付けていない」と読むと、取り込まれうる op の上に通常決済や別の支払いが開く)。
 * httpStatus は応答が届いたときの status (届かなかったときは undefined)。
 * 言えるのは「この送信」についてだけ。最初の送信の拒否で intent / 記録を閉じる側 (pimlicoIntent.ts の c2・circleSend.ts の
 * closeRejectedFirstSend) は、これに加えて下の語の確認と、bundler にその op の状態を聞くこと (readBundlerOpStatus) を要る。
 */
export function classifyBroadcastError(
  error: unknown,
  httpStatus: number | undefined,
): BroadcastFailureKind {
  const rpc = findRpcRequestError(error);
  if (!rpc) return 'unknown';
  const text = `${String(rpc.details ?? '')} ${String(rpc.message ?? '')}`;
  // bundler がこの op を持っている: 受理と同じく receipt を待つ (閉じない側なので status は問わない)。
  if (ALREADY_KNOWN_RE.test(text)) return 'already-known';
  if (httpStatus === undefined || httpStatus < 200 || httpStatus > 299) return 'unknown';
  return typeof rpc.code === 'number' && BUNDLER_VALIDATION_REJECTION_CODES.has(rpc.code)
    ? 'validation-rejected'
    : 'unknown';
}

/**
 * bundler が返した JSON-RPC の error の文 (message = viem の RpcRequestError の details と、data の JSON)。
 * viem の error の message は入れない: 送った request の本文 (署名済みの op = "nonce" という欄を必ず含む) と URL を載せるので、
 * bundler の言い分として読むと、どの拒否も下の語に当たる。
 */
export function bundlerErrorText(rpc: RpcRequestErrorLike | null): string {
  const details = typeof rpc?.details === 'string' ? rpc.details : '';
  const data = rpc?.data === undefined ? '' : JSON.stringify(rpc.data);
  return `${details} ${data}`;
}

// 検証の拒否 (HTTP 2xx + allowlist の code) でも、bundler の言い分にこの語があるときは「この op を受け付けていない」と読まない
// (第 10 回レビュー PR-39 の S1)。nonce の key が時刻由来で試みごとに新しい op (Circle の経路・Pimlico の経路の simple 7702) の
// **最初の送信** に nonce・mempool・重複・置き換えの拒否が返るなら、もっとも考えやすいのは **この op 自身がもう届いている** こと
// (送信が途中で 2 回届いた・先に取り込まれた)。閉じると、取り込まれる支払いの上に新しい支払いが開く。語は広めに取る
// (外れても確認待ちに残るだけ = 払えない側)。
//   AA25 = EntryPoint の「nonce が違う」/ nonce / mempool (「もう mempool にある」「mempool の上限」) /
//   already (already known 以外の「もう…」) / replace (replacement underpriced = 同じ nonce の op がもうある)
// 語の定義はここ 1 つ。使うのは「最初の送信の拒否で閉じてよいか」を決める 2 か所だけ: Circle の経路の分類
// (circleAccount.ts の classifyCircleBroadcastError) と、Pimlico の経路の c2 (pimlicoIntent.ts の buildAndSend)。
// 上の classifyBroadcastError には入れない (送り直しの拒否 = 同じ nonce で作り直す、の動きを変えない)。
// 語に当たらなければ閉じてよい、ではない: 語に当たらない拒否 (preVerificationGas が足りない等) も、重複の配送にだけ返ることが
// ある。閉じる前には必ず下の readBundlerOpStatus も聞く。語の確認を残す理由: status と語は別の失敗を断つ。status の記録が
// bundler の中で反映される前に聞いてしまう場合 (受理した node と聞いた node のずれ) でも、nonce・重複の拒否は語で止まる。
const NOT_REJECTION_PROOF_RE = /AA25|nonce|mempool|already|replace/i;

/** bundler の JSON-RPC の error の文 (bundlerErrorText) が、上の語を含むか。 */
export function mentionsNonceOrMempool(bundlerText: string): boolean {
  return NOT_REJECTION_PROOF_RE.test(bundlerText);
}

/** bundler に聞いた、ある op (userOpHash) の状態 (readBundlerOpStatus)。 */
export type BundlerOpStatus = {
  /** bundler が「その hash を知らない」(status が not_found) と答えたときだけ true。 */
  unknownToBundler: boolean;
  /** log に載せる値: bundler の答えた status (長さを切る)、読めなかったときは `unreadable:<理由>`。 */
  status: string;
};

/**
 * bundler に、その op (userOpHash) の状態を 1 回聞く (`pimlico_getUserOperationStatus`・再送なし・timeout は transport の値)。
 *
 * 何のためか: 最初の送信を bundler が検証で拒否したとき、intent / 記録を閉じてよいかを決める (pimlicoIntent.ts の c2・
 * circleSend.ts の closeRejectedFirstSend)。検証の拒否が示すのは「この送信が断られた」ことだけで、同じ op の前の配送が受理されて
 * いないことは示さない: 送信が途中で 2 回届き、1 回目は受理されて mempool にあり、2 回目 (重複の配送) にだけ拒否が返ることがある
 * (例: 受理の後に preVerificationGas の必要量が上がり、重複の配送に「preVerificationGas is not enough」(-32500) が返る。
 * Pimlico の bundler (Alto) はこの検査を、mempool の重複の確認より前に行う)。そこで閉じると、次の試みは新しい nonce の op に
 * なり、2 本とも取り込まれる。閉じてよい根拠は **「bundler がその hash を知らないと答えた」(not_found)** こと。
 *
 * unknownToBundler が true になるのは not_found のときだけ。ほかの status (permissionless 0.2.57 の PimlicoUserOperationStatus:
 * not_submitted・submitted・rejected・reverted・included・failed) も、型に無い値も、読めなかったとき (通信の失敗・timeout・
 * HTTP の失敗・JSON-RPC の error・形の崩れた応答) も false = 閉じない側。rejected も閉じない側にする: その hash を bundler が
 * 一度は受け取っていて、ここからは「取り込まれない」と言い切れない。
 * 失敗は投げずに「読めなかった」で返す。何の波及を断つか: 付帯の照会の失敗が、送った後の扱い (応答不明・確認待ち) を別の error に
 * 変えること。握りつぶさない: 呼び出し側が status の値 (unreadable:<error の name>) を log に残し、閉じない側へ進む。
 * 理由に viem の error の message は入れない (URL を含む)。
 *
 * 限界 (2026-11-12 に Pimlico の公開 endpoint (Base Sepolia と Base) で確かめた範囲): 一度も受理されていない op (知らない hash・
 * 検証で拒否された op の hash) には、拒否の直後と 3 秒後に `{"status":"not_found","transactionHash":null}` が返る。**「受理された
 * op が not_found 以外を返す」ことは、有効な署名つきの op が要るので実測していない** (API の説明と permissionless の型による)。
 * 本番の key つきの endpoint でも確かめていない。status の記録が bundler の中で遅れて反映される場合 (受理の直後に別の node が
 * not_found と答える) は、語に当たらない拒否で閉じうる。聞く hash は手元で計算した hash で、bundler の hash と違う経路
 * (prepareAndSignPimlicoUserOp のコメント) では、受理された op にも not_found が返りうる。
 */
export async function readBundlerOpStatus(args: {
  // bundler の http transport の設定 (送信と同じ URL・timeout)。
  transport: { url?: string; timeout?: number; fetchOptions?: HttpTransportConfig['fetchOptions'] };
  userOpHash: Hex;
}): Promise<BundlerOpStatus> {
  try {
    const { url, timeout, fetchOptions } = args.transport;
    const reader = createClient({
      transport: http(url, { retryCount: 0, timeout, fetchOptions }),
    });
    const request = reader.request as unknown as (
      parameters: { method: 'pimlico_getUserOperationStatus'; params: [Hex] },
      options: { retryCount: number },
    ) => Promise<unknown>;
    // viem の http は、HTTP が 2xx のときだけ result を返す (2xx 以外は、本文が JSON-RPC の error なら RpcRequestError・
    // それ以外は HttpRequestError を投げる = 下の catch)。
    const result = (await request(
      { method: 'pimlico_getUserOperationStatus', params: [args.userOpHash] },
      { retryCount: 0 },
    )) as { status?: unknown; transactionHash?: unknown } | null;
    const status = result?.status;
    // 形の崩れた応答: status が文字列でない・「知らない」と言いながら transaction を持つ (知らないと読まない)。
    if (
      typeof status !== 'string' ||
      (status === 'not_found' && (result?.transactionHash ?? null) !== null)
    ) {
      return { unknownToBundler: false, status: 'unreadable:malformed' };
    }
    return { unknownToBundler: status === 'not_found', status: status.slice(0, 40) };
  } catch (error) {
    const rpc = findRpcRequestError(error);
    const reason = rpc
      ? `RpcRequestError ${String(rpc.code)}`
      : error instanceof Error
        ? error.name
        : 'unknown';
    return { unknownToBundler: false, status: `unreadable:${reason}` };
  }
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
 * client は記録の chain を読める client なら何でもよい (照合は今の account に依存しない・第 10 回レビュー A-1 の MUST 3)。
 */
export async function isUserOpNonceConsumed(args: {
  client: Client;
  entryPoint: Address;
  sender: Address;
  nonce: bigint;
}): Promise<boolean> {
  const { key } = splitUserOpNonce(args.nonce);
  const current = await getAction(
    args.client,
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
