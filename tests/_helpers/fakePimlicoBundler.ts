// useBatchPayment の Pimlico 経路の test が使う、境界 (smart account の client・bundler の HTTP・EntryPoint) の偽物。
// hook と lib/smartAccount/pimlicoSend.ts は実物のまま通す (第 10 回レビュー A-1)。
//
// 「世界」(bundler の mempool・EntryPoint の nonce・receipt) と「client」を分けてある。
// 世界はページの読み直しをまたいで残るもの、client は hook を mount するたびに作り直すものを表す。
//
//   - EntryPoint: 同じ (key, seq) の op は 1 本しか mine できない。使われた nonce の op は AA25 (-32500) で断る。
//   - bundler: 同じ op の 2 回目は「Already known」、同じ nonce の別の op は「Replacement underpriced」で断る
//     (どちらも -32602・HTTP 200)。
//   - mine() を呼ぶまで receipt は無い。
//
// eth_sendUserOperation は HTTP の層で偽物にする: hook (pimlicoSend.ts の broadcastPimlicoUserOp) は client の
// transport の URL へ、viem の http transport で送り、HTTP の status を見て失敗を分ける。fakePimlicoClients は global の
// fetch を「FAKE_BUNDLER_URL だけ横取りし、ほかは元の fetch へ渡す」形に差し替える。test は `bundlerSend` の
// mockImplementationOnce で答え方 (HTTP の status・JSON-RPC の error・応答なし) を変える。
//
// 分ける前からある test は `sendUserOperation` の mock 1 つで「準備・署名・送信」を表していた。
// legacySendUserOperation に渡すと、その mock を **準備の段で 1 回** 呼ぶ (calls を渡す・reject は準備の失敗として
// そのまま hook に届く) ので、期待値 (呼ばれた回数・calls の中身・error の object) を変えずに使える。
// mock が返した hash は「bundler が返す hash」になる (hook が計算する hash とは違うので、hook は返った hash を正とする)。
import { vi, type Mock } from 'vitest';
import { concat, TimeoutError, type Address, type Hex } from 'viem';
import {
  entryPoint08Address,
  formatUserOperation,
  getUserOperationHash,
  UserOperationReceiptNotFoundError,
  WaitForUserOperationReceiptTimeoutError,
  type RpcUserOperation,
  type UserOperation,
} from 'viem/account-abstraction';
import {
  joinUserOpNonce,
  splitUserOpNonce,
} from '@/lib/smartAccount/pimlicoSend';
import type { SmartAccountBundle } from '@/lib/smartAccount/simpleAccount';

export const FAKE_SENDER: Address = '0x9999999999999999999999999999999999999999';
export const FAKE_BUNDLER_URL = 'https://bundler.fake/rpc';

export type FakeReceipt = {
  success: boolean;
  actualGasCost: bigint;
  receipt: { transactionHash: Hex; blockNumber: bigint };
};

type SignedOp = Record<string, unknown>;
type Call = { to: Address; data: Hex; value?: bigint };

/** bundler が JSON-RPC の error で断った (world.accept が投げる)。 */
export class FakeBundlerRejection extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** eth_sendUserOperation への HTTP の答え。bundlerSend が throw すると応答が返らない (通信断)。 */
export type BundlerHttpReply =
  // HTTP 200 + result (受理)。
  | { result: Hex }
  // JSON-RPC の error (status の既定は 200)。
  | { error: { code: number; message: string }; status?: number }
  // 本文が JSON-RPC でない HTTP の失敗。
  | { status: number; body: string };

/** 応答が返らなかったとき (http の timeout) に viem が投げる error (MAv2 の facade の test が使う)。 */
export function bundlerTimeout(): TimeoutError {
  return new TimeoutError({
    body: { method: 'eth_sendUserOperation' },
    url: 'https://bundler.test',
  });
}

/** 届いた (かもしれない) 後に応答が失われた: fetch が投げる (viem は HttpRequestError にする = 応答不明)。 */
export function lostResponse(): TypeError {
  return new TypeError('Failed to fetch');
}

