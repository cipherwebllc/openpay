import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';

vi.mock('next/navigation', () => ({ useSearchParams: vi.fn() }));
vi.mock('wagmi', () => ({
  useAccount: vi.fn(() => ({ address: '0xUser1234567890123456789012345678901234', isConnected: true, chainId: 137 })),
  useReadContract: vi.fn(() => ({ data: undefined })),
  useSwitchChain: vi.fn(() => ({ switchChain: vi.fn(), isPending: false })),
  useConnect: vi.fn(() => ({ connectors: [], connect: vi.fn(), isPending: false, error: null })),
  useDisconnect: vi.fn(() => ({ disconnect: vi.fn() })),
}));
vi.mock('@/hooks/useSmartAccount', () => ({ useSmartAccount: vi.fn(() => ({ data: null, error: null })) }));
vi.mock('@/hooks/useBatchPayment', () => ({
  useBatchPayment: vi.fn(() => ({ data: undefined, error: null, isPending: false, mutate: vi.fn() })),
}));
vi.mock('@/hooks/useStandardPayment', () => ({
  useStandardPayment: vi.fn(() => ({ data: undefined, error: null, isPending: false, phase: null, isFeeError: false, isMerchantError: false, mutate: vi.fn(), retryFee: vi.fn() })),
}));
vi.mock('@/hooks/useJpycEip3009Payment', () => ({
  useJpycEip3009Payment: vi.fn(() => ({ data: undefined, error: null, isPending: false, mutate: vi.fn(), variables: undefined })),
}));
vi.mock('@/lib/jpycGaslessProvider', () => ({
  resolveJpycGaslessProvider: vi.fn(() => 'eip3009-relay' as const),
}));
vi.mock('@/lib/relay/forwarderConfig', async () => {
  const actual = await vi.importActual<typeof import('@/lib/relay/forwarderConfig')>('@/lib/relay/forwarderConfig');
  return { ...actual, jpycForwarderFor: vi.fn(() => null), relayGasFeeValue: vi.fn(() => 2n * 10n ** 18n) };
});
vi.mock('@/lib/relay/recoverFee', async () => {
  const actual = await vi.importActual<typeof import('@/lib/relay/recoverFee')>('@/lib/relay/recoverFee');
  return { ...actual, recoverFeeValue: vi.fn(() => 2n * 10n ** 18n), recoverFeeBps: vi.fn(() => 0) };
});
vi.mock('@/hooks/useGasQuote', () => ({ useGasQuote: vi.fn(() => ({ data: undefined, error: null })) }));
vi.mock('@/hooks/useGasQuoteCircle', () => ({ useGasQuoteCircle: vi.fn(() => ({ data: undefined, error: null })) }));
vi.mock('@/lib/circlePaymaster', async () => {
  const actual = await vi.importActual<typeof import('@/lib/circlePaymaster')>('@/lib/circlePaymaster');
  return { ...actual, resolveUsdcGaslessProvider: vi.fn(() => 'pimlico') };
});
vi.mock('@/components/CrossChainHint', () => ({ CrossChainHint: () => null }));
vi.mock('@/components/ConnectButton', async () => ({
  ConnectButton: (await import('../_helpers/connectButtonStub')).ConnectButtonStub,
}));
vi.mock('@/lib/pimlico', async () => {
  const actual = await vi.importActual<typeof import('@/lib/pimlico')>('@/lib/pimlico');
  return { ...actual, resolvePaymasterMode: vi.fn(() => 'sponsorship') };
});
vi.mock('@/hooks/useErc20BalanceAndChain', () => ({
  useErc20BalanceAndChain: vi.fn(() => ({ balance: 10000n * 10n ** 18n, insufficientBalance: false, wrongChain: false })),
}));
vi.mock('@/hooks/usePaymentHistory', () => ({ usePaymentHistory: vi.fn() }));
vi.mock('@/hooks/useRelayGaslessSnapshot', () => ({ useRelayGaslessSnapshot: vi.fn(() => ({ data: undefined, error: null, isPending: false })) }));
vi.mock('@/lib/successChime', () => ({ primeChimeAudio: vi.fn() }));

import { PaymentForm } from '@/components/PaymentForm';
import { useSearchParams } from 'next/navigation';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { recoverFeeValue, recoverFeeBps } from '@/lib/relay/recoverFee';

const MOCK_FORWARDER = '0x1234567890123456789012345678901234567890' as `0x${string}`;

function setupSearch(params: Record<string, string>) {
  const sp = new URLSearchParams(params);
  vi.mocked(useSearchParams).mockReturnValue(sp as unknown as ReturnType<typeof useSearchParams>);
}

describe('PaymentForm recover fee disclosure', () => {
  beforeEach(() => {
    vi.mocked(jpycForwarderFor).mockReturnValue(null);
    vi.mocked(recoverFeeValue).mockReturnValue(2n * 10n ** 18n);
    vi.mocked(recoverFeeBps).mockReturnValue(0);
    setupSearch({
      to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      token: 'jpyc',
      chain: 'polygon',
      amount: '1000',
      gas: 'customer',
      mode: 'gasless',
    });
  });

  it('FREE mode: no fee disclosure', () => {
    render(<PaymentForm />);
    expect(screen.queryByText(/決済手数料/)).toBeNull();
  });

  it('RECOVER mode, bps=0: shows gas-only disclosure', () => {
    vi.mocked(jpycForwarderFor).mockReturnValue(MOCK_FORWARDER);
    render(<PaymentForm />);
    expect(screen.getByText(/決済手数料: 2 JPYC（ガス相当）/)).toBeInTheDocument();
  });

  it('RECOVER mode, bps=100: shows % disclosure', () => {
    vi.mocked(jpycForwarderFor).mockReturnValue(MOCK_FORWARDER);
    vi.mocked(recoverFeeBps).mockReturnValue(100);
    vi.mocked(recoverFeeValue).mockReturnValue(10n * 10n ** 18n);
    render(<PaymentForm />);
    expect(screen.getByText(/決済手数料: 10 JPYC（決済額の1%/)).toBeInTheDocument();
  });

  it('RECOVER mode, gasMode=customer: shows customer split label', () => {
    vi.mocked(jpycForwarderFor).mockReturnValue(MOCK_FORWARDER);
    render(<PaymentForm />);
    expect(screen.getByText(/手数料はお客様負担/)).toBeInTheDocument();
  });

  it('RECOVER mode, gasMode=merchant: shows merchant split label', () => {
    vi.mocked(jpycForwarderFor).mockReturnValue(MOCK_FORWARDER);
    setupSearch({
      to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      token: 'jpyc',
      chain: 'polygon',
      amount: '1000',
      gas: 'merchant',
      mode: 'gasless',
    });
    render(<PaymentForm />);
    expect(screen.getByText(/手数料は店舗負担/)).toBeInTheDocument();
  });
});
