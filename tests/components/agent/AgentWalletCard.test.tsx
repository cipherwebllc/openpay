import { useEffect, type ComponentProps } from 'react';
import dynamic from 'next/dynamic';
import type { AgentPurchases } from '@/components/agent/AgentPurchases';
import type { AgentActivity } from '@/components/agent/AgentActivity';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AgentWalletCard } from '@/components/agent/AgentWalletCard';
import { defaultDeploymentForSymbol } from '@/lib/tokens';
import { chainNameForId } from '@/lib/chains';
import { agentPageContentFor } from '@/lib/agentPage';

const C = agentPageContentFor('en').wallet;
const activity = agentPageContentFor('en').activity;
const purchases = agentPageContentFor('en').purchases;
const flags = vi.hoisted(() => ({ enabled: true }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, get enableAgentPurchases() { return flags.enabled; } } };
});

const state = vi.hoisted(() => ({ query: '', data: undefined as bigint | undefined, isError: false, connected: false, read: vi.fn(), fund: vi.fn(), activity: vi.fn(), purchases: vi.fn(), mount: vi.fn(), unmount: vi.fn(), refetch: vi.fn() }));
const address = '0x1111111111111111111111111111111111111111';
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(state.query) }));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('wagmi', () => ({
  useAccount: () => ({ address, isConnected: state.connected }),
  useReadContract: (options: unknown) => { state.read(options); return { data: state.data, isError: state.isError, refetch: state.refetch }; },
}));
vi.mock('next/dynamic', () => ({ default: vi.fn(() => function Dynamic(props: ComponentProps<typeof AgentPurchases> | ComponentProps<typeof AgentActivity> | { value?: string; onSent?: () => void; onBusyChange?: (busy: boolean) => void }) {
  const isFund = !('address' in props) && !props.value;
  useEffect(() => { if (isFund) { state.mount(); return () => { state.unmount(); }; } }, [isFund]);
  if ('refreshKey' in props) { state.activity(props); return <h3>{props.c.title}</h3>; }
  if ('address' in props) { state.purchases(props); return <h3>{props.c.title}</h3>; }
  if (props.value) return <svg data-value={props.value} />;
  state.fund(props);
  return <button type="button" onClick={props.onSent}>Mock funding confirmed</button>;
}), }));
beforeEach(() => { flags.enabled = true; window.localStorage.clear(); window.history.replaceState(null, '', '/'); state.query = ''; state.data = undefined; state.isError = false; state.connected = false; vi.clearAllMocks(); });

