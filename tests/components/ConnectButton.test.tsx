import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
import userEvent from '@testing-library/user-event';

vi.mock('wagmi', () => ({
  useAccount: vi.fn(),
  useConnect: vi.fn(),
  useDisconnect: vi.fn(),
}));

import { useAccount, useConnect, useDisconnect } from 'wagmi';
import type { ConnectErrorType } from '@wagmi/core';
import { ConnectButton } from '@/components/ConnectButton';
import { mockHook } from '../_helpers/wagmiMock';

const ADDR = '0x1234567890aBcdef1234567890ABCDEF12345678';

/** injected コネクタ mock (provider あり) */
function injectedConnector(uid: string, name: string) {
  return { uid, name, type: 'injected', getProvider: () => Promise.resolve({}) };
}

/** injected コネクタ mock (provider なし — モバイル等) */
function injectedConnectorNoProvider(uid: string, name: string) {
  return { uid, name, type: 'injected', getProvider: () => Promise.reject(new Error('not found')) };
}

/** non-injected コネクタ mock (WalletConnect, Coinbase 等) */
function otherConnector(uid: string, name: string) {
  return { uid, name, type: 'walletConnect', getProvider: () => Promise.resolve({}) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ConnectButton (disconnected)', () => {
  it('connectors を全件レンダリング、クリックで connect が呼ばれる', async () => {
    const user = userEvent.setup();
    const connect = vi.fn();
    mockHook(useAccount, { isConnected: false, address: undefined });
    mockHook(useConnect, {
      connectors: [
        injectedConnector('1', 'MetaMask'),
        otherConnector('2', 'Coinbase Wallet'),
        otherConnector('3', 'WalletConnect'),
      ],
      connect,
      isPending: false,
      error: null,
    });
    mockHook(useDisconnect, { disconnect: vi.fn() });

    render(<ConnectButton />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'MetaMask' })).toBeInTheDocument();
    });
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

  it('isPending 中は全ボタン disabled', async () => {
    mockHook(useAccount, { isConnected: false, address: undefined });
    mockHook(useConnect, {
      connectors: [injectedConnector('1', 'MetaMask')],
      connect: vi.fn(),
      isPending: true,
      error: null,
    });
    mockHook(useDisconnect, { disconnect: vi.fn() });

    render(<ConnectButton />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'MetaMask' })).toBeDisabled();
    });
  });

  it('error 状態 → エラーメッセージ表示', () => {
    mockHook(useAccount, { isConnected: false, address: undefined });
    mockHook(useConnect, {
      connectors: [],
      connect: vi.fn(),
      isPending: false,
      // wagmi の ConnectErrorType は narrow union (literal name 等) で
      // 標準 Error と shape が一致しないため、テスト用に最小要素のみ与える
      error: { name: 'Error', message: 'User rejected' } as ConnectErrorType,
    });
    mockHook(useDisconnect, { disconnect: vi.fn() });

    render(<ConnectButton />);
    expect(screen.getByText(/User rejected/)).toBeInTheDocument();
  });
});

describe('ConnectButton (provider filtering)', () => {
  it('provider が無い injected コネクタはモバイル等で非表示', async () => {
    mockHook(useAccount, { isConnected: false, address: undefined });
    mockHook(useConnect, {
      connectors: [
        injectedConnectorNoProvider('1', 'Injected'),
        injectedConnectorNoProvider('2', 'Rabby Wallet'),
        otherConnector('3', 'Coinbase Wallet'),
      ],
      connect: vi.fn(),
      isPending: false,
      error: null,
    });
    mockHook(useDisconnect, { disconnect: vi.fn() });

    render(<ConnectButton />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Coinbase Wallet' })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Injected' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rabby Wallet' })).not.toBeInTheDocument();
  });
});

describe('ConnectButton (deduplication)', () => {
  it('同じ name の connector が複数あっても 1 つだけ表示される', async () => {
    mockHook(useAccount, { isConnected: false, address: undefined });
    mockHook(useConnect, {
      connectors: [
        injectedConnector('1', 'Rabby Wallet'),
        injectedConnector('2', 'Rabby Wallet'),
        injectedConnector('3', 'MetaMask'),
      ],
      connect: vi.fn(),
      isPending: false,
      error: null,
    });
    mockHook(useDisconnect, { disconnect: vi.fn() });

    render(<ConnectButton />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'MetaMask' })).toBeInTheDocument();
    });
    const rabbyButtons = screen.getAllByRole('button', { name: 'Rabby Wallet' });
    expect(rabbyButtons).toHaveLength(1);
  });
});

describe('ConnectButton (connected)', () => {
  it('短縮アドレス + chain 名 + 切断ボタン', async () => {
    const user = userEvent.setup();
    const disconnect = vi.fn();
    mockHook(useAccount, {
      isConnected: true,
      address: ADDR,
      chain: { name: 'Base Sepolia' },
    });
    mockHook(useConnect, {
      connectors: [],
      connect: vi.fn(),
      isPending: false,
      error: null,
    });
    mockHook(useDisconnect, { disconnect });

    render(<ConnectButton />);
    expect(screen.getByText(/0x1234…5678/)).toBeInTheDocument();
    expect(screen.getByText(/Base Sepolia/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '切断' }));
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
