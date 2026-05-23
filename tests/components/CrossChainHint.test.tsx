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
  requiredAtomic: 5_000_000n, // 5 USDC
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
  it('balance API + on-chain query 完了 + decision=direct → 何も表示しない', async () => {
    // wallet が target chain で十分残高 → direct path
    setAllChainsBalance(10_000_000n);
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
    // balance fetch 完了 + direct 判定 → hint 出さない
    await waitFor(() => {
      // loading panel が消える (balance fetch 完了)
      expect(
        screen.queryByText(/他チェーン残高を確認中/),
      ).not.toBeInTheDocument();
    });
    // direct path → 代替経路 hint も success panel も出ない
    expect(container.firstChild).toBeNull();
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

  it('decision=gateway → 代替経路 hint + Gateway badge + Pay button', async () => {
    // target=base で 0、Gateway に Polygon 残高あり
    setAllChainsBalance(0n);
    setupConnected();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              balances: [{ domain: 7, balance: '10000000' }], // 10 USDC on Polygon
            }),
            { status: 200 },
          ),
      ),
    );
    renderWithIntl(withQueryClient(<CrossChainHint {...baseProps} />));
    await waitFor(() => {
      expect(
        screen.getByText(/Circle Gateway 経由でも支払えます/),
      ).toBeInTheDocument();
    });
    expect(screen.getByText('gateway')).toBeInTheDocument();
    expect(screen.getByText(/送金額: 5 USDC/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Circle Gateway で支払う/ }),
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
    await waitFor(() => {
      expect(
        screen.getByText(/CCTP V2 Fast 経由でも支払えます/),
      ).toBeInTheDocument();
    });
    expect(screen.getByText('cctp-v2')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /CCTP V2 Fast で支払う/ }),
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
      name: /Circle Gateway で支払う/,
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
      name: /Circle Gateway で支払う/,
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
