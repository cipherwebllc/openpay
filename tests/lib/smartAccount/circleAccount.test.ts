import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { encodePacked, getAddress, http, type Address, type Hex } from 'viem';
import { createBundlerClient } from 'viem/account-abstraction';
import {
  signUsdcPermit,
  getCircleUserOpGasPrice,
  prepareAndSignCircleUserOp,
  broadcastCircleUserOp,
  prepareCircleBroadcast,
  classifyCircleBroadcastError,
  mentionsNonceOrMempool,
  CircleBroadcastError,
  buildCircleSmartAccountClient,
  entryPoint08Address,
  type CircleSmartAccountBundle,
} from '@/lib/smartAccount/circleAccount';
import { assertCirclePaymasterDeployed } from '@/lib/circlePermit';
import { resolveDeployment } from '@/lib/tokens';

// 重い account builder (permissionless to7702SimpleSmartAccount + viem
// createBundlerClient) はモックせず、bundle を直接組んで orchestration 関数を単体検証する。
const TOKEN = getAddress('0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d'); // USDC Arb Sepolia
const PAYMASTER = getAddress('0x3BA9A96eE3eFf3A69E2B18886AcF52027EFF8966'); // v0.8 testnet
const OWNER = getAddress('0x1111111111111111111111111111111111111111');
const CHAIN_ID = 421614;

function fakeBundle(
  bundlerOverrides: Record<string, unknown> = {},
): CircleSmartAccountBundle {
  const deployment = resolveDeployment('usdc', CHAIN_ID)!;
  return {
    provider: 'circle',
    entryPointVersion: '0.8',
    account: {} as CircleSmartAccountBundle['account'],
    bundlerClient: {
      request: vi.fn(),
      estimateUserOperationGas: vi.fn(),
      sendUserOperation: vi.fn(),
      waitForUserOperationReceipt: vi.fn(),
      ...bundlerOverrides,
    } as unknown as CircleSmartAccountBundle['bundlerClient'],
    chainId: CHAIN_ID,
    deployment,
    paymasterAddress: PAYMASTER,
  };
}

// readContract を functionName でルーティングするモック publicClient。
function fakePublicClient(opts: {
  domainChainId?: bigint;
  verifyingContract?: Address;
  nonce?: bigint;
  code?: Hex | undefined;
}) {
  return {
    readContract: vi.fn(async (params: { functionName: string }) => {
      if (params.functionName === 'eip712Domain') {
        return [
          '0x0f',
          'USD Coin',
          '2',
          opts.domainChainId ?? BigInt(CHAIN_ID),
          opts.verifyingContract ?? TOKEN,
          '0x0000000000000000000000000000000000000000000000000000000000000000',
          [],
        ];
      }
      if (params.functionName === 'nonces') return opts.nonce ?? 0n;
      throw new Error(`unexpected readContract ${params.functionName}`);
    }),
    getCode: vi.fn(async () => opts.code),
    getChainId: vi.fn(async () => CHAIN_ID),
  } as unknown as Parameters<typeof signUsdcPermit>[0]['publicClient'];
}