export function createFakeBundlerWorld(options?: { chainId?: number }) {
  const chainId = options?.chainId ?? 84532;
  const entryPoint = entryPoint08Address;
  // EntryPoint: key → 次に使える seq。
  const nextSeq = new Map<bigint, bigint>();
  // bundler が持っている op (nonce ごとに 1 本)。
  const mempool = new Map<bigint, { op: SignedOp; hash: Hex }>();
  const receipts = new Map<Hex, FakeReceipt>();
  // legacySendUserOperation の mock が返した hash (nonce ごと)。
  const legacyHashes = new Map<bigint, Hex>();
  // mine された op (確定した支払い)。
  const mined: Array<{ op: SignedOp; hash: Hex; success: boolean }> = [];
  let nextKey = 1_700_000_000_000n;

  const seqOf = (key: bigint) => nextSeq.get(key) ?? 0n;

  // hook が計算するのと同じ式の hash (EntryPoint 0.8 の EIP-712)。
  function hashOf(op: SignedOp): Hex {
    return getUserOperationHash({
      chainId,
      entryPointAddress: entryPoint,
      entryPointVersion: '0.8',
      userOperation: formatUserOperation(op as RpcUserOperation) as UserOperation<'0.8'>,
    });
  }

  /** bundler が op を受け取る (受理なら hash を返し、断るなら FakeBundlerRejection を投げる)。 */
  function accept(op: SignedOp): Hex {
    const nonce = BigInt(op.nonce as Hex);
    const { key, seq } = splitUserOpNonce(nonce);
    if (seqOf(key) > seq) {
      throw new FakeBundlerRejection(-32500, 'AA25 invalid account nonce');
    }
    const existing = mempool.get(nonce);
    if (existing) {
      throw new FakeBundlerRejection(
        -32602,
        JSON.stringify(existing.op) === JSON.stringify(op)
          ? 'Already known'
          : 'Replacement underpriced',
      );
    }
    const hash = legacyHashes.get(nonce) ?? hashOf(op);
    mempool.set(nonce, { op, hash });
    return hash;
  }

  /** accept の結果を HTTP の答え (HTTP 200) にする。 */
  function respond(op: SignedOp): BundlerHttpReply {
    try {
      return { result: accept(op) };
    } catch (error) {
      if (!(error instanceof FakeBundlerRejection)) throw error;
      return { error: { code: error.code, message: error.message } };
    }
  }

  /** mempool の op を 1 本 mine する (hash 省略時は mempool に 1 本だけあること)。 */
  function mine(
    hash?: Hex,
    result: { success?: boolean; txHash?: Hex; blockNumber?: bigint } = {},
  ): Hex {
    const entries = [...mempool.entries()];
    const entry = hash ? entries.find(([, v]) => v.hash === hash) : entries[0];
    if (!entry || (!hash && entries.length !== 1)) {
      throw new Error('fake bundler: mine する op を特定できません');
    }
    const [nonce, { op, hash: minedHash }] = entry;
    const { key, seq } = splitUserOpNonce(nonce);
    if (seqOf(key) !== seq) throw new Error('fake EntryPoint: AA25 (この nonce はもう使われた)');
    mempool.delete(nonce);
    nextSeq.set(key, seq + 1n);
    const success = result.success ?? true;
    receipts.set(minedHash, {
      success,
      actualGasCost: 1_000n,
      receipt: {
        transactionHash: result.txHash ?? (`0x${'b'.repeat(64)}` as Hex),
        blockNumber: result.blockNumber ?? 12345n,
      },
    });
    mined.push({ op, hash: minedHash, success });
    return minedHash;
  }

  /** 同じ (key, seq) を **別の op** が使った (MetaMask の key 0 を共有する別の支払い等)。
   * その nonce の op は mempool から消え、receipt はこの支払いの hash には付かない。 */
  function consumeNonceByOtherOp(nonce: bigint): void {
    const { key, seq } = splitUserOpNonce(nonce);
    if (seqOf(key) !== seq) throw new Error('fake EntryPoint: この nonce はもう使われた');
    mempool.delete(nonce);
    nextSeq.set(key, seq + 1n);
  }

  return {
    chainId,
    entryPoint,
    accept,
    respond,
    mine,
    consumeNonceByOtherOp,
    hashOf,
    mined,
    mempoolHashes: () => [...mempool.values()].map((v) => v.hash),
    receiptOf: (hash: Hex) => receipts.get(hash),
    // 以下は client の偽物が使う。
    reserveNonce: () => {
      const key = nextKey;
      nextKey += 1n;
      return joinUserOpNonce(key, seqOf(key));
    },
    currentNonce: (key: bigint) => joinUserOpNonce(key, seqOf(key)),
    rememberLegacyHash: (nonce: bigint, hash: Hex) => {
      legacyHashes.set(nonce, hash);
    },
  };
}

