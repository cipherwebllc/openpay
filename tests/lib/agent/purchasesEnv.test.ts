// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentPurchasesEnabled } from '@/lib/agent/purchasesEnv';

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe('Agent purchases flags', () => {
  it.each([undefined, '', '0', 'false', 'TRUE', ' true ', 'on'])('server flag %s is OFF', (raw) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('ENABLE_AGENT_PURCHASES', raw);
    vi.stubEnv('NEXT_PUBLIC_ENABLE_AGENT_PURCHASES', '1');
    expect(agentPurchasesEnabled()).toBe(false);
  });
  it.each(['1', 'true'])('server flag %s is ON independently of client', (raw) => {
    vi.stubEnv('ENABLE_AGENT_PURCHASES', raw);
    vi.stubEnv('NEXT_PUBLIC_ENABLE_AGENT_PURCHASES', '0');
    expect(agentPurchasesEnabled()).toBe(true);
  });
});
