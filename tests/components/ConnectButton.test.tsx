import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('wagmi', () => ({
  useAccount: vi.fn(),
  useConnect: vi.fn(),
  useDisconnect: vi.fn(),
}));

import { useAccount, useConnect, useDisconnect } from 'wagmi';
import { ConnectButton } from '@/components/ConnectButton';

const ADDR = '0x1234567890aBcdef1234567890ABCDEF12345678';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ConnectButton (disconnected)', () => {
  it('connectors を全件レンダリング、クリックで connect が呼ばれる', async () => {
    const user = userEvent.setup();
    const connect = vi.fn();
    vi.mocked(useAccount).mockReturnValue({
      isConnected: false,
      address: undefined,
    } as never);
    vi.mocked(useConnect).mockReturnValue({
      connectors: [
        { uid: '1', name: 'MetaMask' },
        { uid: '2', name: 'Coinbase Wallet' },
        { uid: '3', name: 'WalletConnect' },
      ],
      connect,
      isPending: false,
      error: null,
    } as never);
    vi.mocked(useDisconnect).mockReturnValue({ disconnect: vi.fn() } as never);

    render(<ConnectButton />);
    expect(screen.getByRole('button', { name: 'MetaMask' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Coinbase Wallet' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'WalletConnect' }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'MetaMask' }));
    expect(connect).toHaveBeenCalledOnce();
    expect(connect.mock.calls[0][0].connector.name).toBe('MetaMask');
  });

  it('isPending 中は全ボタン disabled', () => {
    vi.mocked(useAccount).mockReturnValue({
      isConnected: false,
      address: undefined,
    } as never);
    vi.mocked(useConnect).mockReturnValue({
      connectors: [{ uid: '1', name: 'MetaMask' }],
      connect: vi.fn(),
      isPending: true,
      error: null,
    } as never);
    vi.mocked(useDisconnect).mockReturnValue({ disconnect: vi.fn() } as never);

    render(<ConnectButton />);
    expect(screen.getByRole('button', { name: 'MetaMask' })).toBeDisabled();
  });

  it('error 状態 → エラーメッセージ表示', () => {
    vi.mocked(useAccount).mockReturnValue({
      isConnected: false,
      address: undefined,
    } as never);
    vi.mocked(useConnect).mockReturnValue({
      connectors: [],
      connect: vi.fn(),
      isPending: false,
      error: new Error('User rejected'),
    } as never);
    vi.mocked(useDisconnect).mockReturnValue({ disconnect: vi.fn() } as never);

    render(<ConnectButton />);
    expect(screen.getByText(/User rejected/)).toBeInTheDocument();
  });
});

describe('ConnectButton (connected)', () => {
  it('短縮アドレス + chain 名 + 切断ボタン', async () => {
    const user = userEvent.setup();
    const disconnect = vi.fn();
    vi.mocked(useAccount).mockReturnValue({
      isConnected: true,
      address: ADDR,
      chain: { name: 'Base Sepolia' },
    } as never);
    vi.mocked(useConnect).mockReturnValue({
      connectors: [],
      connect: vi.fn(),
      isPending: false,
      error: null,
    } as never);
    vi.mocked(useDisconnect).mockReturnValue({ disconnect } as never);

    render(<ConnectButton />);
    // 0x1234…5678 のように省略表示
    expect(screen.getByText(/0x1234…5678/)).toBeInTheDocument();
    expect(screen.getByText(/Base Sepolia/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '切断' }));
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
