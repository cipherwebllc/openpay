// 第 10 回レビュー A-1: Pimlico の送信を「nonce → 準備 → 署名 → (保存) → 送信」に分ける primitive
// (lib/smartAccount/pimlicoSend.ts) を、builder と SDK (viem・permissionless・delegation-toolkit) は実物のまま、
// 通信 (fetch) だけを差し替えて確かめる。
//
//   (1) 分ける前 (smartAccountClient.sendUserOperation) と分けた後で、bundler に届く eth_sendUserOperation の
//       params が同じ (simple 7702・MetaMask × sponsorship・erc20 paymaster)
//   (2) 送信は 1 回だけ (再送なし)。失敗の分類: JSON-RPC の error だけが「断られた」、それ以外は「分からない」
//   (3) 計算する hash が、本番の経路 (委任済みの simple 7702・EntryPoint 0.8) の実際の UserOperation の hash と合う
//   (4) EntryPoint の getNonce で「nonce がもう使われたか」を読む・MAv2 の facade は分けられない client として扱う
//
// 保存・ラッチ・再試行の扱い (hook の側) は tests/hooks/useBatchPayment.pimlicoSend.test.tsx。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  encodeAbiParameters,
  http,
  maxUint256,
  toHex,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  entryPoint07Address,
  entryPoint08Address,
  formatUserOperation,
  getUserOperationHash,
  UserOperationReceiptNotFoundError,
  type RpcUserOperation,
  type UserOperation,
} from 'viem/account-abstraction';
import { base, polygon } from 'viem/chains';
import { createPimlicoClient } from 'permissionless/clients/pimlico';
import { GasCongestedError } from '@/lib/gasCeiling';
import type { TokenDeployment } from '@/lib/tokens';
import {
  buildSimpleSmartAccountClient,
  type ConnectedWalletClient,
  type SmartAccountBundle,
} from '@/lib/smartAccount/simpleAccount';
import { buildMetaMaskSmartAccountClient } from '@/lib/smartAccount/metamask';
import {
  asSignedSendClient,
  broadcastPimlicoUserOp,
  classifyBroadcastError,
  findUserOperationReceipt,
  isUserOpNonceConsumed,
  joinUserOpNonce,
  prepareAndSignPimlicoUserOp,
  reserveUserOpNonce,
  splitUserOpNonce,
  toUserOperationRejection,
  type SignedSendClient,
} from '@/lib/smartAccount/pimlicoSend';

const BUNDLER_URL = 'https://bundler.test/rpc';
const CHAIN_URL = 'https://chain.test/';

// anvil の既定の 1 本目の鍵 (公開されている test 用の鍵。資金は無い)。
const OWNER = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);
const SIMPLE_7702_IMPL = 'e6Cae83BdE06E4c305530e199D7217f42808555B';
const METAMASK_7702_IMPL = '63c0c19a282a1B52b07dD5a65b58948A07DAE32B';
const PAYMASTER: Address = '0x888888888888Ec68A58AB8094Cc1AD20Ba3D2402';
const JPYC: Address = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29';
const USDC_BASE: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const MERCHANT: Address = '0x1111111111111111111111111111111111111111';

const jpycPolygon: TokenDeployment = {
  symbol: 'jpyc',
  displaySymbol: 'JPYC',
  name: 'JPY Coin',
  decimals: 18,
  address: JPYC,
  chainId: polygon.id,
  paymasterMode: 'sponsorship',
};
const usdcBase: TokenDeployment = {
  symbol: 'usdc',
  displaySymbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
  address: USDC_BASE,
  chainId: base.id,
  paymasterMode: 'erc20',
};

vi.mock('@/lib/pimlico', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/pimlico')>('@/lib/pimlico');
  return {
    ...actual,
    pimlicoUrl: () => BUNDLER_URL,
    // 実物の permissionless の Pimlico client (URL だけ test の bundler)。
    createPimlico: (_chainId: number, version: '0.7' | '0.8' = '0.7') =>
      createPimlicoClient({
        transport: http(BUNDLER_URL),
        entryPoint:
          version === '0.8'
            ? { address: entryPoint08Address, version: '0.8' }
            : { address: entryPoint07Address, version: '0.7' },
      }),
    // test 環境は testnet で resolvePaymasterMode が USDC erc20 → sponsorship に倒すため、
    // deployment の paymasterMode をそのまま使う (本番の erc20 paymaster の経路を通す)。
    assertGaslessSupported: (deployment: TokenDeployment) =>
      deployment.paymasterMode as 'sponsorship' | 'erc20',
    pimlicoPaymasterContext: (deployment: TokenDeployment) =>
      deployment.paymasterMode === 'erc20'
        ? { token: deployment.address }
        : { sponsorshipPolicyId: 'sp_test' },
  };
});

