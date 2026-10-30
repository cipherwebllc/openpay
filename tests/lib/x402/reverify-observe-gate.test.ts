// @vitest-environment node
// 観測だけの照合 (E-3 の残り・2026-10-30 user 裁定 (b) の「観測」の段)。probeForReverifyDetailed に掲載の payTo を渡すと、
// ok_402_openpay の回だけ、公開待ちと同じ照合 (lib/x402/registrationGateMatch.ts) の結果を observedMismatch に添える。
// verdict・authClass は渡さないときと同じ値のまま (= 公開・非公開を変えない) で、追加の HTTP もしないことを確かめる。
// 402 の accepts は本物のカタログの accepts (publicDiscoveryItem) を使う (tests/lib/x402/reverify-pending-match.test.ts と同じ)。

import { afterEach, describe, expect, it, vi } from 'vitest';

const URL = 'https://seller.test/api/paid/report';
const SELLER = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa';
const OTHER = '0x9999999999999999999999999999999999999999';
const FORWARDER = '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4';
const FEE_RECEIVER = '0x428483d2bd5E9f0e9f8E9f8e9F8E9F8E9f8e9F8e';
const JPYC_AMOY = '0x00000000000000000000000000000000000Ca11a';
const lookupPublic = async () => [{ address: '93.184.216.34', family: 4 }];
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');

async function load() {
  vi.stubEnv('NEXT_PUBLIC_NETWORK_ENV', 'testnet');
  vi.stubEnv('NEXT_PUBLIC_FEE_RECEIVER_ADDRESS', FEE_RECEIVER);
  vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_AMOY', FORWARDER);
  vi.stubEnv('NEXT_PUBLIC_JPYC_TESTNET_ADDRESS', JPYC_AMOY);
  vi.resetModules();
  const reverify = await import('@/lib/x402/reverify');
  const { publicDiscoveryItem } = await import('@/lib/x402/discoveryItem');
  const { registrationAcceptExpectation } = await import('@/lib/x402/registrationGateMatch');
  const catalogAccepts = (merchant: string) => publicDiscoveryItem({
    id: 'r1', merchant, url: URL, description: 'paid report', priceJpyc: '100', category: 'api',
    payTo: merchant, network: registrationAcceptExpectation(merchant).network, active: true, createdAt: 1,
  }).accepts;
  return { ...reverify, catalogAccepts };
}

