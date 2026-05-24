// TipForm を実 CrossChainHint と一緒に render する統合テスト (boundary mock は
// wagmi / viem.createPublicClient / paymentLog のみ、CrossChainHint.test.tsx と
// 同型方針)。spy stub では検証不可能な「TipForm wiring が実 hint を mount + balance
// fetch + path enumerate まで通す」を確認する。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  arbitrumSepolia,
  avalancheFuji,
  baseSepolia,
  optimismSepolia,
  polygonAmoy,
  sepolia,
  unichainSepolia,
} from 'viem/chains';
import type { Address } from 'viem';

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

vi.mock('wagmi', () => ({
  useAccount: vi.fn(),
  useReadContract: vi.fn(),
  useWalletClient: vi.fn(),
  usePublicClient: vi.fn(),
  useSwitchChain: vi.fn(),
  useConnect: vi.fn(() => ({
    connectors: [],
    connect: vi.fn(),
    isPending: false,
    error: null,
  })),
  useDisconnect: vi.fn(() => ({ disconnect: vi.fn() })),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const logPostMock = vi.fn();
vi.mock('@/lib/paymentLog', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/paymentLog')>('@/lib/paymentLog');
  return {
    ...actual,
    logPaymentEvent: (...args: unknown[]) => logPostMock(...args),
  };
});

// TipForm 内部の Pimlico 系 hook は boundary mock (個別 test file で個別検証済)。
vi.mock('@/hooks/useSmartAccount', () => ({ useSmartAccount: vi.fn() }));
vi.mock('@/hooks/useBatchPayment', () => ({ useBatchPayment: vi.fn() }));
vi.mock('@/hooks/useGasQuoteUsdc', () => ({ useGasQuoteUsdc: vi.fn() }));
vi.mock('@/hooks/useGasQuoteJpyc', () => ({ useGasQuoteJpyc: vi.fn() }));
vi.mock('@/lib/pimlico', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/pimlico')>('@/lib/pimlico');
  return {
    ...actual,
    resolvePaymasterMode: vi.fn(actual.resolvePaymasterMode),
  };
});

import {
  useAccount,
  useReadContract,
  usePublicClient,
  useSwitchChain,
  useWalletClient,
} from 'wagmi';
import { useSmartAccount } from '@/hooks/useSmartAccount';
import { useBatchPayment } from '@/hooks/useBatchPayment';
import { useGasQuoteUsdc } from '@/hooks/useGasQuoteUsdc';
import { useGasQuoteJpyc } from '@/hooks/useGasQuoteJpyc';
import { resolvePaymasterMode } from '@/lib/pimlico';
import { TipForm } from '@/components/TipForm';
import type { TipParams } from '@/lib/url';

const CREATOR: Address = '0x2222222222222222222222222222222222222222';
const FAN: Address = '0x1234567890123456789012345678901234567890';

// CROSS_CHAIN_TARGETS は testnet env で 7 chain。全てに balance を設定しないと
// balance.ts の readContract が "test setup missing" を throw する。
const ALL_CHAIN_IDS = [
  baseSepolia.id,
  polygonAmoy.id,
  arbitrumSepolia.id,
  optimismSepolia.id,
  sepolia.id,
  avalancheFuji.id,
  unichainSepolia.id,
];

function makeWalletClient() {
  return { chain: { id: baseSepolia.id } };
}

function makePublicClient() {
  return { getBlockNumber: vi.fn(async () => 1000n) };
}

function setAllChainsBalance(balance: bigint) {
  setReadContractByChain(
    Object.fromEntries(ALL_CHAIN_IDS.map((id) => [id, balance])),
  );
}

function withQueryClient(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
  );
}