export type FakeBundlerWorld = ReturnType<typeof createFakeBundlerWorld>;

type LegacySendUserOperation = (parameters: { calls: Call[] }) => Promise<Hex>;
type GasPriceTier = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
type BundlerSend = (request: { params: [SignedOp, Address] }) => Promise<BundlerHttpReply>;

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

// global の fetch を「FAKE_BUNDLER_URL だけ bundlerSend へ、ほかは差し替える前の fetch へ」にする。
// test が先に fetch を差し替えていても (payment log の spy 等)、それを包むので log の呼び出しはその spy に届く。
function routeBundlerFetch(bundlerSend: Mock<BundlerSend>): void {
  const previousFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (requestUrl(input) !== FAKE_BUNDLER_URL) return previousFetch(input, init);
    const body = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
      params: [SignedOp, Address];
    };
    if (body.method !== 'eth_sendUserOperation') {
      throw new Error(`fake bundler: 想定外の method ${body.method}`);
    }
    const reply = await bundlerSend({ params: body.params });
    if ('body' in reply) return new Response(reply.body, { status: reply.status });
    const payload = 'result' in reply ? { result: reply.result } : { error: reply.error };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...payload }), {
      status: ('status' in reply ? reply.status : undefined) ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

/**
 * 記録の chain の bundler (lib/pimlico の pimlicoUrl) への eth_getUserOperationReceipt を、world の receipt で答える。
 * 今の account の Pimlico の bundle が無いとき (委任を外した・Circle の経路)、hook は照合 (読むだけ) でここへ照会する
 * (第 10 回レビュー A-1 の Codex 第 2 回 MUST 3)。戻り値は照会された hash を記録する mock。
 */
export function routePimlicoReceiptApi(world: FakeBundlerWorld): Mock<(hash: Hex) => void> {
  const lookups: Mock<(hash: Hex) => void> = vi.fn();
  const prefix = `https://api.pimlico.io/v2/${world.chainId}/rpc`;
  const previousFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!requestUrl(input).startsWith(prefix)) return previousFetch(input, init);
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: [Hex] };
    if (body.method !== 'eth_getUserOperationReceipt') {
      throw new Error(`fake pimlico api: 想定外の method ${body.method}`);
    }
    const [hash] = body.params;
    lookups(hash);
    const receipt = world.receiptOf(hash);
    const result = receipt
      ? {
          userOpHash: hash,
          success: receipt.success,
          actualGasCost: `0x${receipt.actualGasCost.toString(16)}`,
          actualGasUsed: '0x1',
          logs: [],
          receipt: {
            transactionHash: receipt.receipt.transactionHash,
            blockNumber: `0x${receipt.receipt.blockNumber.toString(16)}`,
            logs: [],
          },
        }
      : null;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return lookups;
}

/** wagmi の usePublicClient の偽物 (EntryPoint の getNonce(sender, key) を world で答える)。chainId は client の chain。 */
export function fakePublicClient(world: FakeBundlerWorld, chainId: number = world.chainId) {
  const readContract: Mock<
    (parameters: {
      address: Address;
      functionName: string;
      args: readonly [Address, bigint];
    }) => Promise<bigint>
  > = vi.fn(async ({ args: [, key] }) => world.currentNonce(key));
  return { client: { chain: { id: chainId }, readContract }, readContract };
}

/**
 * useSmartAccount の data (Pimlico の bundle) の偽物。smartAccountClient は permissionless の
 * createSmartAccountClient と同じ「分けられる」形 (account・prepareUserOperation・bundler の http transport)。
 */
