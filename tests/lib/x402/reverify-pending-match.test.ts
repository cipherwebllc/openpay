// @vitest-environment node
// E-3: 最初の再検証を待つ新規掲載 (pendingFirstVerification) の probe (probeForPendingFirstVerification)。OpenPay 方式の
// 402 を、登録と同じ照合 (lib/x402/registrationGateMatch.ts) に掲載の payTo で通し、合うときだけ ok にする。
// 公開中の掲載の probe (probeForReverifyDetailed) は同じ 402 でも従来どおりの verdict を返すことも並べて確かめる。
// 402 の accepts は本物のカタログの accepts (publicDiscoveryItem) を使う = SDK / スニペット / x402-jpyc-gateway の
// ゲートが返す形 (tests/lib/x402/registration-gate-match.test.ts がゲートを動かして確かめている)。

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
  // 受取先 merchant の掲載のカタログの accepts (/api/discovery/<id> が返す本物の値)。
  const catalogAccepts = (merchant: string) => publicDiscoveryItem({
    id: 'r1', merchant, url: URL, description: 'paid report', priceJpyc: '100', category: 'api',
    payTo: merchant, network: registrationAcceptExpectation(merchant).network, active: true, createdAt: 1,
  }).accepts;
  return { ...reverify, catalogAccepts };
}

// 呼ばれるたびに新しい Response を返す (本文は 1 回しか読めない)。
function serve(status: number, body: string, headers: Record<string, string> = {}) {
  return (async () => new Response(body, { status, headers })) as unknown as typeof fetch;
}
const opts = (fetchImpl: typeof fetch) => ({ fetchImpl, lookup: lookupPublic });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('probeForPendingFirstVerification', () => {
  it('掲載の受取先のカタログの accepts を返す 402 (v1 body) は ok', async () => {
    const m = await load();
    const accepts = m.catalogAccepts(SELLER);
    expect(accepts.length).toBeGreaterThan(0);
    const res = serve(402, JSON.stringify({ x402Version: 1, accepts }), { 'content-type': 'application/json' });
    expect(await m.probeForPendingFirstVerification(URL, SELLER, opts(res)))
      .toEqual({ verdict: 'ok_402_openpay', authClass: 'clear' });
  });

  it('dual-rail の 402 (v2 ヘッダは USDC だけ・v1 body に JPYC) も、v1 の JPYC accept を照合して ok', async () => {
    const m = await load();
    const usdc = { scheme: 'exact', network: 'eip155:8453', amount: '1000', payTo: OTHER,
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' };
    const res = serve(402, JSON.stringify({ x402Version: 1, accepts: m.catalogAccepts(SELLER) }), {
      'content-type': 'application/json',
      'PAYMENT-REQUIRED': b64({ x402Version: 2, accepts: [usdc] }),
    });
    // USDC の受取先 (OTHER) は照合しない (登録と同じ)。
    expect(await m.probeForPendingFirstVerification(URL, SELLER, opts(res)))
      .toEqual({ verdict: 'ok_402_openpay', authClass: 'clear' });
  });

  it('他人の受取先の 402 は pending_gate_mismatch (payTo)・公開中の掲載の probe では ok のまま', async () => {
    const m = await load();
    const body = JSON.stringify({ x402Version: 1, accepts: m.catalogAccepts(OTHER) });
    expect(await m.probeForPendingFirstVerification(URL, SELLER, opts(serve(402, body))))
      .toEqual({ verdict: 'pending_gate_mismatch', authClass: 'clear', mismatch: 'payTo' });
    expect(await m.probeForReverifyDetailed(URL, opts(serve(402, body))))
      .toEqual({ verdict: 'ok_402_openpay', authClass: 'clear' });
  });

  it('v2 ヘッダの OpenPay accept も照合する (v2 が OpenPay なら body は読まない・登録と同じ順)', async () => {
    const m = await load();
    const res = serve(402, JSON.stringify({ x402Version: 1, accepts: m.catalogAccepts(SELLER) }), {
      'PAYMENT-REQUIRED': b64({ x402Version: 2, accepts: m.catalogAccepts(OTHER) }),
    });
    expect(await m.probeForPendingFirstVerification(URL, SELLER, opts(res)))
      .toMatchObject({ verdict: 'pending_gate_mismatch', mismatch: 'payTo' });
  });

  // E-3 の再現: 本物のゲートが無く、固定の JSON マーカーだけを返す 402。
  it('mode: forwarder-split だけの固定の 402 は pending では ok にならない', async () => {
    const m = await load();
    const body = JSON.stringify({ accepts: [{ extra: { openpay: { mode: 'forwarder-split' } } }] });
    expect(await m.probeForPendingFirstVerification(URL, SELLER, opts(serve(402, body))))
      .toEqual({ verdict: 'pending_gate_mismatch', authClass: 'clear', mismatch: 'payTo' });
    expect(await m.probeForReverifyDetailed(URL, opts(serve(402, body))))
      .toEqual({ verdict: 'ok_402_openpay', authClass: 'clear' });
  });

  it('受取先が合っていても、別のチェーン・JPYC・forwarder を向いたゲートは合わない', async () => {
    const m = await load();
    const [accept] = m.catalogAccepts(SELLER) as Array<Record<string, unknown>>;
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...accept, network: 'eip155:137' }, 'network'],
      [{ ...accept, asset: OTHER }, 'asset'],
      [{ ...accept, payTo: OTHER }, 'forwarder'],
    ];
    for (const [variant, mismatch] of cases) {
      const body = JSON.stringify({ accepts: [variant] });
      expect(await m.probeForPendingFirstVerification(URL, SELLER, opts(serve(402, body))))
        .toEqual({ verdict: 'pending_gate_mismatch', authClass: 'clear', mismatch });
    }
  });

  it('ok 以外の verdict は照合せずにそのまま (公開中の掲載の probe と同じ)', async () => {
    const m = await load();
    const cases: Array<[number, string]> = [
      [404, ''],
      [410, ''],
      [200, 'free content'],
      [500, ''],
      [403, ''],
      [402, JSON.stringify({ accepts: [{ network: 'base', payTo: OTHER }] })],
      [402, 'not json'],
    ];
    for (const [status, body] of cases) {
      const pending = await m.probeForPendingFirstVerification(URL, SELLER, opts(serve(status, body)));
      const visible = await m.probeForReverifyDetailed(URL, opts(serve(status, body)));
      expect([status, body, pending]).toEqual([status, body, visible]);
      expect(pending.verdict).not.toBe('ok_402_openpay');
    }
  });
});

describe('pending_gate_mismatch の分類', () => {
  // 違反に数えない: 違反 3 連続で印が外れると、通常のモデレーションの hidden の復帰 (照合しない) で同じ 402 が公開に
  // 進むため (lib/x402/reverify.ts probeForPendingFirstVerification の注釈)。
  it('確定違反ではない (カウンタを動かさない transient として CAS に渡る)', async () => {
    const m = await load();
    expect(m.isViolationVerdict('pending_gate_mismatch')).toBe(false);
    const next = m.transitionVerification(
      { hidden: true, verification: { failures: 2, lastCheckedAt: 'old', lastRunId: 'r0', probedUrl: URL } },
      'pending_gate_mismatch', 't1', 'r1', URL, 'clear',
    );
    expect(next).toMatchObject({ hidden: true, hiddenTransition: null, verification: { failures: 2 } });
    expect(next.verification).not.toHaveProperty('lastOkAt');
  });
});
