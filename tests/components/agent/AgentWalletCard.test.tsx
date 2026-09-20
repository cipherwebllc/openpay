import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AgentWalletCard } from '@/components/agent/AgentWalletCard';
import { defaultDeploymentForSymbol } from '@/lib/tokens';
import { chainNameForId } from '@/lib/chains';
import { agentPageContentFor } from '@/lib/agentPage';

const C = agentPageContentFor('en').wallet;

const state = vi.hoisted(() => ({ query: '', data: undefined as bigint | undefined, isError: false, connected: false, read: vi.fn() }));
const address = '0x1111111111111111111111111111111111111111';
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(state.query) }));
vi.mock('wagmi', () => ({
  useAccount: () => ({ address, isConnected: state.connected }),
  useReadContract: (options: unknown) => { state.read(options); return { data: state.data, isError: state.isError }; },
}));
vi.mock('next/dynamic', () => ({ default: () => function QR({ value }: { value: string }) { return <svg data-value={value} />; } }));
beforeEach(() => { window.localStorage.clear(); state.query = ''; state.data = undefined; state.isError = false; state.connected = false; state.read.mockClear(); });

describe('AgentWalletCard', () => {
  it('does not enable balance reads for empty or invalid addresses', () => {
    state.query = 'address=invalid';
    render(<AgentWalletCard c={C} />);
    expect(state.read).toHaveBeenLastCalledWith(expect.objectContaining({ query: { enabled: false }, args: undefined }));
    fireEvent.change(screen.getByLabelText('Agent wallet address'), { target: { value: 'invalid' } });
    expect(state.read).toHaveBeenLastCalledWith(expect.objectContaining({ query: { enabled: false }, args: undefined }));
    expect(screen.getByLabelText('Agent wallet address')).toHaveAccessibleDescription('That is not a valid address');
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText(/does not verify who owns/)).toBeInTheDocument();
  });
  it.each([[0n, 'No JPYC'], [10n ** 18n, 'Holds JPYC']] as const)('shows factual balance %s', (data, label) => {
    state.query = `address=${address}`;
    state.data = data;
    const { container } = render(<AgentWalletCard c={C} />);
    const deployment = defaultDeploymentForSymbol('jpyc');
    expect(state.read).toHaveBeenLastCalledWith(expect.objectContaining({ address: deployment.address, chainId: deployment.chainId, args: [address], query: { enabled: true } }));
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText(`JPYC balance · ${chainNameForId(deployment.chainId)}`)).toBeInTheDocument();
    // QR はアドレス行と同じ情報なので a11y 名を持たせない (掟 8)。
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.querySelector(`svg[data-value="${address}"]`)).not.toBeNull();
    expect(container.textContent).not.toMatch(/稼働中|Active|接続済み/);
    expect(container.querySelector('a[href*="/pay"]')).toBeNull();
  });
  it('shows loading and errors without a false zero balance', () => {
    state.query = `address=${address}`;
    const { rerender } = render(<AgentWalletCard c={C} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    state.isError = true;
    rerender(<AgentWalletCard c={C} />);
    expect(screen.getByRole('status')).toHaveTextContent('Could not read the balance');
    expect(screen.queryByText('No JPYC')).toBeNull();
  });
  it('uses the connected wallet only on request and disables reads after invalid edits', () => {
    state.connected = true;
    render(<AgentWalletCard c={C} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use the connected wallet' }));
    expect(screen.getByLabelText('Agent wallet address')).toHaveValue(address);
    expect(state.read).toHaveBeenLastCalledWith(expect.objectContaining({ args: [address], query: { enabled: true } }));
    fireEvent.change(screen.getByLabelText('Agent wallet address'), { target: { value: '0x' } });
    expect(state.read).toHaveBeenLastCalledWith(expect.objectContaining({ args: undefined, query: { enabled: false } }));
  });
  it('remembers a valid public address on this device and restores it on the next visit', () => {
    const first = render(<AgentWalletCard c={C} />);
    fireEvent.change(screen.getByLabelText('Agent wallet address'), { target: { value: address } });
    expect(window.localStorage.getItem('openpay.agent.address')).toBe(address);
    expect(screen.getByRole('link', { name: 'Add funds' })).toHaveAttribute('href', '#agent-fund');
    expect(screen.getByRole('link', { name: 'Connect agent' })).toHaveAttribute('href', '#agent-connect');
    first.unmount();
    render(<AgentWalletCard c={C} />);
    expect(screen.getByLabelText('Agent wallet address')).toHaveValue(address);
  });
});