describe('signUsdcPermit', () => {
  it('deadline=MAX / spender=paymaster で署名し paymasterData を組む', async () => {
    const sig = `0x${'ab'.repeat(65)}` as Hex;
    const signTypedData = vi.fn(async (_params: unknown) => sig);
    const walletClient = {
      signTypedData,
    } as unknown as Parameters<typeof signUsdcPermit>[0]['walletClient'];
    const publicClient = fakePublicClient({});
    const bundle = fakeBundle();

    const permitAmount = 5_000_000n;
    const res = await signUsdcPermit({
      publicClient,
      walletClient,
      bundle,
      owner: OWNER,
      permitAmount,
    });

    // signTypedData に渡った message を検証
    const call = signTypedData.mock.calls[0][0] as unknown as {
      primaryType: string;
      message: {
        owner: Address;
        spender: Address;
        value: bigint;
        deadline: bigint;
      };
    };
    expect(call.primaryType).toBe('Permit');
    expect(call.message.spender).toBe(PAYMASTER);
    expect(call.message.owner).toBe(OWNER);
    expect(call.message.value).toBe(permitAmount);
    expect(call.message.deadline).toBe(2n ** 256n - 1n);

    // paymasterData は encodePacked(uint8(0), token, amount, sig)
    expect(res.permitSignature).toBe(sig);
    expect(res.paymasterData).toBe(
      encodePacked(
        ['uint8', 'address', 'uint256', 'bytes'],
        [0, TOKEN, permitAmount, sig],
      ),
    );
  });

  it('permit domain の chainId drift で throw (revert 早期切り分け)', async () => {
    const walletClient = {
      signTypedData: vi.fn(),
    } as unknown as Parameters<typeof signUsdcPermit>[0]['walletClient'];
    const publicClient = fakePublicClient({ domainChainId: 8453n });
    await expect(
      signUsdcPermit({
        publicClient,
        walletClient,
        bundle: fakeBundle(),
        owner: OWNER,
        permitAmount: 1_000_000n,
      }),
    ).rejects.toThrow(/chainId/);
  });

  // 第 10 回レビュー H-V (a): 呼び出し側 (circleSend.ts) が、画面を離れた試みの署名の要求を出さないために使う。RPC を待つ間に
  // 離れたことを拾えるように、読み取り (domain・permit の nonce) の後・ウォレットの前で呼ぶ。
  it('beforeSign は nonces の読み取りの後・signTypedData の前に 1 回呼ばれる', async () => {
    const sig = `0x${'ab'.repeat(65)}` as Hex;
    const signTypedData = vi.fn(async (_params: unknown) => sig);
    const walletClient = {
      signTypedData,
    } as unknown as Parameters<typeof signUsdcPermit>[0]['walletClient'];
    const publicClient = fakePublicClient({});
    const readContract = vi.mocked(publicClient.readContract);
    // beforeSign が呼ばれた時点の「読み取り済みの関数」と「署名を求めた回数」を持ち出す。
    const seen: Array<{ reads: string[]; signRequests: number }> = [];
    const beforeSign = vi.fn(() => {
      seen.push({
        reads: readContract.mock.calls.map(
          (c) => (c[0] as { functionName: string }).functionName,
        ),
        signRequests: signTypedData.mock.calls.length,
      });
    });

    const res = await signUsdcPermit({
      publicClient,
      walletClient,
      bundle: fakeBundle(),
      owner: OWNER,
      permitAmount: 5_000_000n,
      beforeSign,
    });

    expect(seen).toEqual([{ reads: ['eip712Domain', 'nonces'], signRequests: 0 }]);
    // 投げなければ今までどおり署名を求めて返す。
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(res.permitSignature).toBe(sig);
  });

  it('beforeSign が投げると、signTypedData を呼ばずにその error で終わる', async () => {
    const signTypedData = vi.fn(async (_params: unknown) => `0x${'ab'.repeat(65)}` as Hex);
    const walletClient = {
      signTypedData,
    } as unknown as Parameters<typeof signUsdcPermit>[0]['walletClient'];

    await expect(
      signUsdcPermit({
        publicClient: fakePublicClient({}),
        walletClient,
        bundle: fakeBundle(),
        owner: OWNER,
        permitAmount: 5_000_000n,
        beforeSign: () => {
          throw new Error('payment_cancelled');
        },
      }),
    ).rejects.toThrow('payment_cancelled');
    expect(signTypedData).not.toHaveBeenCalled();
  });
});

describe('getCircleUserOpGasPrice', () => {
  it('pimlico_getUserOperationGasPrice standard tier を bigint で返す', async () => {
    const request = vi.fn(async () => ({
      standard: {
        maxFeePerGas: '0x3b9aca00', // 1e9
        maxPriorityFeePerGas: '0x1dcd6500', // 5e8
      },
    }));
    const bundle = fakeBundle({ request });
    const got = await getCircleUserOpGasPrice(bundle);
    expect(got.maxFeePerGas).toBe(1_000_000_000n);
    expect(got.maxPriorityFeePerGas).toBe(500_000_000n);
    expect(request).toHaveBeenCalledWith({
      method: 'pimlico_getUserOperationGasPrice',
      params: [],
    });
  });

  it('ceiling 超過の gas price は GasCongestedError で弾く (P2: Circle 送信経路の上限ガード)', async () => {
    // arbSepolia (421614) の既定 ceiling は 1000 gwei。これを超える standard gas は署名/送信前に
    // 拒否し、送信時スパイクで顧客 USDC が permit 上限まで過大 pull されるのを防ぐ。
    const request = vi.fn(async () => ({
      standard: {
        maxFeePerGas: `0x${(2000n * 10n ** 9n).toString(16)}`, // 2000 gwei > 1000 ceiling
        maxPriorityFeePerGas: '0x1dcd6500',
      },
    }));
    await expect(
      getCircleUserOpGasPrice(fakeBundle({ request })),
    ).rejects.toThrow(/gas_congested/);
  });
});

