import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CreatorStoreSellerPanel } from '@/components/CreatorStoreSellerPanel';
import { renderWithIntl } from '../_helpers/i18n';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';

const A = '0x00000000000000000000000000000000000000aa';
const B = '0x00000000000000000000000000000000000000bb';
const state = vi.hoisted(() => ({ wallet: '', session: null as string | null }));
vi.mock('wagmi', () => ({ useAccount: () => ({ isConnected: true, address: state.wallet }) }));
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({
    isSignedIn: state.session?.toLowerCase() === state.wallet.toLowerCase(), sessionAddress: state.session,
    signIn: vi.fn(), isSigningIn: false, signInError: null,
  }),
}));
vi.mock('@/components/ConnectButton', () => ({ ConnectButton: () => <button>Connect</button> }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, enableCreatorStoreUi: true, enableLicenseNftUi: false } };
});
// useStoreCacheScope and QueryClient stay real: the stale callback survives its observer's unmount.

function response(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function product(owner: string) {
  return {
    id: owner === A ? 'h_a' : 'h_b', payTo: owner, title: owner === A ? 'Product A' : 'Product B',
    priceJpyc: '1000', contentKind: 'text', label: 'prompt', saleActive: true,
    contentAvailable: true, usdcEnabled: true,
  };
}

function ownerResponse(url: string) {
  const owner = state.session!;
  if (url === '/api/store/seller') return response({ ok: true, seller: { name: `Seller ${owner}`, contact: 'seller@example.com', updatedAt: 1 } });
  if (url === '/api/store/products') return response({ ok: true, products: [product(owner)], max: 12 });
  return response({ ok: true, product: product(owner), content: { kind: 'text', value: `Private ${owner}` } });
}

function setup(locale: 'ja' | 'en' = 'ja') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const tree = (showPanel = true) => <QueryClientProvider client={client}>{showPanel ? <CreatorStoreSellerPanel handle="alice" /> : null}</QueryClientProvider>;
  const rendered = renderWithIntl(tree(), { locale });
  return { client, refresh: (showPanel = true) => rendered.rerender(tree(showPanel)) };
}

function content() {
  return document.getElementById('creator-store-product-content')!;
}

const targets = ['create', 'update', 'seller', 'toggle'] as const;
function openDisclosure() {
  const details = document.querySelector('details')!;
  if (!details.open) fireEvent.click(details.querySelector('summary')!);
}

async function startMutation(target: typeof targets[number]) {
  const row = within(screen.getByText('Product A').closest('li')!);
  if (target === 'toggle') {
    fireEvent.click(row.getByRole('checkbox'));
    return;
  }
  if (target === 'update') {
    fireEvent.click(row.getByRole('button', { name: '編集' }));
    await waitFor(() => expect(content()).toHaveValue(`Private ${A}`));
  }
  if (target === 'seller') openDisclosure();
  const field = screen.getByLabelText(target === 'seller' ? '氏名・名称' : '商品名');
  fireEvent.change(field, { target: { value: 'Draft A' } });
  if (target === 'create') {
    fireEvent.change(screen.getByLabelText('価格 (JPYC)'), { target: { value: '1000' } });
    fireEvent.change(content(), { target: { value: 'https://example.com/private' } });
  }
  fireEvent.submit(field.closest('form')!);
}

beforeEach(() => {
  state.wallet = A;
  state.session = A;
  vi.unstubAllGlobals();
});
afterEach(() => vi.restoreAllMocks());

