// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { polygonAmoy } from 'viem/chains';
vi.mock('@/lib/chains', () => ({ chainObjectForId: () => polygonAmoy, customRpcUrlForChain: () => 'https://rpc.example' }));
import { licenseRpc, LICENSE_RPC_TIMEOUT_MS } from '@/lib/license/rpc';
afterEach(() => { vi.unstubAllGlobals(); });
it('uses bounded transport with zero retries and stops new RPC dispatch after the deadline', async () => {
  const fetch = vi.fn().mockRejectedValue(new Error('unavailable')); vi.stubGlobal('fetch', fetch);
  const client = licenseRpc(80002);
  expect(client.transport.timeout).toBe(LICENSE_RPC_TIMEOUT_MS); expect(client.transport.retryCount).toBe(0);
  await expect(client.getBlockNumber()).rejects.toThrow(); expect(fetch).toHaveBeenCalledTimes(1);
  const expired = licenseRpc(80002, Date.now() - 1); await expect(expired.getBlockNumber()).rejects.toThrow('license dispatch deadline'); expect(fetch).toHaveBeenCalledTimes(1);
});
