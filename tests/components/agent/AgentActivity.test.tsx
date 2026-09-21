import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AgentActivity } from '@/components/agent/AgentActivity';
import { agentPageContentFor } from '@/lib/agentPage';
import type { AgentActivityFailure, AgentActivityItem, AgentActivityResponse } from '@/lib/agent/activityTypes';
import { defaultDeploymentForSymbol } from '@/lib/tokens';

vi.mock('@/lib/tokens', () => ({ defaultDeploymentForSymbol: vi.fn() }));
vi.mock('@/lib/chains', () => ({ blockExplorerUrl: (chainId: number) => chainId === 137 ? 'https://polygonscan.com' : 'https://amoy.polygonscan.com' }));

const address = '0xaBcdefabcdefabcdefabcdefabcdefabcdefabCd';
const nextAddress = '0x2222222222222222222222222222222222222222';
const tokenAddress = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29';
const asOf = 1_800_000_000;
const day = 86_400;
const deployment = { symbol: 'jpyc', displaySymbol: 'JPYC', name: 'JPYC', decimals: 18, address: tokenAddress, chainId: 137, paymasterMode: 'erc20' } as const;
const c = agentPageContentFor('en').activity;
const mockFetch = vi.fn<typeof fetch>();
const clients: QueryClient[] = [];

function item(overrides: Partial<AgentActivityItem> = {}): AgentActivityItem {
  return { key: 'transfer-1', hash: `0x${'a'.repeat(64)}`, timestamp: asOf - 60, direction: 'out', counterparty: '0x1234567890abcdef1234567890abcdef1234abcd', valueAtomic: '2500000000000000000', viaOpenPay: false, ...overrides };
}
const outgoing = item({ viaOpenPay: true });
const incoming = item({ key: 'transfer-2', hash: `0x${'b'.repeat(64)}`, direction: 'in', valueAtomic: '1250000000000000000' });
function success(items: AgentActivityItem[] = [outgoing, incoming], truncated = false): AgentActivityResponse {
  return { ok: true, chainId: 137, items, rawCount: truncated ? 50 : items.length, truncated, asOf };
}
function response(body: AgentActivityResponse, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function mount(overrides: Partial<ComponentProps<typeof AgentActivity>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 1, gcTime: Infinity } } });
  clients.push(client);
  let props = { address, locale: 'en', c, refreshKey: 0, ...overrides } satisfies ComponentProps<typeof AgentActivity>;
  const ui = () => <QueryClientProvider client={client}><AgentActivity {...props} /></QueryClientProvider>;
  const view = render(ui());
  return { ...view, client, update: (next: Partial<ComponentProps<typeof AgentActivity>>) => { props = { ...props, ...next }; view.rerender(ui()); } };
}
function table() { return within(screen.getByRole('table')); }
function expectExplorer(base = 'https://polygonscan.com') {
  const link = screen.getByRole('link', { name: c.explorerLink });
  expect(link).toHaveAttribute('href', `${base}/token/${tokenAddress}?a=${address.toLowerCase()}`);
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
}