describe('seller mutation completion stays in the starting account', () => {
  it.each(targets.flatMap((target) => ['direct', 'sign-out', 'wallet-first', 'return-to-A', 'tab-remount'].map((transition) => ({ target, transition }))))(
    'late $target refreshes only a mounted starting account after $transition', async ({ target, transition }) => {
      let resolve!: (value: Response) => void;
      const pending = new Promise<Response>((done) => { resolve = done; });
      let committed = false;
      const endpoint = target === 'seller' ? '/api/store/seller' : '/api/store/products';
      // Like a session cookie, the owner is read when fetch starts, not from the old query key.
      const requests: { url: string; method: string; owner: string | null }[] = [];
      vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
        requests.push({ url, method: init?.method ?? 'GET', owner: state.session });
        if (init?.method) return pending;
        if (committed && state.session === A && url === endpoint) {
          if (target === 'seller') return Promise.resolve(response({ ok: true, seller: { name: 'Saved seller', contact: 'seller@example.com', updatedAt: 2 } }));
          const saved = target === 'toggle' ? { ...product(A), saleActive: false } : { ...product(A), title: 'Saved product' };
          const products = target === 'create' ? [product(A), { ...saved, id: 'h_created' }] : [saved];
          return Promise.resolve(response({ ok: true, products, max: 12 }));
        }
        return Promise.resolve(ownerResponse(url));
      }));
      const { client, refresh } = setup();
      await screen.findByText('Product A');
      await startMutation(target);
      await waitFor(() => expect(requests.filter(({ method }) => method !== 'GET')).toHaveLength(1));
      const mutation = client.getMutationCache().getAll().find((entry) => entry.state.status === 'pending')!;
      if (transition === 'tab-remount') {
        refresh(false);
        expect(document.getElementById('creator-store-product-content')).toBeNull();
      } else if (transition === 'sign-out') {
        state.session = null;
      } else if (transition === 'wallet-first') {
        state.wallet = B;
      } else {
        state.wallet = B;
        state.session = B;
      }
      refresh();
      if (transition === 'tab-remount') await screen.findByText('Product A');
      if (transition === 'direct' || transition === 'return-to-A') await screen.findByText('Product B');
      if (transition === 'return-to-A') {
        state.wallet = A;
        state.session = A;
        refresh();
        await screen.findByText('Product A');
      }
      const returnedToA = transition === 'return-to-A' || transition === 'tab-remount';
      const hasEditor = transition === 'direct' || returnedToA;
      if (hasEditor) {
        openDisclosure();
        fireEvent.change(screen.getByLabelText('商品名'), { target: { value: 'Current draft' } });
        fireEvent.change(content(), { target: { value: 'Current private content' } });
        fireEvent.change(screen.getByLabelText('氏名・名称'), { target: { value: 'Current seller' } });
      } else {
        expect(document.getElementById('creator-store-product-content')).toBeNull();
      }
      const beforeCompletion = [...requests];
      await act(async () => {
        committed = true;
        resolve(response({ ok: true, product: product(A) }));
      });
      await waitFor(() => expect(mutation.state.status).toBe('success'));
      expect(requests).toEqual(returnedToA
        ? [...beforeCompletion, { url: endpoint, method: 'GET', owner: A }]
        : beforeCompletion);
      if (returnedToA) {
        if (target === 'toggle') {
          await waitFor(() => expect(within(screen.getByText('Product A').closest('li')!).getByRole('checkbox')).not.toBeChecked());
        } else {
          expect(await screen.findByText(target === 'seller' ? 'Saved seller' : 'Saved product')).toBeVisible();
        }
      }
      // Feedback/draft isolation already comes from remounting; the request assertion above catches S1.
      expect(screen.queryByText(ja.CreatorStoreSeller.productSaved)).not.toBeInTheDocument();
      expect(screen.queryByText(ja.CreatorStoreSeller.sellerSaved)).not.toBeInTheDocument();
      if (hasEditor) {
        expect(screen.getByLabelText('商品名')).toHaveValue('Current draft');
        expect(content()).toHaveValue('Current private content');
        expect(screen.getByLabelText('氏名・名称')).toHaveValue('Current seller');
      }
    },
  );

  it.each(targets)('%s still refetches in the same account before announcing success', async (target) => {
    const endpoint = target === 'seller' ? '/api/store/seller' : '/api/store/products';
    let saved = false;
    let resolve!: (value: Response) => void;
    const pendingRefetch = new Promise<Response>((done) => { resolve = done; });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method) { saved = true; return response({ ok: true }); }
      return saved && url === endpoint ? pendingRefetch : ownerResponse(url);
    });
    vi.stubGlobal('fetch', fetchMock);
    setup();
    await screen.findByText('Product A');
    await startMutation(target);
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url, init]) => url === endpoint && !init?.method)).toHaveLength(2));
    expect(screen.queryByText(ja.CreatorStoreSeller.productSaved)).not.toBeInTheDocument();
    expect(screen.queryByText(ja.CreatorStoreSeller.sellerSaved)).not.toBeInTheDocument();
    await act(async () => { resolve(ownerResponse(endpoint)); });
    if (target !== 'toggle') {
      const savedMessage = target === 'seller' ? ja.CreatorStoreSeller.sellerSaved : ja.CreatorStoreSeller.productSaved;
      expect(await screen.findByText(savedMessage)).toBeVisible();
      fireEvent.change(screen.getByLabelText(target === 'seller' ? '氏名・名称' : '商品名'), { target: { value: 'Next draft' } });
      expect(screen.queryByText(savedMessage)).not.toBeInTheDocument();
    }
  });
});

