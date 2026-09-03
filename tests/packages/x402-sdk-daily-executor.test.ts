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
  createPaymentExecutor: (options: Record<string, unknown>) => unknown;
  parseClientOptions: (options?: Record<string, unknown>) => Record<string, unknown>;
};

const SDK_ENTRY = resolve(process.cwd(), 'packages/x402-sdk/src/index.mjs');
const JPYC = 10n ** 18n;
const RESOURCE = 'https://open-pay.jp/api/paid/demo';
const PRIVATE_KEY = `0x${'1'.repeat(64)}` as Hex;
const TOKEN = getAddress('0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29');
const FORWARDER = getAddress('0x752B7AaD0089286EB7b553d84D05233d80c9FCB4');
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
    reserve: vi.fn(
      async (key: string, amountAtomic: string, limitAtomic: string) => {
        const next = BigInt(values.get(key) ?? '0') + BigInt(amountAtomic);
        if (next > BigInt(limitAtomic)) {
          return { ok: false as const, reason: 'limit_exceeded' as const };
        }
        values.set(key, next.toString());
        return { ok: true as const, totalAtomic: next.toString() };
      },
    ),
    confirm: vi.fn(async () => true),
    save: vi.fn(async (key: string, atomicString: string) => {
      values.set(key, atomicString);
    }),
  };
}

// 実時計を使うと UTC 日付境界 (23:59 頃) で「署名の有効期限が翌日にまたがる」仕様どおりの拒否が
// 起きてフレークする (2026-09-02 実害)。時刻を指定しないテストは全てこの固定時計を使う。
const FIXED_NOW = new Date('2026-07-17T12:00:00.000Z');
function fixedClock() {
  return {
    now: () => FIXED_NOW,
    nowSec: () => Math.floor(FIXED_NOW.getTime() / 1000),
  };
}

