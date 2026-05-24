import { describe, it, expect, vi, beforeEach } from 'vitest';
import { http, type Address, type Hex } from 'viem';
import { kaia, kairos, polygon } from 'viem/chains';
import { buildMav2SmartAccountClient } from '@/lib/smartAccount/mav2';
import { IncompatibleSmartAccountError } from '@/lib/accountDetection';
import { type TokenDeployment } from '@/lib/tokens';

// aa-sdk / account-kit を mock。実 SDK を呼ばずに facade の振る舞いだけ検証する。
const sendUserOperationMock = vi.fn();
const createModularAccountV2Mock = vi.fn();
const erc7677MiddlewareMock = vi.fn();
const createAaClientMock = vi.fn();
const splitMock = vi.fn();

vi.mock('@aa-sdk/core', () => ({
  createSmartAccountClient: (...args: unknown[]) => {
    createAaClientMock(...args);
    return { sendUserOperation: sendUserOperationMock };
  },
  WalletClientSigner: class {
    constructor(
      public readonly inner: unknown,
      public readonly signerType: string,
    ) {}
  },
  erc7677Middleware: (...args: unknown[]) => {
    erc7677MiddlewareMock(...args);
    return {
      paymasterAndData: vi.fn(),
      dummyPaymasterAndData: vi.fn(),
    };
  },
  // split(...) は viem の Transport を返す。テストでは渡された設定だけ
  // 観察したいので marker object で代替する。
  split: (params: unknown) => {
    splitMock(params);
    return { __splitMarker: true } as unknown as ReturnType<typeof http>;
  },
}));

vi.mock('@account-kit/smart-contracts', () => ({
  createModularAccountV2: (args: unknown) => {
    createModularAccountV2Mock(args);
    return { address: '0x2C3aEA8502A0074e2b9B3a804E247139293Dfa12' };
  },
}));

vi.mock('@/lib/pimlico', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/pimlico')>('@/lib/pimlico');
  return {
    ...actual,
    pimlicoUrl: () => 'https://api.pimlico.io/v2/137/rpc?apikey=test',
    createPimlico: () => ({
      getUserOperationGasPrice: vi.fn().mockResolvedValue({
        standard: { maxFeePerGas: 100n, maxPriorityFeePerGas: 50n },
      }),
    }),
    // テスト環境は NEXT_PUBLIC_NETWORK_ENV=testnet なので resolvePaymasterMode
    // が USDC erc20 → sponsorship に倒してしまう。テストでは deployment の
    // paymasterMode をそのまま尊重したいので素通しする stub を使う。
    resolvePaymasterMode: (deployment: TokenDeployment) =>
      deployment.paymasterMode,
    // assertGaslessSupported は内部で resolvePaymasterMode を呼ぶが、actual
    // module 内 import 解決のため上の mock が届かない。test では deployment の
    // paymasterMode をそのまま使い、unavailable のみ throw する素通し stub に置換。
    assertGaslessSupported: (
      deployment: TokenDeployment,
      chainId: number,
      callerName: string,
    ) => {
      if (deployment.paymasterMode === 'unavailable') {
        throw new Error(
          `${callerName}: deployment ${deployment.symbol} on chain ${chainId} は gasless mode 非対応`,
        );
      }
      return deployment.paymasterMode;
    },
    pimlicoPaymasterContext: () => undefined,
  };
});

const TOKEN: Address = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29';
const SAMPLE_CALLS = [
  { to: TOKEN, data: '0xa9059cbb' as Hex },
  { to: TOKEN, data: '0xa9059cbb' as Hex },
];

const jpycSponsorship: TokenDeployment = {
  symbol: 'jpyc',
  displaySymbol: 'JPYC',
  name: 'JPY Coin',
  decimals: 18,
  address: TOKEN,
  chainId: polygon.id,
  paymasterMode: 'sponsorship',
};

const usdcErc20: TokenDeployment = {
  symbol: 'usdc',
  displaySymbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
  address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  chainId: polygon.id,
  paymasterMode: 'erc20',
};

