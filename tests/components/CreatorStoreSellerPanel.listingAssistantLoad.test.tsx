// AI 出品アシスタントの本体 (next/dynamic の chunk) の読み込みに失敗しても、未保存の出品フォームを失わない。
// 実物の next/dynamic に渡す loader を包み、ListingAssistant の読み込みだけを失敗させる (通信断の ChunkLoadError の代わり)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ComponentType } from 'react';
import { renderWithIntl } from '../_helpers/i18n';
import ja from '@/messages/ja.json';
import { jsonResponse } from '../_helpers/listingAssistantFixtures';

const ADDRESS = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const chunk = vi.hoisted(() => ({ fail: true, attempts: 0 }));

// 本番の app router は next/dynamic を React.lazy の実装 (next/dist/shared/lib/app-dynamic) に差し替える (読み込みの失敗は
// 例外として親へ伝わる)。vitest が解決する next/dynamic は pages 向けの実装 (失敗を loading に渡す) なので、本番の方を使う。
vi.mock('next/dynamic', async () => {
  const { default: dynamic } = (await import('next/dist/shared/lib/app-dynamic')) as unknown as typeof import('next/dynamic');
  const wrapped: typeof dynamic = (loader, options) => {
    if (typeof loader !== 'function') throw new Error('Expected a dynamic loader');
    return dynamic(async () => {
      const imported = await loader();
      const component = ('default' in imported ? imported.default : imported) as ComponentType;
      if (component.name === 'ListingAssistant') {
        chunk.attempts += 1;
        if (chunk.fail) throw new Error('Loading chunk 4062 failed.');
      }
      return imported;
    }, options);
  };
  return { default: wrapped };
});
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, enableCreatorStoreUi: true, enableLicenseNftUi: false } };
});
vi.mock('@/hooks/useStoreCacheScope', () => ({ useStoreCacheScope: () => {} }));
vi.mock('wagmi', () => ({ useAccount: () => ({ isConnected: true, address: ADDRESS }) }));
vi.mock('@/components/ConnectButton', () => ({ ConnectButton: () => <button type="button">Connect wallet</button> }));
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({
    isSignedIn: true, sessionAddress: ADDRESS, signIn: vi.fn(), isSigningIn: false, signInError: null,
    signOut: vi.fn(), mismatch: false, isLoading: false,
  }),
}));

import { CreatorStoreSellerPanel } from '@/components/CreatorStoreSellerPanel';

const A = ja.CreatorStoreSeller.assistant;

beforeEach(() => {
  chunk.fail = true;
  chunk.attempts = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/store/seller') return jsonResponse({ ok: true, seller: null, listingAssistant: true });
    if (url === '/api/store/products') return jsonResponse({ ok: true, products: [], max: 24 });
    return jsonResponse({ ok: false, error: 'unexpected' }, 500);
  }));
  // React は境界で受け止めた例外も console.error に出す (この test では想定どおりの出力)。
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithIntl(
    <QueryClientProvider client={client}>
      <CreatorStoreSellerPanel handle="alice" />
    </QueryClientProvider>,
  );
}

async function fillForm() {
  await screen.findByRole('heading', { name: '新しい商品' });
  fireEvent.change(screen.getByLabelText('商品名'), { target: { value: '手で書いた商品名' } });
  fireEvent.change(screen.getByLabelText('説明 (任意)'), { target: { value: '手で書いた説明' } });
  fireEvent.change(screen.getByLabelText('価格 (JPYC)'), { target: { value: '500' } });
}

describe('AI 出品アシスタントの本体の読み込みに失敗したとき', () => {
  it('アシスタントの所だけに案内を出し、未保存のフォームの値は残る・もう一度読める', async () => {
    renderPanel();
    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: A.open }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(A.loadFailed);
    expect(chunk.attempts).toBe(1);
    expect(screen.getByLabelText('商品名')).toHaveValue('手で書いた商品名');
    expect(screen.getByLabelText('説明 (任意)')).toHaveValue('手で書いた説明');
    expect(screen.getByLabelText('価格 (JPYC)')).toHaveValue('500');
    // 手入力は続けられる。
    fireEvent.change(screen.getByLabelText('商品名'), { target: { value: '続けて直した商品名' } });
    expect(screen.getByLabelText('商品名')).toHaveValue('続けて直した商品名');

    // もう一度読む: 失敗を覚えた読み込みを使い回さず、読み直す。
    chunk.fail = false;
    fireEvent.click(screen.getByRole('button', { name: A.loadRetry }));
    expect(await screen.findByRole('button', { name: A.generate })).toBeInTheDocument();
    expect(chunk.attempts).toBe(2);
    expect(screen.queryByText(A.loadFailed)).not.toBeInTheDocument();
    expect(screen.getByLabelText('商品名')).toHaveValue('続けて直した商品名');
  });

  it('閉じるとアシスタントを畳み、次に開くときは読み直す', async () => {
    renderPanel();
    await fillForm();
    const open = screen.getByRole('button', { name: A.open });
    fireEvent.click(open);
    await screen.findByRole('alert');
    // 前の test で失敗した初回の読み込みは React.lazy が失敗を覚えている (この test では loader を呼ばずに失敗する)。
    const attemptsBefore = chunk.attempts;
    fireEvent.click(screen.getByRole('button', { name: A.loadClose }));
    expect(open).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(A.loadFailed)).not.toBeInTheDocument();
    expect(screen.getByLabelText('商品名')).toHaveValue('手で書いた商品名');

    chunk.fail = false;
    fireEvent.click(open);
    expect(await screen.findByRole('button', { name: A.generate })).toBeInTheDocument();
    await waitFor(() => expect(chunk.attempts).toBe(attemptsBefore + 1));
    expect(screen.getByLabelText('商品名')).toHaveValue('手で書いた商品名');
  });
});