describe('seller editor shows the most recent failure', () => {
  const cases = [
    { error: 'invalid_product', detail: 'invalid title', key: 'detailInvalidTitle' },
    { error: 'usdc_pay_to_contract_wallet', key: 'usdcContractWalletError' },
    { error: 'storage_unavailable', key: 'requestError' },
  ] as const;
  it.each((['ja', 'en'] as const).flatMap((locale) => cases.map((failure) => ({ locale, ...failure }))))(
    '$locale renders the save $error message', async ({ locale, key, ...failure }) => {
      const messages = (locale === 'ja' ? ja : en).CreatorStoreSeller;
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method) return response({ ok: false, ...failure }, 400);
        if (url.endsWith('/h_a')) return response({ ok: true, product: product(A), content: null });
        return ownerResponse(url);
      }));
      setup(locale);
      const row = within((await screen.findByText('Product A')).closest('li')!);
      fireEvent.click(row.getByRole('button', { name: locale === 'ja' ? '編集' : 'Edit' }));
      const loadMessage = messages.requestError.replace('{error}', 'content_unavailable');
      await screen.findByText(loadMessage);
      const title = document.getElementById('creator-store-product-title')!;
      fireEvent.change(title, { target: { value: 'New draft' } });
      fireEvent.change(document.getElementById('creator-store-product-price')!, { target: { value: '1000' } });
      fireEvent.change(content(), { target: { value: 'https://example.com/private' } });
      fireEvent.submit(title.closest('form')!);
      await screen.findByText(messages[key].replace('{error}', failure.error));
      expect(screen.queryByText(loadMessage)).not.toBeInTheDocument();
      expect(title).toHaveValue('New draft');
      expect(content()).toHaveValue('https://example.com/private');
    },
  );

  it.each(['ja', 'en'] as const)('%s shows a newer load failure after a save failure', async (locale) => {
    const messages = (locale === 'ja' ? ja : en).CreatorStoreSeller;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method) return response({ ok: false, error: 'invalid_product', detail: 'invalid title' }, 400);
      if (url.endsWith('/h_a')) return response({ ok: true, product: product(A), content: null });
      return ownerResponse(url);
    }));
    setup(locale);
    await screen.findByText('Product A');
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const title = document.getElementById('creator-store-product-title')!;
    fireEvent.change(title, { target: { value: 'New draft' } });
    fireEvent.change(document.getElementById('creator-store-product-price')!, { target: { value: '1000' } });
    fireEvent.change(content(), { target: { value: 'https://example.com/private' } });
    fireEvent.submit(title.closest('form')!);
    expect(await screen.findByText(messages.detailInvalidTitle)).toBeVisible();
    now.mockReturnValue(2000);
    fireEvent.click(within(screen.getByText('Product A').closest('li')!).getByRole('button', { name: locale === 'ja' ? '編集' : 'Edit' }));
    expect(await screen.findByText(messages.requestError.replace('{error}', 'content_unavailable'))).toBeVisible();
    expect(screen.queryByText(messages.detailInvalidTitle)).not.toBeInTheDocument();
    expect(title).toHaveValue('New draft');
    expect(content()).toHaveValue('https://example.com/private');
  });
});
