// CrossChainHint integration test — useCrossChainPayment hook の実コードを
// 走らせ、wagmi (useAccount / useWalletClient / usePublicClient / useSwitchChain) と
// グローバル fetch のみ boundary mock。balance.ts / router.ts / execute.ts /
// gateway.ts / cctp.ts は実コード経由で実行される。
//
// 検証する flow:
//   - amount=0 / token!=usdc / enabled=false → render nothing
//   - balance fetching → loading パネル
//   - decision='direct' → 何も出さない (既存 UI に委譲)
//   - decision='onramp' → 何も出さない (OnrampCta に委譲)
//   - decision='gateway' or 'cctp-v2' → 代替経路 hint + Pay button
//   - Pay button click → execute → success panel + paymentLog POST
//   - execute 失敗 → error 表示
//   - balance query 失敗 → Sentry warn
//
// React Query は test 毎に新 QueryClient を作って cache 汚染を防ぐ。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type Address, type Hex } from 'viem';
import type { ReactNode } from 'react';

vi.mock('wagmi', () => ({
  useAccount: vi.fn(),
  useWalletClient: vi.fn(),
  usePublicClient: vi.fn(),
  useSwitchChain: vi.fn(),
}));
// viem.createPublicClient は balance.ts が ERC20.balanceOf を呼ぶ network layer。
// integration test では実 RPC 呼ばないよう boundary mock し、readContract が
// chain ごとに canned value を返すようにする。chainId → balance map を test
// 毎に setReadContractByChain で設定する。
const readContractByChain = new Map<number, bigint>();
function setReadContractByChain(map: Record<number, bigint>) {
  readContractByChain.clear();
  for (const [k, v] of Object.entries(map)) {
    readContractByChain.set(Number(k), v);
  }
}
vi.mock('viem', async () => {
  const actual = await vi.importActual<typeof import('viem')>('viem');
  return {
    ...actual,
    createPublicClient: vi.fn((opts: { chain: { id: number } }) => ({
      readContract: vi.fn(async () => {
        const v = readContractByChain.get(opts.chain.id);
        if (v === undefined) {
          throw new Error(
            `test setup missing readContract balance for chainId ${opts.chain.id}`,
          );
        }
        return v;
      }),
    })),
  };
});
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
// /api/log/payment への POST を boundary で stub (network 不発火)
const logPostMock = vi.fn();
vi.mock('@/lib/paymentLog', async () => {
  const actual = await vi.importActual<typeof import('@/lib/paymentLog')>(
    '@/lib/paymentLog',
  );
  return {
    ...actual,
    logPaymentEvent: (...args: unknown[]) => logPostMock(...args),
  };
});

import {
  useAccount,
  usePublicClient,
  useSwitchChain,
  useWalletClient,
} from 'wagmi';
import { renderWithIntl } from '../_helpers/i18n';
import { CrossChainHint } from '@/components/CrossChainHint';
import { logger } from '@/lib/logger';

const ACCOUNT: Address = '0x1234567890123456789012345678901234567890';
const RECIPIENT: Address = '0x000000000000000000000000000000000000aBcd';
const USDC_BASE_SEPOLIA: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const baseSepoliaId = 84532;
const polygonAmoyId = 80002;
const arbitrumSepoliaId = 421614;
const optimismSepoliaId = 11155420;

function setupConnected(opts: {
  walletClient?: ReturnType<typeof makeWalletClient>;
  publicClient?: ReturnType<typeof makePublicClient>;
  switchChainAsync?: ReturnType<typeof vi.fn>;
  account?: Address;
} = {}) {
  const walletClient = opts.walletClient ?? makeWalletClient();
  const publicClient = opts.publicClient ?? makePublicClient();
  vi.mocked(useAccount).mockReturnValue({
    address: opts.account ?? ACCOUNT,
    isConnected: true,
  } as never);
  vi.mocked(useWalletClient).mockReturnValue({
    data: walletClient,
    isLoading: false,
  } as never);
  vi.mocked(usePublicClient).mockReturnValue(publicClient as never);
  vi.mocked(useSwitchChain).mockReturnValue({
    switchChainAsync: opts.switchChainAsync ?? vi.fn(async () => undefined),
  } as never);
  return { walletClient, publicClient };
}

