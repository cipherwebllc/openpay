import { StrictMode, useLayoutEffect, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { track } from '@vercel/analytics';
import { AgentPurchases } from '@/components/agent/AgentPurchases';
import { agentPageContentFor } from '@/lib/agentPage';
import type { PurchaseItem } from '@/lib/agent/purchases';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';

const h = vi.hoisted(() => ({
  enabled: true, sessionAddress: null as string | null, isLoading: false,
  isSignedIn: true, mismatch: false, isSigningIn: false, signInError: null as Error | null, signIn: vi.fn(),
}));
vi.mock('@/lib/env', () => ({ env: { get enableAgentPurchases() { return h.enabled; } } }));
vi.mock('@/hooks/useSiweSession', () => ({ useSiweSession: () => ({ ...h }) }));
vi.mock('@vercel/analytics', () => ({ track: vi.fn() }));
vi.mock('@/lib/chains', () => ({ txExplorerUrl: (chain: number, tx: string) => {
  const base = ({ 137: 'https://polygonscan.com', 8453: 'https://basescan.org' } as Record<number, string>)[chain];
  return base ? `${base}/tx/${tx}` : undefined;
} }));
const address = '0x1111111111111111111111111111111111111111';
const owner = '0x2222222222222222222222222222222222222222';
const other = '0x3333333333333333333333333333333333333333';
const c = agentPageContentFor('en').purchases;
const mockFetch = vi.fn<typeof fetch>();
const clients: QueryClient[] = [];
function client() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(qc);
  return qc;
}
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function item(overrides: Partial<PurchaseItem> = {}): PurchaseItem {
  return { at: '2026-09-23T09:30:00.000Z', source: 'jpyc-facilitator', network: 'eip155:137', asset: 'JPYC', amount: '0.1', fee: '1', resource: { host: 'open-pay.jp', path: '/api/paid/demo' }, resourceOrigin: 'claimed', tx: `0x${'a'.repeat(64)}`, ...overrides };
}
function success(items: PurchaseItem[] = [item()], truncated = false) {
  return { ok: true, since: '2026-09-23', boundAt: '2026-09-23T09:00:00.000Z', items, truncated };
}
function mount(overrides: Partial<ComponentProps<typeof AgentPurchases>> = {}, strict = false) {
  const qc = client();
  let props = { address, locale: 'en', c, isConnected: true, ...overrides };
  const ui = () => <NextIntlClientProvider locale={props.locale} messages={props.locale === 'ja' ? ja : en}><QueryClientProvider client={qc}><AgentPurchases {...props} /></QueryClientProvider></NextIntlClientProvider>;
  const tree = () => strict ? <StrictMode>{ui()}</StrictMode> : ui();
  const view = render(tree());
  return { ...view, qc, update: (next: Partial<ComponentProps<typeof AgentPurchases>> = {}) => { props = { ...props, ...next }; view.rerender(tree()); } };
}
const encodeProof = (agentAddress = address, extra = {}) => Buffer.from(JSON.stringify({ v: 1, address: agentAddress, nonce: `0x${'aa'.repeat(32)}`, signature: `0x${'bb'.repeat(65)}`, ...extra })).toString('base64url');
function landing(proof = encodeProof()) {
  window.history.replaceState({ keep: 'next-history' }, '', `/en/agent?address=${address}#proof=${proof}`);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.clearAllMocks();
  h.enabled = true; h.isSignedIn = true; h.mismatch = false; h.sessionAddress = null; h.isLoading = false; h.isSigningIn = false; h.signInError = null;
  h.signIn.mockReset().mockResolvedValue(undefined);
  mockFetch.mockReset().mockImplementation(async () => response(success()));
  vi.stubGlobal('fetch', mockFetch);
  window.history.replaceState(null, '', '/en/agent');
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((qc) => qc.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AgentPurchases', () => {
  it.each(['ja', 'en'])('signs in with the existing Nav statement and visible button text in %s', async (locale) => {
    const copy = agentPageContentFor(locale).purchases;
    const { container, update } = mount({ locale, c: copy });
    expect(screen.getByText(copy.lead)).toBeVisible();
    expect(mockFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: copy.signIn }));
    await waitFor(() => expect(h.signIn).toHaveBeenCalledWith((locale === 'ja' ? ja : en).Nav.siweStatement));
    expect(track).toHaveBeenCalledWith('agent_purchases_signin', { locale });
    h.isSigningIn = true; update();
    expect(screen.getByRole('button', { name: copy.signingIn })).toBeDisabled();
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(container.querySelector('[aria-label]')).toBeNull();
  });

  it('shows a rejected sign-in without reporting a successful binding or view', async () => {
    h.signIn.mockRejectedValue(new Error('rejected'));
    mount();
    fireEvent.click(screen.getByRole('button', { name: c.signIn }));
    await screen.findByText(c.signInError);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(track).toHaveBeenCalledTimes(1);
  });

  it('shows the same unbound guidance for an unrelated Agent and a cookie owner different from A', async () => {
    h.sessionAddress = owner;
    mockFetch.mockImplementation(async () => response({ reason: 'not_bound' }, 401));
    mount();
    await screen.findByText(c.notBoundLead);
    expect(screen.getByRole('list').tagName).toBe('OL');
    for (const step of c.notBoundSteps) expect(screen.getByText(step)).toBeVisible();
    expect(screen.getByText('0x2222…2222')).toBeVisible();
    expect(mockFetch).toHaveBeenCalledWith(`/api/agent/purchases?address=${address}`, expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }));
    expect(screen.queryByRole('table')).toBeNull();
    expect(track).not.toHaveBeenCalled();
  });

  it('erases proof immediately, preserves URL and history state, then verifies once after sign-in (StrictMode)', async () => {
    landing();
    const replace = vi.spyOn(window.history, 'replaceState');
    const verification = deferred<Response>();
    mockFetch.mockImplementation(async (url) => String(url).endsWith('/verify') ? verification.promise : response(success()));
    const view = mount({}, true);
    expect(window.location.hash).toBe('');
    expect(replace).toHaveBeenCalledWith({ keep: 'next-history' }, '', `/en/agent?address=${address}`);
    expect(screen.getByRole('status')).toHaveTextContent(c.continueAfterSignIn);
    expect(mockFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: c.signIn }));
    await waitFor(() => expect(h.signIn).toHaveBeenCalled());
    h.sessionAddress = owner; view.update();
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('status')).toHaveTextContent(c.verifying);
    expect(mockFetch).toHaveBeenCalledWith('/api/agent/proof/verify', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proof: encodeProof() }) });
    expect(view.container.textContent).not.toContain(encodeProof());
    await act(async () => { verification.resolve(response({ address, boundAt: '2026-09-23T09:00:00Z' })); });
    await screen.findByRole('table');
    expect(screen.getByRole('status')).toHaveTextContent(c.bound);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(track).toHaveBeenCalledWith('agent_proof_bound', { locale: 'en' });
    expect(track).toHaveBeenCalledWith('agent_purchases_view', { locale: 'en' });
    for (const call of vi.mocked(track).mock.calls) expect(call[1]).toEqual({ locale: 'en' });
    view.update();
    expect(track).toHaveBeenCalledTimes(3);
  });

  it.each([['ja', true], ['en', true], ['en', false]] as const)('requires explicit owner confirmation in %s when wallet connected=%s but isSignedIn is false', async (locale, connected) => {
    h.sessionAddress = owner; h.isSignedIn = false; h.mismatch = connected; landing();
    const copy = agentPageContentFor(locale).purchases;
    mount({ locale, c: copy, isConnected: connected }, true);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('');
    expect(screen.getByText(copy.bindConfirm.replace('{owner}', owner))).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: copy.confirmBind }));
    await screen.findByRole('table');
    expect(mockFetch.mock.calls.filter(([url]) => String(url).endsWith('/verify'))).toHaveLength(1);
  });

  it.each(['ja', 'en'])('announces the full checksummed owner before binding in %s', (locale) => {
    const checksummed = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
    h.sessionAddress = checksummed.toLowerCase(); h.isSignedIn = false; landing();
    const copy = agentPageContentFor(locale).purchases;
    mount({ locale, c: copy });
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(copy.bindConfirm.replace('{owner}', checksummed));
    expect(status).toHaveClass('break-all');
    expect(screen.getByRole('button', { name: copy.confirmBind })).toHaveAccessibleDescription(copy.bindConfirm.replace('{owner}', checksummed));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('cancels a pending proof without posting it', async () => {
    h.sessionAddress = owner; h.isSignedIn = false; landing();
    mount();
    expect(mockFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: c.cancelBind }));
    await screen.findByRole('table');
    expect(mockFetch.mock.calls.some(([url]) => String(url).endsWith('/verify'))).toBe(false);
  });

  it('shows a new owner in confirmation after session changes', async () => {
    h.sessionAddress = owner; h.isSignedIn = false; landing();
    const view = mount();
    h.sessionAddress = other; view.update();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(screen.getByText(c.bindConfirm.replace('{owner}', other))).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: c.confirmBind }));
    await screen.findByRole('table');
  });

  it('requires confirmation for a different proof Agent and reports/invalidate that Agent only', async () => {
    h.sessionAddress = owner; landing(encodeProof(other));
    mockFetch.mockImplementation(async (url) => String(url).endsWith('/verify') ? response({ address: other }) : response({ reason: 'not_bound' }, 401));
    const { qc } = mount({}, true);
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(screen.getByText(c.proofAddressMismatch.replace('{proofAddress}', other).replace('{cardAddress}', address))).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: c.confirmBind }));
    await screen.findByText(c.boundOther.replace('{address}', other));
    expect(screen.queryByText(c.bound, { exact: true })).toBeNull();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['agent-purchases', other, owner] });
    expect(mockFetch.mock.calls.filter(([url]) => String(url).endsWith('/verify'))).toHaveLength(1);
  });

  it('also requires confirmation when proof matches the saved card but differs from the URL Agent', async () => {
    h.sessionAddress = owner;
    window.history.replaceState(null, '', `/en/agent?address=${other}#proof=${encodeProof()}`);
    mount();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(screen.getByText(c.proofLinkAddressMismatch.replace('{proofAddress}', address).replace('{linkAddress}', other))).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: c.confirmBind }));
    await screen.findByRole('table');
  });

  it('retains an unsubmitted proof when the user accepts a different card address', async () => {
    h.sessionAddress = owner;
    landing(encodeProof());
    const view = mount({ address: other }, true);
    expect(mockFetch).not.toHaveBeenCalled();
    view.update({ address });
    await screen.findByRole('table');
    expect(mockFetch.mock.calls.filter(([url]) => String(url).endsWith('/verify'))).toHaveLength(1);
  });

  it('automatically continues a pending proof when the connected wallet matches the session', async () => {
    h.sessionAddress = owner; h.isSignedIn = false; landing();
    const view = mount();
    expect(mockFetch).not.toHaveBeenCalled();
    h.isSignedIn = true; view.update();
    await screen.findByRole('table');
    expect(mockFetch.mock.calls.filter(([url]) => String(url).endsWith('/verify'))).toHaveLength(1);
  });

  it('compares proof and card addresses without case sensitivity', async () => {
    const agent = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa';
    h.sessionAddress = owner;
    window.history.replaceState(null, '', `/en/agent?address=${agent}#proof=${encodeProof(agent)}`);
    mount({ address: agent.toLowerCase() });
    await screen.findByRole('table');
    expect(mockFetch.mock.calls.filter(([url]) => String(url).endsWith('/verify'))).toHaveLength(1);
  });

  it.each(['not-a-proof', `${encodeProof()}=`, encodeProof(address, { v: 2 }), encodeProof(address, { audience: 'evil' })])('does not submit a malformed proof envelope %s', async (proof) => {
    h.sessionAddress = owner; landing(proof);
    mount();
    await screen.findByText(c.failures.malformed);
    expect(mockFetch.mock.calls.some(([url]) => String(url).endsWith('/verify'))).toBe(false);
  });

  it.each(Object.keys(c.failures) as (keyof typeof c.failures)[])('shows the fixed proof failure for %s', async (reason) => {
    h.sessionAddress = owner; landing();
    mockFetch.mockResolvedValue(response({ reason }, reason === 'feature_disabled' ? 404 : reason === 'storage_error' ? 503 : 401));
    mount();
    expect(await screen.findByText(c.failures[reason])).toBeVisible();
    // verify の失敗後も一覧の取得は行う (紐づけ済みの持ち主が一覧を失わない)。ここでは一覧も失敗する mock なので table は出ない。
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(reason === 'binding_limit' ? 3 : 2));
    expect(screen.queryByRole('table')).toBeNull();
    expect(track).not.toHaveBeenCalled();
  });

  it.each(['unknown_reason', 'toString'])('maps unknown proof failure %s to storage_error', async (reason) => {
    h.sessionAddress = owner; landing();
    mockFetch.mockResolvedValue(response({ reason }, 401));
    mount();
    await screen.findByText(c.failures.storage_error);
  });

  it('maps non-JSON verify 404 to feature_disabled and does not retry', async () => {
    h.sessionAddress = owner; landing();
    mockFetch.mockResolvedValue(new Response('Not found', { status: 404 }));
    mount();
    await screen.findByText(c.failures.feature_disabled);
    // verify は 1 回だけ (再試行しない)。その後の一覧取得 1 回は別。
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(mockFetch.mock.calls.filter(([url]) => String(url).endsWith('/verify'))).toHaveLength(1);
  });

  it.each(['read', 'verify'])('isolates a %s network failure in the panel', async (operation) => {
    h.sessionAddress = owner;
    if (operation === 'verify') landing();
    mockFetch.mockRejectedValue(new Error('offline'));
    mount();
    await screen.findByText(c.error);
    expect(screen.queryByRole('table')).toBeNull();
    // verify の失敗後も一覧の取得は 1 回行う (再試行はしない)。
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(operation === 'verify' ? 2 : 1));
  });

  it.each([503, 429])('shows the general read error for HTTP %s', async (status) => {
    h.sessionAddress = owner;
    mockFetch.mockResolvedValue(response({ reason: 'storage_error' }, status));
    mount();
    await screen.findByText(c.error);
  });

  it('returns to sign-in when the server rejects an expired session', async () => {
    h.sessionAddress = owner;
    mockFetch.mockResolvedValueOnce(response({ reason: 'not_signed_in' }, 401));
    const view = mount();
    await screen.findByRole('button', { name: c.signIn });
    expect(screen.queryByRole('table')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: c.signIn }));
    await screen.findByRole('table');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    view.update();
  });

  it.each(['ja', 'en'])('renders purchases, origins, fees, external hosts and disclosures in %s', async (locale) => {
    h.sessionAddress = owner;
    const copy = agentPageContentFor(locale).purchases;
    const items = [item(), item({ resourceOrigin: 'first-party', fee: undefined, asset: 'USDC', amount: '0.01', network: 'base', tx: '0xbb' }), item({ resource: { host: 'merchant.example', path: null, pathTag: 'a1b2c3d4' }, resourceOrigin: 'listed', network: 'unknown', tx: null })];
    mockFetch.mockResolvedValue(response(success(items, true)));
    const { container, qc } = mount({ locale, c: copy });
    const table = await screen.findByRole('table');
    for (const label of [copy.colDate, copy.colItem, copy.colAmount]) expect(within(table).getByRole('columnheader', { name: label })).toHaveAttribute('scope', 'col');
    for (const label of [copy.originFirstParty, copy.originListed, copy.originClaimed, copy.truncated, copy.sinceNote, copy.caveat, 'merchant.example', 'a1b2c3d4', '0.01 USDC', `+ 1 ${copy.feeSuffix}`]) expect(screen.getAllByText(label)[0]).toBeVisible();
    expect(screen.queryByText('open-pay.jp')).toBeNull();
    const links = screen.getAllByRole('link', { name: copy.viewTx });
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute('href', `https://polygonscan.com/tx/${items[0].tx}`);
    expect(links[1]).toHaveAttribute('href', 'https://basescan.org/tx/0xbb');
    for (const link of links) { expect(link).toHaveAttribute('target', '_blank'); expect(link).toHaveAttribute('rel', 'noopener noreferrer'); }
    expect(table.parentElement).toHaveClass('overflow-x-auto', 'min-w-0', 'max-w-full');
    expect(container.querySelector('section')).toHaveClass('min-w-0', 'break-words');
    expect(container.querySelector('[aria-label]')).toBeNull();
    expect(screen.getByRole('button', { name: copy.unbind })).toHaveAccessibleName(copy.unbind);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(qc.getQueryCache().getAll()[0].options).toMatchObject({ staleTime: 30_000, refetchOnWindowFocus: false, gcTime: 0 });
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith('agent_purchases_view', { locale });
  });

  it('shows an empty bound history with the same disclosures and unlink action', async () => {
    h.sessionAddress = owner;
    mockFetch.mockResolvedValue(response(success([])));
    mount();
    await screen.findByText(c.empty);
    expect(screen.getByText(c.sinceNote)).toBeVisible();
    expect(screen.getByText(c.caveat)).toBeVisible();
    expect(screen.getByRole('button', { name: c.unbind })).toBeEnabled();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('requires a second unlink click, supports Escape, and clears the table only after success', async () => {
    h.sessionAddress = owner;
    const confirm = vi.spyOn(window, 'confirm');
    const unlink = deferred<Response>();
    mockFetch.mockImplementation(async (url) => String(url).endsWith('/unbind') ? unlink.promise : response(success()));
    mount();
    await screen.findByRole('table');
    const button = screen.getByRole('button', { name: c.unbind });
    fireEvent.click(button);
    expect(screen.getByRole('status')).toHaveTextContent(c.unbindConfirm);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(button, { key: 'Escape' });
    expect(screen.queryByText(c.unbindConfirm)).toBeNull();
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(button).toBeDisabled();
    expect(mockFetch).toHaveBeenLastCalledWith('/api/agent/proof/unbind', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address }) });
    expect(confirm).not.toHaveBeenCalled();
    await act(async () => { unlink.resolve(new Response(null, { status: 204 })); });
    await screen.findByText(c.notBoundLead);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('button', { name: c.unbind })).toBeNull();
  });

  it.each([[401, 'not_bound'], [404, 'not_bound'], [401, 'not_signed_in'], [404, 'not_found']] as const)('clears stale rows when unlink returns %s %s', async (status, reason) => {
    h.sessionAddress = owner;
    mockFetch.mockImplementation(async (url) => String(url).endsWith('/unbind') ? response({ reason }, status) : response(success()));
    mount();
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: c.unbind }));
    fireEvent.click(screen.getByRole('button', { name: c.unbind }));
    if (reason === 'not_signed_in') await screen.findByRole('button', { name: c.signIn });
    else await screen.findByText(reason === 'not_bound' ? c.notBoundLead : c.failures.feature_disabled);
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('asks for sign-in when proof verification finds an expired cookie, without replaying proof', async () => {
    h.sessionAddress = owner; landing();
    mockFetch.mockResolvedValueOnce(response({ reason: 'not_signed_in' }, 401));
    mount();
    await screen.findByRole('button', { name: c.signIn });
    fireEvent.click(screen.getByRole('button', { name: c.signIn }));
    await screen.findByRole('table');
    expect(mockFetch.mock.calls.filter(([url]) => String(url).endsWith('/verify'))).toHaveLength(1);
  });

  it('does not pretend unlink succeeded after a storage failure', async () => {
    h.sessionAddress = owner;
    mockFetch.mockImplementation(async (url) => String(url).endsWith('/unbind') ? response({ reason: 'storage_error' }, 503) : response(success()));
    mount();
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: c.unbind }));
    fireEvent.click(screen.getByRole('button', { name: c.unbind }));
    await screen.findByText(c.error);
    expect(screen.getByRole('table')).toBeVisible();
    expect(screen.queryByText(c.notBoundLead)).toBeNull();
  });

  it('removes private rows on owner changes and logout, and reauthorizes a returning owner', async () => {
    h.sessionAddress = owner;
    const view = mount();
    await screen.findByRole('table');
    mockFetch.mockImplementation(async () => response({ reason: 'not_bound' }, 401));
    h.sessionAddress = other; view.update();
    expect(screen.queryByRole('table')).toBeNull();
    await screen.findByText(c.notBoundLead);
    h.sessionAddress = null; view.update();
    expect(screen.getByRole('button', { name: c.signIn })).toBeVisible();
    h.sessionAddress = owner; view.update();
    expect(screen.queryByRole('table')).toBeNull();
    await screen.findByText(c.notBoundLead);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('does not let a delayed previous Agent response replace the selected Agent', async () => {
    h.sessionAddress = owner;
    const first = deferred<Response>();
    mockFetch.mockImplementation(async (url) => String(url).includes(address) ? first.promise : response({ reason: 'not_bound' }, 401));
    const view = mount();
    view.update({ address: other });
    await screen.findByText(c.notBoundLead);
    await act(async () => { first.resolve(response(success())); });
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('keeps the panel working when analytics throws', async () => {
    h.sessionAddress = owner; landing();
    vi.mocked(track).mockImplementation(() => { throw new Error('analytics unavailable'); });
    mockFetch.mockImplementation(async (url) => String(url).endsWith('/verify') ? response({ address }) : response(success()));
    mount();
    await screen.findByRole('table');
    expect(screen.getByRole('status')).toHaveTextContent(c.bound);
    vi.mocked(track).mockReset();
  });

  it('renders and fetches nothing when the client flag is off', () => {
    h.enabled = false; landing();
    const { container } = mount();
    expect(container).toBeEmptyDOMElement();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  it('keeps a history API failure isolated and does not submit proof left in the URL', async () => {
    h.sessionAddress = owner; landing();
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => { throw new Error('denied'); });
    mount();
    await screen.findByText(c.error);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([false, true])('matches SSR and the initial client render before reading proof (signed in: %s)', async (signedIn) => {
    h.sessionAddress = signedIn ? owner : null;
    landing();
    mockFetch.mockImplementation(async (url) => String(url).endsWith('/verify') ? response({ address }) : response(success()));
    const qc = client();
    const wrap = (child: React.ReactNode) => <NextIntlClientProvider locale="en" messages={en}><QueryClientProvider client={qc}>{child}</QueryClientProvider></NextIntlClientProvider>;
    const ui = <AgentPurchases address={address} locale="en" c={c} isConnected />;
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root: Root | undefined;
    try {
      const html = renderToString(wrap(ui));
      container.innerHTML = html;
      expect(window.location.hash).toBe(`#proof=${encodeProof()}`);
      let initial = '';
      function Probe() { useLayoutEffect(() => { initial = container.innerHTML; }, []); return ui; }
      const onRecoverableError = vi.fn();
      await act(async () => { root = hydrateRoot(container, wrap(<Probe />), { onRecoverableError }); });
      expect(initial).toBe(html);
      expect(onRecoverableError).not.toHaveBeenCalled();
      expect(window.location.hash).toBe('');
      if (signedIn) await within(container).findByRole('table');
      else expect(within(container).getByRole('status')).toHaveTextContent(c.continueAfterSignIn);
    } finally {
      if (root) await act(async () => { root?.unmount(); });
      container.remove();
    }
  });

  it('shows the connect hint instead of a sign-in button while no wallet is connected', () => {
    mount({ isConnected: false });
    expect(screen.queryByRole('button', { name: c.signIn })).toBeNull();
    expect(screen.getByText(c.connectFirst)).toBeInTheDocument();
    expect(h.signIn).not.toHaveBeenCalled();
  });

  it('keeps showing an already-bound list when a stale link fails verification', async () => {
    h.sessionAddress = owner; landing();
    mockFetch.mockImplementation(async (url) => String(url).endsWith('/verify')
      ? response({ reason: 'expired_or_unknown' }, 401)
      : response(success([item()])));
    mount();
    await screen.findByText(c.failures.expired_or_unknown);
    await screen.findByRole('table');
  });
});

describe('G4: linked agents', () => {
  async function openList() {
    const summary = await screen.findByText(c.bindingsTitle);
    const details = summary.closest('details')!;
    details.open = true;
    fireEvent(details, new Event('toggle'));
  }
  function stubBindings() {
    mockFetch.mockImplementation(async (url) => String(url).endsWith('/bindings')
      ? response({ addresses: [{ address: other, boundAt: '2026-09-23T09:00:00.000Z' }] })
      : response(success()));
  }

  it.each(['ja', 'en'])('gives each row a visible unlink label naming its address in %s', async (locale) => {
    h.sessionAddress = owner;
    const copy = agentPageContentFor(locale).purchases;
    mockFetch.mockImplementation(async (url) => String(url).endsWith('/bindings')
      ? response({ addresses: [address, other].map((agent) => ({ address: agent, boundAt: '2026-09-23T09:00:00.000Z' })) })
      : response(success()));
    mount({ locale, c: copy });
    const details = (await screen.findByText(copy.bindingsTitle)).closest('details')!;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    for (const agent of [address, other]) {
      const row = (await screen.findByText(agent)).closest('li')!;
      const button = within(row).getByRole('button');
      const label = locale === 'ja' ? `Agent ${agent} の紐づけを解除` : `Unlink agent ${agent}`;
      expect(button).toHaveAccessibleName(label);
      expect(button).toHaveTextContent(label);
      expect(button).not.toHaveAttribute('aria-label');
    }
    expect(screen.getByRole('button', { name: copy.unbind })).toBeVisible();
  });

  it('fetches only when expanded, and clears linked addresses on owner changes and logout', async () => {
    h.sessionAddress = owner;
    stubBindings();
    const view = mount();
    await screen.findByRole('table');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await openList();
    await screen.findByText(other);
    h.sessionAddress = address; view.update();
    expect(screen.queryByText(other)).toBeNull();
    await openList();
    await screen.findByText(other);
    h.sessionAddress = null; view.update();
    expect(screen.queryByText(other)).toBeNull();
    expect(screen.queryByText(c.bindingsTitle)).toBeNull();
  });

  it('hides a late binding response from the previous owner', async () => {
    h.sessionAddress = owner;
    const pending = deferred<Response>();
    mockFetch.mockImplementation(async (url) => String(url).endsWith('/bindings') ? pending.promise : response(success()));
    const view = mount();
    await openList();
    await waitFor(() => expect(mockFetch.mock.calls.some(([url]) => String(url).endsWith('/bindings'))).toBe(true));
    h.sessionAddress = address; view.update();
    await act(async () => { pending.resolve(response({ addresses: [{ address: other, boundAt: '2026-09-23T09:00:00.000Z' }] })); });
    expect(screen.queryByText(other)).toBeNull();
  });

  it.each(['read', 'unbind'])('requires sign-in if a bindings %s rejects the session', async (operation) => {
    h.sessionAddress = owner;
    mockFetch.mockImplementation(async (url) => {
      if (String(url).endsWith('/bindings')) return operation === 'read'
        ? response({ reason: 'not_signed_in' }, 401)
        : response({ addresses: [{ address: other, boundAt: '2026-09-23T09:00:00.000Z' }] });
      if (String(url).endsWith('/unbind')) return response({ reason: 'not_signed_in' }, 401);
      return response(success());
    });
    mount();
    await openList();
    if (operation === 'unbind') {
      const row = (await screen.findByText(other)).closest('li')!;
      const button = within(row).getByRole('button', { name: c.unbindAddress.replace('{address}', other) });
      fireEvent.click(button); fireEvent.click(button);
    }
    await screen.findByRole('button', { name: c.signIn });
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText(other)).toBeNull();
  });

  it('keeps bindings and purchases visible when unlink fails', async () => {
    h.sessionAddress = owner;
    stubBindings();
    const original = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(async (url, init) => String(url).endsWith('/unbind') ? response({ reason: 'storage_error' }, 503) : original(url, init));
    mount();
    await openList();
    const row = (await screen.findByText(other)).closest('li')!;
    const button = within(row).getByRole('button', { name: c.unbindAddress.replace('{address}', other) });
    fireEvent.click(button);
    expect(button).toHaveAccessibleDescription(c.unbindAddressConfirm.replace('{address}', other));
    fireEvent.click(button);
    await screen.findByText(c.failures.storage_error);
    expect(screen.getByText(other)).toBeVisible();
    expect(screen.getByRole('table')).toBeVisible();
  });

  it('clears current purchases when that address is unlinked from the list', async () => {
    h.sessionAddress = owner;
    mockFetch.mockImplementation(async (url) => String(url).endsWith('/bindings')
      ? response({ addresses: [{ address, boundAt: '2026-09-23T09:00:00.000Z' }] })
      : String(url).endsWith('/unbind') ? new Response(null, { status: 204 }) : response(success()));
    mount();
    await openList();
    const row = (await screen.findByText(address)).closest('li')!;
    const button = within(row).getByRole('button', { name: c.unbindAddress.replace('{address}', address) });
    fireEvent.click(button); fireEvent.click(button);
    await screen.findByText(c.bindingsEmpty);
    await screen.findByText(c.notBoundLead);
    expect(screen.queryByRole('table')).toBeNull();
  });

  it.each(['ja', 'en'])('lists and unlinks a remembered address after binding_limit in %s', async (locale) => {
    h.sessionAddress = owner; landing();
    const copy = agentPageContentFor(locale).purchases;
    let bindings = [{ address: other, boundAt: '2026-09-23T09:00:00.000Z' }];
    mockFetch.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/verify')) return response({ reason: 'binding_limit' }, 401);
      if (String(url).endsWith('/bindings')) return response({ addresses: bindings });
      if (String(url).endsWith('/unbind')) {
        expect(JSON.parse(String(init?.body))).toEqual({ address: other });
        bindings = [];
        return new Response(null, { status: 204 });
      }
      return response({ reason: 'not_bound' }, 401);
    });
    mount({ locale, c: copy });
    await screen.findByText(copy.failures.binding_limit);
    const row = (await screen.findByText(other)).closest('li')!;
    expect(within(row).getByText(/2026/).closest('time')).toHaveAttribute('dateTime', bindings[0].boundAt);
    const unlink = within(row).getByRole('button', { name: copy.unbindAddress.replace('{address}', other) });
    fireEvent.click(unlink);
    expect(mockFetch.mock.calls.filter(([url]) => String(url).endsWith('/unbind'))).toHaveLength(0);
    fireEvent.keyDown(unlink, { key: 'Escape' });
    fireEvent.click(unlink);
    fireEvent.click(unlink);
    await waitFor(() => expect(screen.queryByText(other)).toBeNull());
    await waitFor(() => expect(screen.queryByText(copy.failures.binding_limit)).toBeNull());
    expect(mockFetch).toHaveBeenCalledWith('/api/agent/purchases/bindings', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }));
    expect(mockFetch.mock.calls.filter(([url]) => String(url).endsWith('/unbind'))).toHaveLength(1);
    expect(mockFetch.mock.calls.filter(([url]) => String(url).endsWith('/verify'))).toHaveLength(1);
  });
});
