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

// モバイル誘導テスト用の navigator stub。isMobilePlatform() は UA + maxTouchPoints を
// 見るので PwaInstallHint.test と同じ defineProperty 様式で差し替える。
function setUserAgent(ua: string) {
  Object.defineProperty(window.navigator, 'userAgent', {
    value: ua,
    configurable: true,
  });
}
function setMaxTouchPoints(n: number) {
  Object.defineProperty(window.navigator, 'maxTouchPoints', {
    value: n,
    configurable: true,
  });
}
const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)';

beforeEach(() => {
  vi.clearAllMocks();
  // 既定はデスクトップ Mac (maxTouchPoints=0) に倒す。各 test が必要なら上書きする。
  setUserAgent(DESKTOP_UA);
  setMaxTouchPoints(0);
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

  it('各ボタンにウォレットアイコン (EIP-6963 icon 優先・同梱 SVG マッピング・汎用 fallback)', async () => {
    const dataUri = 'data:image/svg+xml;base64,PHN2Zy8+';
    mockHook(useAccount, { isConnected: false, address: undefined });
    mockHook(useConnect, {
      connectors: [
        injected('1', 'MetaMask'),
        other('2', 'WalletConnect'),
        // EIP-6963 が provider 自身のアイコンを告知するケース → マッピングより優先
        { ...injected('3', 'Phantom'), icon: dataUri },
        injected('4', 'Unknown Wallet'),
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
    const iconSrc = (name: string) =>
      screen.getByRole('button', { name }).querySelector('img')?.getAttribute('src');
    expect(iconSrc('MetaMask')).toBe('/wallets/MetaMask.svg');
    expect(iconSrc('WalletConnect')).toBe('/wallets/walletConnectWallet.svg');
    expect(iconSrc('Phantom')).toBe(dataUri);
    expect(iconSrc('Unknown Wallet')).toBe('/wallets/injectedWallet.svg');
  });
});

describe('ConnectButton: MetaMask アプリ内ブラウザ誘導 (Blockaid 回避)', () => {
  it('モバイル + injected 無し (WC のみ) → 推奨バナーが接続ボタンより前に出る、WC は「別の方法」見出し下に残る', async () => {
    setUserAgent(IPHONE_UA);
    mockHook(useAccount, { isConnected: false, address: undefined });
    mockHook(useConnect, {
      connectors: [other('1', 'WalletConnect')],
      connect: vi.fn(),
      isPending: false,
      error: null,
    });
    mockHook(useDisconnect, { disconnect: vi.fn() });

    render(<ConnectButton />);

    // probeSettled (700ms) + isMobile effect 後に推奨バナーが出る。
    const recTitle = await screen.findByText(
      /MetaMask アプリで開くとスムーズです/,
      undefined,
      { timeout: 2000 },
    );
    expect(recTitle).toBeInTheDocument();
    expect(
      screen.getByText(/セキュリティ警告が出ずにそのままお支払いできます/),
    ).toBeInTheDocument();

    // 推奨 CTA は metamask.app.link を含むディープリンク。
    const link = screen.getByRole('link', { name: /MetaMask で開く/ });
    expect(link.getAttribute('href')).toContain('metamask.app.link');

    // WC ボタンは「または別の方法で接続」見出しの下に残る (選択肢を奪わない)。
    expect(screen.getByText(/または別の方法で接続/)).toBeInTheDocument();
    const wcButton = screen.getByRole('button', { name: 'WalletConnect' });
    expect(wcButton).toBeInTheDocument();

    // DOM 順序: 推奨バナー (link) が WC 接続ボタンより前に来る。
    expect(
      link.compareDocumentPosition(wcButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // 推奨が出るとき amber の noWallet 文面は二重表示しない。
    expect(screen.queryByText(/ウォレットが見つかりません/)).not.toBeInTheDocument();
  });

  it('injected が visible (MetaMask アプリ内ブラウザ相当) → 推奨バナーは出ない', async () => {
    setUserAgent(IPHONE_UA);
    mockHook(useAccount, { isConnected: false, address: undefined });
    mockHook(useConnect, {
      connectors: [injected('1', 'MetaMask'), other('2', 'WalletConnect')],
      connect: vi.fn(),
      isPending: false,
      error: null,
    });
    mockHook(useDisconnect, { disconnect: vi.fn() });

    render(<ConnectButton />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'MetaMask' })).toBeInTheDocument();
    });
    expect(
      screen.queryByText(/MetaMask アプリで開くとスムーズです/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/または別の方法で接続/)).not.toBeInTheDocument();
  });

  it('PC (Mac UA + maxTouchPoints=0) → injected 無くても推奨バナーは出ない', async () => {
    // beforeEach の既定 (DESKTOP_UA + 0) のまま。
    mockHook(useAccount, { isConnected: false, address: undefined });
    mockHook(useConnect, {
      connectors: [other('1', 'WalletConnect')],
      connect: vi.fn(),
      isPending: false,
      error: null,
    });
    mockHook(useDisconnect, { disconnect: vi.fn() });

    render(<ConnectButton />);
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'WalletConnect' }),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByText(/MetaMask アプリで開くとスムーズです/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/または別の方法で接続/)).not.toBeInTheDocument();
  });

  it('モバイル + コネクタ皆無 → 推奨バナーは出る (WC 見出しは出ない)', async () => {
    setUserAgent(IPHONE_UA);
    mockHook(useAccount, { isConnected: false, address: undefined });
    mockHook(useConnect, {
      connectors: [injectedNoProvider('1', 'Injected')],
      connect: vi.fn(),
      isPending: false,
      error: null,
    });
    mockHook(useDisconnect, { disconnect: vi.fn() });

    render(<ConnectButton />);
    expect(
      await screen.findByText(
        /MetaMask アプリで開くとスムーズです/,
        undefined,
        { timeout: 2000 },
      ),
    ).toBeInTheDocument();
    // visible が空なので「別の方法」見出しは出さない。
    expect(screen.queryByText(/または別の方法で接続/)).not.toBeInTheDocument();
    // amber の noWallet は推奨に寄せたので出さない。
    expect(screen.queryByText(/ウォレットが見つかりません/)).not.toBeInTheDocument();
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