// 本番の送信は prepare+sign → (pending store に保存) → broadcast に分かれる (lib/smartAccount/circleSend.ts)。
// 旧「素の送信」helper (sendCircleUserOperation・estimateCircleUserOp) は本番から呼ばれず削除した
// (第 7 回レビュー A15) ので、Circle 下限の強制と同一 op の broadcast はここで現行の境界に対して固定する。
const SENDER = getAddress('0x2222222222222222222222222222222222222222');

function preparedOp(postOp: bigint | undefined) {
  return {
    sender: SENDER,
    nonce: 0n,
    callData: '0xabc' as Hex,
    callGasLimit: 50_000n,
    verificationGasLimit: 60_000n,
    preVerificationGas: 40_000n,
    maxFeePerGas: 16n,
    maxPriorityFeePerGas: 8n,
    paymaster: PAYMASTER,
    paymasterData: '0xpm' as Hex,
    paymasterVerificationGasLimit: 20_000n,
    paymasterPostOpGasLimit: postOp,
    signature: '0x' as Hex,
  };
}

function signingBundle(postOp: bigint | undefined) {
  const request = vi.fn(async () => ({
    standard: { maxFeePerGas: '0x10', maxPriorityFeePerGas: '0x8' },
  }));
  const prepareUserOperation = vi.fn(async (_params: unknown) => preparedOp(postOp));
  const signUserOperation = vi.fn(async (_op: unknown) => `0x${'11'.repeat(65)}` as Hex);
  const bundle = fakeBundle({ request, prepareUserOperation });
  (bundle as { account: unknown }).account = { signUserOperation };
  return { bundle, prepareUserOperation, signUserOperation };
}

