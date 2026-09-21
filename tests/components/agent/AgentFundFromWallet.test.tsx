import { StrictMode, type ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { track } from '@vercel/analytics';
import { erc20Abi, maxUint256, parseUnits, type Address, type Hash } from 'viem';
import type { AgentActivity } from '@/components/agent/AgentActivity';
import { AgentWalletCard } from '@/components/agent/AgentWalletCard';
import { AgentFundFromWallet } from '@/components/agent/AgentFundFromWallet';
import { agentPageContentFor } from '@/lib/agentPage';
import { chainNameForId, txExplorerUrl } from '@/lib/chains';
import { defaultDeploymentForSymbol } from '@/lib/tokens';

const state = vi.hoisted(() => ({
  address: undefined as Address | undefined,
  connected: true,
  chainId: 0,
  balance: undefined as bigint | undefined,
  balanceError: false,
  hash: undefined as Hash | undefined,
  writePending: false,
  writeError: null as Error | null,
  switchPending: false,
  switchError: null as Error | null,
  receiptSuccess: false,
  receiptError: false,
  receiptStatus: undefined as 'success' | 'reverted' | undefined,
  read: vi.fn(),
  wait: vi.fn(),
  write: vi.fn(),
  switchChain: vi.fn(),
  resetWrite: vi.fn(),
  resetSwitch: vi.fn(),
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: state.address, isConnected: state.connected, chainId: state.chainId }),
  useReadContract: (options: unknown) => {
    state.read(options);
    return { data: state.balance, isError: state.balanceError, refetch: vi.fn() };
  },
  useWriteContract: () => ({ writeContract: state.write, data: state.hash, isPending: state.writePending, error: state.writeError, reset: state.resetWrite }),
  useSwitchChain: () => ({ switchChain: state.switchChain, isPending: state.switchPending, error: state.switchError, reset: state.resetSwitch }),
  useWaitForTransactionReceipt: (options: unknown) => {
    state.wait(options);
    return { isSuccess: state.receiptSuccess, isError: state.receiptError, data: state.receiptStatus ? { status: state.receiptStatus } : undefined };
  },
}));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('address=0xabcdefabcdefabcdefabcdefabcdefabcdefabcd') }));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('next/dynamic', () => ({ default: () => function Dynamic(props: ComponentProps<typeof AgentFundFromWallet> | ComponentProps<typeof AgentActivity> | { value: string }) {
  if ('refreshKey' in props) return <h3>{props.c.title}</h3>;
  return 'value' in props ? <svg data-value={props.value} /> : <AgentFundFromWallet {...props} />;
} }));
vi.mock('@vercel/analytics', () => ({ track: vi.fn() }));

const C = agentPageContentFor('en').wallet.fundFromWallet;
const deployment = defaultDeploymentForSymbol('jpyc');
const sender: Address = '0x1111111111111111111111111111111111111111';
const agentAddress: Address = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const hash: Hash = `0x${'a'.repeat(64)}`;
const onSent = vi.fn();

function ui(locale = 'en', recipient = agentAddress, sent: () => void = onSent) {
  return <AgentFundFromWallet locale={locale} c={agentPageContentFor(locale).wallet.fundFromWallet} agentAddress={recipient} onSent={sent} />;
}

function reviewAmount(value = '12.5') {
  fireEvent.change(screen.getByLabelText(C.amountLabel), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: C.send }));
}

function sendAmount() {
  reviewAmount();
  fireEvent.click(screen.getByRole('button', { name: C.confirmSend }));
}

function settleWrite() {
  act(() => state.write.mock.calls.at(-1)?.[1].onSettled());
}

beforeEach(() => {
  vi.clearAllMocks();
  state.address = sender;
  state.connected = true;
  state.chainId = deployment.chainId;
  state.balance = parseUnits('100', deployment.decimals);
  state.balanceError = false;
  state.hash = undefined;
  state.writePending = false;
  state.writeError = null;
  state.switchPending = false;
  state.switchError = null;
  state.receiptSuccess = false;
  state.receiptError = false;
  state.receiptStatus = undefined;
});

