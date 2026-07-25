import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_BODY_BYTES } from '@/lib/relay/relayRoute';

const claimSpy = vi.hoisted(() => vi.fn());
const rateLimitSpy = vi.hoisted(() => vi.fn());
const enabled = vi.hoisted(() => ({ value: true }));

vi.mock('@/lib/env', () => ({
  env: {
    get enableRegisterFee() {
      return enabled.value;
    },
  },
}));
vi.mock('@/lib/registerFeeClaim', () => ({
  claimRegisterFeePayment: (...args: unknown[]) => claimSpy(...args),
}));
vi.mock('@/lib/relay/relayGuards', () => ({
  checkIpRateLimit: (...args: unknown[]) => rateLimitSpy(...args),
}));
vi.mock('@/lib/net/ipHash', () => ({
  clientIp: () => '192.0.2.1',
  hashIp: () => 'hashed-ip',
}));

import { POST } from '@/app/api/register/claim/route';

const TOKEN = '0x1111111111111111111111111111111111111111';
const MERCHANT = '0x2222222222222222222222222222222222222222';
const MERCHANT_TX = `0x${'a'.repeat(64)}`;
const FEE_TX = `0x${'b'.repeat(64)}`;
const body = {
  chainId: 137,
  tokenAddress: TOKEN,
  merchant: MERCHANT,
  saleAmount: '3000000000000000000000',
  merchantTxHash: MERCHANT_TX,
  feeTxHash: FEE_TX,
};

function request(value: unknown): Request {
  return new Request('http://localhost/api/register/claim', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '192.0.2.1',
    },
    body: typeof value === 'string' ? value : JSON.stringify(value),
  });
}

beforeEach(() => {
  enabled.value = true;
  claimSpy.mockReset().mockResolvedValue('claimed');
  rateLimitSpy.mockReset().mockResolvedValue(true);
});

describe('POST /api/register/claim', () => {
  it('検証済み claim を確定し、同じ fee tx の再通知は replay を返す', async () => {
    const first = await POST(request(body));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, status: 'claimed' });
    expect(claimSpy).toHaveBeenCalledWith({
      chainId: 137,
      tokenAddress: TOKEN,
      merchant: MERCHANT,
      saleAmount: 3000n * 10n ** 18n,
      merchantTxHash: MERCHANT_TX,
      feeTxHash: FEE_TX,
    });

    claimSpy.mockResolvedValue('replay');
    const again = await POST(request(body));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, status: 'replay' });
  });

  it('feeTxHash 欠落は invalid_body (どの tx を claim するか特定できない)', async () => {
    const response = await POST(request({ ...body, feeTxHash: undefined }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'invalid_body',
    });
    expect(claimSpy).not.toHaveBeenCalled();
  });

  it('flag OFF は 404 (本番 inert)', async () => {
    enabled.value = false;
    const response = await POST(request(body));
    expect(response.status).toBe(404);
    expect(claimSpy).not.toHaveBeenCalled();
  });

  it('IP上限をbody parse/RPC claimより前に止める', async () => {
    rateLimitSpy.mockResolvedValue(false);
    const response = await POST(request(body));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(rateLimitSpy).toHaveBeenCalledWith(
      'register-claim',
      'hashed-ip',
      60,
      60,
    );
    expect(claimSpy).not.toHaveBeenCalled();
  });

  it('MAX_BODY_BYTES超過をRPC claimへ到達させない', async () => {
    const response = await POST(request('x'.repeat(MAX_BODY_BYTES + 1)));
    expect(response.status).toBe(413);
    expect(claimSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid', 400],
    ['conflict', 409],
    ['verify_failed', 422],
    ['kv_error', 503],
  ] as const)('claim 結果 %s を %i で返す', async (result, status) => {
    claimSpy.mockResolvedValue(result);
    const response = await POST(request(body));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ ok: false, error: result });
  });
});