describe('prepareAndSignCircleUserOp (Circle 下限は署名前に強制)', () => {
  it('postOp が Circle 下限 (15000) 未満なら 15000 に引き上げた op に署名する', async () => {
    const { bundle, prepareUserOperation, signUserOperation } = signingBundle(11_360n);
    const calls = [{ to: TOKEN, data: '0xabc' as Hex }];
    const { signedUserOp, userOpHash } = await prepareAndSignCircleUserOp({
      bundle,
      calls,
      paymasterData: '0xpm' as Hex,
    });
    // prepare には paymaster・paymasterData・Circle 下限・standard tier の gas price が渡る。
    expect(prepareUserOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        calls,
        paymaster: PAYMASTER,
        paymasterData: '0xpm',
        paymasterPostOpGasLimit: 15_000n,
        maxFeePerGas: 16n,
        maxPriorityFeePerGas: 8n,
      }),
    );
    // 署名は下限を適用した op に対して行う (署名後に書き換えない)。
    expect(signUserOperation.mock.calls[0][0]).toMatchObject({ paymasterPostOpGasLimit: 15_000n });
    expect(signedUserOp.paymasterPostOpGasLimit).toBe('0x3a98');
    expect(userOpHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('postOp が下限以上ならその値のまま署名する', async () => {
    const { bundle, signUserOperation } = signingBundle(22_000n);
    const { signedUserOp } = await prepareAndSignCircleUserOp({
      bundle,
      calls: [],
      paymasterData: '0x' as Hex,
    });
    expect(signUserOperation.mock.calls[0][0]).toMatchObject({ paymasterPostOpGasLimit: 22_000n });
    expect(signedUserOp.paymasterPostOpGasLimit).toBe('0x55f0');
  });

  it('postOp の見積が無いときも下限で署名する', async () => {
    const { bundle, signUserOperation } = signingBundle(undefined);
    await prepareAndSignCircleUserOp({ bundle, calls: [], paymasterData: '0x' as Hex });
    expect(signUserOperation.mock.calls[0][0]).toMatchObject({ paymasterPostOpGasLimit: 15_000n });
  });

  // 第 10 回レビュー H-V (b): signUsdcPermit の beforeSign と同じ。準備 (ガス価格・prepareUserOperation) の後・ウォレットの前。
  it('beforeSign は prepareUserOperation の後・signUserOperation の前に 1 回呼ばれる', async () => {
    const { bundle, prepareUserOperation, signUserOperation } = signingBundle(22_000n);
    const seen: Array<{ prepared: number; signRequests: number }> = [];
    const beforeSign = vi.fn(() => {
      seen.push({
        // 準備が「返った」後であること (呼んだだけでなく) を、返り値の数で見る。
        prepared: prepareUserOperation.mock.results.filter((r) => r.type === 'return').length,
        signRequests: signUserOperation.mock.calls.length,
      });
    });

    const { userOpHash } = await prepareAndSignCircleUserOp({
      bundle,
      calls: [],
      paymasterData: '0x' as Hex,
      beforeSign,
    });

    expect(seen).toEqual([{ prepared: 1, signRequests: 0 }]);
    expect(signUserOperation).toHaveBeenCalledTimes(1);
    expect(userOpHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('beforeSign が投げると、signUserOperation を呼ばずにその error で終わる', async () => {
    const { bundle, prepareUserOperation, signUserOperation } = signingBundle(22_000n);

    await expect(
      prepareAndSignCircleUserOp({
        bundle,
        calls: [],
        paymasterData: '0x' as Hex,
        beforeSign: () => {
          throw new Error('payment_cancelled');
        },
      }),
    ).rejects.toThrow('payment_cancelled');
    expect(prepareUserOperation).toHaveBeenCalledTimes(1);
    expect(signUserOperation).not.toHaveBeenCalled();
  });
});

// 第 10 回レビュー H-X (PR-39b): 送信は、bundle の bundler の transport と同じ URL・timeout で作った 1 回用の http transport を
// 通し、HTTP の status を見て失敗を分ける (Pimlico の経路の broadcastPimlicoUserOp と同じ考え方・分類の定義も同じもの)。
// 前はここで「bundlerClient.request が { retryCount: 0 } で呼ばれる」ことを偽物の request で確かめていたが、送信は
// bundlerClient.request を通らなくなった (request の error からは HTTP の status が見えない) ので、本物の viem の http transport と
// 偽物の fetch で、実際に bundler へ届く HTTP の request (URL・method・params・回数) を確かめる形に書き直した
// (tests/lib/smartAccount/pimlicoSend.test.ts の「送信は 1 回だけ・失敗の分類」と同じ作り)。
describe('broadcastCircleUserOp / prepareCircleBroadcast (保存済みの署名済み op をそのまま送る・失敗を分類する)', () => {
  // URL の query と op の中身に、S1 の語 (nonce・mempool・already・replace・AA25) をわざと入れる。viem の error の message は
  // URL と request の本文を載せるので、分類が bundler の文でなく message を見ていると、どの拒否も「閉じない側」に倒れる。
  const BUNDLER_URL = 'https://bundler.test/v2/421614/rpc?apikey=nonce-mempool-already-replace-AA25';
  const HASH = `0x${'ab'.repeat(32)}` as Hex;
  const SIGNED_OP = {
    sender: SENDER,
    nonce: '0xaa25',
    callData: '0xAA25',
    signature: `0x${'11'.repeat(65)}`,
  };

  type SendReply =
    | { kind: 'hash' }
    | { kind: 'rpc-error'; code: number; message: string; data?: unknown; status?: number }
    | { kind: 'http'; status: number }
    | { kind: 'network' }
    | { kind: 'hang' };
  let sendReply: SendReply;
  let requests: Array<{ url: string; method: string; params: unknown[] }>;

  beforeEach(() => {
    sendReply = { kind: 'hash' };
    requests = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
        requests.push({ url: String(url), method: body.method, params: body.params });
        const reply = (payload: object, status = 200) =>
          new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...payload }), {
            status,
            headers: { 'Content-Type': 'application/json' },
          });
        if (sendReply.kind === 'hash') return reply({ result: HASH });
        if (sendReply.kind === 'rpc-error') {
          const { code, message, data } = sendReply;
          return reply({ error: { code, message, ...(data === undefined ? {} : { data }) } }, sendReply.status);
        }
        if (sendReply.kind === 'http') return new Response('bad gateway', { status: sendReply.status });
        if (sendReply.kind === 'network') throw new TypeError('Failed to fetch');
        // hang: 応答を返さない (viem の http transport の timeout が abort するまで)。
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          );
        });
      }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // bundle の bundlerClient は本物 (viem の createBundlerClient + http transport)。buildCircleSmartAccountClient と同じ作り方。
  function realBundle(): CircleSmartAccountBundle {
    return {
      ...fakeBundle(),
      bundlerClient: createBundlerClient({ transport: http(BUNDLER_URL) }),
    } as CircleSmartAccountBundle;
  }

  async function broadcastWith(reply: SendReply) {
    sendReply = reply;
    try {
      const hash = await broadcastCircleUserOp({ bundle: realBundle(), signedUserOp: SIGNED_OP });
      return { hash, error: undefined };
    } catch (error) {
      return { hash: undefined, error: error as CircleBroadcastError };
    }
  }

  it('bundle の bundler の URL へ、raw の eth_sendUserOperation で同じ op と EntryPoint v0.8 を 1 回だけ送り、hash を返す', async () => {
    const { hash } = await broadcastWith({ kind: 'hash' });
    expect(hash).toBe(HASH);
    expect(requests).toEqual([
      { url: BUNDLER_URL, method: 'eth_sendUserOperation', params: [SIGNED_OP, entryPoint08Address] },
    ]);
  });

  // ERC-7769 が eth_sendUserOperation の検証の失敗に割り当てる code (lib/smartAccount/pimlicoSend.ts の allowlist)。
  it.each([
    { code: -32602, message: 'invalid UserOperation field' },
    { code: -32500, message: "AA21 didn't pay prefund" },
    { code: -32501, message: 'AA33 reverted (or OOG)' },
    { code: -32502, message: 'banned opcode' },
    { code: -32503, message: 'AA22 expired or not due' },
    { code: -32504, message: 'paymaster throttled' },
    { code: -32505, message: 'paymaster stake too low' },
    { code: -32506, message: 'unsupported aggregator' },
    { code: -32507, message: 'AA24 signature error' },
  ])('HTTP 200 + 検証の拒否 ($code) → validation-rejected・code と bundler の文を持つ・送信は 1 回だけ', async (reply) => {
    const { error } = await broadcastWith({ kind: 'rpc-error', ...reply });
    expect(error?.name).toBe('CircleBroadcastError');
    expect(error).toBeInstanceOf(CircleBroadcastError);
    expect(error?.kind).toBe('validation-rejected');
    expect(error?.code).toBe(reply.code);
    expect(error?.details).toBe(reply.message);
    expect(requests).toHaveLength(1);
  });

  it.each([
    // bundler が受理した後に proxy / 内部で失敗し、HTTP 5xx に JSON-RPC の error が載る (PR-02 の Codex の再現)。
    { label: 'HTTP 500 + -32603 internal', code: -32603, status: 500 },
    // allowlist の code でも、HTTP 5xx・4xx は「受け付けていない」と言えない。
    { label: 'HTTP 500 + -32500', code: -32500, status: 500 },
    { label: 'HTTP 502 + -32602', code: -32602, status: 502 },
    { label: 'HTTP 429 + -32501', code: -32501, status: 429 },
    { label: 'HTTP 429 + -32005 rate limit', code: -32005, status: 429 },
    // HTTP 200 でも allowlist に無い code は分からない。
    { label: 'HTTP 200 + -32603 internal', code: -32603, status: 200 },
    { label: 'HTTP 200 + -32005 rate limit', code: -32005, status: 200 },
    { label: 'HTTP 200 + -32601 method not found', code: -32601, status: 200 },
    { label: 'HTTP 200 + -32508 (viem は持つが allowlist の外)', code: -32508, status: 200 },
    { label: 'HTTP 200 + -32521 execution reverted', code: -32521, status: 200 },
  ])('$label → unknown・送信は 1 回だけ', async ({ code, status }) => {
    const { error } = await broadcastWith({ kind: 'rpc-error', code, message: 'failed', status });
    expect(error).toBeInstanceOf(CircleBroadcastError);
    expect(error?.kind).toBe('unknown');
    expect(error?.code).toBe(code);
    expect(requests).toHaveLength(1);
  });

  it('「Already known」の JSON-RPC の error → already-known (bundler がその op を持っている = 受理と同じ・閉じない側)', async () => {
    const { error } = await broadcastWith({ kind: 'rpc-error', code: -32602, message: 'Already known' });
    expect(error?.kind).toBe('already-known');
  });

  it('HTTP の失敗 (502・本文が JSON-RPC でない) → unknown。viem の既定の再試行 (3 回) をせず、送信は 1 回だけ', async () => {
    const { error } = await broadcastWith({ kind: 'http', status: 502 });
    expect(error).toBeInstanceOf(CircleBroadcastError);
    expect(error?.kind).toBe('unknown');
    expect(error?.code).toBeUndefined();
    expect(error?.details).toBeUndefined();
    expect(requests).toHaveLength(1);
  });

  it('通信断 (fetch の失敗) → unknown・送信は 1 回だけ', async () => {
    const { error } = await broadcastWith({ kind: 'network' });
    expect(error?.kind).toBe('unknown');
    expect(requests).toHaveLength(1);
  });

  it('応答が返らない (bundle の transport の timeout = 既定 10 秒) → unknown・送信は 1 回だけ', async () => {
    sendReply = { kind: 'hang' };
    vi.useFakeTimers();
    const pending = broadcastCircleUserOp({ bundle: realBundle(), signedUserOp: SIGNED_OP }).catch(
      (error: CircleBroadcastError) => error,
    );
    await vi.advanceTimersByTimeAsync(10_001);
    const error = (await pending) as CircleBroadcastError;

    expect(error).toBeInstanceOf(CircleBroadcastError);
    expect(error.kind).toBe('unknown');
    expect((error.cause as Error).name).toBe('TimeoutError');
    expect(requests).toHaveLength(1);
  });

  it('投げる error の message は元の error (viem) の文のまま・cause に元の error を持つ', async () => {
    const { error } = await broadcastWith({ kind: 'rpc-error', code: -32501, message: 'AA33 reverted (or OOG)' });
    const cause = error?.cause as Error;
    expect(cause).toBeInstanceOf(Error);
    expect(error?.message).toBe(cause.message);
    // viem の文は、送った request の本文 (署名) を含む。だから呼び出し側は message を記録にも画面にも出さず、details を使う。
    expect(error?.message).toContain(SIGNED_OP.signature);
    expect(error?.details).not.toContain(SIGNED_OP.signature);
  });

  // S1: 検証の拒否 (HTTP 200 + allowlist の code) でも、bundler の文が nonce・mempool・重複・置き換えに触れているときは
  // 「受け付けていない」と読まない。この経路の nonce は試みごとに新しい key なので、その op 自身がもう届いている疑いがある。
  describe('S1: bundler の文が nonce・mempool などに触れている拒否は、閉じない側 (unknown / already-known) に倒す', () => {
    it.each([
      { message: 'AA25 invalid account nonce', kind: 'unknown' },
      { message: 'UserOperation reverted during simulation with reason: AA25 invalid account nonce', kind: 'unknown' },
      { message: 'invalid Nonce', kind: 'unknown' },
      { message: 'sender has too many UserOperations in the mempool', kind: 'unknown' },
      { message: 'userOp was already included', kind: 'unknown' },
      { message: 'replacement underpriced', kind: 'unknown' },
      { message: 'Replacement op must have higher fees', kind: 'unknown' },
      // already known の形は Pimlico の経路と同じ分類 (already-known) のまま。
      { message: 'Already known', kind: 'already-known' },
      { message: 'UserOperation already in mempool', kind: 'already-known' },
    ])('HTTP 200 + -32500「$message」→ $kind', async ({ message, kind }) => {
      const { error } = await broadcastWith({ kind: 'rpc-error', code: -32500, message });
      expect(error?.kind).toBe(kind);
      expect(error?.code).toBe(-32500);
      expect(requests).toHaveLength(1);
    });

    it('語が JSON-RPC の error の data の側にあるときも、閉じない側', async () => {
      const { error } = await broadcastWith({
        kind: 'rpc-error',
        code: -32500,
        message: 'validation failed',
        data: { reason: 'AA25 invalid account nonce' },
      });
      expect(error?.kind).toBe('unknown');
    });

    it('data があっても、語が無ければ validation-rejected のまま', async () => {
      const { error } = await broadcastWith({
        kind: 'rpc-error',
        code: -32501,
        message: 'AA33 reverted (or OOG)',
        data: { paymaster: PAYMASTER },
      });
      expect(error?.kind).toBe('validation-rejected');
    });

    it('語の一覧 (AA25・nonce・mempool・already・replace) と判定を固定する', () => {
      for (const text of [
        'AA25 invalid account nonce',
        'aa25',
        'invalid nonce',
        'NONCE too low',
        'already in mempool',
        'Mempool is full',
        'already known',
        'Already processed',
        'replacement underpriced',
        'cannot REPLACE userOp',
      ]) {
        expect(mentionsNonceOrMempool(text), text).toBe(true);
      }
      // EntryPoint・paymaster の検証の拒否 (残高・署名・期限・paymaster) は、どの語にも当たらない。
      for (const text of [
        "AA21 didn't pay prefund",
        'AA23 reverted (or OOG)',
        'AA24 signature error',
        'AA22 expired or not due',
        'AA31 paymaster deposit too low',
        'AA32 paymaster expired or not due',
        'AA33 reverted (or OOG)',
        'AA34 signature error',
        'ERC20: transfer amount exceeds balance',
        'paymaster throttled',
        'invalid UserOperation field',
        '',
      ]) {
        expect(mentionsNonceOrMempool(text), text).toBe(false);
      }
    });

    it('分類の関数は、JSON-RPC の error を持たない error を unknown にする (HTTP の status に関わらず)', () => {
      expect(classifyCircleBroadcastError(new Error('AA21 prefund'), 200)).toEqual({
        kind: 'unknown',
        code: undefined,
        details: undefined,
      });
      expect(classifyCircleBroadcastError(undefined, 200).kind).toBe('unknown');
    });
  });

  // S3: 用意 (transport を作る) と送信を分ける。呼び出し側 (circleSend.ts) は、記録を submitting にする前に用意を済ませる。
  describe('prepareCircleBroadcast (送信の用意)', () => {
    it('用意は同期で、何も送らない。返った関数を呼んだときに 1 回だけ送る', async () => {
      const send = prepareCircleBroadcast(realBundle());
      expect(typeof send).toBe('function');
      expect(requests).toEqual([]);

      await expect(send(SIGNED_OP)).resolves.toBe(HASH);
      expect(requests).toEqual([
        { url: BUNDLER_URL, method: 'eth_sendUserOperation', params: [SIGNED_OP, entryPoint08Address] },
      ]);
    });

    it('bundle の transport が URL を持たない (設定の誤り) → 用意の時点で同期で投げる・何も送らない', () => {
      // 偽物の bundlerClient (transport なし) ではなく、URL の無い transport を持つ形。
      const bundle = {
        ...fakeBundle(),
        bundlerClient: { transport: { type: 'custom' } },
      } as unknown as CircleSmartAccountBundle;
      expect(() => prepareCircleBroadcast(bundle)).toThrow(/No URL was provided/);
      expect(requests).toEqual([]);
    });

    it('用意した関数の失敗も、同じ分類の error', async () => {
      const send = prepareCircleBroadcast(realBundle());
      sendReply = { kind: 'rpc-error', code: -32507, message: 'AA24 signature error' };
      const error = await send(SIGNED_OP).catch((e: CircleBroadcastError) => e);
      expect(error).toBeInstanceOf(CircleBroadcastError);
      expect((error as CircleBroadcastError).kind).toBe('validation-rejected');
    });
  });
});

