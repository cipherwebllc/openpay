// 受注閲覧トークン発行パネル (オーナー用) を実 react-query で検証。fetch のみ stub。
// 未発行→発行ボタン / 発行済→厨房ホールリンク(?t=)+再発行+取消 / DELETE で取消。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../../messages/ja.json';
import { OrderOperatorTokenPanel } from '@/components/OrderOperatorTokenPanel';

const TOKEN = 'a'.repeat(43);
const fetchHold: { token: string | null } = { token: null };
const fetchSpy = vi.fn((_url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET';
  if (method === 'POST') {
    fetchHold.token = 'b'.repeat(43);
    return Promise.resolve({ ok: true, json: async () => ({ ok: true, token: fetchHold.token }) } as Response);
  }
  if (method === 'DELETE') {
    fetchHold.token = null;
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
  }
  return Promise.resolve({ ok: true, json: async () => ({ ok: true, token: fetchHold.token }) } as Response);
});

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="ja" messages={messages}>
        <OrderOperatorTokenPanel sessionAddress="0x52d4901142e2B5680027da5EB47C86CB02a3cA81" />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchSpy);
  fetchSpy.mockClear();
  fetchHold.token = null;
});
afterEach(() => vi.unstubAllGlobals());

describe('OrderOperatorTokenPanel', () => {
  it('未発行: 「リンクを発行」ボタンを出す', async () => {
    renderPanel();
    expect(await screen.findByRole('button', { name: /リンクを発行/ })).toBeInTheDocument();
    expect(screen.queryByText('厨房')).toBeNull();
  });

  it('発行: POST → 厨房/ホールの ?t= リンクと再発行/取消を表示', async () => {
    renderPanel();
    // 初期 GET 解決前は発行ボタンが disabled(=click が no-op)。enabled を待ってから押す。
    const issueBtn = await screen.findByRole('button', { name: /リンクを発行/ });
    await waitFor(() => expect(issueBtn).not.toBeDisabled());
    fireEvent.click(issueBtn);
    // POST 後の invalidate でリンク UI が出る。
    const kitchenInput = (await screen.findByLabelText('厨房')) as HTMLInputElement;
    expect(kitchenInput.value).toContain('/ja/orders/kitchen?t=' + 'b'.repeat(43));
    expect((screen.getByLabelText('ホール') as HTMLInputElement).value).toContain('/ja/orders/hall?t=');
    expect(screen.getByRole('button', { name: /再発行/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /取り消し/ })).toBeInTheDocument();
    const posted = fetchSpy.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
    expect(posted).toBeTruthy();
  });

  it('発行済みを再表示: 既存トークンのリンクを出す', async () => {
    fetchHold.token = TOKEN;
    renderPanel();
    const input = (await screen.findByLabelText('厨房')) as HTMLInputElement;
    expect(input.value).toContain(`?t=${TOKEN}`);
  });

  it('取り消し: DELETE を送る', async () => {
    fetchHold.token = TOKEN;
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /取り消し/ }));
    await waitFor(() =>
      expect(fetchSpy.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE')).toBe(true),
    );
  });
});
