import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';

const h = vi.hoisted(() => ({
  enabled: true,
  rateAllowed: true,
  result: {
    ok: true,
    chainId: 80002,
    payer: '0x1111111111111111111111111111111111111111' as Address,
    state: 'unused',
  } as unknown,
}));

vi.mock('@/lib/env', () => ({
  env: {
    get enableX402Facilitator() {
      return h.enabled;
    },
  },
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/relay/relayGuards', () => ({
  checkIpRateLimit: vi.fn(async () => h.rateAllowed),
}));
vi.mock('@/lib/x402/facilitatorStatus', () => ({
  resolveFacilitatorPaymentStatus: vi.fn(async () => h.result),
}));

import { checkIpRateLimit } from '@/lib/relay/relayGuards';
import { resolveFacilitatorPaymentStatus } from '@/lib/x402/facilitatorStatus';
import { POST } from '@/app/api/facilitator/status/route';

const HASH = `0x${'a'.repeat(64)}` as Hex;

function req(body: unknown = { paymentPayload: {}, paymentRequirements: {} }) {
  return new Request('http://localhost/api/facilitator/status', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.10',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('IP_HASH_SECRET', 'status-test-secret-32-bytes-long!!');
  h.enabled = true;
  h.rateAllowed = true;
  h.result = {
    ok: true,
    chainId: 80002,
    payer: '0x1111111111111111111111111111111111111111',
    state: 'unused',
  };
});

describe('POST /api/facilitator/status', () => {
  it('settled を relay status と同じ response 形で返す', async () => {
    h.result = {
      ok: true,
      chainId: 80002,
      payer: '0x1111111111111111111111111111111111111111',
      state: 'settled',
      txHash: HASH,
    };
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      state: 'settled',
      txHash: HASH,
    });
  });

  it('unused / indeterminate は txHash を含めない', async () => {
    const unused = await POST(req());
    expect(await unused.json()).toEqual({ ok: true, state: 'unused' });

    h.result = {
      ok: true,
      chainId: 80002,
      payer: '0x1111111111111111111111111111111111111111',
      state: 'indeterminate',
    };
    const indeterminate = await POST(req());
    expect(await indeterminate.json()).toEqual({
      ok: true,
      state: 'indeterminate',
    });
  });

  it('署名/構造エラーは 400', async () => {
    h.result = { ok: false, error: 'signature_mismatch' };
    const res = await POST(req());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'signature_mismatch',
    });
  });

  it('x402 flag OFF は 404 で helper を呼ばない', async () => {
    h.enabled = false;
    const res = await POST(req());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'not_found' });
    expect(resolveFacilitatorPaymentStatus).not.toHaveBeenCalled();
  });

  it('x402-status 30/60 の IP rate limit を適用する', async () => {
    h.rateAllowed = false;
    const res = await POST(req());
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'ip_rate_limited',
    });
    expect(checkIpRateLimit).toHaveBeenCalledWith(
      'x402-status',
      expect.anything(),
      30,
      60,
    );
  });

  it('JSON 不正は helper 前に 400', async () => {
    const res = await POST(req('{not-json'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'invalid_payload',
    });
    expect(resolveFacilitatorPaymentStatus).not.toHaveBeenCalled();
  });
});