function makeWalletClient() {
  let i = 0;
  const txHashes: Hex[] = [
    '0xtx0000000000000000000000000000000000000000000000000000000000000a',
    '0xtx0000000000000000000000000000000000000000000000000000000000000b',
    '0xtx0000000000000000000000000000000000000000000000000000000000000c',
  ];
  return {
    chain: { id: baseSepoliaId },
    signTypedData: vi.fn(async () => '0xsignedburnintent'),
    sendTransaction: vi.fn(async () => txHashes[i++]),
    writeContract: vi.fn(async () => txHashes[i++]),
  };
}

function makePublicClient() {
  return {
    getBlockNumber: vi.fn(async () => 1000n),
    waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
  };
}

// 全 chain で同じ wallet USDC balance に揃える helper。
function setAllChainsBalance(balance: bigint) {
  setReadContractByChain({
    [baseSepoliaId]: balance,
    [polygonAmoyId]: balance,
    [arbitrumSepoliaId]: balance,
    [optimismSepoliaId]: balance,
  });
}

// React Query wrapper (test 毎に fresh client、retry disabled)
function withQueryClient(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
  );
}

const baseProps = {
  token: 'usdc' as const,
  enabled: true,
  targetChainId: baseSepoliaId,
  recipient: RECIPIENT,
  requiredAtomic: 5_000_000n, // 5 USDC (invoice amount)
  feeReceiver:
    '0x00000000000000000000000000000000000fee01' as `0x${string}`,
  displayDecimals: 6,
  tokenAddress: USDC_BASE_SEPOLIA,
};

beforeEach(() => {
  vi.clearAllMocks();
  logPostMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CrossChainHint: 早期 return (enabled / token / amount guard)', () => {
  it('token != usdc → null (JPYC は Gateway/CCTP 非対応)', () => {
    setupConnected();
    const { container } = renderWithIntl(
      withQueryClient(<CrossChainHint {...baseProps} token={'jpyc' as never} />),
    );
    expect(container.firstChild).toBeNull();
  });

  it('enabled=false → null (store opt-out)', () => {
    setupConnected();
    const { container } = renderWithIntl(
      withQueryClient(<CrossChainHint {...baseProps} enabled={false} />),
    );
    expect(container.firstChild).toBeNull();
  });

  it('requiredAtomic=0n → null (amount 未確定)', () => {
    setupConnected();
    const { container } = renderWithIntl(
      withQueryClient(<CrossChainHint {...baseProps} requiredAtomic={0n} />),
    );
    expect(container.firstChild).toBeNull();
  });
});

