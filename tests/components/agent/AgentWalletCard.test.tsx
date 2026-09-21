import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AgentWalletCard } from '@/components/agent/AgentWalletCard';
import { defaultDeploymentForSymbol } from '@/lib/tokens';
import { chainNameForId } from '@/lib/chains';
import { agentPageContentFor } from '@/lib/agentPage';

const C = agentPageContentFor('en').wallet;

const state = vi.hoisted(() => ({ query: '', data: undefined as bigint | undefined, isError: false, connected: false, read: vi.fn(), fund: vi.fn(), mount: vi.fn(), unmount: vi.fn(), refetch: vi.fn() }));
const address = '0x1111111111111111111111111111111111111111';
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(state.query) }));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('wagmi', () => ({
  useAccount: () => ({ address, isConnected: state.connected }),
  useReadContract: (options: unknown) => { state.read(options); return { data: state.data, isError: state.isError, refetch: state.refetch }; },
}));
vi.mock('next/dynamic', () => ({ default: () => function Dynamic(props: { value?: string; onSent?: () => void; onBusyChange?: (busy: boolean) => void }) {
  const isFund = !props.value;
  useEffect(() => { if (isFund) { state.mount(); return () => { state.unmount(); }; } }, [isFund]);
  if (props.value) return <svg data-value={props.value} />;
  state.fund(props);
  return <button type="button" onClick={props.onSent}>Mock funding confirmed</button>;
} }));
beforeEach(() => { window.localStorage.clear(); window.history.replaceState(null, '', '/'); state.query = ''; state.data = undefined; state.isError = false; state.connected = false; vi.clearAllMocks(); });

