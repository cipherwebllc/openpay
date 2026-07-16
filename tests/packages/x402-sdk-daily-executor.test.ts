import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { getAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { FORWARDER_COMMIT_VERSION } from '@/lib/relay/forwarderIntent';

type Client = {
  pay: (
    url: string,
    options: { maxTotalJpyc: string },
  ) => Promise<Record<string, unknown>>;
  quote: (url: string) => Promise<Record<string, unknown>>;
  session: { spentAtomic: bigint; spentJpyc: string };
};

type SdkModule = {
  createOpenPayClient: (options?: Record<string, unknown>) => Client;
};

const SDK_ENTRY = resolve(process.cwd(), 'packages/x402-sdk/src/index.mjs');
const JPYC = 10n ** 18n;
const RESOURCE = 'https://open-pay.jp/api/paid/demo';
const PRIVATE_KEY = `0x${'1'.repeat(64)}` as Hex;
const TOKEN = getAddress('0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29');
const FORWARDER = getAddress('0x4444444444444444444444444444444444444444');
const MERCHANT = getAddress('0x2222222222222222222222222222222222222222');
const FEE_RECEIVER = getAddress('0x3333333333333333333333333333333333333333');
const account = privateKeyToAccount(PRIVATE_KEY);

async function loadSdk(): Promise<SdkModule> {
  return (await import(pathToFileURL(SDK_ENTRY).href)) as SdkModule;
}

function accept() {
  const merchantValue = 5n * JPYC;
  const feeValue = 2n * JPYC;
  return {
    scheme: 'exact',
    network: 'eip155:80002',
    maxAmountRequired: (merchantValue + feeValue).toString(),
    resource: RESOURCE,
    description: 'demo',
    mimeType: 'application/json',
    payTo: FORWARDER,
    maxTimeoutSeconds: 600,
    asset: TOKEN,
    extra: {
      name: 'JPY Coin',
      version: '1',
      decimals: 18,
      assetTransferMethod: 'eip3009',
      openpay: {
        mode: 'forwarder-split',
        forwarder: FORWARDER,
        merchant: MERCHANT,
        merchantValue: merchantValue.toString(),
        feeReceiver: FEE_RECEIVER,
        feeValue: feeValue.toString(),
        commitVersion: FORWARDER_COMMIT_VERSION,
      },
    },
  };
}

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function isPaid(init?: RequestInit) {
  return new Headers(init?.headers).has('X-PAYMENT');
}

function successfulFetch() {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
    isPaid(init)
      ? jsonResponse({ unlocked: true }, 200)
      : jsonResponse({ accepts: [accept()] }, 402),
  );
}

function memoryStore(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    load: vi.fn(async (key: string) => values.get(key) ?? '0'),
    save: vi.fn(async (key: string, atomicString: string) => {
      values.set(key, atomicString);
    }),
  };
}

