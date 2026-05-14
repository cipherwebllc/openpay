import { describe, it, expect, vi } from 'vitest';

// x402-fetch を境界 mock。SUT (callPaidApi) の本体は実コード走行で、
// wrapFetchWithPayment / decodeXPaymentResponse を正しく呼出すこと、
// status / body / paymentResponse を組み立てて返すことを検証する。
vi.mock('x402-fetch', () => ({
  wrapFetchWithPayment: vi.fn(),
  decodeXPaymentResponse: vi.fn(),
}));

import { wrapFetchWithPayment, decodeXPaymentResponse } from 'x402-fetch';
import { callPaidApi } from '../../examples/agent-client';

describe('examples/agent-client.callPaidApi', () => {
  it('paid API 200: status / body を返し、paymentResponse は x-payment-response header から decode', async () => {
    const fakeBody = { message: 'Hello, paid AI agent.', timestamp: '2026-05-14T00:00:00.000Z' };
    const fakeRes = new Response(JSON.stringify(fakeBody), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-payment-response': 'opaque-base64-from-server',
      },
    });
    const paidFetch = vi.fn().mockResolvedValue(fakeRes);
    vi.mocked(wrapFetchWithPayment).mockReturnValue(paidFetch);
    vi.mocked(decodeXPaymentResponse).mockReturnValue({
      success: true,
      transaction: '0xtxhash',
    } as unknown as ReturnType<typeof decodeXPaymentResponse>);

    const walletClient = { mock: true } as unknown as Parameters<
      typeof callPaidApi
    >[1];
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await callPaidApi(
      'http://test.local/api/paid/hello',
      walletClient,
      fetchImpl,
    );

    expect(wrapFetchWithPayment).toHaveBeenCalledWith(fetchImpl, walletClient);
    expect(paidFetch).toHaveBeenCalledWith('http://test.local/api/paid/hello');
    expect(result.status).toBe(200);
    expect(result.body).toEqual(fakeBody);
    expect(result.paymentResponse).toEqual({
      success: true,
      transaction: '0xtxhash',
    });
    expect(decodeXPaymentResponse).toHaveBeenCalledWith(
      'opaque-base64-from-server',
    );
  });

  it('x-payment-response header 欠落時は paymentResponse=null', async () => {
    const fakeBody = { message: 'Hello' };
    const fakeRes = new Response(JSON.stringify(fakeBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    vi.mocked(wrapFetchWithPayment).mockReturnValue(
      vi.fn().mockResolvedValue(fakeRes),
    );
    vi.mocked(decodeXPaymentResponse).mockReset();

    const walletClient = {} as unknown as Parameters<typeof callPaidApi>[1];
    const result = await callPaidApi(
      'http://test.local/api/paid/hello',
      walletClient,
      vi.fn() as unknown as typeof fetch,
    );

    expect(result.status).toBe(200);
    expect(result.paymentResponse).toBeNull();
    expect(decodeXPaymentResponse).not.toHaveBeenCalled();
  });

  it('paid API が 402 を返した場合も throw せず result を返す (caller が判断)', async () => {
    const fake402 = new Response(
      JSON.stringify({ x402Version: 1, error: 'payment_required' }),
      { status: 402, headers: { 'content-type': 'application/json' } },
    );
    vi.mocked(wrapFetchWithPayment).mockReturnValue(
      vi.fn().mockResolvedValue(fake402),
    );

    const result = await callPaidApi(
      'http://test.local/api/paid/hello',
      {} as unknown as Parameters<typeof callPaidApi>[1],
      vi.fn() as unknown as typeof fetch,
    );

    expect(result.status).toBe(402);
    expect(result.body).toEqual({ x402Version: 1, error: 'payment_required' });
  });
});