describe('openpay-x402-sdk daily executor', () => {
  it('fails construction when a direct executor silently omits the configured store', async () => {
    const sdk = await loadSdk();
    const config = sdk.parseClientOptions({
      maxDailyJpyc: '10',
      catalogTrust: false,
    });

    expect(() =>
      sdk.createPaymentExecutor({
        config,
        session: { spentAtomic: 0n },
        spendStore: null,
      }),
    ).toThrow('spendStore is required when maxDailyAtomic is configured');
  });

  it('loads the signer/day key and reserves before a 2xx unlock', async () => {
    const sdk = await loadSdk();
    const store = memoryStore();
    const current = new Date('2026-07-17T12:00:00.000Z');
    const client = sdk.createOpenPayClient({
      privateKey: PRIVATE_KEY,
      maxDailyJpyc: '20',
      spendStore: store,
      catalogTrust: false,
      fetchImpl: successfulFetch(),
      now: () => current,
      nowSec: () => Math.floor(current.getTime() / 1000),
    });

    const result = await client.pay(RESOURCE, { maxTotalJpyc: '7' });

    const key = `${account.address.toLowerCase()}:2026-07-17`;
    expect(result).toMatchObject({ status: 200, body: { unlocked: true } });
    expect(store.load).toHaveBeenCalledWith(key);
    expect(store.reserve).toHaveBeenCalledWith(
      key,
      (7n * JPYC).toString(),
      (20n * JPYC).toString(),
      expect.objectContaining({
        payer: account.address,
        network: 'eip155:80002',
        asset: TOKEN,
      }),
    );
    expect(store.confirm).toHaveBeenCalledOnce();
    expect(store.save).not.toHaveBeenCalled();
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

  it('keeps a pre-send reservation after a non-2xx unlock', async () => {
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
      maxDailyJpyc: '10',
      spendStore: store,
      catalogTrust: false,
      fetchImpl,
      ...fixedClock(),
    });

    await expect(
      client.pay(RESOURCE, { maxTotalJpyc: '7' }),
    ).resolves.toMatchObject({ status: 503 });
    const second = await client.pay(RESOURCE, { maxTotalJpyc: '7' });

    // A seller can settle before returning 503, so the exposed authorization must
    // keep consuming the daily cap until a future on-chain unused check releases it.
    expect(second.reasons).toContain('daily_limit_exceeded');
    expect(store.reserve).toHaveBeenCalledOnce();
    expect(store.confirm).not.toHaveBeenCalled();
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
      ...fixedClock(),
    });

    const result = await client.pay(RESOURCE, { maxTotalJpyc: '6' });

    expect(result.reasons).toContain('total_exceeds_max_total');
    expect(store.reserve).not.toHaveBeenCalled();
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
      ...fixedClock(),
    });

    await expect(
      client.pay(RESOURCE, { maxTotalJpyc: '7' }),
    ).rejects.toThrow('signature failed');
    expect(store.reserve).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
  });

  it('keeps the successful payment response when confirmation metadata fails', async () => {
    const sdk = await loadSdk();
    const values = new Map<string, string>();
    const store = {
      load: vi.fn(async (key: string) => values.get(key) ?? '0'),
      reserve: vi.fn(
        async (key: string, amountAtomic: string, limitAtomic: string) => {
          const next = BigInt(values.get(key) ?? '0') + BigInt(amountAtomic);
          if (next > BigInt(limitAtomic)) {
            return { ok: false as const, reason: 'limit_exceeded' as const };
          }
          values.set(key, next.toString());
          return { ok: true as const, totalAtomic: next.toString() };
        },
      ),
      confirm: vi.fn(async () => {
        throw new Error('confirmation unavailable');
      }),
      save: vi.fn(async () => {}),
    };
    const client = sdk.createOpenPayClient({
      privateKey: PRIVATE_KEY,
      maxDailyJpyc: '20',
      spendStore: store,
      catalogTrust: false,
      fetchImpl: successfulFetch(),
      ...fixedClock(),
    });

    const result = await client.pay(RESOURCE, { maxTotalJpyc: '7' });

    expect(result).toEqual({
      status: 200,
      body: { unlocked: true },
      receipt: null,
      settlement: 'receipt_unavailable',
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
      ...fixedClock(),
    });

    const result = await client.pay(RESOURCE, { maxTotalJpyc: '7' });

    expect(result.reasons).toContain('daily_spend_unavailable');
    expect(paidFetches).toBe(0);
    expect(store.save).not.toHaveBeenCalled();
  });

  it('fails closed when a custom reserve does not prove its durable total', async () => {
    const sdk = await loadSdk();
    let paidFetches = 0;
    const store = {
      load: vi.fn(async () => '0'),
      reserve: vi.fn(async () => ({ ok: true })),
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
      ...fixedClock(),
    });

    const result = await client.pay(RESOURCE, { maxTotalJpyc: '7' });

    expect(result.reasons).toContain('daily_spend_unavailable');
    expect(paidFetches).toBe(0);
  });

  it('serializes concurrent reserve pairs without losing an increment', async () => {
    const sdk = await loadSdk();
    const values = new Map<string, string>();
    const operations: string[] = [];
    const store = {
      async load(key: string) {
        const value = values.get(key) ?? '0';
        operations.push(`load:${value}`);
        return value;
      },
      async reserve(key: string, amountAtomic: string, limitAtomic: string) {
        const next = BigInt(values.get(key) ?? '0') + BigInt(amountAtomic);
        operations.push(`reserve:${next}`);
        if (next > BigInt(limitAtomic)) {
          return { ok: false as const, reason: 'limit_exceeded' as const };
        }
        values.set(key, next.toString());
        return { ok: true as const, totalAtomic: next.toString() };
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
      nowSec: () =>
        Math.floor(new Date('2026-07-17T00:00:00.000Z').getTime() / 1000),
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
      'load:0',
      `reserve:${7n * JPYC}`,
      `load:${7n * JPYC}`,
      `load:${7n * JPYC}`,
      `reserve:${14n * JPYC}`,
    ]);
  });

  it('starts from zero under a new UTC key when the date changes', async () => {
    const sdk = await loadSdk();
    const store = memoryStore();
    let now = new Date('2026-07-17T12:00:00.000Z');
    const client = sdk.createOpenPayClient({
      privateKey: PRIVATE_KEY,
      maxDailyJpyc: '10',
      spendStore: store,
      catalogTrust: false,
      fetchImpl: successfulFetch(),
      now: () => now,
      nowSec: () => Math.floor(now.getTime() / 1000),
    });

    await client.pay(RESOURCE, { maxTotalJpyc: '7' });
    now = new Date('2026-07-18T12:00:00.000Z');
    const second = await client.pay(RESOURCE, { maxTotalJpyc: '7' });

    expect(second).toMatchObject({ status: 200 });
    expect(store.values).toEqual(
      new Map([
        [`${account.address.toLowerCase()}:2026-07-17`, (7n * JPYC).toString()],
        [`${account.address.toLowerCase()}:2026-07-18`, (7n * JPYC).toString()],
      ]),
    );
  });

  it('refuses an authorization whose validity crosses UTC midnight', async () => {
    const sdk = await loadSdk();
    const store = memoryStore();
    const current = new Date('2026-07-17T23:59:59.000Z');
    const fetchImpl = successfulFetch();
    const client = sdk.createOpenPayClient({
      privateKey: PRIVATE_KEY,
      maxDailyJpyc: '20',
      spendStore: store,
      catalogTrust: false,
      fetchImpl,
      now: () => current,
      nowSec: () => Math.floor(current.getTime() / 1000),
    });

    const result = await client.pay(RESOURCE, { maxTotalJpyc: '7' });

    expect(result.reasons).toContain(
      'daily_authorization_crosses_utc_day',
    );
    expect(store.reserve).not.toHaveBeenCalled();
    expect(
      fetchImpl.mock.calls.filter(([, init]) => isPaid(init)).length,
    ).toBe(0);
  });

  it('does not touch an injected store when the daily limit is unset', async () => {
    const sdk = await loadSdk();
    const store = memoryStore();
    const client = sdk.createOpenPayClient({
      privateKey: PRIVATE_KEY,
      spendStore: store,
      catalogTrust: false,
      fetchImpl: successfulFetch(),
      ...fixedClock(),
    });

    await expect(client.quote(RESOURCE)).resolves.toMatchObject({ ok: true });
    expect(store.load).not.toHaveBeenCalled();
    expect(store.reserve).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
  });
});
