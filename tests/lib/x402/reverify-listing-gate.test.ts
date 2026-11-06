// @vitest-environment node
// 外部の掲載 (公開中・モデレーションの hidden) の照合 (E-3 の残り・2026-10-30 user 裁定 (b) の「強制」の段)。
// probeForReverifyDetailed に掲載の payTo を渡すと、OpenPay 方式の 402 は登録と同じ照合 (lib/x402/registrationGateMatch.ts)
// を通ったときだけ ok になり、合わなければ確定違反 (violation_gate_mismatch) と不一致の項目を返す。ok 以外の verdict・
// 渡さないとき (first-party) の戻り値は従来どおりで、追加の HTTP もしないことを確かめる。
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

describe('probeForReverifyDetailed の照合 (listingPayTo)', () => {
  it('掲載の受取先の 402 は ok (渡さないときと同じ値・mismatch なし)', async () => {
    const m = await load();
    const body = v1(m.catalogAccepts(SELLER));
    const plain = await m.probeForReverifyDetailed(URL, opts(serve(402, body)));
    const matched = await m.probeForReverifyDetailed(URL, opts(serve(402, body)), SELLER);
    expect(plain).toEqual({ verdict: 'ok_402_openpay', authClass: 'clear' });
    expect(matched).toEqual(plain);
  });

  it('他人の受取先の 402 は確定違反 (violation_gate_mismatch・payTo)・公開待ちの probe と同じ照合', async () => {
    const m = await load();
    const body = v1(m.catalogAccepts(OTHER));
    expect(await m.probeForReverifyDetailed(URL, opts(serve(402, body)), SELLER))
      .toEqual({ verdict: 'violation_gate_mismatch', authClass: 'clear', mismatch: 'payTo' });
    // 公開待ちの probe (#957) も同じ 402 で同じ項目を返す (verdict だけが違う = 違反に数えない)。
    expect(await m.probeForPendingFirstVerification(URL, SELLER, opts(serve(402, body))))
      .toEqual({ verdict: 'pending_gate_mismatch', authClass: 'clear', mismatch: 'payTo' });
  });

  it('別のチェーン・JPYC・forwarder・mode だけの固定の 402 (E-3)・v2 ヘッダの他人の accept も確定違反', async () => {
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
      // 照合しない probe (first-party) では従来どおり ok。
      expect(await m.probeForReverifyDetailed(URL, opts(serve(402, body, headers))))
        .toEqual({ verdict: 'ok_402_openpay', authClass: 'clear' });
      expect([mismatch, await m.probeForReverifyDetailed(URL, opts(serve(402, body, headers)), SELLER)])
        .toEqual([mismatch, { verdict: 'violation_gate_mismatch', authClass: 'clear', mismatch }]);
    }
  });

  it('dual-rail の 402 (v2 は USDC だけ・v1 body に JPYC) は v1 の JPYC accept を照合して ok', async () => {
    const m = await load();
    const usdc = { scheme: 'exact', network: 'eip155:8453', amount: '1000', payTo: OTHER,
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' };
    const res = serve(402, v1(m.catalogAccepts(SELLER)), {
      'content-type': 'application/json',
      'PAYMENT-REQUIRED': b64({ x402Version: 2, accepts: [usdc] }),
    });
    expect(await m.probeForReverifyDetailed(URL, opts(res), SELLER))
      .toEqual({ verdict: 'ok_402_openpay', authClass: 'clear' });
  });

  it('ok 以外の verdict は照合しない (渡さないときと同じ値・mismatch なし)', async () => {
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
      const matched = await m.probeForReverifyDetailed(URL, opts(serve(status, body, headers)), SELLER);
      expect([status, matched]).toEqual([status, plain]);
      expect(matched).not.toHaveProperty('mismatch');
      expect(matched.verdict).not.toBe('ok_402_openpay');
    }
  });

  it('照合しても HTTP は 1 回だけ (この probe が読んだ 402 の accepts を使う)', async () => {
    const m = await load();
    const plainFetch = serve(402, v1(m.catalogAccepts(OTHER)));
    const matchedFetch = serve(402, v1(m.catalogAccepts(OTHER)));
    await m.probeForReverifyDetailed(URL, opts(plainFetch));
    await m.probeForReverifyDetailed(URL, opts(matchedFetch), SELLER);
    expect(plainFetch.mock.calls).toHaveLength(1);
    expect(matchedFetch.mock.calls).toHaveLength(1);
  });
});

describe('violation_gate_mismatch の分類', () => {
  it('確定違反: 公開中は failures を数えて閾値で hidden・hidden は戻らない・締め出しのカウンタは 0 に戻す', async () => {
    const m = await load();
    expect(m.isViolationVerdict('violation_gate_mismatch')).toBe(true);
    const verification = (failures: number) =>
      ({ failures, authFailures: 2, lastCheckedAt: 'old', lastRunId: 'r0', probedUrl: URL });
    const counted = m.transitionVerification(
      { hidden: false, verification: verification(0) }, 'violation_gate_mismatch', 't1', 'r1', URL, 'clear',
    );
    expect(counted).toMatchObject({ hidden: false, hiddenTransition: null, verification: { failures: 1 } });
    expect(counted.verification).not.toHaveProperty('authFailures');
    expect(counted.verification).not.toHaveProperty('lastOkAt');
    expect(m.transitionVerification(
      { hidden: false, verification: verification(m.REVERIFY_HIDE_THRESHOLD - 1) },
      'violation_gate_mismatch', 't1', 'r1', URL, 'clear',
    )).toMatchObject({ hidden: true, hiddenTransition: 'hidden' });
    expect(m.transitionVerification(
      { hidden: true, verification: verification(m.REVERIFY_HIDE_THRESHOLD) },
      'violation_gate_mismatch', 't1', 'r1', URL, 'clear',
    )).toMatchObject({ hidden: true, hiddenTransition: null, verification: { failures: m.REVERIFY_HIDE_THRESHOLD + 1 } });
  });
});
