import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
import userEvent from '@testing-library/user-event';

vi.mock('@/hooks/useResolveAddress', () => ({
  useResolveAddress: vi.fn(() => ({ data: null, isFetching: false, error: null })),
}));
vi.mock('wagmi', () => ({
  useAccount: vi.fn(() => ({ address: undefined, isConnected: false })),
}));
vi.mock('@/hooks/useOrigin', () => ({
  useOrigin: () => 'https://test.local',
}));
vi.mock('@/hooks/useMarketRates', () => ({
  useMarketRates: vi.fn(() => ({
    data: { usdcJpy: 150, updatedAt: '2026-06-03T00:00:00.000Z' },
    isLoading: false, isError: false, refetch: vi.fn(),
  })),
}));

// resolveJpycGaslessProvider = eip3009-relay (recover path)
vi.mock('@/lib/jpycGaslessProvider', () => ({
  resolveJpycGaslessProvider: vi.fn(() => 'eip3009-relay' as const),
}));

// forwarderConfig: controlled per test
vi.mock('@/lib/relay/forwarderConfig', async () => {
  const actual = await vi.importActual<typeof import('@/lib/relay/forwarderConfig')>(
    '@/lib/relay/forwarderConfig',
  );
  return {
    ...actual,
    jpycForwarderFor: vi.fn(() => null),
    relayGasFeeValue: vi.fn(() => 2n * 10n ** 18n),
  };
});

// recoverFee: controlled per test
vi.mock('@/lib/relay/recoverFee', async () => {
  const actual = await vi.importActual<typeof import('@/lib/relay/recoverFee')>(
    '@/lib/relay/recoverFee',
  );
  return {
    ...actual,
    recoverFeeValue: vi.fn((amount: bigint) => 2n * 10n ** 18n),
    recoverFeeBps: vi.fn(() => 0),
  };
});

import { QrGenerator } from '@/components/QrGenerator';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { recoverFeeValue, recoverFeeBps } from '@/lib/relay/recoverFee';

const MOCK_FORWARDER = '0x1234567890123456789012345678901234567890' as `0x${string}`;
const VALID_RECEIVER = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

async function fillAmount(user: ReturnType<typeof userEvent.setup>, amount: string) {
  const input = screen.getByPlaceholderText('1000');
  await user.clear(input);
  await user.type(input, amount);
}

async function openStep2(user: ReturnType<typeof userEvent.setup>) {
  const toggle = screen.queryByRole('button', { name: /受取先/ });
  if (toggle && toggle.getAttribute('aria-expanded') === 'false') {
    await user.click(toggle);
  }
}

describe('QrGenerator recover fee disclosure', () => {
  beforeEach(() => {
    vi.mocked(jpycForwarderFor).mockReturnValue(null);
    vi.mocked(recoverFeeValue).mockReturnValue(2n * 10n ** 18n);
    vi.mocked(recoverFeeBps).mockReturnValue(0);
  });

  it('FREE mode (forwarder null): no fee disclosure shown', async () => {
    const user = userEvent.setup();
    render(<QrGenerator />);
    await openStep2(user);
    const receiverInput = screen.getByPlaceholderText(/0x/i);
    await user.type(receiverInput, VALID_RECEIVER);
    await fillAmount(user, '1000');
    expect(screen.queryByText(/決済手数料/)).toBeNull();
  });

  it('RECOVER mode, bps=0: shows "2 JPYC（ガス相当）" disclosure', async () => {
    vi.mocked(jpycForwarderFor).mockReturnValue(MOCK_FORWARDER);
    const user = userEvent.setup();
    render(<QrGenerator />);
    await openStep2(user);
    const receiverInput = screen.getByPlaceholderText(/0x/i);
    await user.type(receiverInput, VALID_RECEIVER);
    await fillAmount(user, '1000');
    expect(screen.getByText(/決済手数料: 2 JPYC（ガス相当）/)).toBeInTheDocument();
  });

  it('RECOVER mode, bps=100: shows % form disclosure', async () => {
    vi.mocked(jpycForwarderFor).mockReturnValue(MOCK_FORWARDER);
    vi.mocked(recoverFeeBps).mockReturnValue(100);
    vi.mocked(recoverFeeValue).mockReturnValue(10n * 10n ** 18n); // 1% of 1000 = 10
    const user = userEvent.setup();
    render(<QrGenerator />);
    await openStep2(user);
    const receiverInput = screen.getByPlaceholderText(/0x/i);
    await user.type(receiverInput, VALID_RECEIVER);
    await fillAmount(user, '1000');
    // % form: "決済手数料: 10 JPYC（決済額の1%・最低2 JPYC）"
    expect(screen.getByText(/決済手数料: 10 JPYC（決済額の1%/)).toBeInTheDocument();
  });

  it('RECOVER mode, customer gasMode: shows customer split label', async () => {
    vi.mocked(jpycForwarderFor).mockReturnValue(MOCK_FORWARDER);
    const user = userEvent.setup();
    render(<QrGenerator />);
    await openStep2(user);
    const receiverInput = screen.getByPlaceholderText(/0x/i);
    await user.type(receiverInput, VALID_RECEIVER);
    await fillAmount(user, '1000');
    // default gasMode = 'customer'
    expect(screen.getByText(/手数料はお客様負担/)).toBeInTheDocument();
  });
});
