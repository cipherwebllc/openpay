import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import { mockHook } from '../_helpers/wagmiMock';

// wagmi 境界 mock。接続/未接続の両 branch を切り替えてテストする。
vi.mock('wagmi', () => ({
  useAccount: vi.fn(),
  useConnect: vi.fn(),
  useDisconnect: vi.fn(),
}));
import { useAccount, useConnect, useDisconnect } from 'wagmi';

// useVisibleConnectors は WalletBadge から呼ばれる。実 hook を走らせる代わりに
// 境界 mock — connectors のフィルタロジックは別 test (useVisibleConnectors.test)
// で検証済。本 test は WalletBadge の UI 分岐を focus。
const visibleConnectorsMock = vi.fn();
vi.mock('@/hooks/useVisibleConnectors', () => ({
  useVisibleConnectors: () => visibleConnectorsMock(),
}));

// SIWE セッション hook は boundary mock (React Query + useSignMessage を引かない)。
// nonce→署名→verify の検証は lib/siwe (siwe.test) と route が担保。本 test は UI 分岐。
const siweMock = vi.fn();
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => siweMock(),
}));

// SIWE ログイン UI は freee/利用権 が有効なときだけ出す。flag は holder で test 毎に切替
// (既定 = freee ON で SIWE UI を出す。両 OFF で隠れることは専用 test で検証)。
const flags = vi.hoisted(() => ({ enableFreeeSync: true, enableBilling: false }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableFreeeSync() {
        return flags.enableFreeeSync;
      },
      get enableBilling() {
        return flags.enableBilling;
      },
    },
  };
});

type SiweState = ReturnType<typeof defaultSiwe>;
function defaultSiwe() {
  return {
    sessionAddress: null as string | null,
    isSignedIn: false,
    mismatch: false,
    isLoading: false,
    signIn: vi.fn().mockResolvedValue(undefined),
    isSigningIn: false,
    signInError: null as Error | null,
    signOut: vi.fn().mockResolvedValue(undefined),
    isSigningOut: false,
  };
}
function setSiwe(overrides: Partial<SiweState> = {}) {
  const state = { ...defaultSiwe(), ...overrides };
  siweMock.mockReturnValue(state);
  return state;
}

import { WalletBadge } from '@/components/WalletBadge';

const ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

function setConnected(opts: { chain?: { name: string } | null } = {}) {
  // chain=null で「未確定」を明示 (default 引数の undefined と区別)
  const chain = opts.chain === null ? undefined : opts.chain ?? { name: 'Base' };
  mockHook(useAccount, { isConnected: true, address: ADDR, chain });
  const disconnect = vi.fn();
  mockHook(useDisconnect, { disconnect });
  mockHook(useConnect, {
    connectors: [],
    connect: vi.fn(),
    isPending: false,
    error: null,
  });
  return { disconnect };
}

function setDisconnected(opts: { error?: Error | null; isPending?: boolean } = {}) {
  mockHook(useAccount, { isConnected: false, address: undefined });
  const connect = vi.fn();
  // wagmi の useConnect().error は ConnectError 系の discriminated union だが、
  // 本テストは Error.message を読む path しか叩かないので Error を渡す。
  // 型はテストの責務外なので as never で逃がす (wagmiMock helper と同パターン)。
  mockHook(useConnect, {
    connectors: [],
    connect,
    isPending: opts.isPending ?? false,
    error: (opts.error ?? null) as never,
  });
  mockHook(useDisconnect, { disconnect: vi.fn() });
  return { connect };
}

/**
 * <details> ベース dropdown を開く helper。
 *
 * 実 browser では summary を click することで `<details>` に `open` 属性が付き、
 * 子コンテンツが visible になる。JSDOM は CSS visibility を強制しないので、テスト
 * では `open` 属性の有無で「user が開いたかどうか」を表現する。getByRole の query
 * 自体は open 状態に依らず通るが、本テストでは open=false 時に意図的に未 click の
 * まま menuitem を assert しないことで、「user が開かないと触れない」前提を担保する。
 */
function openDropdown(summaryText: string | RegExp): HTMLDetailsElement {
  const summary = screen.getByText(summaryText).closest('summary');
  if (!summary) throw new Error(`summary containing "${summaryText}" not found`);
  const details = summary.closest('details') as HTMLDetailsElement | null;
  if (!details) throw new Error('parent <details> not found');
  expect(details.open).toBe(false);
  fireEvent.click(summary);
  expect(details.open).toBe(true);
  return details;
}

beforeEach(() => {
  vi.clearAllMocks();
  visibleConnectorsMock.mockReturnValue([]);
  setSiwe();
  flags.enableFreeeSync = true; // 既定: SIWE 機能 ON → ログイン UI を出す
  flags.enableBilling = false;
});