// ---- 通信の偽物 -------------------------------------------------------------
type RpcCall = { url: string; method: string; params: unknown[] };
let rpcCalls: RpcCall[] = [];
// 委任先 (eth_getCode が返す 0xef0100 + 実装)。
let delegatedImpl = SIMPLE_7702_IMPL;
// EntryPoint の getNonce が返す seq (key はそのまま返す)。
let entryPointSeq = 0n;
// ウォレットに届いた署名の要求の数。
let walletSignatures = 0;
// eth_sendUserOperation への答え方。
type SendReply =
  | { kind: 'hash'; hash: Hex }
  | { kind: 'rpc-error'; code: number; message: string }
  | { kind: 'http'; status: number }
  | { kind: 'network' }
  | { kind: 'hang' };
let sendReply: SendReply = { kind: 'hash', hash: `0x${'ab'.repeat(32)}` };

// Base の上限 (10 gwei) と Polygon の上限 (1000 gwei) のどちらも下回る値。test が上げることがある。
const NORMAL_GAS_PRICE_TIER = { maxFeePerGas: toHex(2n * 10n ** 9n), maxPriorityFeePerGas: toHex(10n ** 8n) };
let GAS_PRICE_TIER = NORMAL_GAS_PRICE_TIER;
const PAYMASTER_FIELDS = {
  paymaster: PAYMASTER,
  paymasterData: '0x0000006af3a9ce00000000000022b8d9c2b406ffb700d3214823824c759ba2c9',
  paymasterVerificationGasLimit: toHex(35_470n),
  paymasterPostOpGasLimit: toHex(1n),
};

// chain の RPC と、ウォレット (injected wallet の代わり) の両方に答える。署名は owner の鍵で実際に作る。
async function chainRpcResult(method: string, params: unknown[]): Promise<unknown> {
  if (method === 'eth_chainId') return toHex(1);
  if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [OWNER.address];
  if (method === 'eth_signTypedData_v4') {
    walletSignatures += 1;
    return OWNER.signTypedData(JSON.parse(params[1] as string));
  }
  if (method === 'eth_getCode') return `0xef0100${delegatedImpl}`;
  if (method === 'eth_call') {
    const [{ to, data }] = params as [{ to: Address; data: Hex }];
    const isEntryPoint =
      to.toLowerCase() === entryPoint08Address.toLowerCase() ||
      to.toLowerCase() === entryPoint07Address.toLowerCase();
    if (isEntryPoint) {
      // getNonce(address sender, uint192 key) → key << 64 | seq
      const key = BigInt(`0x${data.slice(2 + 8 + 64)}`);
      return encodeAbiParameters([{ type: 'uint256' }], [joinUserOpNonce(key, entryPointSeq)]);
    }
    // token の allowance(owner, paymaster): 足りている (approve を足さない)。
    return encodeAbiParameters([{ type: 'uint256' }], [maxUint256]);
  }
  throw new Error(`chain rpc: 想定外の method ${method}`);
}

function bundlerRpcResult(method: string): unknown {
  if (method === 'pimlico_getUserOperationGasPrice') {
    return { slow: GAS_PRICE_TIER, standard: GAS_PRICE_TIER, fast: GAS_PRICE_TIER };
  }
  if (method === 'pimlico_getTokenQuotes') {
    return {
      quotes: [
        {
          paymaster: PAYMASTER,
          token: USDC_BASE,
          postOpGas: toHex(50_000n),
          exchangeRate: toHex(10n ** 18n),
          exchangeRateNativeToUsd: toHex(10n ** 18n),
        },
      ],
    };
  }
  if (method === 'pm_getPaymasterStubData' || method === 'pm_getPaymasterData') {
    return PAYMASTER_FIELDS;
  }
  if (method === 'eth_estimateUserOperationGas') {
    return {
      preVerificationGas: toHex(55_289n),
      verificationGasLimit: toHex(51_698n),
      callGasLimit: toHex(74_351n),
      paymasterVerificationGasLimit: toHex(35_470n),
      paymasterPostOpGasLimit: toHex(1n),
    };
  }
  throw new Error(`bundler rpc: 想定外の method ${method}`);
}