beforeEach(() => {
  vi.mocked(defaultDeploymentForSymbol).mockReturnValue(deployment);
  mockFetch.mockReset().mockImplementation(async () => response(success()));
  vi.stubGlobal('fetch', mockFetch);
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('AgentActivity', () => {
  it.each(['ja', 'en'])('renders loading, transfers, accessible columns and mobile values in %s', async (locale) => {
    const copy = agentPageContentFor(locale).activity;
    const { container } = mount({ locale, c: copy });
    expect(screen.getByRole('heading', { name: copy.title, level: 3 })).toBeInTheDocument();
    expect(screen.getByText(copy.publicNote)).toBeVisible();
    expect(screen.getByText(copy.loading).parentElement).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelectorAll('[aria-busy] .animate-pulse')).toHaveLength(3);
    expect(screen.getAllByText('—')).toHaveLength(2);
    await screen.findByRole('table');
    expect(screen.queryByText(copy.loading)).toBeNull();
    expect(table().getByText(copy.filterIn)).toBeInTheDocument();
    expect(table().getByText(copy.filterOut)).toBeInTheDocument();
    expect(table().getByText(copy.viaOpenPay)).toBeInTheDocument();
    expect(table().getByText('+1.25 JPYC')).toHaveClass('text-emerald-700');
    expect(table().getByText('−2.5 JPYC')).toHaveClass('text-slate-900');
    expect(table().getAllByText('0x1234…abcd')).toHaveLength(2);
    expect(table().getAllByText(new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(outgoing.timestamp * 1000))).toHaveLength(2);
    for (const label of [copy.colDate, copy.colType, copy.colCounterparty, copy.colAmount, copy.viewTx]) {
      expect(table().getByRole('columnheader', { name: label })).toHaveAttribute('scope', 'col');
    }
    expect(screen.getByRole('table')).toHaveClass('hidden', 'sm:table');
    const mobile = screen.getByRole('list');
    expect(mobile).toHaveClass('sm:hidden');
    expect(within(mobile).getAllByRole('listitem')).toHaveLength(2);
    for (const row of within(mobile).getAllByRole('listitem')) {
      for (const label of [copy.colDate, copy.colType, copy.colCounterparty, copy.colAmount]) {
        expect(within(row).getByText(`${label}:`)).toHaveClass('sr-only');
      }
    }
    for (const link of screen.getAllByRole('link', { name: copy.viewTx })) {
      expect(link.getAttribute('href')).toMatch(/^https:\/\/polygonscan\.com\/tx\/0x[ab]{64}$/);
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(link).toHaveAccessibleName(copy.viewTx);
    }
    expect(container.querySelector('[aria-label]')).toBeNull();
    expect(container.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(4);
  });

  it('fetches a canonical lowercase URL, without cache-busting parameters', async () => {
    mount();
    await screen.findByRole('table');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(`/api/agent/activity?address=${address.toLowerCase()}`, { signal: expect.any(AbortSignal) });
    fireEvent(window, new Event('focus'));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('filters with pressed-state chips and keeps the totals independent of the filter', async () => {
    mount();
    await screen.findByRole('table');
    const all = screen.getByRole('button', { name: c.filterAll });
    const received = screen.getByRole('button', { name: c.filterIn });
    const sent = screen.getByRole('button', { name: c.filterOut });
    expect(all).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(received);
    expect(received).toHaveAttribute('aria-pressed', 'true');
    expect(all).toHaveAttribute('aria-pressed', 'false');
    expect(sent).toHaveAttribute('aria-pressed', 'false');
    expect(table().getAllByRole('row')).toHaveLength(2);
    expect(table().queryByText('−2.5 JPYC')).toBeNull();
    expect(screen.getAllByText('2.5 JPYC')).toHaveLength(2);
    fireEvent.click(sent);
    expect(sent).toHaveAttribute('aria-pressed', 'true');
    expect(table().queryByText('+1.25 JPYC')).toBeNull();
    fireEvent.click(all);
    expect(table().getAllByRole('row')).toHaveLength(3);
  });

  it.each(['ja', 'en'])('distinguishes an empty filter from an empty history in %s', async (locale) => {
    const copy = agentPageContentFor(locale).activity;
    mockFetch.mockResolvedValue(response(success([outgoing])));
    mount({ locale, c: copy });
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: copy.filterIn }));
    expect(screen.getByText(copy.filterEmpty)).toBeVisible();
    expect(screen.queryByText(copy.empty)).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows ten more fetched transfers per click and resets pagination on a filter change', async () => {
    const items = Array.from({ length: 25 }, (_, i) => item({ key: `transfer-${i}`, direction: i < 12 ? 'in' : 'out' }));
    mockFetch.mockResolvedValue(response(success(items)));
    mount();
    await screen.findByRole('table');
    expect(table().getAllByRole('row')).toHaveLength(11);
    fireEvent.click(screen.getByRole('button', { name: c.more }));
    expect(table().getAllByRole('row')).toHaveLength(21);
    fireEvent.click(screen.getByRole('button', { name: c.more }));
    expect(table().getAllByRole('row')).toHaveLength(26);
    expect(screen.queryByRole('button', { name: c.more })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: c.filterIn }));
    expect(table().getAllByRole('row')).toHaveLength(11);
    fireEvent.click(screen.getByRole('button', { name: c.more }));
    expect(table().getAllByRole('row')).toHaveLength(13);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it.each(['ja', 'en'])('shows complete empty history and zero totals in %s', async (locale) => {
    const copy = agentPageContentFor(locale).activity;
    mockFetch.mockResolvedValue(response(success([])));
    mount({ locale, c: copy });
    expect(await screen.findByText(copy.empty)).toBeVisible();
    expect(screen.getAllByText('0 JPYC')).toHaveLength(2);
    expect(screen.queryByRole('table')).toBeNull();
  });

  describe.each(['ja', 'en'])('failure states in %s', (locale) => {
    it.each<AgentActivityFailure>(['not_configured', 'upstream', 'busy', 'rate_limited', 'invalid_address', 'unsupported_chain'])('reads the %s reason even on non-2xx responses', async (reason) => {
      const copy = agentPageContentFor(locale).activity;
      mockFetch.mockResolvedValue(response({ ok: false, reason }, reason === 'busy' || reason === 'rate_limited' ? 429 : 503));
      mount({ locale, c: copy });
      const expected = reason === 'busy' || reason === 'rate_limited' ? copy.busy : reason === 'unsupported_chain' ? copy.unsupported : copy.error;
      expect(await screen.findByText(expected, { exact: false })).toBeVisible();
      const link = screen.getByRole('link', { name: copy.explorerLink });
      expect(link).toHaveAttribute('href', `https://polygonscan.com/token/${tokenAddress}?a=${address.toLowerCase()}`);
      expect(screen.queryByText(copy.empty)).toBeNull();
      expect(screen.getAllByText('—')).toHaveLength(2);
    });
  });

  it('maps a non-JSON response to the history error', async () => {
    mockFetch.mockResolvedValue(new Response('<html>upstream unavailable</html>', { status: 502 }));
    mount();
    expect(await screen.findByText(c.error, { exact: false })).toBeVisible();
    expectExplorer();
    expect(screen.queryByText(c.empty)).toBeNull();
  });

  it('retries a network failure once and displays the error without exposing the exception', async () => {
    mockFetch.mockRejectedValue(new Error('private error details'));
    mount();
    expect(await screen.findByText(c.error, { exact: false })).toBeVisible();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expectExplorer();
    expect(screen.queryByText('private error details')).toBeNull();
  });

  it('does not fetch or start confirmation polling on an unsupported chain', async () => {
    vi.useFakeTimers();
    vi.mocked(defaultDeploymentForSymbol).mockReturnValue({ ...deployment, chainId: 80002 });
    const { update } = mount();
    expect(screen.getByText(c.unsupported, { exact: false })).toBeVisible();
    expectExplorer('https://amoy.polygonscan.com');
    update({ refreshKey: 1 });
    await act(async () => { await vi.advanceTimersByTimeAsync(80_000); });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(screen.queryByText(c.loading)).toBeNull();
    expect(screen.queryByText(c.refreshing)).toBeNull();
  });

  it('shows truncation and incomplete totals instead of reporting missing transfers as zero', async () => {
    mockFetch.mockResolvedValue(response(success([incoming], true)));
    mount();
    expect(await screen.findByText(c.truncatedNote, { exact: false })).toBeVisible();
    expectExplorer();
    expect(screen.getAllByText('—')).toHaveLength(2);
    expect(screen.getAllByText(c.statsPartial)).toHaveLength(2);
    expect(screen.queryByText('0 JPYC')).toBeNull();
  });

  it('uses asOf and all fetched transfers for rolling totals, even when rows are paginated', async () => {
    const items = Array.from({ length: 11 }, (_, i) => item({ key: `row-${i}`, valueAtomic: '1000000000000000000' }));
    items.push(item({ key: 'older', timestamp: asOf - day - 1, valueAtomic: '99000000000000000000' }));
    mockFetch.mockResolvedValue(response(success(items, true)));
    mount();
    await screen.findByRole('table');
    expect(screen.getByText(c.stat24h).parentElement).toHaveTextContent('11 JPYC');
    expect(screen.getByText(c.stat7d).parentElement).toHaveTextContent(`—${c.statsPartial}`);
    expect(table().getAllByRole('row')).toHaveLength(11);
  });

  it('discards old rows and totals immediately when the address changes', async () => {
    const { update } = mount();
    await screen.findByRole('table');
    let resolveNext!: (value: Response) => void;
    mockFetch.mockImplementationOnce(() => new Promise((resolve) => { resolveNext = resolve; }));
    update({ address: nextAddress });
    expect(screen.getByText(c.loading)).toBeVisible();
    expect(screen.queryByText('−2.5 JPYC')).toBeNull();
    expect(screen.queryByText('2.5 JPYC')).toBeNull();
    expect(screen.getAllByText('—')).toHaveLength(2);
    await act(async () => { resolveNext(response(success([]))); });
    expect(await screen.findByText(c.empty)).toBeVisible();
    expect(mockFetch.mock.lastCall?.[0]).toBe(`/api/agent/activity?address=${nextAddress}`);
  });

  it('does not let a late response for the previous address overwrite the new address', async () => {
    let resolveOld!: (value: Response) => void;
    mockFetch.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const { update } = mount();
    mockFetch.mockResolvedValue(response(success([])));
    update({ address: nextAddress });
    await screen.findByText(c.empty);
    await act(async () => { resolveOld(response(success())); });
    expect(screen.getByText(c.empty)).toBeVisible();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getAllByText('0 JPYC')).toHaveLength(2);
  });

  it('refetches at 20-second intervals exactly three times after confirmation', async () => {
    const { update } = mount();
    await screen.findByRole('table');
    vi.useFakeTimers();
    update({ refreshKey: 1 });
    expect(screen.getByText(c.refreshing)).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(19_999); });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    update({ refreshKey: 1 });
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(mockFetch).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(screen.queryByText(c.refreshing)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(mockFetch.mock.calls.every(([url]) => url === `/api/agent/activity?address=${address.toLowerCase()}`)).toBe(true);
  });

  it.each(['address', 'unmount', 'confirmation'])('cleans up previous polling on %s', async (change) => {
    const { update, unmount } = mount();
    await screen.findByRole('table');
    vi.useFakeTimers();
    update({ refreshKey: 1 });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    if (change === 'address') update({ address: nextAddress });
    else if (change === 'unmount') unmount();
    else update({ refreshKey: 2 });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(mockFetch).toHaveBeenCalledTimes(change === 'address' ? 2 : 1);
    await act(async () => { await vi.advanceTimersByTimeAsync(100_000); });
    expect(mockFetch).toHaveBeenCalledTimes(change === 'address' ? 2 : change === 'confirmation' ? 4 : 1);
    expect(screen.queryByText(c.refreshing)).toBeNull();
  });

  it('keeps chain-specific caches separate when moving to testnet', async () => {
    const { update } = mount();
    await screen.findByRole('table');
    vi.mocked(defaultDeploymentForSymbol).mockReturnValue({ ...deployment, chainId: 80002 });
    update({});
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText('2.5 JPYC')).toBeNull();
    expect(screen.getByText(c.unsupported, { exact: false })).toBeVisible();
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
  });
});
