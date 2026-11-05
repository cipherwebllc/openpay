// 第 9 回レビュー A-5: Pimlico の 3 つの builder (simpleAccount / metamask / mav2) の fee の見積もりは、
// UserOp に実際に入れる standard に上限をかける (lib/gasCeiling の ceilingCheckedStandardFee)。
// 呼出元 (useBatchPayment) の fast の検査の後にガスが上がっても、検査していない値で署名させない。
//
// throw は viem (estimateFeesPerGas) / aa-sdk (feeEstimator の middleware) の中で起きるので、builder と
// SDK (permissionless・viem・aa-sdk) は実物のまま通し、account と通信 (fetch) と Pimlico の価格だけを差し替えて
//   (1) 上限を超えると署名・送信の前に止まる
//   (2) エラーは包まれずに sendUserOperation の reject として届き、フォームの isGasCongestedError で判定できる
//   (3) 上限以下なら UserOp の fee は従来どおり standard の値
// を確かめる。その先の鎖は別の test: hook が包まずに渡すこと = tests/hooks/useBatchPayment.test.tsx、
// フォームが GasCongestedError を混雑の案内に変えること = tests/components/{Payment,Checkout,Tip}Form.test.tsx。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toHex, type Address, type Chain, type Hex, type PublicClient } from 'viem';
import {
  entryPoint07Address,
  entryPoint08Address,
} from 'viem/account-abstraction';
import { base, polygon } from 'viem/chains';
import { GasCongestedError, isGasCongestedError } from '@/lib/gasCeiling';
import type { TokenDeployment } from '@/lib/tokens';
import {
  buildSimpleSmartAccountClient,
  type ConnectedWalletClient,
  type SmartAccountBundle,
} from '@/lib/smartAccount/simpleAccount';
import { buildMetaMaskSmartAccountClient } from '@/lib/smartAccount/metamask';
import { buildMav2SmartAccountClient } from '@/lib/smartAccount/mav2';

const GWEI = 10n ** 9n;
type Tier = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
type GasPrice = { slow: Tier; standard: Tier; fast: Tier };

const ACCOUNT: Address = '0x9999999999999999999999999999999999999999';
const PAYMASTER: Address = '0x7777777777777777777777777777777777777777';
const JPYC: Address = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29';
const USDC_BASE: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CALLS = [{ to: JPYC, data: '0xa9059cbb' as Hex }];

const jpycPolygon: TokenDeployment = {
  symbol: 'jpyc',
  displaySymbol: 'JPYC',
  name: 'JPY Coin',
  decimals: 18,
  address: JPYC,
  chainId: polygon.id,
  paymasterMode: 'sponsorship',
};
// 本番で残る経路の 1 つ: Circle Paymaster が OFF のときの USDC の erc20 paymaster (Base・上限 10 gwei)。
const usdcBase: TokenDeployment = {
  symbol: 'usdc',
  displaySymbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
  address: USDC_BASE,
  chainId: base.id,
  paymasterMode: 'erc20',
};

// --- Pimlico (価格と token quote だけを差し替える) ---
const getUserOperationGasPrice = vi.fn<() => Promise<GasPrice>>();
const getTokenQuotes = vi.fn(async () => [
  {
    paymaster: PAYMASTER,
    token: USDC_BASE,
    postOpGas: 50_000n,
    exchangeRate: 10n ** 18n,
    exchangeRateNativeToUsd: 10n ** 18n,
    balanceSlot: undefined,
    allowanceSlot: undefined,
  },
]);

function setGasPrice(standard: Tier, fast: Tier): void {
  getUserOperationGasPrice.mockResolvedValue({
    slow: { maxFeePerGas: standard.maxFeePerGas / 2n, maxPriorityFeePerGas: 1n },
    standard,
    fast,
  });
}

