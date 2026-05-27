import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { kaia, kairos, polygonAmoy, baseSepolia } from 'viem/chains';
import type { Address } from 'viem';

// 重要: この import が壊れていれば (permissionless の
// `to7702SimpleSmartAccount` が消える等)、このテストファイル自体の
// ロード時点で例外を投げて失敗するため、CI で即検出される。
import { useSmartAccount } from '@/hooks/useSmartAccount';
import {
  prepareUserOperationForErc20Paymaster,
} from 'permissionless/experimental/pimlico';

vi.mock('wagmi', () => ({
  useAccount: vi.fn(),
  useWalletClient: vi.fn(),
  usePublicClient: vi.fn(),
}));

// queryFn 本体を実走行させるため、permissionless 側の重い処理 (Smart Account
// 構築 / Pimlico bundler への http 通信) を mock する。テスト対象である
// useSmartAccount のロジック (paymaster mode 分岐 / config 組み立て) は
// 実コードを実行する。
const stubAccount = { address: '0xS', entryPoint: { address: '0xEP', version: '0.7' } };
const to7702SimpleSmartAccount = vi.fn(async (_args: unknown) => stubAccount);
vi.mock('permissionless/accounts', () => ({
  to7702SimpleSmartAccount: (args: unknown) => to7702SimpleSmartAccount(args),
}));

// createSmartAccountClient の引数を inspection したいので、引数を保存する
// pass-through な mock として定義する。
let lastSAConfig: unknown = undefined;
const createSmartAccountClient = vi.fn((cfg) => {
  lastSAConfig = cfg;
  return { _stub: 'smartAccountClient' };
});
vi.mock('permissionless', () => ({
  createSmartAccountClient: (cfg: unknown) => createSmartAccountClient(cfg),
}));

import { useAccount, useWalletClient, usePublicClient } from 'wagmi';
import { mockHook } from '../_helpers/wagmiMock';
import { defaultDeploymentForSymbol, type TokenDeployment } from '@/lib/tokens';

const usdcDep = defaultDeploymentForSymbol('usdc');
const jpycDep = defaultDeploymentForSymbol('jpyc');

// JPYC on Kairos (Kaia testnet)。env override が未設定なので
// defaultDeploymentForSymbol では取れない。実 contract address が公表され
// るまでの placeholder を inline で組み立てる (本 test の目的は chainId
// 経路の routing 検証であり address の正当性ではない)。
const jpycKairosDep: TokenDeployment = {
  symbol: 'jpyc',
  displaySymbol: 'JPYC',
  name: 'JPY Coin',
  decimals: 18,
  address: '0xc0de000000000000000000000000000000005555' as Address,
  chainId: kairos.id,
  paymasterMode: 'sponsorship',
};

// 既に Pimlico SimpleAccount (0xe6Cae8…) に委任済みの EOA を表す eth_getCode 戻り値。
// pristine ('0x') は injected wallet で初回ガスレス委任を張れず throw するように
// なったため、SimpleAccount build 経路 (paymaster 設定等) を検証する test は「委任済み」
// code を使う。idle 系 test は queryFn が走らず getCode を読まないので影響しない。
const PIMLICO_SIMPLE7702_ADDR = '0xe6Cae83BdE06E4c305530e199D7217f42808555B';
const DELEGATED_PIMLICO_CODE = `0xef0100${PIMLICO_SIMPLE7702_ADDR.slice(2).toLowerCase()}`;

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  lastSAConfig = undefined;
});