describe('CrossChainHint: balance fetch + decision 表示', () => {
  it('direct のみ可 (target 以外の chain は balance 0) → 何も表示しない', async () => {
    // wallet が target chain (base) で十分残高、他 chain は 0 → direct option
    // のみで cross-chain alternatives なし → chooser 非表示 (既存 Pay button が
    // 処理する委譲、本 panel は出さない設計)。
    setReadContractByChain({
      [baseSepoliaId]: 10_000_000n,
      [polygonAmoyId]: 0n,
      [arbitrumSepoliaId]: 0n,
      [optimismSepoliaId]: 0n,
    });
    setupConnected();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              balances: [{ domain: 6, balance: '0' }],
            }),
            { status: 200 },
          ),
      ),
    );
    const { container } = renderWithIntl(
      withQueryClient(<CrossChainHint {...baseProps} />),
    );
    // balance fetch 完了 + cross-chain alternative なし → hint 出さない
    await waitFor(() => {
      expect(
        screen.queryByText(/他チェーン残高を確認中/),
      ).not.toBeInTheDocument();
    });
    expect(container.firstChild).toBeNull();
  });

  it('direct + cross-chain alternative あり → chooser 表示 (新 UX)', async () => {
    // wallet が target chain (base) + 他 chain (polygon) で十分残高
    // → direct と cctp-v2 の両 option が出る → chooser 表示で buyer に選ばせる
    setReadContractByChain({
      [baseSepoliaId]: 10_000_000n,
      [polygonAmoyId]: 10_000_000n,
      [arbitrumSepoliaId]: 0n,
      [optimismSepoliaId]: 0n,
    });
    setupConnected();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ balances: [] }), { status: 200 }),
      ),
    );
    renderWithIntl(withQueryClient(<CrossChainHint {...baseProps} />));
    // chooser が出る
    await waitFor(() => {
      expect(screen.getByText(/支払元チェーンを選ぶ/)).toBeInTheDocument();
    });
    // direct badge + cctp-v2 badge 両方
    expect(screen.getByText(/直接送金/)).toBeInTheDocument();
    expect(screen.getByText(/通常 \(CCTP V2\)/)).toBeInTheDocument();
    // cross-chain option のみ「ブリッジ手数料 + ガス代」を表示 (buyer が払う実費)。
    // direct (同一チェーン) は bridge fee 0 のため fee 行を出さない →
    // "ブリッジ手数料" は cctp-v2 option の 1 箇所だけに現れる。
    expect(screen.getAllByText(/ブリッジ手数料/)).toHaveLength(1);
  });

  it('decision=onramp (全 chain + Gateway 0) → 何も表示しない', async () => {
    setAllChainsBalance(0n);
    setupConnected();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ balances: [] }), { status: 200 }),
      ),
    );
    const { container } = renderWithIntl(
      withQueryClient(<CrossChainHint {...baseProps} />),
    );
    await waitFor(() => {
      expect(
        screen.queryByText(/他チェーン残高を確認中/),
      ).not.toBeInTheDocument();
    });
    expect(container.firstChild).toBeNull();
  });

  it('decision=gateway → CrossChainSourceChooser + Gateway 高速 badge + 統一 Pay button', async () => {
    // target=base で 0、Gateway に Polygon 残高あり。wallet にも Polygon 10 USDC
    // (Gateway option を出すための前提 = wallet balance + gateway pre-deposit 両方ある)。
    setReadContractByChain({
      [baseSepoliaId]: 0n,
      [polygonAmoyId]: 10_000_000n,
      [arbitrumSepoliaId]: 0n,
      [optimismSepoliaId]: 0n,
    });
    setupConnected();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              balances: [{ domain: 7, balance: '10000000' }], // 10 USDC on Polygon Gateway pre-deposit
            }),
            { status: 200 },
          ),
      ),
    );
    renderWithIntl(withQueryClient(<CrossChainHint {...baseProps} />));
    // 新 UI: chooser title が出る、Polygon (mainnet 名 = "Polygon" / testnet 名 = "Polygon Amoy")
    // の chooser button + "高速 (Gateway)" badge
    await waitFor(() => {
      expect(screen.getByText(/支払元チェーンを選ぶ/)).toBeInTheDocument();
    });
    expect(screen.getByText(/高速 \(Gateway\)/)).toBeInTheDocument();
    expect(screen.getByText(/必要額 5 USDC/)).toBeInTheDocument();
    // 統一 Pay button (option kind に依らず常に同じ label)
    expect(
      screen.getByRole('button', { name: /選択したチェーンで支払う/ }),
    ).toBeInTheDocument();
  });

  it('decision=cctp-v2 (target 0 + 他 chain に残高 + Gateway 不足) → CCTP V2 badge', async () => {
    // target=base で 0、Polygon Amoy で 10 USDC、Gateway 残高なし
    setReadContractByChain({
      [baseSepoliaId]: 0n,
      [polygonAmoyId]: 10_000_000n,
      [arbitrumSepoliaId]: 0n,
      [optimismSepoliaId]: 0n,
    });
    setupConnected();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ balances: [] }), { status: 200 }),
      ),
    );
    renderWithIntl(withQueryClient(<CrossChainHint {...baseProps} />));
    // 新 UI: chooser に Polygon の "通常 (CCTP V2)" badge
    await waitFor(() => {
      expect(screen.getByText(/支払元チェーンを選ぶ/)).toBeInTheDocument();
    });
    expect(screen.getByText(/通常 \(CCTP V2\)/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /選択したチェーンで支払う/ }),
    ).toBeInTheDocument();
  });
});

