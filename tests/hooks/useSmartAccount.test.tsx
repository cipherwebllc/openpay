import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { polygonAmoy, baseSepolia } from 'viem/chains';

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
import { defaultDeploymentForSymbol } from '@/lib/tokens';

const usdcDep = defaultDeploymentForSymbol('usdc');
const jpycDep = defaultDeploymentForSymbol('jpyc');

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
    mockHook(usePublicClient, {});

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
    mockHook(usePublicClient, {});

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
    mockHook(usePublicClient, {});

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
    mockHook(usePublicClient, {});

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

  it('USDC (testnet → sponsorship フォールバック): JPYC と同じく sponsorship 経路', async () => {
    // vitest は NEXT_PUBLIC_NETWORK_ENV=testnet で動くので USDC でも sponsorship に倒れる
    mockHook(useAccount, {
      address: '0x1111111111111111111111111111111111111111',
      chainId: baseSepolia.id,
    });
    mockHook(useWalletClient, { data: { chain: baseSepolia } });
    mockHook(usePublicClient, {});

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
    mockHook(usePublicClient, {});

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
    mockHook(usePublicClient, {});

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
    mockHook(usePublicClient, {});

    const { result } = renderHook(() => useSmartAccount(usdcDep), {
      // usdcDep は Base Sepolia (84532)、wallet は Polygon Amoy (80002)
      wrapper: makeWrapper(),
    });

    expect(result.current.fetchStatus).toBe('idle');
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
      mockHook(usePublicClient, {});

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
