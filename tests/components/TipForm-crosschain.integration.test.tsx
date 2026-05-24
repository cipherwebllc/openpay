// TipForm + 実 CrossChainHint 統合テスト。
//
// LARP audit L3 への対処: 既存 TipForm.test.tsx は CrossChainHint を spy stub で
// 置換していたため「props を渡す」までしか確認していなかった。本 file では
// CrossChainHint を実 component で mount し、useCrossChainPayment / balance.ts /
// pathEnumerator まで実コードを通す。boundary mock は wagmi / viem.createPublicClient
// / paymentLog のみ (CrossChainHint.test.tsx と同型方針)。
//
// 検証する unique flow (CrossChainHint.test.tsx は PaymentForm context だが、
// 本 file は TipForm context で同じ component が同じ shape の props を受けて
// 同じ UI を出すことを確認する。設定の信頼合成では覆えない wiring 検証):
//   - TipForm USDC + 接続済 + balance あり → 実 CrossChainHint が DOM 要素を出す
//   - TipForm crossChain=false → 実 CrossChainHint が早期 return で null
//   - TipForm JPYC → 実 CrossChainHint が token guard で null (JPYC 経路)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { baseSepolia } from 'viem/chains';
import type { Address, Hex } from 'viem';

// CrossChainHint と同型の boundary mock
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

// TipForm 内部 hook (smart account / batch payment / gas quote) は boundary mock。
// これらは TipForm の責務外 (個別 test file あり)、本 file は CrossChainHint 統合のみ検証。
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

// chain id constants (testnet env、CROSS_CHAIN_TARGETS の 7 chain 全部 cover 必要)
const baseSepoliaId = 84532;
const polygonAmoyId = 80002;
const arbitrumSepoliaId = 421614;
const optimismSepoliaId = 11155420;
const sepoliaId = 11155111;
const avalancheFujiId = 43113;
const unichainSepoliaId = 1301;

