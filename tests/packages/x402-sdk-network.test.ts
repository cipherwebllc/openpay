import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

type SdkModule = {
  fetchPaymentTarget: (
    url: string,
    options?: Record<string, unknown>,
  ) => Promise<Response>;
};

const SDK_ENTRY = resolve(process.cwd(), 'packages/x402-sdk/src/index.mjs');

async function loadSdk(): Promise<SdkModule> {
  return (await import(pathToFileURL(SDK_ENTRY).href)) as SdkModule;
}

describe('openpay-x402-sdk payment network boundary', () => {
  it('rejects a private literal before DNS or fetch', async () => {
    const sdk = await loadSdk();
    const lookup = vi.fn();
    const fetchImpl = vi.fn();

    await expect(
      sdk.fetchPaymentTarget('http://127.0.0.1:3900/agents', {
        lookup,
        fetchImpl,
      }),
    ).rejects.toThrow('payment_target_not_allowed');
    expect(lookup).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a private DNS result before a custom transport runs', async () => {
    const sdk = await loadSdk();
    const lookup = vi.fn(async () => [
      { address: '169.254.169.254', family: 4 },
    ]);
    const fetchImpl = vi.fn();

    await expect(
      sdk.fetchPaymentTarget('https://seller.example/paid', {
        lookup,
        fetchImpl,
      }),
    ).rejects.toThrow('payment_target_private_address');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('checks DNS again at connect time and blocks rebinding', async () => {
    const sdk = await loadSdk();
    const lookup = vi
      .fn()
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);

    await expect(
      sdk.fetchPaymentTarget('http://seller.example:43210/paid', {
        fetchImpl: globalThis.fetch,
        lookup,
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow('payment_target_private_address');
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('uses manual redirects and aborts an unresponsive custom transport', async () => {
    const sdk = await loadSdk();
    const fetchImpl = vi.fn(
      async (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );

    await expect(
      sdk.fetchPaymentTarget('https://seller.example/paid', {
        fetchImpl,
        timeoutMs: 5,
      }),
    ).rejects.toBeDefined();
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://seller.example/paid',
      expect.objectContaining({
        redirect: 'manual',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('includes DNS preflight in the request timeout', async () => {
    const sdk = await loadSdk();
    const lookup = vi.fn(
      async () => new Promise<Array<{ address: string }>>(() => {}),
    );
    const fetchImpl = vi.fn();

    await expect(
      sdk.fetchPaymentTarget('https://seller.example/paid', {
        lookup,
        fetchImpl,
        timeoutMs: 5,
      }),
    ).rejects.toBeDefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