describe('AgentWalletCard', () => {
  it.each(['ja', 'en'])('shows a slim empty form and hides a valid address until Change in %s', (locale) => {
    const c = agentPageContentFor(locale).wallet;
    const empty = render(<AgentWalletCard c={c} />);
    expect(screen.getByRole('heading', { name: c.title })).toBeVisible();
    expect(screen.getByText(c.lead)).toBeVisible();
    expect(screen.getByRole('textbox', { name: c.inputLabel })).toBeVisible();
    expect(screen.queryByRole('button', { name: c.useConnected })).toBeNull();
    expect(screen.getByText(c.ownershipNote)).toBeVisible();
    empty.unmount();
    state.query = `address=${address}`;
    render(<AgentWalletCard c={c} />);
    expect(screen.getByLabelText(c.inputLabel)).not.toBeVisible();
    const change = screen.getByRole('button', { name: c.changeAddress });
    expect(change).toHaveAttribute('aria-expanded', 'false');
    expect(change).toHaveAttribute('aria-controls', 'agent-wallet-input');
    fireEvent.click(change);
    expect(change).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText(c.inputLabel)).toBeVisible();
    fireEvent.click(change);
    expect(screen.getByLabelText(c.inputLabel)).not.toBeVisible();
    fireEvent.click(change);
    fireEvent.change(screen.getByLabelText(c.inputLabel), { target: { value: 'invalid' } });
    expect(screen.getByRole('textbox', { name: c.inputLabel })).toBeVisible();
    expect(screen.getByText(c.invalidAddress)).toBeVisible();
  });
  it('keeps funding mounted across toggles and empty, invalid and valid address edits', () => {
    const { container } = render(<AgentWalletCard c={C} />);
    const panel = container.querySelector('#agent-fund');
    expect(panel).not.toBeVisible();
    expect(state.mount).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText(C.inputLabel), { target: { value: address } });
    expect(panel).not.toBeVisible();
    const toggle = screen.getByRole('button', { name: C.fundCta });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(panel).toBeVisible();
    expect(toggle).toHaveAccessibleName(C.closeFund);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(panel).not.toBeVisible();
    fireEvent.click(toggle);
    expect(panel).toBeVisible();
    for (const value of ['', 'invalid', '0x2222222222222222222222222222222222222222']) {
      fireEvent.change(screen.getByLabelText(C.inputLabel), { target: { value } });
      expect(state.mount).toHaveBeenCalledTimes(1);
      expect(state.unmount).not.toHaveBeenCalled();
    }
    expect(panel).toBeVisible();
  });
  it.each(['query', 'saved'])('opens a direct funding anchor with a %s address', (source) => {
    window.history.replaceState(null, '', '/#agent-fund');
    if (source === 'query') state.query = `address=${address}`;
    else window.localStorage.setItem('openpay.agent.address', address);
    const { container } = render(<AgentWalletCard c={C} />);
    expect(container.querySelector('#agent-fund')).toBeVisible();
    expect(screen.getByRole('button', { name: C.closeFund })).toHaveAttribute('aria-expanded', 'true');
  });
  it('opens on hashchange and retains a pending anchor until an address is entered', () => {
    const { container } = render(<AgentWalletCard c={C} />);
    act(() => {
      window.history.replaceState(null, '', '/#agent-fund');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(container.querySelector('#agent-fund')).not.toBeVisible();
    fireEvent.change(screen.getByLabelText(C.inputLabel), { target: { value: address } });
    expect(container.querySelector('#agent-fund')).toBeVisible();
  });
  it('prefers the URL address to the saved address', () => {
    state.query = `address=${address}`;
    window.localStorage.setItem('openpay.agent.address', '0x2222222222222222222222222222222222222222');
    render(<AgentWalletCard c={C} />);
    expect(screen.getByLabelText(C.inputLabel)).toHaveValue(address);
    expect(window.localStorage.getItem('openpay.agent.address')).toBe(address);
  });
  it('disables closing while busy and preserves the mounted recipient through edits', () => {
    state.query = `address=${address}`;
    const { container } = render(<AgentWalletCard c={C} />);
    fireEvent.click(screen.getByRole('button', { name: C.fundCta }));
    act(() => state.fund.mock.calls.at(-1)?.[0].onBusyChange(true));
    const close = screen.getByRole('button', { name: C.closeFund });
    expect(close).toBeDisabled();
    fireEvent.click(close);
    fireEvent.click(screen.getByRole('button', { name: C.changeAddress }));
    fireEvent.change(screen.getByLabelText(C.inputLabel), { target: { value: '' } });
    expect(container.querySelector('#agent-fund')).toBeVisible();
    const next = '0x2222222222222222222222222222222222222222';
    fireEvent.change(screen.getByLabelText(C.inputLabel), { target: { value: next } });
    expect(screen.getByRole('button', { name: C.closeFund })).toBeDisabled();
    expect(state.fund).toHaveBeenLastCalledWith(expect.objectContaining({ agentAddress: address }));
    act(() => state.fund.mock.calls.at(-1)?.[0].onBusyChange(false));
    expect(screen.getByRole('button', { name: C.closeFund })).toBeEnabled();
    expect(state.fund).toHaveBeenLastCalledWith(expect.objectContaining({ agentAddress: next }));
    expect(state.mount).toHaveBeenCalledTimes(1);
    expect(state.unmount).not.toHaveBeenCalled();
  });
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
  // 残高は数値そのものが事実。「残高あり/なし」の言い換え行は引き算した (P1)。
  it.each([[0n, '0'], [10n ** 18n, '1']] as const)('shows factual balance %s', (data, label) => {
    state.query = `address=${address}`;
    state.data = data;
    const { container } = render(<AgentWalletCard c={C} />);
    const deployment = defaultDeploymentForSymbol('jpyc');
    expect(state.read).toHaveBeenLastCalledWith(expect.objectContaining({ address: deployment.address, chainId: deployment.chainId, args: [address], query: { enabled: true } }));
    expect(screen.getByRole('status')).toHaveTextContent(new RegExp(`^${label}\\s*JPYC$`));
    expect(container.textContent).not.toMatch(/Holds JPYC|No JPYC/);
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
    fireEvent.click(screen.getByRole('button', { name: C.changeAddress }));
    fireEvent.change(screen.getByLabelText('Agent wallet address'), { target: { value: '0x' } });
    expect(state.read).toHaveBeenLastCalledWith(expect.objectContaining({ args: undefined, query: { enabled: false } }));
  });
  it('remembers a valid public address on this device and restores it on the next visit', () => {
    const first = render(<AgentWalletCard c={C} />);
    fireEvent.change(screen.getByLabelText('Agent wallet address'), { target: { value: address } });
    expect(window.localStorage.getItem('openpay.agent.address')).toBe(address);
    expect(screen.getByRole('button', { name: 'Add funds' })).toHaveAttribute('aria-controls', 'agent-fund');
    expect(screen.getByRole('link', { name: 'Connect agent' })).toHaveAttribute('href', '#agent-connect');
    first.unmount();
    render(<AgentWalletCard c={C} />);
    expect(screen.getByLabelText('Agent wallet address')).toHaveValue(address);
  });
  it('passes the funding copy, locale and address inside the funding block and refreshes on confirmation', () => {
    state.query = `address=${address}`;
    render(<AgentWalletCard c={C} />);
    expect(state.fund).toHaveBeenLastCalledWith(expect.objectContaining({ locale: 'en', c: C.fundFromWallet, agentAddress: address }));
    fireEvent.click(screen.getByRole('button', { name: C.fundCta }));
    const button = screen.getByRole('button', { name: 'Mock funding confirmed' });
    expect(button.closest('#agent-fund')).not.toBeNull();
    expect(state.refetch).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(state.refetch).toHaveBeenCalledTimes(1);
  });
});
