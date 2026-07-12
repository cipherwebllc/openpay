// 受注タブの未対応件数バッジを実 react-query + fetch mock で検証。
// SIWE / flag / feed 障害時はタブ表示へ波及させず null、未対応があるときだけ数字を描画する。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const hold = vi.hoisted(() => ({
  isSignedIn: true,
  enableOrderRelay: true,
  orders: [] as Array<{ fulfilled: boolean }>,
  ok: true,
}));

vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({
    isSignedIn: hold.isSignedIn,
    sessionAddress: hold.isSignedIn ? '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' : null,
  }),
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableOrderRelay() {
        return hold.enableOrderRelay;
      },
    },
  };
});

import { OrdersTabBadge } from '@/components/OrdersTabBadge';

const fetchSpy = vi.fn(async () => ({
  ok: hold.ok,
  status: hold.ok ? 200 : 503,
  json: async () =>
    hold.ok
      ? { ok: true, orders: hold.orders }
      : { ok: false, error: 'kv_error' },
}) as Response);

function renderBadge() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <OrdersTabBadge />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  hold.isSignedIn = true;
  hold.enableOrderRelay = true;
  hold.orders = [];
  hold.ok = true;
  fetchSpy.mockClear();
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

describe('OrdersTabBadge', () => {
  it('サインイン済み + 未対応 N 件 → 数字のバッジを描画', async () => {
    hold.orders = [
      { fulfilled: false },
      { fulfilled: true },
      { fulfilled: false },
    ];
    renderBadge();
    expect(await screen.findByText('2')).toBeInTheDocument();
  });

  it('未対応 0 件 → null', async () => {
    hold.orders = [{ fulfilled: true }];
    const { container } = renderBadge();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(container).toBeEmptyDOMElement();
  });

  it('未サインイン → null、feed を取得しない', async () => {
    hold.isSignedIn = false;
    const { container } = renderBadge();
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('flag OFF → null、feed を取得しない', async () => {
    hold.enableOrderRelay = false;
    const { container } = renderBadge();
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('feed エラー → null (fail-quiet)', async () => {
    hold.ok = false;
    const { container } = renderBadge();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
