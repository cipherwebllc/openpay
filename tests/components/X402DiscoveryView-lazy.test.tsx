import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { X402DiscoveryView } from '@/components/X402DiscoveryView';
import { renderWithIntl } from '../_helpers/i18n';

const auth = vi.hoisted(() => ({
  address: undefined as string | undefined,
  connected: false,
  signedIn: false,
  signIn: vi.fn(async () => {}),
}));
const chunk = vi.hoisted(() => {
  let resolve!: () => void;
  let resolveForm!: () => void;
  const pending = new Promise<void>((done) => { resolve = done; });
  const form = new Promise<void>((done) => { resolveForm = done; });
  return { pending, resolve, form, resolveForm, requested: vi.fn(), loaded: vi.fn(), prefetchedOwned: vi.fn() };
});

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: auth.address, isConnected: auth.connected }),
}));
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({ isSignedIn: auth.signedIn, isSigningIn: false, signIn: auth.signIn }),
}));
vi.mock('@/components/ConnectButton', () => ({
  ConnectButton: () => <button type="button">Connect fixture</button>,
}));
vi.mock('@/components/x402/DiscoveryOwnedResources', async (importOriginal) => {
  chunk.prefetchedOwned();
  return importOriginal<typeof import('@/components/x402/DiscoveryOwnedResources')>();
});
// 実物の next/dynamic に渡す loader を遅らせる。static import に戻る回帰でも test の収集は止めない。
vi.mock('next/dynamic', async (importOriginal) => {
  const { default: dynamic } = await importOriginal<typeof import('next/dynamic')>();
  const delayed: typeof dynamic = (loader, options) => {
    if (typeof loader !== 'function') throw new Error('Expected a dynamic loader');
    return dynamic(async () => {
      // import の解決を待たず、loader が呼ばれた瞬間を記録する。
      chunk.requested();
      const imported = await loader();
      const component = 'default' in imported ? imported.default : imported;
      chunk.loaded(component.name);
      await (component.name === 'DiscoveryRegistrationForm' ? chunk.form : chunk.pending);
      return imported;
    }, options);
  };
  return { default: delayed };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('keeps auth eager and preserves drafts, expansion and pending feedback when the owner chunk arrives', async () => {
  const address = '0x1111111111111111111111111111111111111111';
  const resource = {
    id: 'owned-a', title: 'Owned fixture', url: 'https://example.com/owned',
    description: 'Owned description', priceJpyc: '101', category: 'api', payTo: address,
  };
  let finishSubmission!: (value: Response) => void;
  const pendingSubmission = new Promise<Response>((resolve) => { finishSubmission = resolve; });
  let finishOwned!: (value: Response) => void;
  const pendingOwned = new Promise<Response>((resolve) => { finishOwned = resolve; });
  const reply = (body: unknown) => ({ ok: true, json: async () => body }) as Response;
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return pendingSubmission;
    if (url === '/api/facilitator/resources') return pendingOwned;
    return reply({ items: [{ ...resource, resource: resource.url, title: 'Catalog fixture', license: 'Catalog license', accepts: [] }] });
  });
  vi.stubGlobal('fetch', fetchFn);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => (
    <QueryClientProvider client={qc}>
      <X402DiscoveryView maxResourcesPerMerchant={100} />
    </QueryClientProvider>
  );
  const view = renderWithIntl(tree());

  expect(screen.getByRole('button', { name: 'Connect fixture' })).toBeInTheDocument();
  expect(chunk.requested).not.toHaveBeenCalled();
  expect(screen.queryAllByRole('status')).toHaveLength(0);
  await screen.findByText('Catalog fixture');
  expect(chunk.requested).not.toHaveBeenCalled();
  expect(chunk.prefetchedOwned).not.toHaveBeenCalled();
  expect(screen.queryAllByRole('status')).toHaveLength(0);
  auth.address = address;
  auth.connected = true;
  view.rerender(tree());
  fireEvent.click(screen.getByRole('button', { name: 'ウォレットでサインイン' }));
  expect(auth.signIn).toHaveBeenCalledOnce();
  expect(chunk.requested).not.toHaveBeenCalled();
  expect(chunk.prefetchedOwned).not.toHaveBeenCalled();
  expect(screen.queryAllByRole('status')).toHaveLength(0);

  auth.signedIn = true;
  view.rerender(tree());
  // 一覧の応答前に先読みする。一覧の dynamic loader 自体はまだ呼ばれない。
  await waitFor(() => expect(chunk.prefetchedOwned).toHaveBeenCalledOnce());
  expect(chunk.requested).toHaveBeenCalledOnce();
  expect(screen.getAllByRole('status')).toHaveLength(1);
  await act(async () => finishOwned(reply({ resources: [resource] })));
  await waitFor(() => expect(screen.getAllByRole('status')).toHaveLength(2));
  await waitFor(() => expect(chunk.requested).toHaveBeenCalledTimes(2));
  expect(screen.queryByPlaceholderText('https://api.example.jp/paid/weather')).not.toBeInTheDocument();
  // フォームの chunk が先に到着し、一覧はまだ読み込み中でも出品できる。
  await act(async () => chunk.resolveForm());
  const input = await screen.findByPlaceholderText('https://api.example.jp/paid/weather');
  expect(screen.getByRole('status')).toHaveTextContent('読み込み中…');
  expect(screen.getByRole('status').closest('section')).toHaveAttribute('aria-busy', 'true');
  await waitFor(() => expect(chunk.loaded.mock.calls).toEqual(expect.arrayContaining([
    ['DiscoveryRegistrationForm'], ['DiscoveryOwnedResources'],
  ])));
  expect(screen.queryByText('Owned fixture')).not.toBeInTheDocument();
  const registration = input.closest('section')!;
  fireEvent.click(screen.getByText('新しい API を出品する'));
  await waitFor(() => expect(registration.querySelector('details')).toHaveAttribute('open'));
  fireEvent.change(input, { target: { value: 'https://example.com/draft' } });
  fireEvent.click(screen.getByRole('checkbox', { name: '正当な権利と支払い制限を確認しました' }));
  const card = screen.getByText('Catalog fixture').closest('li')!;
  fireEvent.click(within(card).getByRole('button', { name: '続きを読む' }));
  fireEvent.click(screen.getByRole('button', { name: '登録する' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '登録中…' })).toBeDisabled());

  await act(async () => chunk.resolve());
  await screen.findByText('Owned fixture');
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(screen.getByPlaceholderText('https://api.example.jp/paid/weather')).toBe(input);
  expect(input).toHaveValue('https://example.com/draft');
  expect(registration.querySelector('details')).toHaveAttribute('open');
  expect(screen.getByRole('checkbox', { name: '正当な権利と支払い制限を確認しました' })).toBeChecked();
  expect(within(card).getByRole('button', { name: '閉じる' })).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('button', { name: '登録中…' })).toBeDisabled();

  await act(async () => finishSubmission(reply({ resource, paywallSnippet: 'created gate' })));
  expect(await screen.findByText('登録しました。')).toBeVisible();
  expect(screen.getByText('created gate')).toBeVisible();
  expect(fetchFn.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  await waitFor(() => expect(qc.isFetching()).toBe(0));
  view.unmount();
  qc.clear();
});