export function fakePimlicoClients(args: {
  world: FakeBundlerWorld;
  paymasterMode?: 'sponsorship' | 'erc20';
  // account の address (= 署名済みの op の sender)。既定は FAKE_SENDER。
  sender?: Address;
  // account の EntryPoint (委任先を変えた account を作る)。既定は world の EntryPoint。
  entryPoint?: Address;
  legacySendUserOperation?: LegacySendUserOperation;
  waitForUserOperationReceipt?: (parameters: { hash: Hex }) => Promise<unknown>;
  getUserOperationGasPrice?: () => Promise<{
    slow: GasPriceTier;
    standard: GasPriceTier;
    fast: GasPriceTier;
  }>;
}) {
  const { world, legacySendUserOperation } = args;
  const sender = args.sender ?? FAKE_SENDER;
  const tier: GasPriceTier = { maxFeePerGas: 50n * 10n ** 9n, maxPriorityFeePerGas: 1n };

  const getNonce: Mock<() => Promise<bigint>> = vi.fn(async () => world.reserveNonce());

  // 準備のたびに fee が少し変わる (作り直しの op は、同じ nonce でも元の op と別の op になる)。
  let prepared = 0n;
  const prepareUserOperation: Mock<
    (parameters: { calls: readonly Call[]; nonce: bigint }) => Promise<UserOperation>
  > = vi.fn(async ({ calls, nonce }) => {
    prepared += 1n;
    if (legacySendUserOperation) {
      world.rememberLegacyHash(nonce, await legacySendUserOperation({ calls: [...calls] }));
    }
    return {
      sender,
      nonce,
      callData: concat(calls.map((call) => call.data)),
      callGasLimit: 100_000n,
      verificationGasLimit: 100_000n,
      preVerificationGas: 50_000n,
      maxFeePerGas: tier.maxFeePerGas + prepared,
      maxPriorityFeePerGas: tier.maxPriorityFeePerGas,
      signature: '0x',
    } as UserOperation;
  });

  // ウォレットの署名 (呼ばれた回数 = 署名の要求の回数)。
  const signUserOperation: Mock<(userOperation: UserOperation) => Promise<Hex>> = vi.fn(
    async () => `0x${'5a'.repeat(65)}` as Hex,
  );

  // bundler の HTTP の eth_sendUserOperation。既定は world.respond (受理 or HTTP 200 の JSON-RPC の error)。
  // test は mockImplementationOnce で「受理したが応答が返らない」「届かなかった」「HTTP 500」を作る。
  const bundlerSend: Mock<BundlerSend> = vi.fn(async ({ params }) => world.respond(params[0]));
  routeBundlerFetch(bundlerSend);

  // EntryPoint の getNonce(sender, key)。
  const readContract: Mock<
    (parameters: { functionName: string; args: readonly [Address, bigint] }) => Promise<bigint>
  > = vi.fn(async ({ args: [, key] }) => world.currentNonce(key));

  const getUserOperationReceipt: Mock<(parameters: { hash: Hex }) => Promise<FakeReceipt>> = vi.fn(
    async ({ hash }) => {
      const receipt = world.receiptOf(hash);
      if (!receipt) throw new UserOperationReceiptNotFoundError({ hash });
      return receipt;
    },
  );

  const waitForUserOperationReceipt =
    args.waitForUserOperationReceipt ??
    vi.fn(async ({ hash }: { hash: Hex }) => {
      const receipt = world.receiptOf(hash);
      if (!receipt) throw new WaitForUserOperationReceiptTimeoutError({ hash });
      return receipt;
    });

  const getUserOperationGasPrice =
    args.getUserOperationGasPrice ??
    vi.fn(async () => ({ slow: tier, standard: tier, fast: tier }));

  // 偽物は hook が使う部分だけを持つ。useSmartAccount の戻り値の型へはここ 1 か所で合わせる。
  const data = {
      provider: 'pimlico' as const,
      entryPointVersion: '0.8' as const,
      smartAccountClient: {
        account: {
          address: sender,
          client: { readContract },
          entryPoint: { address: args.entryPoint ?? world.entryPoint, version: '0.8' as const },
          getNonce,
          signUserOperation,
        },
        chain: { id: world.chainId },
        prepareUserOperation,
        // viem の client.transport (http transport の設定 + 値) と同じ形。
        transport: { type: 'http', url: FAKE_BUNDLER_URL, timeout: 10_000 },
      },
      pimlicoClient: {
        waitForUserOperationReceipt,
        getUserOperationGasPrice,
        getUserOperationReceipt,
      },
      paymasterMode: args.paymasterMode ?? ('sponsorship' as const),
  } as unknown as SmartAccountBundle;

  return {
    data,
    getNonce,
    prepareUserOperation,
    signUserOperation,
    bundlerSend,
    readContract,
    getUserOperationReceipt,
    waitForUserOperationReceipt,
  };
}