// --- account (署名は呼ばれないことを見る) ---
const signUserOperation = vi.fn(async () => `0x${'aa'.repeat(65)}` as Hex);
const signUserOperationHash = vi.fn(async () => `0x${'aa'.repeat(65)}` as Hex);

// viem の SmartAccount (to7702SimpleSmartAccount / toMetaMaskSmartAccount の代わり)。
function fakeViemSmartAccount(entryPoint: {
  address: Address;
  version: '0.7' | '0.8';
}) {
  return {
    type: 'smart' as const,
    address: ACCOUNT,
    entryPoint: { ...entryPoint, abi: [] },
    client: {},
    encodeCalls: vi.fn(async () => '0xdeadbeef' as Hex),
    getFactoryArgs: vi.fn(async () => ({
      factory: undefined,
      factoryData: undefined,
    })),
    getNonce: vi.fn(async () => 0n),
    getStubSignature: vi.fn(async () => `0x${'ff'.repeat(65)}` as Hex),
    signUserOperation,
    signMessage: vi.fn(),
    signTypedData: vi.fn(),
    isDeployed: vi.fn(async () => true),
  };
}
let viemAccount: ReturnType<typeof fakeViemSmartAccount>;

// aa-sdk の SmartContractAccount (createModularAccountV2 の代わり)。source を MAv2 にしないので
// 7702 の委任確認 (eth_getCode 等) は走らない。fee の middleware の扱いには関係しない。
const aaAccount = {
  address: ACCOUNT,
  source: 'TestAccount',
  getEntryPoint: () => ({ version: '0.7.0', address: entryPoint07Address }),
  encodeBatchExecute: vi.fn(async () => '0xdeadbeef' as Hex),
  encodeExecute: vi.fn(async () => '0xdeadbeef' as Hex),
  getDummySignature: () => `0x${'ff'.repeat(65)}` as Hex,
  getAccountNonce: vi.fn(async () => 0n),
  isAccountDeployed: vi.fn(async () => true),
  getFactoryAddress: vi.fn(async () => ACCOUNT),
  getFactoryData: vi.fn(async () => '0x' as Hex),
  getInitCode: vi.fn(async () => '0x' as Hex),
  signUserOperationHash,
};

vi.mock('permissionless/accounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('permissionless/accounts')>()),
  to7702SimpleSmartAccount: async () => viemAccount,
}));
vi.mock('@metamask/delegation-toolkit', () => ({
  Implementation: { Stateless7702: 'Stateless7702' },
  toMetaMaskSmartAccount: async () => viemAccount,
}));
vi.mock('@account-kit/smart-contracts', () => ({
  createModularAccountV2: async () => aaAccount,
}));
vi.mock('@/lib/pimlico', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/pimlico')>('@/lib/pimlico');
  return {
    ...actual,
    createPimlico: () => ({ getUserOperationGasPrice, getTokenQuotes }),
    // test 環境は testnet で resolvePaymasterMode が USDC erc20 → sponsorship に倒すため、
    // deployment の paymasterMode をそのまま使う (本番の Base USDC = erc20 経路を通す)。
    assertGaslessSupported: (deployment: TokenDeployment) =>
      deployment.paymasterMode as 'sponsorship' | 'erc20',
    pimlicoPaymasterContext: (deployment: TokenDeployment) =>
      deployment.paymasterMode === 'erc20'
        ? { token: deployment.address }
        : { sponsorshipPolicyId: 'sp_test' },
  };
});

