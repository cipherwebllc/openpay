// useBatchPayment の Pimlico 経路の test が使う、境界 (smart account の client・bundler・EntryPoint) の偽物。
// hook と lib/smartAccount/pimlicoSend.ts は実物のまま通す (第 10 回レビュー A-1)。
//
// 「世界」(bundler の mempool・EntryPoint の nonce・receipt) と「client」を分けてある。
// 世界はページの読み直しをまたいで残るもの、client は hook を mount するたびに作り直すものを表す。
//
//   - EntryPoint: 同じ (key, seq) の op は 1 本しか mine できない。使われた nonce の op は AA25 で断る。
//   - bundler: 同じ op の 2 回目は「Already known」、同じ nonce の別の op は「Replacement underpriced」で断る
//     (どちらも JSON-RPC の error)。
//   - mine() を呼ぶまで receipt は無い。
//
// 分ける前からある test は `sendUserOperation` の mock 1 つで「準備・署名・送信」を表していた。
// legacySendUserOperation に渡すと、その mock を **準備の段で 1 回** 呼ぶ (calls を渡す・reject は準備の失敗として
// そのまま hook に届く) ので、期待値 (呼ばれた回数・calls の中身・error の object) を変えずに使える。
// mock が返した hash は「bundler が返す hash」になる (hook が計算する hash とは違うので、hook は返った hash を正とする)。
import { vi, type Mock } from 'vitest';
import {
  concat,
  RpcRequestError,
  TimeoutError,
  type Address,
  type Hex,
} from 'viem';
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

export type FakeReceipt = {
  success: boolean;
  actualGasCost: bigint;
  receipt: { transactionHash: Hex; blockNumber: bigint };
};

type SignedOp = Record<string, unknown>;
type Call = { to: Address; data: Hex; value?: bigint };

/** bundler が JSON-RPC の error で答えたときに viem の http transport が投げる error。 */
export function bundlerJsonRpcError(code: number, message: string): RpcRequestError {
  return new RpcRequestError({
    body: { method: 'eth_sendUserOperation' },
    error: { code, message },
    url: 'https://bundler.test',
  });
}

/** 応答が返らなかったとき (http の timeout) に viem が投げる error。 */
export function bundlerTimeout(): TimeoutError {
  return new TimeoutError({
    body: { method: 'eth_sendUserOperation' },
    url: 'https://bundler.test',
  });
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

  /** bundler が op を受け取る (受理なら hash を返し、断るなら JSON-RPC の error を投げる)。 */
  function accept(op: SignedOp): Hex {
    const nonce = BigInt(op.nonce as Hex);
    const { key, seq } = splitUserOpNonce(nonce);
    if (seqOf(key) > seq) {
      throw bundlerJsonRpcError(-32500, 'AA25 invalid account nonce');
    }
    const existing = mempool.get(nonce);
    if (existing) {
      throw bundlerJsonRpcError(
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

  return {
    chainId,
    entryPoint,
    accept,
    mine,
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

/**
 * useSmartAccount の data (Pimlico の bundle) の偽物。smartAccountClient は permissionless の
 * createSmartAccountClient と同じ「分けられる」形 (account・prepareUserOperation・request)。
 */
export function fakePimlicoClients(args: {
  world: FakeBundlerWorld;
  paymasterMode?: 'sponsorship' | 'erc20';
  legacySendUserOperation?: LegacySendUserOperation;
  waitForUserOperationReceipt?: (parameters: { hash: Hex }) => Promise<unknown>;
  getUserOperationGasPrice?: () => Promise<{
    slow: GasPriceTier;
    standard: GasPriceTier;
    fast: GasPriceTier;
  }>;
}) {
  const { world, legacySendUserOperation } = args;
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
      sender: FAKE_SENDER,
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

  // bundler への eth_sendUserOperation。既定は world.accept (受理 or JSON-RPC の error)。
  // test は mockImplementationOnce で「受理したが応答が返らない」「届かなかった」を作る。
  const request: Mock<
    (
      request: { method: string; params: [SignedOp, Address] },
      options?: { retryCount?: number },
    ) => Promise<Hex>
  > = vi.fn(async ({ params }) => world.accept(params[0]));

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
          address: FAKE_SENDER,
          client: { readContract },
          entryPoint: { address: world.entryPoint, version: '0.8' as const },
          getNonce,
          signUserOperation,
        },
        chain: { id: world.chainId },
        prepareUserOperation,
        request,
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
    request,
    readContract,
    getUserOperationReceipt,
    waitForUserOperationReceipt,
  };
}
