import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useStoreCacheScope } from '@/hooks/useStoreCacheScope';

const wallet: { address: string | undefined } = { address: undefined };

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: wallet.address }),
}));

const OLD_ADDRESS = '0x00000000000000000000000000000000000000aa';
const NEW_ADDRESS = '0x1111111111111111111111111111111111111111';

function setup(sessionAddress: string | null) {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const rendered = renderHook(
    ({ session }: { session: string | null }) => useStoreCacheScope(session),
    { wrapper, initialProps: { session: sessionAddress } },
  );
  return { client, ...rendered };
}

describe('useStoreCacheScope', () => {
  beforeEach(() => {
    wallet.address = OLD_ADDRESS;
  });

  it('初回 mount では既存の store cache を消さない', () => {
    const { client } = (() => {
      const client = new QueryClient();
      client.setQueryData(['store', OLD_ADDRESS, 'library'], { ok: true });
      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      );
      renderHook(() => useStoreCacheScope(OLD_ADDRESS), { wrapper });
      return { client };
    })();
    expect(
      client.getQueryData(['store', OLD_ADDRESS, 'library']),
    ).toEqual({ ok: true });
  });

  it('wallet 切替で旧 address の store cache を即時破棄する', () => {
    const { client, rerender } = setup(OLD_ADDRESS);
    client.setQueryData(['store', OLD_ADDRESS, 'library'], {
      ok: true,
      items: [{ resourceId: 'h_old' }],
    });
    wallet.address = NEW_ADDRESS;
    rerender({ session: OLD_ADDRESS });
    expect(
      client.getQueryData(['store', OLD_ADDRESS, 'library']),
    ).toBeUndefined();
  });

  it('SIWE sign-out (sessionAddress→null) でも store cache を破棄する', () => {
    const { client, rerender } = setup(OLD_ADDRESS);
    client.setQueryData(['store', OLD_ADDRESS, 'content', 'h_a'], {
      value: 'secret',
    });
    rerender({ session: null });
    expect(
      client.getQueryData(['store', OLD_ADDRESS, 'content', 'h_a']),
    ).toBeUndefined();
  });

  it('store 以外の query は消さない', () => {
    const { client, rerender } = setup(OLD_ADDRESS);
    client.setQueryData(['handle-profile'], { ok: true });
    rerender({ session: null });
    expect(client.getQueryData(['handle-profile'])).toEqual({ ok: true });
  });
});