describe('AgentWalletCard', () => {
  it('renders purchases below activity with the Agent address and server-supplied copy', () => {
    state.query = `address=${address}`;
    const { container } = render(<AgentWalletCard c={C} activity={activity} purchases={purchases} />);
    const heading = screen.getByRole('heading', { name: purchases.title });
    expect(screen.getByRole('heading', { name: activity.title }).compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(state.purchases).toHaveBeenCalledWith({ address, locale: 'en', c: purchases, isConnected: false });
    expect(container.querySelector('#agent-fund')!.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it('does not even register the purchases dynamic import when the flag is off', async () => {
    flags.enabled = false;
    vi.resetModules();
    const { AgentWalletCard: Disabled } = await import('@/components/agent/AgentWalletCard');
    expect(dynamic).toHaveBeenCalledTimes(3);
    state.query = `address=${address}`;
    render(<Disabled c={C} activity={activity} purchases={purchases} />);
    expect(screen.queryByRole('heading', { name: purchases.title })).toBeNull();
    expect(state.purchases).not.toHaveBeenCalled();
  });
  it('shows activity after the ownership note and funding panel only for a valid address', () => {
    const { container } = render(<AgentWalletCard purchases={agentPageContentFor('en').purchases} c={C} activity={activity} />);
    expect(screen.queryByRole('heading', { name: activity.title })).toBeNull();
    expect(state.activity).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(C.inputLabel), { target: { value: address } });
    const heading = screen.getByRole('heading', { name: activity.title });
    expect(heading).toBeVisible();
    expect(screen.getByText(C.ownershipNote).compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector('#agent-fund')!.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(state.activity).toHaveBeenLastCalledWith({ address, locale: 'en', c: activity, refreshKey: 0 });
    fireEvent.change(screen.getByLabelText(C.inputLabel), { target: { value: 'invalid' } });
    expect(screen.queryByRole('heading', { name: activity.title })).toBeNull();
  });
  it.each(['ja', 'en'])('shows a slim empty form and hides a valid address until Change in %s', (locale) => {
    const c = agentPageContentFor(locale).wallet;
    const empty = render(<AgentWalletCard purchases={agentPageContentFor('en').purchases} c={c} activity={agentPageContentFor(locale).activity} />);
    expect(screen.getByRole('heading', { name: c.title })).toBeVisible();
    // 初期状態は入力欄を出さない: ウォレットは「Agent を接続」のセットアップで作られ、Agent が返すリンクで反映される。
    expect(screen.getByText(c.emptyLead)).toBeVisible();
    expect(screen.getByRole('link', { name: c.emptyConnectCta })).toHaveAttribute('href', '#agent-connect');
    expect(screen.getByLabelText(c.inputLabel)).not.toBeVisible();
    // まだ何も読み取っていないので、読み取りの注記も出さない。
    expect(screen.queryByText(c.ownershipNote)).toBeNull();
    const manual = screen.getByRole('button', { name: c.manualEntry });
    expect(manual).toHaveAttribute('aria-controls', 'agent-wallet-input');
    fireEvent.click(manual);
    expect(screen.getByText(c.lead)).toBeVisible();
    expect(screen.getByRole('textbox', { name: c.inputLabel })).toBeVisible();
    expect(screen.queryByText(c.emptyLead)).toBeNull();
    expect(screen.queryByRole('button', { name: c.useConnected })).toBeNull();
    expect(screen.getByText(c.ownershipNote)).toBeVisible();
    empty.unmount();
    state.query = `address=${address}`;
    render(<AgentWalletCard purchases={agentPageContentFor('en').purchases} c={c} activity={agentPageContentFor(locale).activity} />);
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
    const { container } = render(<AgentWalletCard purchases={agentPageContentFor('en').purchases} c={C} activity={activity} />);
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
    const { container } = render(<AgentWalletCard purchases={agentPageContentFor('en').purchases} c={C} activity={activity} />);
    expect(container.querySelector('#agent-fund')).toBeVisible();
    expect(screen.getByRole('button', { name: C.closeFund })).toHaveAttribute('aria-expanded', 'true');
  });
  it('opens on hashchange and retains a pending anchor until an address is entered', () => {
    const { container } = render(<AgentWalletCard purchases={agentPageContentFor('en').purchases} c={C} activity={activity} />);
    act(() => {
      window.history.replaceState(null, '', '/#agent-fund');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(container.querySelector('#agent-fund')).not.toBeVisible();
    fireEvent.change(screen.getByLabelText(C.inputLabel), { target: { value: address } });
    expect(container.querySelector('#agent-fund')).toBeVisible();
  });
  it.each(['ja', 'en'])('keeps the saved address until a conflicting link is confirmed in %s', (locale) => {
    const c = agentPageContentFor(locale).wallet;
    const saved = '0x2222222222222222222222222222222222222222';
    state.query = `address=${address}`;
    window.history.replaceState(null, '', '/#agent-fund');
    window.localStorage.setItem('openpay.agent.address', saved);
    const { container } = render(<AgentWalletCard purchases={purchases} c={c} activity={activity} />);
    expect(screen.getByLabelText(c.inputLabel)).toHaveValue(saved);
    expect(window.localStorage.getItem('openpay.agent.address')).toBe(saved);
    expect(state.read).toHaveBeenLastCalledWith(expect.objectContaining({ args: [saved] }));
    expect(state.fund).toHaveBeenLastCalledWith(expect.objectContaining({ agentAddress: saved }));
    expect(container.querySelector('#agent-fund')).not.toBeVisible();
    expect(screen.getByText(c.linkedAddressConfirm.replace('{address}', address))).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: c.useLinkedAddress }));
    expect(screen.getByLabelText(c.inputLabel)).toHaveValue(address);
    expect(window.localStorage.getItem('openpay.agent.address')).toBe(address);
    expect(state.fund).toHaveBeenLastCalledWith(expect.objectContaining({ agentAddress: address }));
    expect(container.querySelector('#agent-fund')).toBeVisible();
  });
  it('keeps the saved address after declining a conflicting link and on the next direct visit', () => {
    const saved = '0x2222222222222222222222222222222222222222';
    state.query = `address=${address}`;
    window.localStorage.setItem('openpay.agent.address', saved);
    const view = render(<AgentWalletCard purchases={purchases} c={C} activity={activity} />);
    expect(window.localStorage.getItem('openpay.agent.address')).toBe(saved);
    fireEvent.click(screen.getByRole('button', { name: C.keepSavedAddress }));
    expect(screen.queryByRole('button', { name: C.useLinkedAddress })).toBeNull();
    expect(screen.getByLabelText(C.inputLabel)).toHaveValue(saved);
    view.unmount(); state.query = '';
    render(<AgentWalletCard purchases={purchases} c={C} activity={activity} />);
    expect(screen.getByLabelText(C.inputLabel)).toHaveValue(saved);
  });
  it('accepts the same saved address with different casing without a replacement prompt', () => {
    const saved = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    state.query = 'address=0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa';
    window.localStorage.setItem('openpay.agent.address', saved);
    render(<AgentWalletCard purchases={purchases} c={C} activity={activity} />);
    expect(screen.queryByRole('button', { name: C.useLinkedAddress })).toBeNull();
    expect(screen.getByLabelText(C.inputLabel)).toHaveValue(saved);
    expect(window.localStorage.getItem('openpay.agent.address')).toBe(saved);
  });
  it('disables closing while busy and preserves the mounted recipient through edits', () => {
    state.query = `address=${address}`;
    const { container } = render(<AgentWalletCard purchases={agentPageContentFor('en').purchases} c={C} activity={activity} />);
    // `?address=` 付きの着地 (MCP の入金リンク) は最初から開いている。
    expect(container.querySelector('#agent-fund')).toBeVisible();
    expect(screen.queryByText(C.fundLockedNote)).toBeNull();
    act(() => state.fund.mock.calls.at(-1)?.[0].onBusyChange(true));
    const close = screen.getByRole('button', { name: C.closeFund });
    expect(close).toBeDisabled();
    // 閉じられない理由を見せる。
    expect(screen.getByText(C.fundLockedNote)).toBeVisible();
    fireEvent.click(close);
    fireEvent.click(screen.getByRole('button', { name: C.changeAddress }));
    fireEvent.change(screen.getByLabelText(C.inputLabel), { target: { value: '' } });
    expect(container.querySelector('#agent-fund')).toBeVisible();
    const next = '0x2222222222222222222222222222222222222222';
    fireEvent.change(screen.getByLabelText(C.inputLabel), { target: { value: next } });
    expect(screen.getByRole('button', { name: C.closeFund })).toBeDisabled();
    expect(state.fund).toHaveBeenLastCalledWith(expect.objectContaining({ agentAddress: address }));
    // 入金用の表示 (アドレス行・QR) は上のカードと同じ新しいアドレス。送金フォームの宛先だけが旧アドレスに固定される。
    // 旧アドレスの QR が残ると、外部からの入金が意図しない宛先へ着く (送金は取り消せない)。
    expect(container.querySelector(`svg[data-value="${next}"]`)).not.toBeNull();
    expect(container.querySelector(`svg[data-value="${address}"]`)).toBeNull();
    expect(container.querySelector('#agent-fund p.select-all')).toHaveTextContent(next);
    const pending = screen.getByText(C.pendingToOther, { exact: false });
    expect(pending).toBeVisible();
    expect(pending).toHaveTextContent(address);
    act(() => state.fund.mock.calls.at(-1)?.[0].onBusyChange(false));
    expect(screen.queryByText(C.pendingToOther, { exact: false })).toBeNull();
    expect(screen.queryByText(C.fundLockedNote)).toBeNull();
    expect(screen.getByRole('button', { name: C.closeFund })).toBeEnabled();
    expect(state.fund).toHaveBeenLastCalledWith(expect.objectContaining({ agentAddress: next }));
    expect(state.mount).toHaveBeenCalledTimes(1);
    expect(state.unmount).not.toHaveBeenCalled();
  });
  it('keeps the funding panel closed for a saved address but opens it for a funding link', () => {
    window.localStorage.setItem('openpay.agent.address', address);
    const saved = render(<AgentWalletCard purchases={agentPageContentFor('en').purchases} c={C} activity={activity} />);
    expect(saved.container.querySelector('#agent-fund')).not.toBeVisible();
    saved.unmount();
    state.query = `address=${address}`;
    const linked = render(<AgentWalletCard purchases={agentPageContentFor('en').purchases} c={C} activity={activity} />);
    expect(linked.container.querySelector('#agent-fund')).toBeVisible();
  });
  it('moves focus to Change after using the connected wallet, not to the body', async () => {
    state.connected = true;
    render(<AgentWalletCard purchases={agentPageContentFor('en').purchases} c={C} activity={activity} />);
    fireEvent.click(screen.getByRole('button', { name: C.manualEntry }));
    const use = screen.getByRole('button', { name: C.useConnected });
    use.focus();
    fireEvent.click(use);
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))); });
    expect(screen.getByLabelText(C.inputLabel)).not.toBeVisible();
    expect(screen.getByRole('button', { name: C.changeAddress })).toHaveFocus();
  });
  it('focuses the input on manual entry, collapses the moment the address becomes valid, and never on blur', async () => {
    render(<AgentWalletCard purchases={agentPageContentFor('en').purchases} c={C} activity={activity} />);
    fireEvent.click(screen.getByRole('button', { name: C.manualEntry }));
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))); });
    const input = screen.getByLabelText(C.inputLabel);
    // 押したボタン自身が消える → フォーカスは body ではなく、開いた入力欄へ。
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: 'invalid' } });
    fireEvent.blur(input);
    // 不正な入力は直せるよう開いたまま。blur では畳まない (畳むとカードがずれ、進行中のクリックが空振りする)。
    expect(input).toBeVisible();
    fireEvent.change(input, { target: { value: address } });
    // 有効になった瞬間に畳む。フォーカスは「変更」へ (消えた入力欄に残さない)。
    expect(input).not.toBeVisible();
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))); });
    const change = screen.getByRole('button', { name: C.changeAddress });
    expect(change).toHaveFocus();
    // 「変更」は直後でも必ず効く (タイマーや無視する時間帯を持たない)。
    fireEvent.click(change);
    expect(input).toBeVisible();
    fireEvent.blur(input);
    expect(input).toBeVisible();
    fireEvent.click(change);
    expect(input).not.toBeVisible();
    // 開いたまま別の有効なアドレスに書き換えても同じ。
    fireEvent.click(change);
    fireEvent.change(input, { target: { value: '0x2222222222222222222222222222222222222222' } });
    expect(input).not.toBeVisible();
  });
  it('does not enable balance reads for empty or invalid addresses', () => {
    state.query = 'address=invalid';
    render(<AgentWalletCard purchases={agentPageContentFor('en').purchases} c={C} activity={activity} />);
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
    const { container } = render(<AgentWalletCard purchases={agentPageContentFor('en').purchases} c={C} activity={activity} />);
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
    const { rerender } = render(<AgentWalletCard purchases={agentPageContentFor('en').purchases} c={C} activity={activity} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    state.isError = true;
    rerender(<AgentWalletCard purchases={agentPageContentFor('en').purchases} c={C} activity={activity} />);
    expect(screen.getByRole('status')).toHaveTextContent('Could not read the balance');
    expect(screen.queryByText('No JPYC')).toBeNull();
  });
  it('uses the connected wallet only on request and disables reads after invalid edits', () => {
    state.connected = true;
    render(<AgentWalletCard purchases={agentPageContentFor('en').purchases} c={C} activity={activity} />);
    fireEvent.click(screen.getByRole('button', { name: C.manualEntry }));
    fireEvent.click(screen.getByRole('button', { name: 'Use the connected wallet' }));
    expect(screen.getByLabelText('Agent wallet address')).toHaveValue(address);
    expect(state.read).toHaveBeenLastCalledWith(expect.objectContaining({ args: [address], query: { enabled: true } }));
    fireEvent.click(screen.getByRole('button', { name: C.changeAddress }));
    fireEvent.change(screen.getByLabelText('Agent wallet address'), { target: { value: '0x' } });
    expect(state.read).toHaveBeenLastCalledWith(expect.objectContaining({ args: undefined, query: { enabled: false } }));
  });
  it('remembers a valid public address on this device and restores it on the next visit', () => {
    const first = render(<AgentWalletCard purchases={agentPageContentFor('en').purchases} c={C} activity={activity} />);
    fireEvent.change(screen.getByLabelText('Agent wallet address'), { target: { value: address } });
    expect(window.localStorage.getItem('openpay.agent.address')).toBe(address);
    expect(screen.getByRole('button', { name: 'Add funds' })).toHaveAttribute('aria-controls', 'agent-fund');
    expect(screen.getByRole('link', { name: 'Connect agent' })).toHaveAttribute('href', '#agent-connect');
    first.unmount();
    render(<AgentWalletCard purchases={agentPageContentFor('en').purchases} c={C} activity={activity} />);
    expect(screen.getByLabelText('Agent wallet address')).toHaveValue(address);
  });
  it('passes the funding copy, locale and address inside the funding block and refreshes on confirmation', () => {
    state.query = `address=${address}`;
    render(<AgentWalletCard purchases={agentPageContentFor('en').purchases} c={C} activity={activity} />);
    expect(state.fund).toHaveBeenLastCalledWith(expect.objectContaining({ locale: 'en', c: C.fundFromWallet, agentAddress: address }));
    // `?address=` 付きの着地は開いた状態 (押さなくても入金ブロックが見える)。
    expect(screen.getByRole('button', { name: C.closeFund })).toHaveAttribute('aria-expanded', 'true');
    const button = screen.getByRole('button', { name: 'Mock funding confirmed' });
    expect(button.closest('#agent-fund')).not.toBeNull();
    expect(state.refetch).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(state.refetch).toHaveBeenCalledTimes(1);
    expect(state.activity).toHaveBeenLastCalledWith(expect.objectContaining({ refreshKey: 1 }));
    fireEvent.click(button);
    expect(state.refetch).toHaveBeenCalledTimes(2);
    expect(state.activity).toHaveBeenLastCalledWith(expect.objectContaining({ refreshKey: 2 }));
  });
});