beforeEach(() => {
  rpcCalls = [];
  delegatedImpl = SIMPLE_7702_IMPL;
  entryPointSeq = 0n;
  walletSignatures = 0;
  GAS_PRICE_TIER = NORMAL_GAS_PRICE_TIER;
  sendReply = { kind: 'hash', hash: `0x${'ab'.repeat(32)}` };
  // nonce の key は Date.now() から作られる (viem の toSmartAccount)。分ける前と後で同じ key にする。
  vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
        params: unknown[];
      };
      rpcCalls.push({ url: String(url), method: body.method, params: body.params });
      const reply = (payload: object, status = 200) =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...payload }), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      if (body.method === 'eth_sendUserOperation') {
        if (sendReply.kind === 'hash') return reply({ result: sendReply.hash });
        if (sendReply.kind === 'rpc-error') {
          return reply({ error: { code: sendReply.code, message: sendReply.message } });
        }
        if (sendReply.kind === 'http') return new Response('bad gateway', { status: sendReply.status });
        if (sendReply.kind === 'network') throw new TypeError('Failed to fetch');
        // hang: 応答を返さない (viem の http transport の timeout が abort するまで)。
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          );
        });
      }
      const result = String(url).startsWith(BUNDLER_URL)
        ? bundlerRpcResult(body.method)
        : await chainRpcResult(body.method, body.params);
      return reply({ result });
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function clientsFor(chain: Chain) {
  const publicClient = createPublicClient({ chain, transport: http(CHAIN_URL) }) as PublicClient;
  const walletClient = createWalletClient({
    account: OWNER,
    chain,
    transport: http(CHAIN_URL),
  }) as unknown as ConnectedWalletClient;
  return { publicClient, walletClient };
}

type BuilderCase = {
  name: string;
  impl: string;
  entryPoint: Address;
  build: (deployment: TokenDeployment, chain: Chain) => Promise<SmartAccountBundle>;
};

const builders: BuilderCase[] = [
  {
    name: 'simple 7702 (permissionless to7702SimpleSmartAccount・EntryPoint 0.8)',
    impl: SIMPLE_7702_IMPL,
    entryPoint: entryPoint08Address,
    build: (deployment, chain) =>
      buildSimpleSmartAccountClient({ ...clientsFor(chain), chainId: chain.id, deployment }),
  },
  {
    name: 'MetaMask (delegation-toolkit Stateless7702・EntryPoint 0.7)',
    impl: METAMASK_7702_IMPL,
    entryPoint: entryPoint07Address,
    build: (deployment, chain) =>
      buildMetaMaskSmartAccountClient({
        ...clientsFor(chain),
        chainId: chain.id,
        account: OWNER.address,
        deployment,
      }),
  },
];

const CALLS = [
  {
    to: JPYC,
    // transfer(MERCHANT, 1000)
    data: `0xa9059cbb${MERCHANT.slice(2).padStart(64, '0')}${(1000).toString(16).padStart(64, '0')}` as Hex,
  },
];

function sentUserOps(): Array<{ op: Record<string, unknown>; entryPoint: Address }> {
  return rpcCalls
    .filter((c) => c.method === 'eth_sendUserOperation')
    .map((c) => ({
      op: c.params[0] as Record<string, unknown>,
      entryPoint: c.params[1] as Address,
    }));
}

function bundlerMethods(): string[] {
  return rpcCalls.filter((c) => c.url.startsWith(BUNDLER_URL)).map((c) => c.method);
}

function splitClientOf(bundle: SmartAccountBundle): SignedSendClient {
  const client = asSignedSendClient(bundle.smartAccountClient);
  if (!client) throw new Error('分けられる client のはず');
  return client;
}

async function sendSplit(bundle: SmartAccountBundle) {
  const client = splitClientOf(bundle);
  const nonce = await reserveUserOpNonce(client);
  const built = await prepareAndSignPimlicoUserOp({ client, calls: CALLS, nonce });
  const returned = await broadcastPimlicoUserOp({
    client,
    signedUserOp: built.signedUserOp,
    entryPoint: built.entryPoint,
  });
  return { nonce, built, returned };
}