describe('buildCircleSmartAccountClient', () => {
  it('USDC 以外の deployment を拒否する', async () => {
    const jpyc = resolveDeployment('jpyc', 80002)!; // Polygon Amoy JPYC
    await expect(
      buildCircleSmartAccountClient({
        walletClient: {} as never,
        publicClient: fakePublicClient({}) as never,
        chainId: 80002,
        deployment: jpyc,
      }),
    ).rejects.toThrow(/USDC 専用/);
  });
});

describe('assertCirclePaymasterDeployed (C3 guard)', () => {
  it('allowlist アドレスに code が無ければ throw', async () => {
    const publicClient = fakePublicClient({ code: '0x' });
    await expect(
      assertCirclePaymasterDeployed(publicClient as never, CHAIN_ID),
    ).rejects.toThrow(/contract code/);
  });

  it('登録済 codehash と不一致の code なら throw (B1: 信頼境界 codehash 検証)', async () => {
    // CHAIN_ID (421614=Arb Sepolia) は CIRCLE_PAYMASTER_CODEHASH 登録済。任意の
    // 非空 code は実 paymaster の codehash と一致しないので keccak256 不一致で弾く。
    // (一致 path = 実 bytecode は scripts/verify-circle-codehash.mjs が全 chain で on-chain 検証済。)
    const publicClient = fakePublicClient({ code: '0x6080604052' });
    await expect(
      assertCirclePaymasterDeployed(publicClient as never, CHAIN_ID),
    ).rejects.toThrow(/codehash/);
  });
});
