import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';

const h = vi.hoisted(() => ({ read: vi.fn<() => Promise<bigint>>() }));
// Keep real React Query caching/deduplication so stale and in-flight requests behave like wagmi.
vi.mock('wagmi', () => ({
  useReadContract: (options: {
    address: string; chainId: number; args: string[]; scopeKey?: string;
    query: { enabled: boolean; refetchInterval: number };
  }) => useQuery({
    queryKey: ['balance', options.address, options.chainId, options.args, options.scopeKey],
    queryFn: () => h.read(),
    ...options.query,
    retry: false,
  }),
}));

import { useIncomingPaymentWatch } from '@/hooks/useIncomingPaymentWatch';

type Params = Parameters<typeof useIncomingPaymentWatch>[0];
const BASE: Params = {
  receiver: '0x1111111111111111111111111111111111111111',
  tokenAddress: '0x2222222222222222222222222222222222222222',
  chainId: 137,
  expectedAmountWei: 500n,
  enabled: true,
};

function mount(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const view = renderHook((params: Params) => useIncomingPaymentWatch(params), {
    initialProps: BASE,
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  return { ...view, client };
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

beforeEach(() => {
  h.read.mockReset().mockResolvedValue(1000n);
});

describe('X10: activation-specific fresh balance', () => {
  it('does not count the previous sale from a cached baseline on reopening', async () => {
    const { result, rerender, client } = mount();
    await settle();
    rerender({ ...BASE, enabled: false });
    h.read.mockResolvedValue(1500n);
    rerender(BASE);
    await settle();
    expect(result.current).toEqual({ status: 'watching', receivedWei: 0n });
    h.read.mockResolvedValue(2000n);
    await act(async () => { await client.invalidateQueries(); });
    await waitFor(() => expect(result.current).toEqual({ status: 'received', receivedWei: 500n }));
  });

  it('starts a new request while an earlier activation is still in flight', async () => {
    let resolveOld!: (value: bigint) => void;
    let resolveNew!: (value: bigint) => void;
    h.read.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNew = resolve; }));
    const { result, rerender, client } = mount();
    await waitFor(() => expect(h.read).toHaveBeenCalledTimes(1));
    rerender({ ...BASE, enabled: false });
    rerender(BASE);
    await waitFor(() => expect(h.read).toHaveBeenCalledTimes(2));
    await act(async () => resolveNew(1500n));
    await settle();
    await act(async () => resolveOld(1000n));
    await settle();
    expect(result.current).toEqual({ status: 'watching', receivedWei: 0n });
    h.read.mockResolvedValue(2000n);
    await act(async () => { await client.invalidateQueries(); });
    await waitFor(() => expect(result.current.receivedWei).toBe(500n));
  });

  it('remounting uses a new identity even when the old request has not finished', async () => {
    h.read.mockImplementationOnce(() => new Promise<bigint>(() => {}));
    const first = mount();
    await waitFor(() => expect(h.read).toHaveBeenCalledTimes(1));
    first.unmount();
    h.read.mockResolvedValue(1500n);
    const second = mount(first.client);
    await settle();
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(second.result.current).toEqual({ status: 'watching', receivedWei: 0n });
  });

  it.each(['chain', 'token'] as const)('resets baseline when only the %s changes', async (field) => {
    const { result, rerender, client } = mount();
    await settle();
    h.read.mockResolvedValue(5000n);
    rerender({ ...BASE, ...(field === 'chain' ? { chainId: 8453 } : { tokenAddress: '0x3333333333333333333333333333333333333333' as const }) });
    await settle();
    expect(result.current).toEqual({ status: 'watching', receivedWei: 0n });
    h.read.mockResolvedValue(5500n);
    await act(async () => { await client.invalidateQueries(); });
    await waitFor(() => expect(result.current.receivedWei).toBe(500n));
  });

  it('a payment racing the fresh baseline is not asserted to belong to this invoice', async () => {
    h.read.mockResolvedValue(1500n);
    const { result } = mount();
    await settle();
    expect(result.current).toEqual({ status: 'watching', receivedWei: 0n });
  });

  it('baseline failure waits for a successful fresh read', async () => {
    h.read.mockRejectedValueOnce(new Error('RPC unavailable'));
    const { result, client } = mount();
    await settle();
    expect(result.current).toEqual({ status: 'watching', receivedWei: 0n });
    h.read.mockResolvedValue(1500n);
    await act(async () => { await client.invalidateQueries(); });
    await settle();
    expect(result.current).toEqual({ status: 'watching', receivedWei: 0n });
  });

  it('Japanese and English hints describe balance growth and do not confirm an invoice', () => {
    // 2026-10 磨き上げ P5: 短い状態 (ピル) と注記に分けた。注記で「この支払いとは限らない」「直後は検知できない」
    // 「結果は取引履歴で」を伝え続ける (決済の確定に見せない)。
    expect(ja.QrGenerator.paymentReceived).toContain('残高');
    expect(ja.QrGenerator.paymentReceivedNote).toContain('この支払いとは限りません');
    expect(ja.QrGenerator.paymentReceivedNote).toContain('取引履歴');
    expect(en.QrGenerator.paymentReceived).toContain('Balance');
    expect(en.QrGenerator.paymentReceivedNote).toContain('may not be this payment');
    expect(ja.QrGenerator.paymentWatchingNote).toContain('表示した直後に届いた支払い');
    expect(en.QrGenerator.paymentWatchingNote).toContain('right after this screen opens');
    expect(ja.QrGenerator.paymentWatchingNote).toContain('取引履歴');
    expect(en.QrGenerator.paymentWatchingNote).toContain('history');
  });
});