function setupConnected() {
  vi.mocked(useAccount).mockReturnValue({
    address: FAN,
    isConnected: true,
    chainId: baseSepolia.id,
  } as never);
  vi.mocked(useWalletClient).mockReturnValue({
    data: makeWalletClient(),
    isLoading: false,
  } as never);
  vi.mocked(usePublicClient).mockReturnValue(makePublicClient() as never);
  vi.mocked(useSwitchChain).mockReturnValue({
    switchChain: vi.fn(),
    switchChainAsync: vi.fn(async () => undefined),
    isPending: false,
  } as never);
  // useErc20BalanceAndChain が直接呼ぶ wagmi の useReadContract (チェーン上 USDC
  // balance)。CrossChainHint 経路の readContract は viem mock 側で別途設定。
  vi.mocked(useReadContract).mockReturnValue({
    data: 1_000_000n,
    isLoading: false,
    error: null,
  } as never);
  vi.mocked(useSmartAccount).mockReturnValue({
    data: { smartAccountClient: {}, pimlicoClient: {} },
    isLoading: false,
    error: null,
  } as never);
  vi.mocked(useBatchPayment).mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    data: undefined,
    error: null,
  } as never);
  const gasState = {
    data: { gasAmount: 100_000n },
    isLoading: false,
    isError: false,
    error: null,
  };
  vi.mocked(useGasQuoteUsdc).mockReturnValue(gasState as never);
  vi.mocked(useGasQuoteJpyc).mockReturnValue(gasState as never);
}

const USDC_PARAMS: TipParams = {
  to: CREATOR,
  token: 'usdc',
  chain: 'base',
  presets: ['1', '5', '10'],
};

const JPYC_PARAMS: TipParams = {
  to: CREATOR,
  token: 'jpyc',
  chain: 'polygon',
  presets: ['100', '500'],
};

beforeEach(() => {
  vi.clearAllMocks();
  logPostMock.mockClear();
  readContractByChain.clear();
  vi.mocked(resolvePaymasterMode).mockImplementation(() => 'sponsorship');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TipForm + 実 CrossChainHint 統合', () => {
  function stubGatewayBalances() {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ balances: [] }), { status: 200 }),
      ),
    );
  }

  it('USDC + 接続済 + 他 chain に balance → SourceChooser が実 DOM に出る', async () => {
    setupConnected();
    setReadContractByChain(
      Object.fromEntries(
        ALL_CHAIN_IDS.map((id) => [
          id,
          id === polygonAmoy.id ? 10_000_000n : 0n,
        ]),
      ),
    );
    stubGatewayBalances();

    renderWithIntl(withQueryClient(<TipForm params={USDC_PARAMS} />));

    await waitFor(
      () => {
        expect(screen.getByText(/支払元チェーンを選ぶ/)).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
    expect(
      screen.getByRole('button', { name: /選択したチェーンで支払う/ }),
    ).toBeInTheDocument();
    // どの path badge が出るかは pathEnumerator の優先順位 + balance 配分で決まる。
    // 何れか 1 つ出ていれば path 算出が動作した証拠。
    const badges = screen.queryAllByText(
      /直接送金|高速 \(Gateway\)|通常 \(CCTP V2\)/,
    );
    expect(badges.length).toBeGreaterThan(0);
  });

  it('USDC + crossChain=false → enabled=false で早期 return (DOM 要素なし)', async () => {
    setupConnected();
    setAllChainsBalance(10_000_000n);

    renderWithIntl(
      withQueryClient(
        <TipForm params={{ ...USDC_PARAMS, crossChain: false }} />,
      ),
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '1 USDC' })).toBeInTheDocument();
    });
    expect(screen.queryByText(/支払元チェーンを選ぶ/)).toBeNull();
    expect(screen.queryByText(/Gateway/)).toBeNull();
  });

  it('JPYC → token guard で何も render しない', async () => {
    setupConnected();
    setAllChainsBalance(0n);

    renderWithIntl(withQueryClient(<TipForm params={JPYC_PARAMS} />));

    await waitFor(() => {
      expect(screen.getByText('100 JPYC')).toBeInTheDocument();
    });
    expect(screen.queryByText(/支払元チェーンを選ぶ/)).toBeNull();
    expect(screen.queryByText(/Gateway/)).toBeNull();
    expect(screen.queryByText(/CCTP/)).toBeNull();
  });

  it('全 chain balance=0 → pathOptions 空 (render なし)', async () => {
    setupConnected();
    setAllChainsBalance(0n);
    stubGatewayBalances();

    renderWithIntl(withQueryClient(<TipForm params={USDC_PARAMS} />));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '1 USDC' })).toBeInTheDocument();
    });
    // balance fetch + enumeration の完了待ち
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.queryByText(/支払元チェーンを選ぶ/)).toBeNull();
  });
});
