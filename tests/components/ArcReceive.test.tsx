import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '../_helpers/i18n';

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, enableUsdcArc: true } };
});
vi.mock('@/hooks/useResolveAddress', () => ({
  useResolveAddress: () => ({ data: null, isFetching: false, error: null }),
}));
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined, isConnected: false }),
  useReadContract: () => ({ data: undefined }),
}));
vi.mock('@/hooks/useOrigin', () => ({ useOrigin: () => 'https://test.local' }));
vi.mock('@/hooks/useMarketRates', () => ({
  useMarketRates: () => ({ data: { usdcJpy: 150 }, isLoading: false, isError: false, refetch: vi.fn() }),
}));

import { CheckoutLinkGenerator } from '@/components/CheckoutLinkGenerator';
import { QrGenerator } from '@/components/QrGenerator';
import { USDC_CHAINS } from '@/lib/chains';

const receiver = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
beforeEach(() => window.localStorage.clear());

describe('Arc receive UI with flag ON', () => {
  it('checkout lists seven chains and corrects gasless when Arc is selected', async () => {
    window.localStorage.setItem('openpay:checkout-settings:v1', JSON.stringify({
      receiver, token: 'usdc', chain: 'base', payMode: 'gasless',
      items: [{ name: 'A', qty: '1', price: '1' }],
    }));
    render(<CheckoutLinkGenerator />);
    expect(USDC_CHAINS).toHaveLength(7);
    await userEvent.click(await screen.findByRole('button', { name: /^Arc Testnet/ }));
    await waitFor(() => {
      const saved = JSON.parse(window.localStorage.getItem('openpay:checkout-settings:v1')!);
      expect(saved).toMatchObject({ chain: 'arc', payMode: 'standard' });
    });
    expect(screen.getByRole('button', { name: /^ガス代不要/ })).toBeDisabled();
  });

  it('QR preserves Arc standard mode, removes cross-chain offer, and uses USDC gas copy', async () => {
    window.localStorage.setItem('openpay:qr-settings:v2', JSON.stringify({
      receiver, token: 'usdc', chain: 'arc', payMode: 'gasless', crossChain: true,
    }));
    render(<QrGenerator />);
    await waitFor(() => {
      const saved = JSON.parse(window.localStorage.getItem('openpay:qr-settings:v2')!);
      expect(saved).toMatchObject({ chain: 'arc', payMode: 'standard', crossChain: false });
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /高度な設定/ }));
    expect(screen.getByRole('button', { name: /^ガス代不要/ })).toBeDisabled();
    expect(screen.getAllByText(/ガスは USDC で支払われるため別トークン不要/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('checkbox', { name: /別チェーン/ })).not.toBeInTheDocument();
  });
});
