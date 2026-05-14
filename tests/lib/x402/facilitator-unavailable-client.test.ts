import { describe, it, expect, vi } from 'vitest';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { wrapFetchWithPayment } from 'x402-fetch';

// OpenPay の safety 402 (= facilitator 不通時に middleware が返す) を
// 標準 x402 client (x402-fetch) が retry path に乗せて crash しないか実機検証。
//
// OpenPay middleware.ts は内部例外時に `{x402Version:1, error:'payment_facility_unavailable'}`
// を返す (accepts array なし)。x402-fetch は 402 を受けたら response.json() で
// accepts を取って sign を試みるため、accepts が無いと TypeError になり caller
// に伝播する。これは "safety 402" の趣旨 (graceful degrade) を破壊する可能性。

const TEST_PK =
  '0x0000000000000000000000000000000000000000000000000000000000000001' as `0x${string}`;
const account = privateKeyToAccount(TEST_PK);
const walletClient = createWalletClient({
  account,
  chain: baseSepolia,
  transport: http(),
});

describe('x402-fetch behavior against OpenPay safety 402', () => {
  it('safety 402 (accepts なし) を返す server に対して x402-fetch は throw する (current behavior)', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          x402Version: 1,
          error: 'payment_facility_unavailable',
          message: 'Payment verification failed. Please retry later.',
        }),
        { status: 402, headers: { 'content-type': 'application/json' } },
      ),
    );
    const paidFetch = wrapFetchWithPayment(
      fakeFetch as unknown as typeof fetch,
      walletClient as unknown as Parameters<typeof wrapFetchWithPayment>[1],
    );

    // accepts undefined → .map で TypeError、または別の error type を期待
    await expect(paidFetch('http://localhost/api/paid/hello')).rejects.toThrow();
  });

  it('safety 503 (Service Unavailable) を返す場合、x402-fetch は retry せず素通し返却', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          x402Version: 1,
          error: 'payment_facility_unavailable',
          message: 'Payment verification failed. Please retry later.',
        }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      ),
    );
    const paidFetch = wrapFetchWithPayment(
      fakeFetch as unknown as typeof fetch,
      walletClient as unknown as Parameters<typeof wrapFetchWithPayment>[1],
    );

    const res = await paidFetch('http://localhost/api/paid/hello');
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('payment_facility_unavailable');
    // retry されていない = fakeFetch は 1 回しか呼ばれない
    expect(fakeFetch).toHaveBeenCalledOnce();
  });
});