function makeWalletClient() {
  let i = 0;
  const txHashes: Hex[] = [
    '0xtx0000000000000000000000000000000000000000000000000000000000000a',
    '0xtx0000000000000000000000000000000000000000000000000000000000000b',
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

function setAllChainsBalance(balance: bigint) {
  setReadContractByChain({
    [baseSepoliaId]: balance,
    [polygonAmoyId]: balance,
    [arbitrumSepoliaId]: balance,
    [optimismSepoliaId]: balance,
    [sepoliaId]: balance,
    [avalancheFujiId]: balance,
    [unichainSepoliaId]: balance,
  });
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
  const walletClient = makeWalletClient();
  const publicClient = makePublicClient();
  vi.mocked(useAccount).mockReturnValue({
    address: FAN,
    isConnected: true,
    chainId: baseSepoliaId,
  } as never);
  vi.mocked(useWalletClient).mockReturnValue({
    data: walletClient,
    isLoading: false,
  } as never);
  vi.mocked(usePublicClient).mockReturnValue(publicClient as never);
  vi.mocked(useSwitchChain).mockReturnValue({
    switchChain: vi.fn(),
    switchChainAsync: vi.fn(async () => undefined),
    isPending: false,
  } as never);
  // TipForm 内部の useErc20BalanceAndChain が useReadContract を直接呼ぶ
  vi.mocked(useReadContract).mockReturnValue({
    data: 1_000_000n, // 1 USDC on local chain — insufficient (=insufficientBalance=true)
    isLoading: false,
    error: null,
  } as never);
  // TipForm 内部 hook
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

const USDC_BASE_SEPOLIA: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

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

describe('TipForm + 実 CrossChainHint 統合 (LARP L3)', () => {
  it('USDC + 接続済 + 他 chain に balance → CrossChainHint の chooser UI が実 DOM に出る', async () => {
    setupConnected();
    // base (target) = 不足、polygon に 10 USDC、他 chain = 0
    // → polygon → base の Gateway path が enumerate される想定
    setReadContractByChain({
      [baseSepoliaId]: 0n,
      [polygonAmoyId]: 10_000_000n, // 10 USDC on polygon
      [arbitrumSepoliaId]: 0n,
      [optimismSepoliaId]: 0n,
      [sepoliaId]: 0n,
      [avalancheFujiId]: 0n,
      [unichainSepoliaId]: 0n,
    });
    // Circle Gateway pre-deposit API (useCrossChainPayment 内部で fetch) を stub。
    // 残高 0 で返す → wallet 残高経由のみで path 算出。
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ balances: [] }), { status: 200 }),
      ),
    );

    renderWithIntl(withQueryClient(<TipForm params={USDC_PARAMS} />));

    // 実 CrossChainHint が render する SourceChooser の i18n 文字列を assert。
    // spy stub では決して出ない要素 (= 実 component が mount + balance fetch +
    // pathEnumerator 実行された証拠)。
    await waitFor(
      () => {
        expect(screen.getByText(/支払元チェーンを選ぶ/)).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
    // 統一 Pay button (TipForm 経由でも CrossChainHint の同 button が出る)
    expect(
      screen.getByRole('button', { name: /選択したチェーンで支払う/ }),
    ).toBeInTheDocument();
    // path badge のうち少なくとも 1 つ (direct / Gateway / CCTP V2) が表示される。
    // どれが auto-selected かは pathEnumerator の優先順位 (direct→gateway→cctp) で
    // 決まり、本 test の wallet balance 配分次第。何れか出ていれば pathOptions
    // 算出が動作した証拠。
    const badges = screen.queryAllByText(
      /直接送金|高速 \(Gateway\)|通常 \(CCTP V2\)/,
    );
    expect(badges.length).toBeGreaterThan(0);
  });

  it('USDC + crossChain=false → 実 CrossChainHint が早期 return (DOM に hint 要素なし)', async () => {
    setupConnected();
    // enabled=false なら balance fetch も skip されるが、念のため全 chain 設定
    setAllChainsBalance(10_000_000n);

    renderWithIntl(
      withQueryClient(
        <TipForm params={{ ...USDC_PARAMS, crossChain: false }} />,
      ),
    );

    // preset 表示で render 完了を待機
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '1 USDC' })).toBeInTheDocument();
    });
    // CrossChainHint の i18n key (SourceChooser title) が DOM に無いこと
    expect(screen.queryByText(/支払元チェーンを選ぶ/)).toBeNull();
    expect(screen.queryByText(/Gateway/)).toBeNull();
  });

  it('JPYC + 接続済 → CrossChainHint は token guard で何も render しない', async () => {
    setupConnected();
    // balance は無関係 (どうせ render しない)
    setAllChainsBalance(0n);

    renderWithIntl(withQueryClient(<TipForm params={JPYC_PARAMS} />));

    await waitFor(() => {
      expect(screen.getByText('100 JPYC')).toBeInTheDocument();
    });
    // JPYC では Gateway/CCTP UI は出ない
    expect(screen.queryByText(/支払元チェーンを選ぶ/)).toBeNull();
    expect(screen.queryByText(/Gateway/)).toBeNull();
    expect(screen.queryByText(/CCTP/)).toBeNull();
  });

  it('全 chain balance=0 → CrossChainHint は pathOptions=0 で何も render しない', async () => {
    setupConnected();
    setAllChainsBalance(0n);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ balances: [] }), { status: 200 }),
      ),
    );

    renderWithIntl(withQueryClient(<TipForm params={USDC_PARAMS} />));

    // preset で render 完了を待機
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '1 USDC' })).toBeInTheDocument();
    });
    // balance fetch + enumeration が走るまで少し待つ (jsdom + react-query)
    await new Promise((r) => setTimeout(r, 200));
    // 0 balance では direct も alternative も無い → hint UI 出ない
    expect(screen.queryByText(/支払元チェーンを選ぶ/)).toBeNull();
  });
});