describe('CrossChainHint: execute click → success / error flow', () => {
  it('Gateway path Pay click → execute 成功 → success panel + paymentLog POST', async () => {
    const user = userEvent.setup();
    setAllChainsBalance(0n);
    const walletClient = makeWalletClient();
    setupConnected({ walletClient });

    // attestation API: balances (initial) + transfer (during execute)
    const fetchMock = vi.fn();
    let callIdx = 0;
    fetchMock.mockImplementation(async (url: string) => {
      callIdx++;
      if (url.includes('/v1/balances')) {
        return new Response(
          JSON.stringify({
            balances: [{ domain: 7, balance: '10000000' }],
          }),
          { status: 200 },
        );
      }
      if (url.includes('/v1/transfer')) {
        return new Response(
          JSON.stringify({ attestation: '0xattestation', signature: '0xsig' }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${callIdx}: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithIntl(withQueryClient(<CrossChainHint {...baseProps} />));

    const payBtn = await screen.findByRole('button', {
      name: /選択したチェーンで支払う/,
    });
    await user.click(payBtn);

    // success panel が出る (formatUnits(5_000_000, 6) = "5")
    await waitFor(() => {
      expect(
        screen.getByText(/Circle Gateway 経由で着金しました/),
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/5 USDC を/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Explorer で確認/ })).toBeInTheDocument();

    // paymentLog 呼出確認 (bridge='gateway')
    expect(logPostMock).toHaveBeenCalledTimes(1);
    const evt = logPostMock.mock.calls[0][0];
    expect(evt.bridge).toBe('gateway');
    expect(evt.result).toBe('success');
    expect(evt.merchantAmount).toBe('5000000');
    expect(evt.chainId).toBe(baseSepoliaId);

    // Sentry success log
    expect(logger.info).toHaveBeenCalledWith(
      'cross-chain.execute.success',
      expect.objectContaining({ bridge: 'gateway' }),
    );
  });

  it('execute 中 fetch 失敗 → error 表示 + Sentry error log', async () => {
    const user = userEvent.setup();
    setAllChainsBalance(0n);
    setupConnected();

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/v1/balances')) {
        return new Response(
          JSON.stringify({
            balances: [{ domain: 7, balance: '10000000' }],
          }),
          { status: 200 },
        );
      }
      // attestation API: 503
      return new Response('service unavailable', { status: 503 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithIntl(withQueryClient(<CrossChainHint {...baseProps} />));
    const payBtn = await screen.findByRole('button', {
      name: /選択したチェーンで支払う/,
    });
    await user.click(payBtn);

    await waitFor(() => {
      expect(screen.getByText(/エラー:/)).toBeInTheDocument();
    });
    expect(screen.getByText(/HTTP 503/)).toBeInTheDocument();
    expect(logger.error).toHaveBeenCalledWith(
      'cross-chain.execute.failed',
      expect.objectContaining({ decisionPath: 'gateway' }),
    );
    // 失敗時は paymentLog POST されない (success 時のみ)
    expect(logPostMock).not.toHaveBeenCalled();
  });

  it('balance query: gateway API 500 + wallet 0 → onramp 判定で Hint 出さず', async () => {
    setAllChainsBalance(0n);
    setupConnected();

    // balances API 500 — readGatewayUnifiedBalance は throw せず
    // {status: 'error'} で resolve する設計
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    );

    const { container } = renderWithIntl(
      withQueryClient(<CrossChainHint {...baseProps} />),
    );

    // wallet 全 0 + gateway error → onramp 判定 → hint 出さず
    await waitFor(() => {
      expect(
        screen.queryByText(/他チェーン残高を確認中/),
      ).not.toBeInTheDocument();
    });
    expect(container.firstChild).toBeNull();
  });
});

describe('CrossChainHint: React Query queryKey isolation (LARP audit D2)', () => {
  it('account 切替で fresh fetch → cache pollution なし', async () => {
    // useCrossChainPayment の queryKey は [networkEnv, account, targetChainId]。
    // account 変更で別 key になり、別 account の balance が漏れないことを検証。
    setAllChainsBalance(0n);

    const ACCOUNT_A: Address = '0xaaaa000000000000000000000000000000000000';
    const ACCOUNT_B: Address = '0xbbbb000000000000000000000000000000000000';

    // fetch を call 回数 + body 内 depositor で differentiate
    const fetchCalls: Array<{ depositor: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string);
        fetchCalls.push({ depositor: body.sources[0].depositor });
        return new Response(
          JSON.stringify({ balances: [] }),
          { status: 200 },
        );
      }),
    );

    // QueryClient は test scope で 1 つを共有 (本 plan の本番運用パターン:
    // 1 アプリ instance = 1 QueryClient で、account 切替で同じ client を再利用)。
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      );
    }

    // ACCOUNT_A で render
    setupConnected({ account: ACCOUNT_A });
    const { rerender, unmount } = renderWithIntl(
      <Wrapper>
        <CrossChainHint {...baseProps} />
      </Wrapper>,
    );
    await waitFor(() => {
      expect(fetchCalls.some((c) => c.depositor === ACCOUNT_A)).toBe(true);
    });
    expect(fetchCalls.every((c) => c.depositor !== ACCOUNT_B)).toBe(true);

    // ACCOUNT_B に切替 (useAccount.mockReturnValue を更新 + re-render)
    setupConnected({ account: ACCOUNT_B });
    rerender(
      <Wrapper>
        <CrossChainHint {...baseProps} />
      </Wrapper>,
    );
    // 別 account → React Query は queryKey 変化を検知して fresh fetch
    await waitFor(() => {
      expect(fetchCalls.some((c) => c.depositor === ACCOUNT_B)).toBe(true);
    });

    // ACCOUNT_A balance が ACCOUNT_B のキャッシュとして使われていないこと
    // (= 各 account ごとに独立した queryKey)
    const accountADepositorCalls = fetchCalls.filter(
      (c) => c.depositor === ACCOUNT_A,
    );
    const accountBDepositorCalls = fetchCalls.filter(
      (c) => c.depositor === ACCOUNT_B,
    );
    expect(accountADepositorCalls.length).toBeGreaterThan(0);
    expect(accountBDepositorCalls.length).toBeGreaterThan(0);

    unmount();
  });
});