describe('AgentFundFromWallet', () => {
  it.each(['success', 'reverted', 'rpc-error'] as const)('reports busy from submission through the %s receipt outcome', (outcome) => {
    const busy = vi.fn();
    const element = <AgentFundFromWallet locale="en" c={C} agentAddress={agentAddress} onSent={onSent} onBusyChange={busy} />;
    const { rerender } = render(element);
    expect(busy).toHaveBeenLastCalledWith(false);
    sendAmount();
    expect(busy).toHaveBeenLastCalledWith(true);
    busy.mockClear();
    state.hash = hash;
    settleWrite();
    rerender(<AgentFundFromWallet locale="en" c={C} agentAddress={agentAddress} onSent={onSent} onBusyChange={busy} />);
    expect(busy).not.toHaveBeenCalled();
    state.receiptSuccess = outcome !== 'rpc-error';
    state.receiptStatus = outcome === 'rpc-error' ? undefined : outcome;
    state.receiptError = outcome === 'rpc-error';
    rerender(<AgentFundFromWallet locale="en" c={C} agentAddress={agentAddress} onSent={onSent} onBusyChange={busy} />);
    if (outcome === 'rpc-error') {
      expect(busy).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: C.back })).toBeDisabled();
    } else {
      expect(busy).toHaveBeenLastCalledWith(false);
      expect(screen.getByRole('button', { name: C.back })).toBeEnabled();
    }
    expect(screen.getByRole('button', { name: C.confirmSend })).toBeDisabled();
  });

  it('keeps the real funding form locked across parent edits, unknown receipts and reopening after confirmation', () => {
    const wallet = agentPageContentFor('en').wallet;
    const { container, rerender } = render(<AgentWalletCard c={wallet} activity={agentPageContentFor('en').activity} />);
    // `?address=` 付きの着地 (MCP の入金リンク) は入金パネルが開いた状態で始まる。
    expect(container.querySelector('#agent-fund')).toBeVisible();
    sendAmount();
    expect(screen.getByRole('button', { name: wallet.closeFund })).toBeDisabled();
    state.hash = hash;
    settleWrite();
    state.receiptError = true;
    rerender(<AgentWalletCard c={wallet} activity={agentPageContentFor('en').activity} />);
    fireEvent.click(screen.getByRole('button', { name: wallet.changeAddress }));
    for (const value of ['', 'invalid', sender, agentAddress]) {
      fireEvent.change(screen.getByLabelText(wallet.inputLabel), { target: { value } });
      expect(container.querySelector('#agent-fund')).toBeVisible();
      expect(screen.getByRole('button', { name: C.confirmSend })).toBeDisabled();
      expect(screen.getByRole('button', { name: C.back })).toBeDisabled();
      expect(screen.getByRole('link', { name: `${C.viewTx}: ${hash}` })).toBeVisible();
    }
    expect(screen.getByRole('button', { name: wallet.closeFund })).toBeDisabled();
    state.receiptError = false;
    state.receiptSuccess = true;
    state.receiptStatus = 'success';
    rerender(<AgentWalletCard c={wallet} activity={agentPageContentFor('en').activity} />);
    expect(screen.getByRole('button', { name: wallet.closeFund })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: wallet.closeFund }));
    expect(container.querySelector('#agent-fund')).not.toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: wallet.fundCta }));
    expect(screen.getByRole('button', { name: C.confirmSend })).toBeDisabled();
    expect(screen.getByRole('link', { name: `${C.viewTx}: ${hash}` })).toBeVisible();
    expect(state.write).toHaveBeenCalledTimes(1);
  });

  it('renders nothing and disables balance reads while disconnected', () => {
    state.connected = false;
    state.address = undefined;
    const { container } = render(ui());
    expect(container).toBeEmptyDOMElement();
    expect(state.read).toHaveBeenLastCalledWith(expect.objectContaining({ args: undefined, query: { enabled: false } }));
    expect(state.switchChain).not.toHaveBeenCalled();
    expect(state.write).not.toHaveBeenCalled();
  });

  it('shows only the same-wallet note, comparing addresses without case', () => {
    state.address = `0x${agentAddress.slice(2).toUpperCase()}`;
    render(ui());
    expect(screen.getByText(C.sameWalletNote)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(state.read).toHaveBeenLastCalledWith(expect.objectContaining({ query: { enabled: false } }));
  });

  it.each(['', '0', '-1', 'abc', '1e3', '1,000', '1.2.3', '0.0000000000000000001', '1.1234567890123456789', (maxUint256 + 1n).toString()])('blocks invalid amount %s with an accessible error', (value) => {
    render(ui());
    const input = screen.getByLabelText(C.amountLabel);
    fireEvent.change(input, { target: { value } });
    expect(screen.getByRole('button', { name: C.send })).toBeDisabled();
    if (value) {
      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(input).toHaveAccessibleDescription(C.invalidAmount);
    }
    fireEvent.click(screen.getByRole('button', { name: C.send }));
    expect(screen.queryByText(C.confirmTitle)).toBeNull();
    expect(state.write).not.toHaveBeenCalled();
  });

  it('reads the sender balance on the deployment chain and blocks insufficient funds', () => {
    render(ui());
    expect(state.read).toHaveBeenLastCalledWith({ abi: erc20Abi, address: deployment.address, chainId: deployment.chainId, functionName: 'balanceOf', args: [sender], query: { enabled: true } });
    reviewAmount('100.000000000000000001');
    expect(screen.getByLabelText(C.amountLabel)).toHaveAccessibleDescription(C.insufficient);
    expect(screen.getByRole('button', { name: C.send })).toBeDisabled();
    expect(screen.queryByText(C.confirmTitle)).toBeNull();
  });

  it.each([false, true])('blocks sending when balance is unavailable (error: %s)', (isError) => {
    state.balance = undefined;
    state.balanceError = isError;
    render(ui());
    reviewAmount();
    expect(screen.getByRole('button', { name: C.send })).toBeDisabled();
    expect(state.write).not.toHaveBeenCalled();
    if (isError) expect(screen.getByRole('status')).toHaveTextContent(C.failed);
  });

  it.each(['12.5', '0.000000000000000001', '100'])('requires two clicks and sends exactly %s JPYC once', (value) => {
    const { container } = render(ui());
    expect(screen.getByText(C.gasNote)).toBeInTheDocument();
    reviewAmount(value);
    expect(state.write).not.toHaveBeenCalled();
    expect(screen.getByText(C.confirmTitle)).toBeInTheDocument();
    expect(screen.getByText(agentAddress)).toBeInTheDocument();
    expect(screen.getByText(`${value} JPYC`)).toBeInTheDocument();
    expect(screen.getByText(chainNameForId(deployment.chainId)!)).toBeInTheDocument();
    expect(screen.getByText(C.irreversible)).toBeInTheDocument();
    expect(screen.getByText(C.ownershipWarning)).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: C.confirmSend });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(state.write).toHaveBeenCalledTimes(1);
    expect(state.write).toHaveBeenCalledWith({ abi: erc20Abi, address: deployment.address, chainId: deployment.chainId, account: sender, functionName: 'transfer', args: [agentAddress, parseUnits(value, 18)] }, expect.objectContaining({ onSettled: expect.any(Function) }));
    expect(screen.getByRole('status')).toHaveTextContent(C.waitingWallet);
    expect(confirm).toBeDisabled();
    expect(screen.getByRole('button', { name: C.back })).toBeDisabled();
    expect(container.querySelector('a[href*="/pay"]')).toBeNull();
    expect(onSent).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  it('returns to editing without submitting', () => {
    render(ui());
    reviewAmount();
    fireEvent.click(screen.getByRole('button', { name: C.back }));
    expect(screen.getByLabelText(C.amountLabel)).toHaveValue('12.5');
    expect(state.write).not.toHaveBeenCalled();
  });

  it('switches chains only when opening the review, and waits for a separate final confirmation', () => {
    state.chainId = deployment.chainId + 1;
    const { rerender } = render(ui());
    expect(state.switchChain).not.toHaveBeenCalled();
    reviewAmount();
    expect(state.switchChain).toHaveBeenCalledTimes(1);
    expect(state.switchChain).toHaveBeenCalledWith({ chainId: deployment.chainId });
    expect(screen.getByRole('button', { name: C.confirmSend })).toBeDisabled();
    expect(state.write).not.toHaveBeenCalled();
    state.switchPending = true;
    rerender(ui());
    expect(screen.getByRole('status')).toHaveTextContent(C.waitingWallet);
    state.switchPending = false;
    state.chainId = deployment.chainId;
    rerender(ui());
    expect(state.write).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: C.confirmSend }));
    expect(state.write).toHaveBeenCalledTimes(1);
  });

  it('reports rejected chain switches without submitting', () => {
    state.chainId = deployment.chainId + 1;
    const { rerender } = render(ui());
    reviewAmount();
    state.switchError = new Error('User rejected the request.');
    rerender(ui());
    expect(screen.getByRole('status')).toHaveTextContent(C.rejected);
    expect(screen.queryByText(C.confirmed)).toBeNull();
    expect(state.write).not.toHaveBeenCalled();
  });

  it.each(['sender', 'recipient', 'balance', 'chain'])('requires valid, current confirmation after the %s changes', (change) => {
    const { rerender } = render(ui());
    reviewAmount();
    if (change === 'sender') state.address = '0x2222222222222222222222222222222222222222';
    if (change === 'balance') state.balance = 0n;
    if (change === 'chain') state.chainId += 1;
    rerender(ui('en', change === 'recipient' ? '0x3333333333333333333333333333333333333333' : agentAddress));
    const confirm = screen.queryByRole('button', { name: C.confirmSend });
    if (confirm) {
      expect(confirm).toBeDisabled();
      fireEvent.click(confirm);
    }
    expect(state.write).not.toHaveBeenCalled();
  });

  it.each([['User rejected the request.', 'rejected'], ['RPC unavailable', 'failed']] as const)('reports a wallet error (%s) without success or analytics', (message, key) => {
    const { rerender } = render(ui());
    sendAmount();
    state.writeError = new Error(message);
    settleWrite();
    rerender(ui());
    expect(screen.getByRole('status')).toHaveTextContent(C[key]);
    expect(screen.queryByText(C.sent)).toBeNull();
    expect(screen.queryByText(C.confirmed)).toBeNull();
    expect(onSent).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  it('links the broadcast hash and stays locked until the receipt succeeds', () => {
    const { container, rerender } = render(ui());
    sendAmount();
    state.hash = hash;
    settleWrite();
    rerender(ui());
    expect(state.wait).toHaveBeenLastCalledWith(expect.objectContaining({ hash, chainId: deployment.chainId }));
    expect(screen.getByRole('status')).toHaveTextContent(C.sent);
    expect(screen.getByRole('link', { name: `${C.viewTx}: ${hash}` })).toHaveAttribute('href', txExplorerUrl(deployment.chainId, hash));
    expect(screen.getByRole('button', { name: C.confirmSend })).toBeDisabled();
    expect(container.querySelector('a[href*="/pay"]')).toBeNull();
    expect(onSent).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  it('lets the user return to the form only after the transfer settled, never while its outcome is unknown', () => {
    const { rerender } = render(ui());
    sendAmount();
    state.hash = hash;
    settleWrite();
    rerender(ui());
    expect(screen.getByRole('button', { name: C.back })).toBeDisabled(); // broadcast, no receipt yet
    state.receiptError = true; // receipt lookup failed: the transfer may still have landed
    rerender(ui());
    expect(screen.getByRole('button', { name: C.back })).toBeDisabled();
    state.receiptError = false;
    state.receiptSuccess = true;
    state.receiptStatus = 'success';
    rerender(ui());
    expect(screen.getByRole('status')).toHaveTextContent(C.confirmed);
    expect(screen.getByRole('button', { name: C.back })).toBeEnabled();
  });

  it.each(['reverted', 'rpc-error'])('does not confirm or offer duplicate sending after %s', (failure) => {
    const { rerender } = render(ui());
    sendAmount();
    state.hash = hash;
    state.receiptSuccess = failure === 'reverted';
    state.receiptStatus = failure === 'reverted' ? 'reverted' : undefined;
    state.receiptError = failure === 'rpc-error';
    settleWrite();
    rerender(ui());
    expect(screen.getByRole('status')).toHaveTextContent(C.failed);
    expect(screen.queryByText(C.confirmed)).toBeNull();
    expect(screen.getByRole('button', { name: C.confirmSend })).toBeDisabled();
    expect(onSent).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  it.each(['ja', 'en'])('notifies and tracks only the locale once after a successful receipt in %s', (locale) => {
    const c = agentPageContentFor(locale).wallet.fundFromWallet;
    const { rerender } = render(<StrictMode>{ui(locale)}</StrictMode>);
    fireEvent.change(screen.getByLabelText(c.amountLabel), { target: { value: '12.5' } });
    fireEvent.click(screen.getByRole('button', { name: c.send }));
    fireEvent.click(screen.getByRole('button', { name: c.confirmSend }));
    state.hash = hash;
    settleWrite();
    state.receiptSuccess = true;
    rerender(<StrictMode>{ui(locale)}</StrictMode>);
    expect(onSent).not.toHaveBeenCalled();
    state.receiptStatus = 'success';
    rerender(<StrictMode>{ui(locale)}</StrictMode>);
    expect(screen.getByRole('status')).toHaveTextContent(c.confirmed);
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith('agent_fund_send', { locale });
    rerender(<StrictMode>{ui(locale, agentAddress, () => onSent())}</StrictMode>);
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledTimes(1);
  });

  it.each(['cancelled', 'replaced', 'repriced'])('handles a %s transaction without confusing cancellation with funding', (reason) => {
    const { rerender } = render(ui());
    sendAmount();
    state.hash = hash;
    settleWrite();
    const replacementHash = `0x${'b'.repeat(64)}`;
    act(() => state.wait.mock.calls.at(-1)?.[0].onReplaced({ reason, transactionReceipt: { transactionHash: replacementHash } }));
    state.receiptSuccess = true;
    state.receiptStatus = 'success';
    rerender(ui());
    expect(screen.getByRole('link', { name: `${C.viewTx}: ${replacementHash}` })).toHaveAttribute('href', txExplorerUrl(deployment.chainId, replacementHash));
    if (reason === 'repriced') {
      expect(screen.getByRole('status')).toHaveTextContent(C.confirmed);
      expect(onSent).toHaveBeenCalledTimes(1);
      expect(track).toHaveBeenCalledWith('agent_fund_send', { locale: 'en' });
    } else {
      expect(screen.getByRole('status')).toHaveTextContent(C.failed);
      expect(screen.queryByText(C.confirmed)).toBeNull();
      expect(onSent).not.toHaveBeenCalled();
      expect(track).not.toHaveBeenCalled();
    }
  });

  it('isolates analytics failure from the confirmed transfer and balance refresh', () => {
    const { rerender } = render(ui());
    sendAmount();
    state.hash = hash;
    state.receiptSuccess = true;
    state.receiptStatus = 'success';
    vi.mocked(track).mockImplementationOnce(() => { throw new Error('analytics unavailable'); });
    settleWrite();
    rerender(ui());
    expect(screen.getByRole('status')).toHaveTextContent(C.confirmed);
    expect(onSent).toHaveBeenCalledTimes(1);
  });
});