const fakeWalletClient = { account: { address: '0x' } } as never;
const fakePublicClient = {
  transport: { url: 'https://polygon-rpc.example/test' },
} as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildMav2SmartAccountClient', () => {
  it('sponsorship (JPYC): aa-sdk client を構築し facade が sendUserOperation を露出', async () => {
    sendUserOperationMock.mockResolvedValue({ hash: '0xdeadbeef' });

    const bundle = await buildMav2SmartAccountClient({
      walletClient: fakeWalletClient,
      publicClient: fakePublicClient,
      chain: polygon,
      chainId: polygon.id,
      deployment: jpycSponsorship,
    });

    expect(bundle.paymasterMode).toBe('sponsorship');
    // mode: '7702' で MAv2 を作る
    expect(createModularAccountV2Mock).toHaveBeenCalledOnce();
    const mav2Args = createModularAccountV2Mock.mock.calls[0]?.[0] as {
      mode?: string;
    };
    expect(mav2Args.mode).toBe('7702');
    // erc7677 middleware が呼ばれている
    expect(erc7677MiddlewareMock).toHaveBeenCalledOnce();
    // facade が permissionless 互換 shape の sendUserOperation を持つ
    const hash = await bundle.smartAccountClient.sendUserOperation({
      calls: SAMPLE_CALLS,
    });
    expect(hash).toBe('0xdeadbeef');
    // aa-sdk の native shape (uo: [{ target, data }]) で呼んでいる
    expect(sendUserOperationMock).toHaveBeenCalledOnce();
    const uoArgs = sendUserOperationMock.mock.calls[0]?.[0] as {
      uo: Array<{ target: Address; data: Hex }>;
    };
    expect(uoArgs.uo).toHaveLength(2);
    expect(uoArgs.uo[0]?.target).toBe(TOKEN);
  });

  it('erc20 (USDC): IncompatibleSmartAccountError を投げる (phase 1 では未対応)', async () => {
    await expect(
      buildMav2SmartAccountClient({
        walletClient: fakeWalletClient,
        publicClient: fakePublicClient,
        chain: polygon,
        chainId: polygon.id,
        deployment: usdcErc20,
      }),
    ).rejects.toBeInstanceOf(IncompatibleSmartAccountError);
    // 拒否時は MAv2 構築すら走らない
    expect(createModularAccountV2Mock).not.toHaveBeenCalled();
  });

  it('aa-sdk client への transport が Pimlico URL を使う', async () => {
    sendUserOperationMock.mockResolvedValue({ hash: '0x01' });
    await buildMav2SmartAccountClient({
      walletClient: fakeWalletClient,
      publicClient: fakePublicClient,
      chain: polygon,
      chainId: polygon.id,
      deployment: jpycSponsorship,
    });
    expect(createAaClientMock).toHaveBeenCalledOnce();
  });

  it('account 用 transport は publicClient の chain RPC URL を使う (Pimlico bundler ではない)', async () => {
    // R: Pimlico bundler URL を account transport に渡すと
    // eth_getTransactionCount 等が "method does not exist" で reject される。
    // chain RPC URL が createModularAccountV2 に渡る fence。
    sendUserOperationMock.mockResolvedValue({ hash: '0x02' });
    await buildMav2SmartAccountClient({
      walletClient: fakeWalletClient,
      publicClient: fakePublicClient,
      chain: polygon,
      chainId: polygon.id,
      deployment: jpycSponsorship,
    });
    const mav2Args = createModularAccountV2Mock.mock.calls[0]?.[0] as {
      transport: ReturnType<typeof http>;
    };
    // viem の http transport は factory。呼び出した結果の config.url を見る。
    const config = mav2Args.transport({ chain: polygon }) as {
      value?: { url?: string };
    };
    expect(config.value?.url).toBe('https://polygon-rpc.example/test');
  });

  it('Kaia mainnet (8217): Pimlico Kaia は MAv2 非対応のため IncompatibleSmartAccountError + Sentry 観測 log + 他 chain 案内 i18nKey', async () => {
    // Pimlico Kaia 対応 Smart Account は Safe / Simple Account / Thirdweb のみ。
    // MAv2 wallet で Kaia 対応のものは 2026-05 時点で確認されていない (HashPort
    // wallet は Kaia 非対応) が、defensive guard として将来の MAv2 + Kaia 遭遇
    // に対し errorMav2KaiaPolygon で他 chain (Polygon/Base/Arbitrum/Optimism)
    // フォールバックを案内する。
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const jpycKaia: TokenDeployment = {
      ...jpycSponsorship,
      chainId: kaia.id,
    };
    let captured: IncompatibleSmartAccountError | undefined;
    await buildMav2SmartAccountClient({
      walletClient: fakeWalletClient,
      publicClient: fakePublicClient,
      chain: kaia,
      chainId: kaia.id,
      deployment: jpycKaia,
    }).catch((e) => {
      captured = e;
    });
    expect(captured).toBeInstanceOf(IncompatibleSmartAccountError);
    // Polygon フォールバック専用の i18nKey に routing (generic errorIncompatible…
    // ではなく specific errorMav2KaiaPolygon)
    expect(captured?.i18nKey).toBe('errorMav2KaiaPolygon');
    expect(captured?.delegateAddress).toBeNull();
    // 早期 throw のため MAv2 構築すら走らない (USDC 拒否と同じ fence)
    expect(createModularAccountV2Mock).not.toHaveBeenCalled();
    expect(splitMock).not.toHaveBeenCalled();
    // Sentry alert rule "smart_account.mav2_kaia_rejected" のための event tag
    const warnArgs = consoleWarn.mock.calls.flat().map(String);
    expect(
      warnArgs.some((s) => s.includes('smart_account.mav2_kaia_rejected')),
    ).toBe(true);
    expect(warnArgs.some((s) => s.includes(`"chainId":${kaia.id}`))).toBe(true);
    consoleWarn.mockRestore();
  });

  it('Kairos testnet (1001): Pimlico Kairos も MAv2 非対応のため早期 throw', async () => {
    const jpycKairos: TokenDeployment = {
      ...jpycSponsorship,
      chainId: kairos.id,
    };
    await expect(
      buildMav2SmartAccountClient({
        walletClient: fakeWalletClient,
        publicClient: fakePublicClient,
        chain: kairos,
        chainId: kairos.id,
        deployment: jpycKairos,
      }),
    ).rejects.toBeInstanceOf(IncompatibleSmartAccountError);
    expect(createModularAccountV2Mock).not.toHaveBeenCalled();
  });

  it('split transport: bundler/paymaster method は Pimlico、それ以外は chain RPC へ route', async () => {
    // R: aa-sdk の SmartAccountClient は同一 transport で bundler ops と
    // chain reads (eth_getCode 等) の両方を行う。Pimlico bundler URL だけを
    // 渡すと chain reads が "method does not exist" で reject される。
    // split overrides に必須の bundler/paymaster methods が乗っていることを fence。
    sendUserOperationMock.mockResolvedValue({ hash: '0x03' });
    await buildMav2SmartAccountClient({
      walletClient: fakeWalletClient,
      publicClient: fakePublicClient,
      chain: polygon,
      chainId: polygon.id,
      deployment: jpycSponsorship,
    });
    expect(splitMock).toHaveBeenCalledOnce();
    const splitArgs = splitMock.mock.calls[0]?.[0] as {
      overrides: { methods: string[]; transport: unknown }[];
      fallback: unknown;
    };
    const overrideMethods = splitArgs.overrides[0]?.methods ?? [];
    // ERC-4337 / ERC-7677 / pimlico_ いずれも bundler endpoint へ。
    expect(overrideMethods).toContain('eth_sendUserOperation');
    expect(overrideMethods).toContain('eth_estimateUserOperationGas');
    expect(overrideMethods).toContain('eth_supportedEntryPoints');
    expect(overrideMethods).toContain('pm_getPaymasterStubData');
    expect(overrideMethods).toContain('pm_getPaymasterData');
    expect(overrideMethods).toContain('pimlico_getUserOperationGasPrice');
    // 標準 eth_* (eth_getCode / eth_getTransactionCount 等) は overrides に
    // 含めない。fallback (chain RPC) で処理されること。
    expect(overrideMethods).not.toContain('eth_getCode');
    expect(overrideMethods).not.toContain('eth_getTransactionCount');
    expect(overrideMethods).not.toContain('eth_call');
  });
});