describe('CrossChainHint: CROSS_CHAIN_DISABLED kill switch', () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_CROSS_CHAIN_DISABLED;
  });

  it('NEXT_PUBLIC_CROSS_CHAIN_DISABLED=true で hint が null + fetch 発火しない', async () => {
    // module-level const なので reset を強制
    process.env.NEXT_PUBLIC_CROSS_CHAIN_DISABLED = 'true';
    vi.resetModules();
    setAllChainsBalance(10_000_000n);
    setupConnected();

    const balancesFetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ balances: [{ domain: 7, balance: '99999' }] }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', balancesFetchSpy);

    // 再 import (kill switch 反映)
    const { CrossChainHint: HintReloaded } = await import(
      '@/components/CrossChainHint'
    );
    const { container } = renderWithIntl(
      withQueryClient(<HintReloaded {...baseProps} />),
    );

    // kill switch ON → 何も render しない + fetch も発火しない
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(container.firstChild).toBeNull();
    expect(balancesFetchSpy).not.toHaveBeenCalled();
  });

  it('kill switch ON で gateway path 検出済 conditions でも hint 出さない', async () => {
    process.env.NEXT_PUBLIC_CROSS_CHAIN_DISABLED = '1';
    vi.resetModules();
    setAllChainsBalance(0n); // wallet 全 0
    setupConnected();

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              balances: [{ domain: 7, balance: '10000000' }],
            }),
            { status: 200 },
          ),
      ),
    );

    const { CrossChainHint: HintReloaded } = await import(
      '@/components/CrossChainHint'
    );
    const { container } = renderWithIntl(
      withQueryClient(<HintReloaded {...baseProps} />),
    );

    // 通常なら gateway path 表示するが kill switch で抑止
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(container.firstChild).toBeNull();
    expect(
      screen.queryByText(/Circle Gateway 経由でも支払えます/),
    ).not.toBeInTheDocument();
  });
});
