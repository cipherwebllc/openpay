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
const injected = (uid: string, name: string) => ({
  uid, name, type: 'injected',
  getProvider: () => Promise.resolve({}),
});

/** injected コネクタ mock (provider なし — モバイル等) */
const injectedNoProvider = (uid: string, name: string) => ({
  uid, name, type: 'injected',
  getProvider: () => Promise.reject(new Error('not found')),
});

/** non-injected コネクタ mock */
const other = (uid: string, name: string) => ({
  uid, name, type: 'walletConnect',
  getProvider: () => Promise.resolve({}),
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ConnectButton (disconnected)', () => {
  it('provider ありの connectors を全件レンダリング、クリックで connect が呼ばれる', async () => {
    const user = userEvent.setup();
    const connect = vi.fn();
    mockHook(useAccount, { isConnected: false, address: undefined });
    mockHook(useConnect, {
      connectors: [
        injected('1', 'MetaMask'),
        other('2', 'Coinbase Wallet'),
        other('3', 'WalletConnect'),
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
    expect(screen.getByRole('button', { name: 'Coinbase Wallet' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'WalletConnect' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'MetaMask' }));
    expect(connect).toHaveBeenCalledOnce();
    expect(connect.mock.calls[0][0].connector.name).toBe('MetaMask');
  });

  it('isPending 中は全ボタン disabled', async () => {
    mockHook(useAccount, { isConnected: false, address: undefined });
    mockHook(useConnect, {
      connectors: [injected('1', 'MetaMask')],
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
      error: { name: 'Error', message: 'Something went wrong' } as ConnectErrorType,
    });
    mockHook(useDisconnect, { disconnect: vi.fn() });

    render(<ConnectButton />);
    expect(screen.getByText(/Something went wrong/)).toBeInTheDocument();
  });

  it('User rejected / Connection request reset はエラー非表示', () => {
    mockHook(useAccount, { isConnected: false, address: undefined });
    mockHook(useConnect, {
      connectors: [],
      connect: vi.fn(),
      isPending: false,
      error: { name: 'Error', message: 'User rejected the request. Details: Connection request reset.' } as ConnectErrorType,
    });
    mockHook(useDisconnect, { disconnect: vi.fn() });

    render(<ConnectButton />);
    expect(screen.queryByText(/User rejected/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Connection request reset/)).not.toBeInTheDocument();
  });

  it('provider が無い injected コネクタはモバイル等で非表示', async () => {
    mockHook(useAccount, { isConnected: false, address: undefined });
    mockHook(useConnect, {
      connectors: [
        injectedNoProvider('1', 'Injected'),
        injectedNoProvider('2', 'Rabby Wallet'),
        other('3', 'Coinbase Wallet'),
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

  it('getProvider が null を resolve する injected コネクタも非表示', async () => {
    const nullProvider = (uid: string, name: string) => ({
      uid, name, type: 'injected',
      getProvider: () => Promise.resolve(null),
    });
    mockHook(useAccount, { isConnected: false, address: undefined });
    mockHook(useConnect, {
      connectors: [
        nullProvider('1', 'Injected'),
        other('2', 'WalletConnect'),
      ],
      connect: vi.fn(),
      isPending: false,
      error: null,
    });
    mockHook(useDisconnect, { disconnect: vi.fn() });

    render(<ConnectButton />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'WalletConnect' })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Injected' })).not.toBeInTheDocument();
  });

  it('connectors が空の場合はボタンなし', async () => {
    mockHook(useAccount, { isConnected: false, address: undefined });
    mockHook(useConnect, {
      connectors: [],
      connect: vi.fn(),
      isPending: false,
      error: null,
    });
    mockHook(useDisconnect, { disconnect: vi.fn() });

    render(<ConnectButton />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('ウォレット未検出 (provider 全滅) → 検出確定後に案内 + MetaMask で開く リンク', async () => {
    mockHook(useAccount, { isConnected: false, address: undefined });
    mockHook(useConnect, {
      connectors: [injectedNoProvider('1', 'Injected')],
      connect: vi.fn(),
      isPending: false,
      error: null,
    });
    mockHook(useDisconnect, { disconnect: vi.fn() });

    render(<ConnectButton />);
    // probe 確定 (短い猶予) 後に未検出案内が出る (検出中のチラつき防止)。
    expect(
      await screen.findByText(/ウォレットが見つかりません/, undefined, {
        timeout: 2000,
      }),
    ).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /MetaMask で開く/ });
    expect(link.getAttribute('href')).toContain('metamask.app.link');
  });

  it('同名 connector の重複は排除される', async () => {
    mockHook(useAccount, { isConnected: false, address: undefined });
    mockHook(useConnect, {
      connectors: [
        injected('1', 'Rabby Wallet'),
        injected('2', 'Rabby Wallet'),
        injected('3', 'MetaMask'),
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

  it('chain が undefined でもクラッシュしない (chain 名は非表示)', () => {
    mockHook(useAccount, {
      isConnected: true,
      address: ADDR,
      chain: undefined,
    });
    mockHook(useConnect, {
      connectors: [],
      connect: vi.fn(),
      isPending: false,
      error: null,
    });
    mockHook(useDisconnect, { disconnect: vi.fn() });

    render(<ConnectButton />);
    expect(screen.getByText(/0x1234…5678/)).toBeInTheDocument();
    expect(screen.queryByText(/\//)).not.toBeInTheDocument();
  });
});