// --- 通信: 送られた JSON-RPC を記録する。aa-sdk の dummy paymaster (fee の前に走る) にだけ答え、
// それ以外 (eth_estimateUserOperationGas 等) はそこで止める。-32602 は viem が再試行しない code。
type RpcCall = { url: string; method: string; params: unknown[] };
let rpcCalls: RpcCall[] = [];
beforeEach(() => {
  rpcCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
        params: unknown[];
      };
      rpcCalls.push({ url: String(url), method: body.method, params: body.params });
      const payload =
        body.method === 'pm_getPaymasterStubData'
          ? {
              result: {
                paymaster: PAYMASTER,
                paymasterData: '0x',
                paymasterVerificationGasLimit: '0x1',
                paymasterPostOpGasLimit: '0x1',
              },
            }
          : { error: { code: -32602, message: `stopped by test at ${body.method}` } };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...payload }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeWalletClient(chain: Chain): ConnectedWalletClient {
  return { chain, account: { address: ACCOUNT } } as unknown as ConnectedWalletClient;
}
const fakePublicClient = {
  transport: { url: 'https://chain-rpc.test/' },
} as unknown as PublicClient;

async function sendAndCatch(bundle: SmartAccountBundle): Promise<unknown> {
  return bundle.smartAccountClient
    .sendUserOperation({ calls: CALLS })
    .then(() => null, (e: unknown) => e);
}

function expectCongested(err: unknown, chainId: number, ceilingGwei: bigint) {
  // 包まれていない (instanceof) かつ、フォームの判定 (isGasCongestedError) で拾える。
  expect(err).toBeInstanceOf(GasCongestedError);
  expect(isGasCongestedError(err)).toBe(true);
  expect((err as GasCongestedError).chainId).toBe(chainId);
  expect((err as GasCongestedError).ceilingGwei).toBe(ceilingGwei);
}

type ViemBuilderCase = {
  name: string;
  entryPoint: { address: Address; version: '0.7' | '0.8' };
  build: (deployment: TokenDeployment, chain: Chain) => Promise<SmartAccountBundle>;
};

const viemBuilders: ViemBuilderCase[] = [
  {
    name: 'simpleAccount (to7702SimpleSmartAccount・permissionless の estimateFeesPerGas)',
    entryPoint: { address: entryPoint08Address, version: '0.8' },
    build: (deployment, chain) =>
      buildSimpleSmartAccountClient({
        walletClient: fakeWalletClient(chain),
        publicClient: fakePublicClient,
        chainId: chain.id,
        deployment,
      }),
  },
  {
    name: 'metamask (Stateless7702・permissionless の estimateFeesPerGas)',
    entryPoint: { address: entryPoint07Address, version: '0.7' },
    build: (deployment, chain) =>
      buildMetaMaskSmartAccountClient({
        walletClient: fakeWalletClient(chain),
        publicClient: fakePublicClient,
        chainId: chain.id,
        account: ACCOUNT,
        deployment,
      }),
  },
];