describe('WalletBadge: 接続済 branch', () => {
  it('summary に shortAddress + chain.name + ChevronDown が表示 (dropdown 閉)', () => {
    setConnected({ chain: { name: 'Base' } });
    const { container } = renderWithIntl(<WalletBadge />);
    expect(screen.getByText('0x52d4…cA81')).toBeInTheDocument();
    expect(screen.getByText(/\/ Base/)).toBeInTheDocument();
    // dropdown は default closed
    const details = container.querySelector('details');
    expect(details?.open).toBe(false);
  });

  it('chain が undefined → "/ chain" 表記が出ない', () => {
    setConnected({ chain: null });
    renderWithIntl(<WalletBadge />);
    expect(screen.getByText('0x52d4…cA81')).toBeInTheDocument();
    expect(screen.queryByText(/\/ /)).toBeNull();
  });

  it('summary click → <details open> が付き、disconnect menuitem が触れる + click で useDisconnect.disconnect() 呼出', () => {
    const { disconnect } = setConnected();
    renderWithIntl(<WalletBadge />);
    // user は summary を click して開く必要がある (実 browser の <details> 挙動)
    const details = openDropdown('0x52d4…cA81');
    const disconnectBtn = within(details).getByRole('menuitem', { name: '切断' });
    fireEvent.click(disconnectBtn);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('summary 再 click で <details> が閉じる (toggle 動作)', () => {
    setConnected();
    const { container } = renderWithIntl(<WalletBadge />);
    const summary = screen.getByText('0x52d4…cA81').closest('summary')!;
    const details = container.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    fireEvent.click(summary);
    expect(details.open).toBe(true);
    fireEvent.click(summary);
    expect(details.open).toBe(false);
  });

  it('en locale: 切断ボタン label は "Disconnect" (open 後に確認)', () => {
    setConnected();
    renderWithIntl(<WalletBadge />, { locale: 'en' });
    const details = openDropdown('0x52d4…cA81');
    expect(
      within(details).getByRole('menuitem', { name: 'Disconnect' }),
    ).toBeInTheDocument();
  });

  it('接続済 branch では「接続」 button summary が DOM に居ない (regression guard)', () => {
    setConnected();
    renderWithIntl(<WalletBadge />);
    // 「接続」 label を持つ summary は 1 つも無い
    expect(screen.queryByText('接続')).toBeNull();
  });

  it('emerald online dot (aria-hidden) が summary に存在', () => {
    setConnected();
    const { container } = renderWithIntl(<WalletBadge />);
    const dot = container.querySelector('.bg-emerald-500');
    expect(dot).not.toBeNull();
  });

  it('chain.name は dropdown 内にも表示 (open 状態で確認可能)', () => {
    setConnected({ chain: { name: 'Polygon Mainnet' } });
    renderWithIntl(<WalletBadge />);
    const details = openDropdown('0x52d4…cA81');
    // summary 内 (短縮表記) + dropdown header の 2 箇所に出る
    expect(within(details).getByText('Polygon Mainnet')).toBeInTheDocument();
  });
});

describe('WalletBadge: SIWE サインイン', () => {
  it('未サインイン → dropdown に「ログイン (署名)」menuitem・click で signIn(statement) 呼出', () => {
    setConnected();
    const siwe = setSiwe({ isSignedIn: false });
    renderWithIntl(<WalletBadge />);
    const details = openDropdown('0x52d4…cA81');
    const btn = within(details).getByRole('menuitem', { name: 'ログイン (署名)' });
    fireEvent.click(btn);
    expect(siwe.signIn).toHaveBeenCalledWith('OpenPay にこのウォレットでログインします。');
  });

  it('サインイン済 → summary に ✓・dropdown に「ログイン済」+「ログアウト」menuitem', () => {
    setConnected();
    const siwe = setSiwe({ isSignedIn: true, sessionAddress: ADDR });
    renderWithIntl(<WalletBadge />);
    // summary の ✓ (aria-label = ログイン済)
    expect(screen.getByLabelText('ログイン済')).toBeInTheDocument();
    const details = openDropdown('0x52d4…cA81');
    const signOutBtn = within(details).getByRole('menuitem', { name: 'ログアウト' });
    fireEvent.click(signOutBtn);
    expect(siwe.signOut).toHaveBeenCalledTimes(1);
    // サインイン済では「ログイン (署名)」は出ない
    expect(
      within(details).queryByRole('menuitem', { name: 'ログイン (署名)' }),
    ).toBeNull();
  });

  it('mismatch (別アドレスでセッション) → 「再ログイン」menuitem', () => {
    setConnected();
    setSiwe({ mismatch: true, sessionAddress: '0xother' });
    renderWithIntl(<WalletBadge />);
    const details = openDropdown('0x52d4…cA81');
    expect(
      within(details).getByRole('menuitem', { name: '別アドレスでログイン中 — 再ログイン' }),
    ).toBeInTheDocument();
  });

  it('signInError → 赤エラー文言を dropdown 内に表示', () => {
    setConnected();
    setSiwe({ signInError: new Error('invalid_signature') });
    renderWithIntl(<WalletBadge />);
    const details = openDropdown('0x52d4…cA81');
    expect(within(details).getByText('ログインに失敗しました')).toBeInTheDocument();
  });

  it('切断 menuitem → signOut + disconnect の両方を呼ぶ (宙ぶらりんセッション防止)', () => {
    const { disconnect } = setConnected();
    const siwe = setSiwe({ isSignedIn: true, sessionAddress: ADDR });
    renderWithIntl(<WalletBadge />);
    const details = openDropdown('0x52d4…cA81');
    fireEvent.click(within(details).getByRole('menuitem', { name: '切断' }));
    expect(siwe.signOut).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('SIWE 機能 (freee/利用権) が全 OFF → ログイン UI を出さない (切断のみ)', () => {
    flags.enableFreeeSync = false;
    flags.enableBilling = false;
    setConnected();
    setSiwe({ isSignedIn: false }); // 仮にサインインしていなくてもログイン導線を出さない
    renderWithIntl(<WalletBadge />);
    const details = openDropdown('0x52d4…cA81');
    expect(
      within(details).queryByRole('menuitem', { name: 'ログイン (署名)' }),
    ).toBeNull();
    // サインイン済でも ✓/ログアウトは出さない (機能が無いので無意味)
    expect(screen.queryByLabelText('ログイン済')).toBeNull();
    // 切断は常に出る
    expect(
      within(details).getByRole('menuitem', { name: '切断' }),
    ).toBeInTheDocument();
  });
});

describe('WalletBadge: 未接続 branch', () => {
  it('未接続: 「接続」 summary が visible、dropdown は default 閉', () => {
    setDisconnected();
    const { container } = renderWithIntl(<WalletBadge />);
    expect(screen.getByText('接続')).toBeInTheDocument();
    const details = container.querySelector('details');
    expect(details?.open).toBe(false);
  });

  it('summary click で dropdown が開き、visible connector の menuitem が触れる', () => {
    const { connect } = setDisconnected();
    visibleConnectorsMock.mockReturnValue([
      { uid: '1', name: 'MetaMask' },
      { uid: '2', name: 'Rabby' },
    ]);
    renderWithIntl(<WalletBadge />);
    const details = openDropdown('接続');
    const mm = within(details).getByRole('menuitem', { name: 'MetaMask' });
    const rabby = within(details).getByRole('menuitem', { name: 'Rabby' });
    expect(mm).toBeInTheDocument();
    expect(rabby).toBeInTheDocument();
    fireEvent.click(mm);
    expect(connect).toHaveBeenCalledWith({
      connector: expect.objectContaining({ name: 'MetaMask' }),
    });
  });

  it('isPending=true → dropdown 内の connector button が disabled', () => {
    setDisconnected({ isPending: true });
    visibleConnectorsMock.mockReturnValue([{ uid: '1', name: 'MetaMask' }]);
    renderWithIntl(<WalletBadge />);
    const details = openDropdown('接続');
    const btn = within(details).getByRole('menuitem', {
      name: 'MetaMask',
    }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('visible connector が空 → "…" placeholder が dropdown 内に出る (open 状態で確認)', () => {
    setDisconnected();
    visibleConnectorsMock.mockReturnValue([]);
    renderWithIntl(<WalletBadge />);
    const details = openDropdown('接続');
    expect(within(details).getByText('…')).toBeInTheDocument();
  });

  it('connect error (非 user-reject) は赤文字で dropdown 内表示', () => {
    setDisconnected({ error: new Error('Failed to connect: RPC down') });
    visibleConnectorsMock.mockReturnValue([{ uid: '1', name: 'MetaMask' }]);
    renderWithIntl(<WalletBadge />);
    const details = openDropdown('接続');
    expect(
      within(details).getByText(/Failed to connect: RPC down/),
    ).toBeInTheDocument();
  });

  it('connect error が "User rejected" → filter されて表示されない (ノイズ抑制)', () => {
    setDisconnected({ error: new Error('User rejected the request') });
    visibleConnectorsMock.mockReturnValue([{ uid: '1', name: 'MetaMask' }]);
    renderWithIntl(<WalletBadge />);
    openDropdown('接続');
    expect(screen.queryByText(/User rejected/)).toBeNull();
  });

  it('connect error が "connection request reset" → filter される', () => {
    setDisconnected({ error: new Error('Connection request reset') });
    visibleConnectorsMock.mockReturnValue([{ uid: '1', name: 'MetaMask' }]);
    renderWithIntl(<WalletBadge />);
    openDropdown('接続');
    expect(screen.queryByText(/Connection request reset/)).toBeNull();
  });

  it('User rejection 判定は case-insensitive (大文字 USER REJECTED でも filter)', () => {
    setDisconnected({ error: new Error('USER REJECTED the request') });
    visibleConnectorsMock.mockReturnValue([{ uid: '1', name: 'MetaMask' }]);
    renderWithIntl(<WalletBadge />);
    openDropdown('接続');
    expect(screen.queryByText(/USER REJECTED/)).toBeNull();
  });

  it('en locale: 「Connect」 summary が出る', () => {
    setDisconnected();
    renderWithIntl(<WalletBadge />, { locale: 'en' });
    expect(screen.getByText('Connect')).toBeInTheDocument();
  });
});
