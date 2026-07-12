'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { env } from '@/lib/env';
import type { StoredCall } from '@/lib/orderRelay';

export function orderCallsQueryKey(scope: string | null | undefined) {
  return ['order-calls', scope] as const;
}

export async function fetchOrderCalls(token?: string): Promise<StoredCall[]> {
  const response = await fetch(
    '/api/order/calls',
    token ? { headers: { 'x-order-token': token } } : undefined,
  );
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof json.error === 'string' ? json.error : `http_${response.status}`);
  }
  return Array.isArray(json.calls) ? (json.calls as StoredCall[]) : [];
}

export function useOrderCalls(
  sessionAddress: string | null | undefined,
  isSignedIn: boolean,
  refetchMs = 12_000,
  token?: string | null,
) {
  const queryClient = useQueryClient();
  const scope = token ?? sessionAddress;
  const calls = useQuery({
    queryKey: orderCallsQueryKey(scope),
    enabled: env.enableOrderCall && (Boolean(token) || isSignedIn),
    refetchInterval: refetchMs,
    queryFn: () => fetchOrderCalls(token ?? undefined),
  });
  const resolve = useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch('/api/order/calls', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'x-order-token': token } : {}),
        },
        body: JSON.stringify({ id, done: true }),
      });
      const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        throw new Error(typeof json.error === 'string' ? json.error : `http_${response.status}`);
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orderCallsQueryKey(scope) }),
  });
  return { calls, resolve };
}