// 呼ばれるたびに新しい Response を返し、呼ばれた回数を数える (追加の HTTP が無いことを見る)。
function serve(status: number, body: string, headers: Record<string, string> = {}) {
  const fetchImpl = vi.fn(async () => new Response(body, { status, headers }));
  return fetchImpl as unknown as typeof fetch & { mock: { calls: unknown[] } };
}
const opts = (fetchImpl: typeof fetch) => ({ fetchImpl, lookup: lookupPublic });
const v1 = (accepts: unknown) => JSON.stringify({ x402Version: 1, accepts });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('probeForReverifyDetailed の観測 (observePayTo)', () => {
  it('掲載の受取先の 402 は observedMismatch: null (一致)・verdict と authClass は渡さないときと同じ', async () => {
    const m = await load();
    const body = v1(m.catalogAccepts(SELLER));
    const plain = await m.probeForReverifyDetailed(URL, opts(serve(402, body)));
    const observed = await m.probeForReverifyDetailed(URL, opts(serve(402, body)), SELLER);
    expect(plain).toEqual({ verdict: 'ok_402_openpay', authClass: 'clear' });
    expect(observed).toEqual({ ...plain, observedMismatch: null });
  });

  it('他人の受取先の 402 は observedMismatch: payTo を添えるだけで、verdict は ok のまま', async () => {
    const m = await load();
    const body = v1(m.catalogAccepts(OTHER));
    expect(await m.probeForReverifyDetailed(URL, opts(serve(402, body)), SELLER))
      .toEqual({ verdict: 'ok_402_openpay', authClass: 'clear', observedMismatch: 'payTo' });
    // 公開待ちの probe (#957) なら同じ 402 で公開に進まない = 照合の結果は同じ (観測と強制で同じ関数を使う)。
    expect(await m.probeForPendingFirstVerification(URL, SELLER, opts(serve(402, body))))
      .toMatchObject({ mismatch: 'payTo' });
  });

  it('別のチェーン・JPYC・forwarder・mode だけの固定の 402 (E-3)・v2 ヘッダの他人の accept も、verdict は ok のまま項目を添える', async () => {
    const m = await load();
    const [accept] = m.catalogAccepts(SELLER) as Array<Record<string, unknown>>;
    const cases: Array<[string, Record<string, string>, string]> = [
      [v1([{ ...accept, network: 'eip155:137' }]), {}, 'network'],
      [v1([{ ...accept, asset: OTHER }]), {}, 'asset'],
      [v1([{ ...accept, payTo: OTHER }]), {}, 'forwarder'],
      [JSON.stringify({ accepts: [{ extra: { openpay: { mode: 'forwarder-split' } } }] }), {}, 'payTo'],
      [v1(m.catalogAccepts(SELLER)), { 'PAYMENT-REQUIRED': b64({ x402Version: 2, accepts: m.catalogAccepts(OTHER) }) }, 'payTo'],
    ];
    for (const [body, headers, mismatch] of cases) {
      const plain = await m.probeForReverifyDetailed(URL, opts(serve(402, body, headers)));
      expect(plain).toEqual({ verdict: 'ok_402_openpay', authClass: 'clear' });
      expect([mismatch, await m.probeForReverifyDetailed(URL, opts(serve(402, body, headers)), SELLER)])
        .toEqual([mismatch, { ...plain, observedMismatch: mismatch }]);
    }
  });

  it('dual-rail の 402 (v2 は USDC だけ・v1 body に JPYC) は v1 の JPYC accept を照合して一致', async () => {
    const m = await load();
    const usdc = { scheme: 'exact', network: 'eip155:8453', amount: '1000', payTo: OTHER,
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' };
    const res = serve(402, v1(m.catalogAccepts(SELLER)), {
      'content-type': 'application/json',
      'PAYMENT-REQUIRED': b64({ x402Version: 2, accepts: [usdc] }),
    });
    expect(await m.probeForReverifyDetailed(URL, opts(res), SELLER))
      .toEqual({ verdict: 'ok_402_openpay', authClass: 'clear', observedMismatch: null });
  });

  it('ok 以外の verdict は照合しない (observedMismatch を添えず、渡さないときと同じ値)', async () => {
    const m = await load();
    const cases: Array<[number, string, Record<string, string>]> = [
      [404, '', {}],
      [410, '', {}],
      [200, 'free content', {}],
      [500, '', {}],
      [429, '', {}],
      [401, '', {}],
      [403, '', {}],
      [302, '', { location: 'https://elsewhere.test/' }],
      [402, JSON.stringify({ accepts: [{ network: 'base', payTo: OTHER }] }), {}],
      [402, 'not json', {}],
    ];
    for (const [status, body, headers] of cases) {
      const plain = await m.probeForReverifyDetailed(URL, opts(serve(status, body, headers)));
      const observed = await m.probeForReverifyDetailed(URL, opts(serve(status, body, headers)), SELLER);
      expect([status, observed]).toEqual([status, plain]);
      expect(observed).not.toHaveProperty('observedMismatch');
      expect(observed.verdict).not.toBe('ok_402_openpay');
    }
  });

  it('観測しても HTTP は 1 回だけ (この probe が読んだ 402 の accepts を使う)', async () => {
    const m = await load();
    const plainFetch = serve(402, v1(m.catalogAccepts(OTHER)));
    const observedFetch = serve(402, v1(m.catalogAccepts(OTHER)));
    await m.probeForReverifyDetailed(URL, opts(plainFetch));
    await m.probeForReverifyDetailed(URL, opts(observedFetch), SELLER);
    expect(plainFetch.mock.calls).toHaveLength(1);
    expect(observedFetch.mock.calls).toHaveLength(1);
  });
});
