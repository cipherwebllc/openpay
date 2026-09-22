// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const kv = vi.hoisted(() => ({ isKvConfigured: vi.fn(), kvIncr: vi.fn() }));
vi.mock('@/lib/kv', () => kv);
import { agentPurchasesRateLimit } from '@/lib/agent/purchasesRateLimit';

const req = new Request('https://test.local/', { headers: { 'x-forwarded-for': '203.0.113.10' } });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('IP_HASH_SECRET', 'agent-purchases-test-secret-32-bytes');
  kv.isKvConfigured.mockReturnValue(true);
  kv.kvIncr.mockResolvedValue({ ok: true, value: 1 });
});
afterEach(() => vi.unstubAllEnvs());

describe('Agent purchases rate limit with actual shared guard', () => {
  it('writes separate hashed-IP minute/day windows', async () => {
    expect(await agentPurchasesRateLimit(req, 'challenge')).toBeNull();
    expect(kv.kvIncr.mock.calls).toEqual([
      [expect.stringMatching(/^iprl:v1:agent-purchases-challenge:[0-9a-f]{64}$/), { initialTtlSec: 60 }],
      [expect.stringMatching(/^iprl:v1:agent-purchases-challenge-day:[0-9a-f]{64}$/), { initialTtlSec: 86400 }],
    ]);
    expect(JSON.stringify(kv.kvIncr.mock.calls)).not.toContain('203.0.113.10');
  });
  it('minute limit returns before consuming the day window', async () => {
    kv.kvIncr.mockResolvedValue({ ok: true, value: 21 });
    expect(await agentPurchasesRateLimit(req, 'challenge')).toBe(60);
    expect(kv.kvIncr).toHaveBeenCalledTimes(1);
  });
  it('daily limit can reject even when the minute limit allows', async () => {
    kv.kvIncr.mockResolvedValueOnce({ ok: true, value: 1 }).mockResolvedValueOnce({ ok: true, value: 201 });
    expect(await agentPurchasesRateLimit(req, 'challenge')).toBe(86400);
  });
  it.each(['unbind', 'bindings'] as const)('%s has only the designed minute window', async (route) => {
    expect(await agentPurchasesRateLimit(req, route)).toBeNull();
    expect(kv.kvIncr).toHaveBeenCalledTimes(1);
  });
  it.each(['unconfigured', 'error', 'throw'])('rate limit %s fails open', async (failure) => {
    if (failure === 'unconfigured') kv.isKvConfigured.mockReturnValue(false);
    else if (failure === 'error') kv.kvIncr.mockResolvedValue({ ok: false, reason: 'timeout' });
    else kv.kvIncr.mockRejectedValue(new Error('down'));
    expect(await agentPurchasesRateLimit(req, 'purchases')).toBeNull();
  });
});