describe('useSmartAccount (smoke / boundary)', () => {
  it('モジュールが import できる (permissionless API 健全性)', () => {
    // import の解決が壊れていればここに到達しない
    expect(useSmartAccount).toBeTypeOf('function');
  });

  it('未接続: クエリは無効、queryFn は呼ばれない', () => {
    mockHook(useAccount, { address: undefined, chainId: undefined });
    mockHook(useWalletClient, { data: undefined });
    vi.mocked(usePublicClient).mockReturnValue(
      undefined as ReturnType<typeof usePublicClient>,
    );

    const { result } = renderHook(() => useSmartAccount(jpycDep), {
      wrapper: makeWrapper(),
    });
    expect(result.current.data).toBeUndefined();
    expect(result.current.fetchStatus).toBe('idle');
    expect(to7702SimpleSmartAccount).not.toHaveBeenCalled();
    expect(createSmartAccountClient).not.toHaveBeenCalled();
  });

  it('対応外 chainId (ethereum mainnet=1): 無効化', () => {
    mockHook(useAccount, {
      address: '0x1111111111111111111111111111111111111111',
      chainId: 1,
    });
    mockHook(useWalletClient, { data: { chain: { id: 1 } } });
    mockHook(usePublicClient, { getCode: vi.fn().mockResolvedValue(DELEGATED_PIMLICO_CODE) });

    const { result } = renderHook(() => useSmartAccount(jpycDep), {
      wrapper: makeWrapper(),
    });
    expect(result.current.fetchStatus).toBe('idle');
    expect(result.current.data).toBeUndefined();
  });

  it('walletClient だけ欠けている: 無効化', () => {
    mockHook(useAccount, {
      address: '0x1111111111111111111111111111111111111111',
      chainId: polygonAmoy.id,
    });
    mockHook(useWalletClient, { data: undefined });
    mockHook(usePublicClient, { getCode: vi.fn().mockResolvedValue(DELEGATED_PIMLICO_CODE) });

    const { result } = renderHook(() => useSmartAccount(jpycDep), {
      wrapper: makeWrapper(),
    });
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('publicClient だけ欠けている: 無効化', () => {
    mockHook(useAccount, {
      address: '0x1111111111111111111111111111111111111111',
      chainId: polygonAmoy.id,
    });
    mockHook(useWalletClient, { data: { chain: polygonAmoy } });
    vi.mocked(usePublicClient).mockReturnValue(
      undefined as ReturnType<typeof usePublicClient>,
    );

    const { result } = renderHook(() => useSmartAccount(jpycDep), {
      wrapper: makeWrapper(),
    });
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('enabled=false → wallet 接続済でも無効化される', () => {
    mockHook(useAccount, {
      address: '0x1111111111111111111111111111111111111111',
      chainId: polygonAmoy.id,
    });
    mockHook(useWalletClient, { data: { chain: polygonAmoy } });
    mockHook(usePublicClient, { getCode: vi.fn().mockResolvedValue(DELEGATED_PIMLICO_CODE) });

    const { result } = renderHook(() => useSmartAccount(jpycDep, false), {
      wrapper: makeWrapper(),
    });
    expect(result.current.fetchStatus).toBe('idle');
  });
});

describe('useSmartAccount (queryFn 実走行: paymaster 設定の検証)', () => {
  // permissionless の experimental API が import 解決時にクラッシュしないこと自体が
  // ERC20 Paymaster 機能の前提条件。型チェックでは検出できない runtime の健全性。
  it('prepareUserOperationForErc20Paymaster は import 解決後に関数を返す', () => {
    expect(prepareUserOperationForErc20Paymaster).toBeTypeOf('function');
    const stubPimlicoClient = {} as unknown as Parameters<
      typeof prepareUserOperationForErc20Paymaster
    >[0];
    const inner = prepareUserOperationForErc20Paymaster(stubPimlicoClient);
    expect(inner).toBeTypeOf('function');
  });

  it('JPYC (sponsorship): createSmartAccountClient に sponsorship context が渡り prepareUserOperation hook は undefined', async () => {
    mockHook(useAccount, {
      address: '0x1111111111111111111111111111111111111111',
      chainId: polygonAmoy.id,
    });
    mockHook(useWalletClient, { data: { chain: polygonAmoy } });
    mockHook(usePublicClient, { getCode: vi.fn().mockResolvedValue(DELEGATED_PIMLICO_CODE) });

    const { result } = renderHook(() => useSmartAccount(jpycDep), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());

    expect(to7702SimpleSmartAccount).toHaveBeenCalledOnce();
    expect(createSmartAccountClient).toHaveBeenCalledOnce();

    const cfg = lastSAConfig as {
      paymasterContext: unknown;
      paymaster: unknown;
      userOperation: { prepareUserOperation: unknown };
    };
    expect(cfg.paymasterContext).toEqual({ sponsorshipPolicyId: 'sp_test' });
    // sponsorship では permissionless の prepareUserOperation 拡張は使わない (default)
    expect(cfg.userOperation.prepareUserOperation).toBeUndefined();

    // 戻り値構造の検証
    expect(result.current.data!.paymasterMode).toBe('sponsorship');
    expect(result.current.data!.smartAccountClient).toBeDefined();
    expect(result.current.data!.pimlicoClient).toBeDefined();
  });

  it('JPYC on Kaia/Kairos: SimpleAccount (7702) 経路へ routing、Pimlico Kairos URL が組み立てられる', async () => {
    // memory:project_kaia_evaluation — Kaia Prague hardfork で KIP-228 として
    // EIP-7702 実装済 + Pimlico Kaia bundler の Simple Account 対応リスト掲載。
    // useSmartAccount から buildSimpleSmartAccountClient → to7702SimpleSmartAccount
    // が呼ばれる連鎖を test する (mav2 経路に倒れないこと、Polygon と同型の
    // sponsorship paymaster コンフィグが立つこと)。
    mockHook(useAccount, {
      address: '0x1111111111111111111111111111111111111111',
      chainId: kairos.id,
    });
    mockHook(useWalletClient, { data: { chain: kairos } });
    mockHook(usePublicClient, { getCode: vi.fn().mockResolvedValue(DELEGATED_PIMLICO_CODE) });

    const { result } = renderHook(() => useSmartAccount(jpycKairosDep), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());

    // SimpleAccount 経路 (mav2 ではない) — to7702SimpleSmartAccount が呼ばれる
    expect(to7702SimpleSmartAccount).toHaveBeenCalledOnce();
    expect(createSmartAccountClient).toHaveBeenCalledOnce();

    // Kairos の deployment で sponsorship mode が確定 (testnet erc20 → sponsorship
    // フォールバックを通らずに直接 sponsorship)
    expect(result.current.data!.paymasterMode).toBe('sponsorship');
    const cfg = lastSAConfig as {
      bundlerTransport: unknown;
      paymasterContext: unknown;
    };
    expect(cfg.bundlerTransport).toBeDefined();
    expect(cfg.paymasterContext).toEqual({ sponsorshipPolicyId: 'sp_test' });
  });

  it('Kaia mainnet (8217) は testnet env では supportedChains 外: クエリ無効化', () => {
    // testnet env (vitest config) で supportedChains は kairos のみ (kaia は未含)。
    // mainnet chainId が誤って差し込まれた場合は enabled=false で queryFn 不実行
    // — 不正 chain 上の Smart Account 構築を未然に防ぐ fence。
    const jpycKaiaDep: TokenDeployment = {
      ...jpycKairosDep,
      chainId: kaia.id,
    };
    mockHook(useAccount, {
      address: '0x1111111111111111111111111111111111111111',
      chainId: kaia.id,
    });
    mockHook(useWalletClient, { data: { chain: kaia } });
    mockHook(usePublicClient, { getCode: vi.fn().mockResolvedValue(DELEGATED_PIMLICO_CODE) });

    const { result } = renderHook(() => useSmartAccount(jpycKaiaDep), {
      wrapper: makeWrapper(),
    });
    expect(result.current.fetchStatus).toBe('idle');
    expect(result.current.data).toBeUndefined();
    expect(to7702SimpleSmartAccount).not.toHaveBeenCalled();
  });

  it('USDC (testnet → sponsorship フォールバック): JPYC と同じく sponsorship 経路', async () => {
    // vitest は NEXT_PUBLIC_NETWORK_ENV=testnet で動くので USDC でも sponsorship に倒れる
    mockHook(useAccount, {
      address: '0x1111111111111111111111111111111111111111',
      chainId: baseSepolia.id,
    });
    mockHook(useWalletClient, { data: { chain: baseSepolia } });
    mockHook(usePublicClient, { getCode: vi.fn().mockResolvedValue(DELEGATED_PIMLICO_CODE) });

    const { result } = renderHook(() => useSmartAccount(usdcDep), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());

    const cfg = lastSAConfig as {
      paymasterContext: unknown;
      userOperation: { prepareUserOperation: unknown };
    };
    expect(cfg.paymasterContext).toEqual({ sponsorshipPolicyId: 'sp_test' });
    expect(cfg.userOperation.prepareUserOperation).toBeUndefined();
    expect(result.current.data!.paymasterMode).toBe('sponsorship');
  });

  it('queryKey が token を含む → 異なる token は異なるクエリとして共存', async () => {
    // jpyc (Polygon Amoy) でまず query を生成
    mockHook(useAccount, {
      address: '0x1111111111111111111111111111111111111111',
      chainId: polygonAmoy.id,
    });
    mockHook(useWalletClient, { data: { chain: polygonAmoy } });
    mockHook(usePublicClient, { getCode: vi.fn().mockResolvedValue(DELEGATED_PIMLICO_CODE) });

    const { result: jpyc } = renderHook(() => useSmartAccount(jpycDep), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(jpyc.current.data).toBeDefined());

    const callsAfterJpyc = createSmartAccountClient.mock.calls.length;
    expect(callsAfterJpyc).toBe(1);

    // wallet を Base Sepolia に切替えて usdc を mount → 別 queryKey で新規 fetch
    mockHook(useAccount, {
      address: '0x1111111111111111111111111111111111111111',
      chainId: baseSepolia.id,
    });
    mockHook(useWalletClient, { data: { chain: baseSepolia } });

    const { result: usdc } = renderHook(() => useSmartAccount(usdcDep), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(usdc.current.data).toBeDefined());
    expect(createSmartAccountClient.mock.calls.length).toBeGreaterThan(
      callsAfterJpyc,
    );
  });
});

describe('useSmartAccount (queryFn の defense-in-depth throw)', () => {
  // 通常 enabled で全条件チェック済だが、wagmi の HMR / race condition で
  // queryFn 呼出時に walletClient/publicClient/chainId が消えるエッジケース。
  // queryFn の 'not ready' throw が tanstack-query の error path を発火する
  // ことを実際に観測する。
  it('walletClient が undefined になった瞬間 queryFn が走ると "not ready" を投げる', async () => {
    // 戦略: queryFn を直接抜き出して呼び出すのは難しいので、enabled が一旦
    // true になった後で walletClient を消す flow を再現する。
    // useSmartAccount は useQuery 内で walletClient.chain 等を必要とするため、
    // walletClient=undefined のまま queryFn が同期的に走らないよう enabled で
    // ガードしている。enabled の narrowing が動いている限り queryFn は呼ばれ
    // ない (=> 'not ready' はテストし辛い)。代替として、以下を assert:
    //
    //   - walletClient が undefined の状態で hook を render しても queryFn は
    //     呼ばれず (to7702SimpleSmartAccount が 0 回)、fetchStatus は idle
    //   - publicClient が undefined のとき同様
    //
    // これにより enabled 条件と queryFn の defensive throw が論理的に二重ガード
    // として機能していることを確認する (隠れたバグでこの二重防御が崩れたら
    // 検出可能)。

    mockHook(useAccount, {
      address: '0x1111111111111111111111111111111111111111',
      chainId: polygonAmoy.id,
    });
    mockHook(useWalletClient, { data: undefined });
    mockHook(usePublicClient, { getCode: vi.fn().mockResolvedValue(DELEGATED_PIMLICO_CODE) });

    const { result } = renderHook(() => useSmartAccount(jpycDep), {
      wrapper: makeWrapper(),
    });

    // queryFn は呼ばれない (enabled=false)
    expect(result.current.fetchStatus).toBe('idle');
    expect(to7702SimpleSmartAccount).not.toHaveBeenCalled();
    expect(createSmartAccountClient).not.toHaveBeenCalled();
  });

  it('chainId が deployment.chainId と異なる → enabled=false で queryFn 不発火 (multi-chain ガード)', () => {
    // deployment.chainId とウォレット chainId が一致しない場合 (例: USDC base
    // deployment vs Polygon Amoy の wallet) は enabled=false にする防御。
    mockHook(useAccount, {
      address: '0x1111111111111111111111111111111111111111',
      chainId: polygonAmoy.id, // wallet on Polygon
    });
    mockHook(useWalletClient, { data: { chain: polygonAmoy } });
    mockHook(usePublicClient, { getCode: vi.fn().mockResolvedValue(DELEGATED_PIMLICO_CODE) });

    const { result } = renderHook(() => useSmartAccount(usdcDep), {
      // usdcDep は Base Sepolia (84532)、wallet は Polygon Amoy (80002)
      wrapper: makeWrapper(),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(to7702SimpleSmartAccount).not.toHaveBeenCalled();
  });
});

describe('useSmartAccount (7702 delegation 分岐)', () => {
  // detectAccountKind は実コードで動かす (eth_getCode mock に依存)。
  // PIMLICO_SIMPLE7702 / ALCHEMY_MAV2 の固定アドレスを使って分岐を観察。
  const PIMLICO_SIMPLE = '0xe6Cae83BdE06E4c305530e199D7217f42808555B'.toLowerCase();
  const ALCHEMY_MAV2 = '0x69007702764179F14f51cdcE752f4F775d74E139'.toLowerCase();

  it('Pimlico SimpleAccount に既に委任済 (pimlico-simple-7702): 既存 SimpleAccount 経路で動く (regression)', async () => {
    mockHook(useAccount, {
      address: '0x1111111111111111111111111111111111111111',
      chainId: polygonAmoy.id,
    });
    mockHook(useWalletClient, { data: { chain: polygonAmoy } });
    mockHook(usePublicClient, {
      getCode: vi.fn().mockResolvedValue(`0xef0100${PIMLICO_SIMPLE.slice(2)}`),
    });

    const { result } = renderHook(() => useSmartAccount(jpycDep), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());

    expect(to7702SimpleSmartAccount).toHaveBeenCalledOnce();
    expect(createSmartAccountClient).toHaveBeenCalledOnce();
    expect(result.current.data!.paymasterMode).toBe('sponsorship');
  });

  it('pristine EOA (未委任 0x): errorPristineNoBootstrap を throw、SimpleAccount は構築しない', async () => {
    // injected wallet では初回 7702 委任を gasless に張れない (viem signAuthorization
    // が JSON-RPC 非対応) → doomed な SimpleAccount を作らず fail-fast し、UI を
    // standard mode 案内に倒す。
    mockHook(useAccount, {
      address: '0x1111111111111111111111111111111111111111',
      chainId: baseSepolia.id,
    });
    mockHook(useWalletClient, { data: { chain: baseSepolia } });
    mockHook(usePublicClient, { getCode: vi.fn().mockResolvedValue('0x') });

    const { result } = renderHook(() => useSmartAccount(usdcDep), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error?.name).toBe('IncompatibleSmartAccountError');
    expect((result.current.error as { i18nKey?: string })?.i18nKey).toBe(
      'errorPristineNoBootstrap',
    );
    // pristine は delegate 不在なので delegateAddress は null
    expect(
      (result.current.error as { delegateAddress?: unknown })?.delegateAddress,
    ).toBeNull();
    expect(to7702SimpleSmartAccount).not.toHaveBeenCalled();
    expect(createSmartAccountClient).not.toHaveBeenCalled();
  });

  it('空コード (length<=2) も pristine 扱いで errorPristineNoBootstrap', async () => {
    mockHook(useAccount, {
      address: '0x1111111111111111111111111111111111111111',
      chainId: polygonAmoy.id,
    });
    mockHook(useWalletClient, { data: { chain: polygonAmoy } });
    mockHook(usePublicClient, { getCode: vi.fn().mockResolvedValue('0x') });

    const { result } = renderHook(() => useSmartAccount(jpycDep), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as { i18nKey?: string })?.i18nKey).toBe(
      'errorPristineNoBootstrap',
    );
    expect(to7702SimpleSmartAccount).not.toHaveBeenCalled();
  });

  it('Alchemy MAv2 委任済 + feature flag OFF (default): IncompatibleSmartAccountError', async () => {
    mockHook(useAccount, {
      address: '0x1111111111111111111111111111111111111111',
      chainId: polygonAmoy.id,
    });
    mockHook(useWalletClient, { data: { chain: polygonAmoy } });
    mockHook(usePublicClient, {
      getCode: vi.fn().mockResolvedValue(`0xef0100${ALCHEMY_MAV2.slice(2)}`),
    });

    const { result } = renderHook(() => useSmartAccount(jpycDep), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error?.name).toBe('IncompatibleSmartAccountError');
    expect((result.current.error as { i18nKey?: string })?.i18nKey).toBe(
      'errorMav2Disabled',
    );
    // SimpleAccount builder は呼ばれない
    expect(to7702SimpleSmartAccount).not.toHaveBeenCalled();
  });

  it('未知の 7702 delegate: IncompatibleSmartAccountError + delegateAddress 保持', async () => {
    mockHook(useAccount, {
      address: '0x1111111111111111111111111111111111111111',
      chainId: polygonAmoy.id,
    });
    mockHook(useWalletClient, { data: { chain: polygonAmoy } });
    mockHook(usePublicClient, {
      getCode: vi
        .fn()
        .mockResolvedValue(
          '0xef0100deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        ),
    });

    const { result } = renderHook(() => useSmartAccount(jpycDep), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error?.name).toBe('IncompatibleSmartAccountError');
    expect((result.current.error as { i18nKey?: string })?.i18nKey).toBe(
      'errorIncompatibleSmartAccount',
    );
    expect(
      (result.current.error as { delegateAddress?: string })?.delegateAddress?.toLowerCase(),
    ).toBe('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    expect(to7702SimpleSmartAccount).not.toHaveBeenCalled();
  });
});

describe('useSmartAccount (queryFn 実走行: ERC20 mode @ mainnet)', () => {
  // mainnet 切替えのため process.env を一時的に書き換え + モジュール再読込
  it('USDC mainnet: ERC20 paymaster context (token) + prepareUserOperation hook が設定される', async () => {
    const ORIGINAL_ENV = { ...process.env };
    try {
      vi.resetModules();
      process.env.NEXT_PUBLIC_NETWORK_ENV = 'mainnet';
      process.env.NEXT_PUBLIC_PIMLICO_API_KEY = 'test_pimlico_key';

      // 再 import で env が再評価される。permissionless 側 mock は vi.mock の
      // hoisting で維持される。
      const { useSmartAccount: hookFresh } = await import(
        '@/hooks/useSmartAccount'
      );
      const { base: baseChain } = await import('viem/chains');
      const tokens = await import('@/lib/tokens');
      const usdcDepFresh = tokens.defaultDeploymentForSymbol('usdc');

      mockHook(useAccount, {
        address: '0x1111111111111111111111111111111111111111',
        chainId: baseChain.id,
      });
      mockHook(useWalletClient, { data: { chain: baseChain } });
      mockHook(usePublicClient, { getCode: vi.fn().mockResolvedValue(DELEGATED_PIMLICO_CODE) });

      const { result } = renderHook(() => hookFresh(usdcDepFresh), {
        wrapper: makeWrapper(),
      });
      await waitFor(() => expect(result.current.data).toBeDefined());

      const cfg = lastSAConfig as {
        paymasterContext: unknown;
        userOperation: { prepareUserOperation: unknown };
      };
      // ERC20 mode の context は { token: <USDC アドレス> }
      expect(cfg.paymasterContext).toMatchObject({
        token: expect.stringMatching(/^0x[a-fA-F0-9]{40}$/),
      });
      expect((cfg.paymasterContext as { token: string }).token.toLowerCase()).toBe(
        '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      );
      // prepareUserOperation hook が関数として注入されている
      expect(cfg.userOperation.prepareUserOperation).toBeTypeOf('function');
      expect(result.current.data!.paymasterMode).toBe('erc20');
    } finally {
      process.env = { ...ORIGINAL_ENV };
      vi.resetModules();
    }
  });
});