describe('openpay-x402-sdk daily executor', () => {
  it('loads the signer/day key and saves the new total after a 2xx unlock', async () => {
    const sdk = await loadSdk();
    const store = memoryStore();
    const client = sdk.createOpenPayClient({
      privateKey: PRIVATE_KEY,
      maxDailyJpyc: '20',
      spendStore: store,
      catalogTrust: false,
      fetchImpl: successfulFetch(),
      now: () => new Date('2026-07-17T23:59:59.000Z'),
    });

    const result = await client.pay(RESOURCE, { maxTotalJpyc: '7' });

    const key = `${account.address.toLowerCase()}:2026-07-17`;
    expect(result).toMatchObject({ status: 200, body: { unlocked: true } });
    expect(store.load).toHaveBeenCalledWith(key);
    expect(store.save).toHaveBeenCalledWith(key, (7n * JPYC).toString());
  });

  it('passes persisted spend to quote so daily excess is visible before pay', async () => {
    const sdk = await loadSdk();
    const key = `${account.address.toLowerCase()}:2026-07-17`;
    const store = memoryStore({ [key]: (4n * JPYC).toString() });
    const client = sdk.createOpenPayClient({
      privateKey: PRIVATE_KEY,
      maxDailyJpyc: '10',
      spendStore: store,
      catalogTrust: false,
      fetchImpl: successfulFetch(),
      now: () => new Date('2026-07-17T00:00:00.000Z'),
    });

    const result = await client.quote(RESOURCE);

    expect(result.reasons).toContain('daily_limit_exceeded');
    expect(store.save).not.toHaveBeenCalled();
  });

  it('does not save after a non-2xx unlock', async () => {
    const sdk = await loadSdk();
    const store = memoryStore();
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        isPaid(init)
          ? jsonResponse({ error: 'temporary' }, 503)
          : jsonResponse({ accepts: [accept()] }, 402),
    );
    const client = sdk.createOpenPayClient({
      privateKey: PRIVATE_KEY,
      maxDailyJpyc: '20',
      spendStore: store,
      catalogTrust: false,
      fetchImpl,
    });

    await expect(
      client.pay(RESOURCE, { maxTotalJpyc: '7' }),
    ).resolves.toMatchObject({ status: 503 });
    expect(store.save).not.toHaveBeenCalled();
  });

  it('does not save when a guard rejects before signing', async () => {
    const sdk = await loadSdk();
    const store = memoryStore();
    const client = sdk.createOpenPayClient({
      privateKey: PRIVATE_KEY,
      maxDailyJpyc: '20',
      spendStore: store,
      catalogTrust: false,
      fetchImpl: successfulFetch(),
    });

    const result = await client.pay(RESOURCE, { maxTotalJpyc: '6' });

    expect(result.reasons).toContain('total_exceeds_max_total');
    expect(store.save).not.toHaveBeenCalled();
  });

  it('does not save when signing fails', async () => {
    const sdk = await loadSdk();
    const store = memoryStore();
    const client = sdk.createOpenPayClient({
      signer: {
        address: account.address,
        async signTypedData() {
          throw new Error('signature failed');
        },
      },
      maxDailyJpyc: '20',
      spendStore: store,
      catalogTrust: false,
      fetchImpl: successfulFetch(),
    });

    await expect(
      client.pay(RESOURCE, { maxTotalJpyc: '7' }),
    ).rejects.toThrow('signature failed');
    expect(store.save).not.toHaveBeenCalled();
  });

  it('keeps the successful payment response when save throws', async () => {
    const sdk = await loadSdk();
    const store = {
      load: vi.fn(async () => '0'),
      save: vi.fn(async () => {
        throw new Error('store unavailable');
      }),
    };
    const client = sdk.createOpenPayClient({
      privateKey: PRIVATE_KEY,
      maxDailyJpyc: '20',
      spendStore: store,
      catalogTrust: false,
      fetchImpl: successfulFetch(),
    });

    const result = await client.pay(RESOURCE, { maxTotalJpyc: '7' });

    expect(result).toEqual({
      status: 200,
      body: { unlocked: true },
      receipt: null,
    });
    expect(client.session.spentJpyc).toBe('7');
  });

  it('fails closed before signing when load throws', async () => {
    const sdk = await loadSdk();
    let paidFetches = 0;
    const store = {
      load: vi.fn(async () => {
        throw new Error('store unavailable');
      }),
      save: vi.fn(async () => {}),
    };
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (isPaid(init)) paidFetches += 1;
        return jsonResponse({ accepts: [accept()] }, 402);
      },
    );
    const client = sdk.createOpenPayClient({
      privateKey: PRIVATE_KEY,
      maxDailyJpyc: '20',
      spendStore: store,
      catalogTrust: false,
      fetchImpl,
    });

    const result = await client.pay(RESOURCE, { maxTotalJpyc: '7' });

    expect(result.reasons).toContain('daily_spend_unavailable');
    expect(paidFetches).toBe(0);
    expect(store.save).not.toHaveBeenCalled();
  });

  it('serializes concurrent load-save pairs without losing an increment', async () => {
    const sdk = await loadSdk();
    const values = new Map<string, string>();
    const operations: string[] = [];
    const store = {
      async load(key: string) {
        const value = values.get(key) ?? '0';
        operations.push(`load:${value}`);
        return value;
      },
      async save(key: string, atomicString: string) {
        operations.push(`save:${atomicString}`);
        values.set(key, atomicString);
      },
    };
    const client = sdk.createOpenPayClient({
      privateKey: PRIVATE_KEY,
      maxDailyJpyc: '20',
      spendStore: store,
      catalogTrust: false,
      fetchImpl: successfulFetch(),
      now: () => new Date('2026-07-17T00:00:00.000Z'),
    });

    const results = await Promise.all([
      client.pay(RESOURCE, { maxTotalJpyc: '7' }),
      client.pay(RESOURCE, { maxTotalJpyc: '7' }),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ status: 200 }),
      expect.objectContaining({ status: 200 }),
    ]);
    expect(operations).toEqual([
      'load:0',
      `save:${7n * JPYC}`,
      `load:${7n * JPYC}`,
      `save:${14n * JPYC}`,
    ]);
  });

  it('starts from zero under a new UTC key when the date changes', async () => {
    const sdk = await loadSdk();
    const store = memoryStore();
    let now = new Date('2026-07-17T23:59:59.000Z');
    const client = sdk.createOpenPayClient({
      privateKey: PRIVATE_KEY,
      maxDailyJpyc: '10',
      spendStore: store,
      catalogTrust: false,
      fetchImpl: successfulFetch(),
      now: () => now,
    });

    await client.pay(RESOURCE, { maxTotalJpyc: '7' });
    now = new Date('2026-07-18T00:00:00.000Z');
    const second = await client.pay(RESOURCE, { maxTotalJpyc: '7' });

    expect(second).toMatchObject({ status: 200 });
    expect(store.values).toEqual(
      new Map([
        [`${account.address.toLowerCase()}:2026-07-17`, (7n * JPYC).toString()],
        [`${account.address.toLowerCase()}:2026-07-18`, (7n * JPYC).toString()],
      ]),
    );
  });

  it('does not touch an injected store when the daily limit is unset', async () => {
    const sdk = await loadSdk();
    const store = memoryStore();
    const client = sdk.createOpenPayClient({
      privateKey: PRIVATE_KEY,
      spendStore: store,
      catalogTrust: false,
      fetchImpl: successfulFetch(),
    });

    await expect(client.quote(RESOURCE)).resolves.toMatchObject({ ok: true });
    expect(store.load).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
  });
});