describe.each(viemBuilders)('$name', ({ entryPoint, build }) => {
  beforeEach(() => {
    viemAccount = fakeViemSmartAccount(entryPoint);
  });

  it('Base の USDC (erc20): 送信の中の standard が 10.1 gwei → 署名・送信せずに GasCongestedError がそのまま届く', async () => {
    // A-5 の失敗シナリオ: 呼出元が先に見た fast (9.9 gwei) は通ったが、sendUserOperation の中の
    // 見積もりまでにガスが上がって standard が上限 (10 gwei) を超えた。
    setGasPrice(
      { maxFeePerGas: 10n * GWEI + GWEI / 10n, maxPriorityFeePerGas: GWEI / 10n },
      { maxFeePerGas: 11n * GWEI, maxPriorityFeePerGas: GWEI / 5n },
    );
    const bundle = await build(usdcBase, base);
    expect(bundle.paymasterMode).toBe('erc20');

    const err = await sendAndCatch(bundle);

    expectCongested(err, base.id, 10n);
    // erc20 paymaster の prepare (permissionless prepareUserOperationForErc20Paymaster) を実際に通った。
    expect(getTokenQuotes).toHaveBeenCalled();
    expect(signUserOperation).not.toHaveBeenCalled();
    expect(rpcCalls).toEqual([]);
  });

  it('Polygon の JPYC (sponsorship): standard が 1001 gwei → 署名・送信せずに GasCongestedError がそのまま届く', async () => {
    setGasPrice(
      { maxFeePerGas: 1001n * GWEI, maxPriorityFeePerGas: 30n * GWEI },
      { maxFeePerGas: 1100n * GWEI, maxPriorityFeePerGas: 40n * GWEI },
    );
    const bundle = await build(jpycPolygon, polygon);
    expect(bundle.paymasterMode).toBe('sponsorship');

    const err = await sendAndCatch(bundle);

    expectCongested(err, polygon.id, 1000n);
    expect(signUserOperation).not.toHaveBeenCalled();
    expect(rpcCalls).toEqual([]);
  });

  it('上限以下: UserOp に入る fee は従来どおり standard の値 (fast ではない)', async () => {
    setGasPrice(
      { maxFeePerGas: 300n * GWEI, maxPriorityFeePerGas: 30n * GWEI },
      { maxFeePerGas: 400n * GWEI, maxPriorityFeePerGas: 40n * GWEI },
    );
    const bundle = await build(jpycPolygon, polygon);

    const err = await sendAndCatch(bundle);

    // fee の次の段 (gas の見積もり) まで進んだところで test の通信が止めている。
    expect(isGasCongestedError(err)).toBe(false);
    const estimate = rpcCalls.find((c) => c.method === 'eth_estimateUserOperationGas');
    const userOp = estimate?.params[0] as { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex };
    expect(userOp.maxFeePerGas).toBe(toHex(300n * GWEI));
    expect(userOp.maxPriorityFeePerGas).toBe(toHex(30n * GWEI));
    expect(getUserOperationGasPrice).toHaveBeenCalledTimes(1);
  });
});

describe('mav2 (aa-sdk の feeEstimator の middleware・relay OFF のときの JPYC fallback)', () => {
  function buildMav2() {
    return buildMav2SmartAccountClient({
      walletClient: fakeWalletClient(polygon),
      publicClient: fakePublicClient,
      chain: polygon,
      chainId: polygon.id,
      deployment: jpycPolygon,
    });
  }

  it('Polygon の JPYC: standard が 1001 gwei → middleware に包まれずに GasCongestedError が届き、署名・送信しない', async () => {
    setGasPrice(
      { maxFeePerGas: 1001n * GWEI, maxPriorityFeePerGas: 30n * GWEI },
      { maxFeePerGas: 1100n * GWEI, maxPriorityFeePerGas: 40n * GWEI },
    );
    const bundle = await buildMav2();

    const err = await sendAndCatch(bundle);

    expectCongested(err, polygon.id, 1000n);
    // aa-sdk の middleware の列を実際に通った (fee の前の dummy paymaster は Pimlico に問い合わせた)。
    const methods = rpcCalls.map((c) => c.method);
    expect(methods).toEqual(['pm_getPaymasterStubData']);
    expect(rpcCalls[0]?.url).toContain('api.pimlico.io');
    // fee で止まり、gas の見積もり・paymaster の署名・送信には進まない。
    expect(signUserOperationHash).not.toHaveBeenCalled();
  });

  it('上限以下: UserOp に入る fee は従来どおり standard の値 (fast ではない)', async () => {
    setGasPrice(
      { maxFeePerGas: 300n * GWEI, maxPriorityFeePerGas: 30n * GWEI },
      { maxFeePerGas: 400n * GWEI, maxPriorityFeePerGas: 40n * GWEI },
    );
    const bundle = await buildMav2();

    const err = await sendAndCatch(bundle);

    expect(isGasCongestedError(err)).toBe(false);
    const estimate = rpcCalls.find((c) => c.method === 'eth_estimateUserOperationGas');
    const userOp = estimate?.params[0] as { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex };
    expect(userOp.maxFeePerGas).toBe(toHex(300n * GWEI));
    expect(userOp.maxPriorityFeePerGas).toBe(toHex(30n * GWEI));
    expect(getUserOperationGasPrice).toHaveBeenCalledTimes(1);
  });
});
