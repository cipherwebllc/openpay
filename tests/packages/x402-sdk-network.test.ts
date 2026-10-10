import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { isPrivateHost } from '@/lib/net/privateHost';
import { allBoundaryCases } from '../lib/net/privateHostCases';

type SdkModule = {
  fetchPaymentTarget: (
    url: string,
    options?: Record<string, unknown>,
  ) => Promise<Response>;
  isPrivatePaymentHost: (hostname: string) => boolean;
  parseSafePaymentUrl: (raw: unknown) => URL | null;
};

const SDK_ENTRY = resolve(process.cwd(), 'packages/x402-sdk/src/index.mjs');

async function loadSdk(): Promise<SdkModule> {
  return (await import(pathToFileURL(SDK_ENTRY).href)) as SdkModule;
}

// X4: 買い手 SDK の private host 判定は server (lib/net/privateHost.ts) と同じ境界表で判定する。
// 片方だけ狭いと、エージェントが catalog trust 経由で叩く第三者 URL の DNS が NAT64 / 6to4 /
// CGNAT 等を返したとき、署名済み X-PAYMENT 付きの GET が実行環境の内側へ届く。
describe('openpay-x402-sdk private host boundary matches the server', () => {
  it.each(allBoundaryCases())('%s → private=%s on both sides', async (host, isPrivate) => {
    const sdk = await loadSdk();
    expect(sdk.isPrivatePaymentHost(host), `sdk ${host}`).toBe(isPrivate);
    expect(isPrivateHost(host), `server ${host}`).toBe(isPrivate);
  });

  it('keeps the SDK-only .localhost suffix rule', async () => {
    const sdk = await loadSdk();
    expect(sdk.isPrivatePaymentHost('seller.localhost')).toBe(true);
  });

  it.each([
    'https://[64:ff9b::a9fe:a9fe]/paid', 'https://[2002:c0a8:101::]/paid', 'https://100.64.0.1/paid',
    'https://192.88.99.1/paid', 'https://[2001:db8::1]/paid', 'https://192.0.2.10/paid',
  ])('rejects %s before DNS or fetch', async (url) => {
    const sdk = await loadSdk();
    const lookup = vi.fn();
    const fetchImpl = vi.fn();
    expect(sdk.parseSafePaymentUrl(url)).toBeNull();
    await expect(sdk.fetchPaymentTarget(url, { lookup, fetchImpl })).rejects.toThrow('payment_target_not_allowed');
    expect(lookup).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['64:ff9b::a9fe:a9fe', 6], ['2002:c0a8:101::', 6], ['100.64.0.1', 4], ['192.88.99.1', 4],
  ] as const)('rejects a DNS answer of %s before a custom transport runs', async (address, family) => {
    const sdk = await loadSdk();
    const lookup = vi.fn(async () => [{ address, family }]);
    const fetchImpl = vi.fn();
    await expect(
      sdk.fetchPaymentTarget('https://seller.example/paid', { lookup, fetchImpl }),
    ).rejects.toThrow('payment_target_private_address');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

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
        // 公開アドレスに解決する resolver を明示 (未指定でも既定 resolver で pre-resolution は
        // 走るが、実 DNS に依存すると timeoutMs=5 との競合でフレークするため固定する)。
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
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

  // B2: custom fetchImpl のときも既定 resolver で pre-resolution を走らせる。以前は
  // `fetchImpl === globalThis.fetch` でないと DNS 事前解決を丸ごと飛ばしていたため、公開ホスト名が
  // link-local (169.254.169.254 = クラウドのメタデータ endpoint) に解決しても素通りしていた。
  it('pre-resolves with the default resolver when a custom fetchImpl supplies no lookup', async () => {
    vi.resetModules();
    const dnsLookup = vi.fn(async () => [
      { address: '169.254.169.254', family: 4 },
    ]);
    vi.doMock('node:dns/promises', () => ({
      default: { lookup: dnsLookup },
      lookup: dnsLookup,
    }));
    const sdk = (await import(pathToFileURL(SDK_ENTRY).href)) as SdkModule;
    const fetchImpl = vi.fn();

    await expect(
      sdk.fetchPaymentTarget('https://metadata.seller.example/paid', {
        fetchImpl,
      }),
    ).rejects.toThrow('payment_target_private_address');
    expect(dnsLookup).toHaveBeenCalledWith('metadata.seller.example', {
      all: true,
      verbatim: true,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    vi.doUnmock('node:dns/promises');
    vi.resetModules();
  });

  // 既定 resolver が引けない (NXDOMAIN 等) ことは「private 宛て」の証明ではないので、custom
  // transport 側の解決に委ねて通す (fail-open)。connect 時 rebinding の防御は lookup 指定が条件。
  it('lets a custom fetchImpl proceed when the default resolver cannot resolve', async () => {
    vi.resetModules();
    const dnsLookup = vi.fn(async () => {
      throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' });
    });
    vi.doMock('node:dns/promises', () => ({
      default: { lookup: dnsLookup },
      lookup: dnsLookup,
    }));
    const sdk = (await import(pathToFileURL(SDK_ENTRY).href)) as SdkModule;
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 402 }));

    await expect(
      sdk.fetchPaymentTarget('https://seller.example/paid', { fetchImpl }),
    ).resolves.toMatchObject({ status: 402 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    vi.doUnmock('node:dns/promises');
    vi.resetModules();
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