describe.each(builders)('$name', ({ impl, entryPoint, build }) => {
  beforeEach(() => {
    delegatedImpl = impl;
  });

  it.each([
    { label: 'Polygon の JPYC (sponsorship)', deployment: jpycPolygon, chain: polygon as Chain },
    { label: 'Base の USDC (erc20 paymaster)', deployment: usdcBase, chain: base as Chain },
  ])(
    '$label: 分ける前 (sendUserOperation) と分けた後で、bundler に届く eth_sendUserOperation の params が同じ',
    async ({ deployment, chain }) => {
      // 分ける前: viem の sendUserOperation (準備・署名・送信を 1 回で行う)。
      const before = await build(deployment, chain);
      await before.smartAccountClient.sendUserOperation({ calls: CALLS });
      const beforeSent = sentUserOps();
      const beforeMethods = bundlerMethods();
      expect(beforeSent).toHaveLength(1);

      // 分けた後: 同じ条件で account と client を作り直す (nonce の key の採番を最初からにする)。
      rpcCalls = [];
      const after = await build(deployment, chain);
      const { built, returned, nonce } = await sendSplit(after);
      const afterSent = sentUserOps();
      expect(afterSent).toHaveLength(1);

      expect(afterSent[0]).toEqual(beforeSent[0]);
      // bundler・paymaster への問い合わせの列も同じ (erc20 paymaster の独自の prepare と fee の見積もりを通る)。
      expect(bundlerMethods()).toEqual(beforeMethods);
      expect(bundlerMethods()).toContain('pimlico_getUserOperationGasPrice');
      if (deployment.paymasterMode === 'erc20') {
        expect(bundlerMethods()).toContain('pimlico_getTokenQuotes');
      }

      // 保存する op = 送った op。送り先の EntryPoint は account のもの。nonce は先に決めた値。
      expect(afterSent[0].op).toEqual(built.signedUserOp);
      expect(afterSent[0].entryPoint).toBe(entryPoint);
      expect(built.entryPoint).toBe(entryPoint);
      expect(BigInt(afterSent[0].op.nonce as Hex)).toBe(nonce);
      expect(returned).toBe(`0x${'ab'.repeat(32)}`);
      // 送った op の署名は owner の鍵で実際に作られている (stub の署名ではない)。
      expect(afterSent[0].op.signature).toMatch(/^0x[0-9a-f]{130}$/);
    },
  );

  it('fee の上限の検査は分けた後も準備の中を通る: standard が上限を超えると、署名・送信の前に GasCongestedError がそのまま届く', async () => {
    // Base の上限は 10 gwei。準備の中の fee の見積もり (ceilingCheckedStandardFee) が 10.1 gwei で止める (第 9 回 A-5)。
    GAS_PRICE_TIER = {
      maxFeePerGas: toHex(10n * 10n ** 9n + 10n ** 8n),
      maxPriorityFeePerGas: toHex(10n ** 8n),
    };
    const bundle = await build(usdcBase, base);
    const client = splitClientOf(bundle);
    const nonce = await reserveUserOpNonce(client);

    const error = await prepareAndSignPimlicoUserOp({ client, calls: CALLS, nonce }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(GasCongestedError);
    expect(walletSignatures).toBe(0);
    expect(sentUserOps()).toEqual([]);
    expect(bundlerMethods()).not.toContain('eth_estimateUserOperationGas');
  });

  it('作り直し: 同じ nonce を渡すと、fee が変わっても nonce は 1 本目と同じ (account の getNonce を読み直さない)', async () => {
    const bundle = await build(jpycPolygon, polygon);
    const client = splitClientOf(bundle);
    const nonce = await reserveUserOpNonce(client);
    const first = await prepareAndSignPimlicoUserOp({ client, calls: CALLS, nonce });

    // 1 本目が取り込まれて EntryPoint の seq が進んだ後でも、作り直しは保存した nonce のまま
    // (seq を読み直すと seq+1 の op になり、1 本目と並んで実行できてしまう)。
    entryPointSeq = 1n;
    rpcCalls = [];
    const rebuilt = await prepareAndSignPimlicoUserOp({ client, calls: CALLS, nonce });

    expect(BigInt(rebuilt.signedUserOp.nonce as Hex)).toBe(nonce);
    expect(rebuilt.signedUserOp.nonce).toBe(first.signedUserOp.nonce);
    // 準備の中で EntryPoint の getNonce を読んでいない。
    const nonceReads = rpcCalls.filter(
      (c) =>
        c.method === 'eth_call' &&
        (c.params[0] as { to: Address }).to.toLowerCase() === entryPoint.toLowerCase(),
    );
    expect(nonceReads).toEqual([]);
  });

  it('nonce がもう使われたかを EntryPoint の getNonce(sender, key) で読む', async () => {
    const bundle = await build(jpycPolygon, polygon);
    const client = splitClientOf(bundle);
    const nonce = await reserveUserOpNonce(client);
    const args = { client, entryPoint, sender: client.account.address, nonce };

    expect(await isUserOpNonceConsumed(args)).toBe(false);
    const read = rpcCalls.filter((c) => c.method === 'eth_call').at(-1);
    const { to, data } = (read?.params[0] ?? {}) as { to: Address; data: Hex };
    expect(to.toLowerCase()).toBe(entryPoint.toLowerCase());
    // 読んだ key は、保存した nonce の key (account が key を無視する実装でも EntryPoint を直接読む)。
    expect(BigInt(`0x${data.slice(2 + 8 + 64)}`)).toBe(splitUserOpNonce(nonce).key);

    entryPointSeq = splitUserOpNonce(nonce).seq + 1n;
    expect(await isUserOpNonceConsumed(args)).toBe(true);
  });
});

describe('送信は 1 回だけ・失敗の分類 (実物の http transport)', () => {
  async function broadcastAndCatch(reply: SendReply) {
    const bundle = await buildSimpleSmartAccountClient({
      ...clientsFor(polygon),
      chainId: polygon.id,
      deployment: jpycPolygon,
    });
    const client = splitClientOf(bundle);
    const nonce = await reserveUserOpNonce(client);
    const built = await prepareAndSignPimlicoUserOp({ client, calls: CALLS, nonce });
    sendReply = reply;
    rpcCalls = [];
    const error = await broadcastPimlicoUserOp({
      client,
      signedUserOp: built.signedUserOp,
      entryPoint: built.entryPoint,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    return { error, built };
  }

  it('bundler が JSON-RPC の error で断った → rejected。error は viem の sendUserOperation と同じ形に包める', async () => {
    const { error, built } = await broadcastAndCatch({
      kind: 'rpc-error',
      code: -32500,
      message: "AA21 didn't pay prefund",
    });
    expect(classifyBroadcastError(error)).toBe('rejected');
    expect(sentUserOps()).toHaveLength(1);

    const wrapped = toUserOperationRejection(error, { signed: built.signed, calls: CALLS });
    expect(wrapped.name).toBe('UserOperationExecutionError');
    expect(wrapped.message).toContain('prefund');
  });

  it.each([
    { code: -32005, message: 'rate limit exceeded' },
    { code: -32603, message: 'internal error' },
    { code: -32602, message: 'maxFeePerGas must be at least 1000 (current maxFeePerGas: 1)' },
  ])('一時的な JSON-RPC の error ($code) も rejected (呼び出し側は記録を消さずに同じ nonce で作り直す)', async (reply) => {
    const { error } = await broadcastAndCatch({ kind: 'rpc-error', ...reply });
    expect(classifyBroadcastError(error)).toBe('rejected');
    expect(sentUserOps()).toHaveLength(1);
  });

  it('「Already known」の JSON-RPC の error → already-known (bundler がその op を持っている)', async () => {
    const { error } = await broadcastAndCatch({
      kind: 'rpc-error',
      code: -32602,
      message: 'Already known',
    });
    expect(classifyBroadcastError(error)).toBe('already-known');
  });

  it('HTTP の失敗 (502) → unknown。viem の既定の再試行 (3 回) をせず、送信は 1 回だけ', async () => {
    const { error } = await broadcastAndCatch({ kind: 'http', status: 502 });
    expect(classifyBroadcastError(error)).toBe('unknown');
    expect(sentUserOps()).toHaveLength(1);
  });

  it('通信断 (fetch の失敗) → unknown・送信は 1 回だけ', async () => {
    const { error } = await broadcastAndCatch({ kind: 'network' });
    expect(classifyBroadcastError(error)).toBe('unknown');
    expect(sentUserOps()).toHaveLength(1);
  });

  it('応答が返らない (http の timeout) → unknown・送信は 1 回だけ (A-1 の失敗シナリオ)', async () => {
    const bundle = await buildSimpleSmartAccountClient({
      ...clientsFor(polygon),
      chainId: polygon.id,
      deployment: jpycPolygon,
    });
    const client = splitClientOf(bundle);
    const nonce = await reserveUserOpNonce(client);
    const built = await prepareAndSignPimlicoUserOp({ client, calls: CALLS, nonce });
    sendReply = { kind: 'hang' };
    rpcCalls = [];

    vi.useFakeTimers();
    const pending = broadcastPimlicoUserOp({
      client,
      signedUserOp: built.signedUserOp,
      entryPoint: built.entryPoint,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    // viem の http transport の既定の timeout は 10 秒。
    await vi.advanceTimersByTimeAsync(10_001);
    const error = await pending;

    expect((error as Error).name).toBe('TimeoutError');
    expect(classifyBroadcastError(error)).toBe('unknown');
    expect(sentUserOps()).toHaveLength(1);
  });

  it('JSON-RPC の error を持たない error は、何であっても unknown (受理していないと読まない)', () => {
    expect(classifyBroadcastError(new Error('AA21 prefund'))).toBe('unknown');
    expect(classifyBroadcastError(new Error('Already known'))).toBe('unknown');
    expect(classifyBroadcastError(undefined)).toBe('unknown');
    expect(classifyBroadcastError('rejected')).toBe('unknown');
  });
});

describe('計算する hash (本番の経路の実際のベクター)', () => {
  // Base mainnet の tx 0x7870e4a8b39101454f3728292ba3cc592713f72bdf7e45ea0088cc23349dd0c8 (block 55815596) に
  // 入っている UserOperation (公開のチェーンのデータ)。sender は simple 7702 の実装 (0xe6Cae83…) に委任済みの EOA
  // (eth_getCode = 0xef0100e6cae83b…)・EntryPoint 0.8・Pimlico の paymaster・initCode なし・authorization なし
  // = OpenPay の本番の Pimlico の経路 (委任済みの pimlico-simple-7702) と同じ形。
  // EXPECTED は EntryPoint が出した UserOperationEvent の userOpHash (bundler が返す hash と同じ値)。
  const EXPECTED: Hex = '0x355470ee79450e548e3fb6adcfbecec743ce34bb93b76abbef98b72b0bf317d0';
  const SIGNATURE: Hex =
    '0xc319322f4bd022dc159544541e38dd52ff8288a90642f8ba58efb8c181e28bae5f21e11a7554505dca31ec2644acd7576015a4f13282b455116f156d06c9540a1b';
  const UNSIGNED = {
    sender: '0x51b20C405BA5360A46c40792bC697ECcCc4d6C04',
    nonce: 98359691079277037071037552191052879328770159639399913688609539195434000449536n,
    callData:
      '0x34fcd5be0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000120000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000044095ea7b30000000000000000000000004cd00e387622c35bddb9b4c962c136462338bc3100000000000000000000000000000000000000000000000000000000004c4b40000000000000000000000000000000000000000000000000000000000000000000000000000000004cd00e387622c35bddb9b4c962c136462338bc31000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000084e801795200000000000000000000000051b20c405ba5360a46c40792bc697ecccc4d6c04000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda0291300000000000000000000000000000000000000000000000000000000004c4b40aef1d28afb350f38271c0e5d03ddb7c47eea07f4b95e28e6d5bafa0bb0bc31f900000000000000000000000000000000000000000000000000000000',
    verificationGasLimit: 51_698n,
    callGasLimit: 74_351n,
    preVerificationGas: 55_289n,
    maxPriorityFeePerGas: 1_359_875n,
    maxFeePerGas: 8_949_875n,
    paymaster: '0x888888888888ec68a58ab8094cc1ad20ba3d2402',
    paymasterVerificationGasLimit: 35_470n,
    paymasterPostOpGasLimit: 1n,
    paymasterData:
      '0x0000006af3a9ce00000000000022b8d9c2b406ffb700d3214823824c759ba2c986a89f571b2938808b72174a4a7eddb6732e8d1356844d4e336250f323f16817585befe1b3b09e096d89fdb4d51c',
    signature: '0x',
  } as unknown as UserOperation;

  it('準備された op と署名から計算する hash が、EntryPoint の event の userOpHash と一致する', async () => {
    const prepareUserOperation = vi.fn(async () => UNSIGNED);
    const signUserOperation = vi.fn(async () => SIGNATURE);
    const client = {
      account: {
        address: UNSIGNED.sender,
        client: {},
        entryPoint: { address: entryPoint08Address, version: '0.8' },
        getNonce: async () => UNSIGNED.nonce,
        signUserOperation,
      },
      chain: { id: base.id },
      prepareUserOperation,
      request: vi.fn(),
    } as unknown as SignedSendClient;

    const built = await prepareAndSignPimlicoUserOp({
      client,
      calls: CALLS,
      nonce: UNSIGNED.nonce,
    });

    expect(built.userOpHash).toBe(EXPECTED);
    expect(prepareUserOperation).toHaveBeenCalledWith({ calls: CALLS, nonce: UNSIGNED.nonce });
    // 保存する RPC の形の op からも同じ hash になる (保存 → 読み直しで中身が変わらない)。
    const restored = formatUserOperation(
      JSON.parse(JSON.stringify(built.signedUserOp)) as RpcUserOperation,
    ) as UserOperation<'0.8'>;
    expect(
      getUserOperationHash({
        chainId: base.id,
        entryPointAddress: entryPoint08Address,
        entryPointVersion: '0.8',
        userOperation: restored,
      }),
    ).toBe(EXPECTED);
    expect(built.signedUserOp.signature).toBe(SIGNATURE);
    // chain が違えば hash も違う (chain id を hash に入れている)。
    const other = await prepareAndSignPimlicoUserOp({
      client: { ...client, chain: { id: polygon.id } },
      calls: CALLS,
      nonce: UNSIGNED.nonce,
    });
    expect(other.userOpHash).not.toBe(EXPECTED);
  });
});

describe('分けられない client・小さな部品', () => {
  it('MAv2 の facade (sendUserOperation だけ) は分けられない client = null', () => {
    const facade = { sendUserOperation: async () => '0x' as Hex };
    expect(asSignedSendClient(facade)).toBeNull();
    expect(asSignedSendClient(null)).toBeNull();
    expect(asSignedSendClient(undefined)).toBeNull();
  });

  it('nonce を key (上位 192 bit) と seq (下位 64 bit) に分けて戻せる', () => {
    const key = 1_800_000_000_000n;
    const nonce = joinUserOpNonce(key, 7n);
    expect(splitUserOpNonce(nonce)).toEqual({ key, seq: 7n });
    expect(nonce).toBe((key << 64n) | 7n);
    // seq の上限でも key に繰り上がらない。
    const maxSeq = (1n << 64n) - 1n;
    expect(splitUserOpNonce(joinUserOpNonce(key, maxSeq))).toEqual({ key, seq: maxSeq });
  });

  it('receipt の照会: 「まだ無い」は次の hash へ進み、どれも無ければ null', async () => {
    const receipts = new Map<Hex, { ok: true }>([['0x02', { ok: true }]]);
    const getUserOperationReceipt = vi.fn(async ({ hash }: { hash: Hex }) => {
      const receipt = receipts.get(hash);
      if (!receipt) throw new UserOperationReceiptNotFoundError({ hash });
      return receipt;
    });
    const bundler = { getUserOperationReceipt };

    expect(await findUserOperationReceipt(bundler, ['0x01', '0x02', '0x03'])).toEqual({
      userOpHash: '0x02',
      receipt: { ok: true },
    });
    expect(getUserOperationReceipt).toHaveBeenCalledTimes(2);
    expect(await findUserOperationReceipt(bundler, ['0x01', '0x03'])).toBeNull();
  });

  it('receipt の照会: 照会そのものの失敗は「無い」と読まずに投げる', async () => {
    const bundler = {
      getUserOperationReceipt: vi.fn(async () => {
        throw new Error('HTTP request failed');
      }),
    };
    await expect(findUserOperationReceipt(bundler, ['0x01'])).rejects.toThrow(
      'HTTP request failed',
    );
  });

  it('送った calls は transfer のまま (test の入力の確認)', () => {
    const decoded = decodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'transfer',
          stateMutability: 'nonpayable',
          inputs: [
            { name: 'to', type: 'address' },
            { name: 'amount', type: 'uint256' },
          ],
          outputs: [{ type: 'bool' }],
        },
      ],
      data: CALLS[0].data,
    });
    expect(decoded.args).toEqual([MERCHANT, 1000n]);
  });
});
