// R1 の抽出前に旧実装で取った wire の固定。本文全体の SHA は、意図した wire 変更
// (掟 15 のレビューを経たもの) でだけ更新する。抽出やリファクタに合わせて作り直さない。
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress, type Hex } from 'viem';
import type { HostedPurchaseMetadata } from '@/lib/x402/hostedStore';

const h = vi.hoisted(() => ({
  strings: new Map<string, string>(),
  set: vi.fn(),
  eval: vi.fn(),
  product: vi.fn(),
  verify: vi.fn(),
  postFacilitator: vi.fn(),
}));

vi.mock('@/lib/kv', () => ({
  kvGet: async (key: string) => ({ ok: true, value: h.strings.get(key) ?? null }),
  kvSet: h.set,
  kvEval: h.eval,
}));
vi.mock('@/lib/x402/hostedStore', async (original) => ({
  ...await original<typeof import('@/lib/x402/hostedStore')>(),
  getHostedProduct: h.product,
  getHostedContent: async () => ({ kind: 'text', value: 'Private content' }),
  sellerDisclosureComplete: async () => true,
}));
vi.mock('@/lib/x402/purchaseIntent', async (original) => {
  const actual = await original<typeof import('@/lib/x402/purchaseIntent')>();
  return {
    ...actual,
    createQuotedPurchaseIntent: (input: Parameters<typeof actual.createQuotedPurchaseIntent>[0]) =>
      actual.createQuotedPurchaseIntent({ ...input, intentSalt: `0x${'ab'.repeat(32)}` }),
    checkPurchaseQuoteRateLimit: async () => true,
    readPurchaseAnchorBlock: async () => 90n,
  };
});
vi.mock('@/lib/x402/storeUsdcIntent', async (original) => {
  const actual = await original<typeof import('@/lib/x402/storeUsdcIntent')>();
  return {
    ...actual,
    createQuotedStoreUsdcIntent: (input: Parameters<typeof actual.createQuotedStoreUsdcIntent>[0]) =>
      actual.createQuotedStoreUsdcIntent({ ...input, intentSalt: `0x${'ab'.repeat(32)}` }),
  };
});
vi.mock('@/lib/x402/storeUsdcOnchain', async (original) => ({
  ...await original<typeof import('@/lib/x402/storeUsdcOnchain')>(),
  readStoreUsdcAnchorBlock: async () => 90n,
}));
vi.mock('@/lib/x402/storeRailSelection', () => ({
  associateStoreRailIntent: async () => ({ ok: true, parentIntentId: '9'.repeat(64) }),
}));
vi.mock('@/lib/x402/storeUsdcRateProvider', () => ({
  quoteStoreJpycInUsdc: async () => ({ ok: true, quote: {
    usdcQuoteAtomic: '2000000', rateScaled: '150000000',
    fetchedAt: 1_900_000_000_000, fxQuoteExpiresAt: 1_900_000_180_000, rounding: 'ceil',
  } }),
}));
vi.mock('@/lib/net/ipHash', () => ({ clientIp: () => '127.0.0.1', hashIpBucket: () => 'ip' }));
vi.mock('@/app/api/facilitator/verify/route', () => ({ POST: h.verify }));
vi.mock('@/app/api/facilitator/settle/route', () => ({ POST: vi.fn() }));
vi.mock('@/lib/x402/vanillaGate', () => ({ postFacilitator: h.postFacilitator }));

const NOW = 1_900_000_000_000;
const RESOURCE = `h_${'a'.repeat(32)}`;
const PAYER = getAddress('0xabcabcabcabcabcabcabcabcabcabcabcabcabca');
const MERCHANT = getAddress('0x2222222222222222222222222222222222222222');
const FORWARDER = getAddress('0x752b7aad0089286eb7b553d84d05233d80c9fcb4');
const FEE_RECEIVER = getAddress('0x3333333333333333333333333333333333333333');
const SALT = `0x${'ab'.repeat(32)}` as Hex;
const SIGNATURE = `0x${'12'.repeat(64)}1b` as Hex;
const UNIT = 10n ** 18n;
const META: HostedPurchaseMetadata = {
  owner: MERCHANT, payTo: MERCHANT, title: 'Wire fixture 日本語',
  desc: 'Description', emoji: '🧪', priceJpyc: '300', contentKind: 'text', label: 'prompt',
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv('NEXT_PUBLIC_NETWORK_ENV', 'testnet');
  vi.stubEnv('ENABLE_CREATOR_STORE', 'true');
  vi.stubEnv('NEXT_PUBLIC_ENABLE_X402_FACILITATOR', 'true');
  vi.stubEnv('ENABLE_LICENSE_NFT', 'true');
  vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_AMOY', FORWARDER);
  vi.stubEnv('NEXT_PUBLIC_JPYC_TESTNET_ADDRESS', '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29');
  vi.stubEnv('NEXT_PUBLIC_FEE_RECEIVER_ADDRESS', FEE_RECEIVER);
  vi.stubEnv('X402_FEE_BPS', '100');
  vi.stubEnv('X402_FEE_FLOOR_JPYC', '1');
  h.strings.clear();
  h.set.mockImplementation(async (key: string, value: string) => {
    h.strings.set(key, value);
    return { ok: true, value: 'OK' };
  });
  // Only the existing quote write is emulated. Any accidental state transition fails.
  h.eval.mockImplementation(async (script: string, keys: string[], args: string[]) => {
    if (!script.includes("redis.call('EXISTS', KEYS[1])")) throw new Error('unexpected Lua');
    h.strings.set(keys[0], args[0]);
    h.strings.set(keys[1], args[1]);
    return { ok: true, value: 1 };
  });
  h.product.mockResolvedValue({
    ...META, id: RESOURCE, contentRevision: 1, saleActive: true,
    contentAvailable: true, usdcEnabled: true, createdAt: NOW,
  });
  // Stop at the external verification boundary, after real local authorization checks.
  h.verify.mockImplementation(async () => Response.json({ isValid: false, invalidReason: 'fixture_stop' }));
  h.postFacilitator.mockResolvedValue({ isValid: false, invalidReason: 'fixture_stop' });
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

async function quoteBoth(metadata: HostedPurchaseMetadata = META, anchorBlock = 90n) {
  const jpyc = await import('@/lib/x402/purchaseIntent');
  const usdc = await import('@/lib/x402/storeUsdcIntent');
  const { JPYC_V3_ASSET } = await import('@/lib/x402/types');
  const common = { resourceId: RESOURCE, contentRevision: 1, metadata, payer: PAYER, anchorBlock, now: NOW, intentSalt: SALT };
  return {
    jpyc: await jpyc.createQuotedPurchaseIntent({
      ...common, token: JPYC_V3_ASSET.address, chainId: 80002, forwarder: FORWARDER,
      merchant: MERCHANT, merchantValue: BigInt(metadata.priceJpyc) * UNIT,
      feeReceiver: FEE_RECEIVER, feeValue: 3n * UNIT,
    }),
    usdc: await usdc.createQuotedStoreUsdcIntent({
      ...common, usdcQuoteAtomic: '2000000', rateScaled: '150000000',
      rateFetchedAt: NOW, rounding: 'ceil', fxQuoteExpiresAt: NOW + 180_000,
    }),
  };
}

describe('R1 pre-extraction quote contracts', () => {
  it.each([
    ['download', true, true], ['pdf', true, true], ['zip', true, true],
    ['prompt', true, true], ['api', true, true], ['external', true, true],
    ['', false, false], ['PDF', false, false], [' pdf ', false, false],
    ['license', false, false], [undefined, false, false], [null, false, false],
    [1, false, false], [{}, false, false], [[], false, false],
    [['pdf'], false, true], [Object('pdf'), false, true],
  ])('label %j: JPYC=%s / USDC=%s through real creators', async (label, jpycOk, usdcOk) => {
    const results = await quoteBoth({ ...META, label } as HostedPurchaseMetadata);
    expect(results.jpyc.ok).toBe(jpycOk);
    expect(results.usdc.ok).toBe(usdcOk);
    if (results.jpyc.ok) expect(results.jpyc.intent.metadata.label).toBe(label);
    if (results.usdc.ok) {
      // String(label) validates only; USDC persists the original value.
      expect(results.usdc.intent.metadata.label).toBe(label);
      expect(JSON.parse(h.eval.mock.calls[0][2][0]).metadata.label).toEqual(JSON.parse(JSON.stringify(label)));
    }
  });

  it('preserves the license-only JPYC metadata path', async () => {
    const { createLicenseDefinition } = await import('@/lib/license/definition');
    const license = createLicenseDefinition(RESOURCE, {
      supply: 10, transferable: false, termsUrl: 'https://seller.example/terms', termsVersion: 'v1',
    }, 80002, MERCHANT);
    const results = await quoteBoth({ ...META, productKind: 'license', license, priceJpyc: '1000' });
    expect(results.jpyc.ok).toBe(true);
    expect(results.usdc).toEqual({ ok: false, reason: 'invalid' });
  });

  it('preserves uint256 bounds in JPYC and unbounded canonical decimals in USDC', async () => {
    const results = await quoteBoth(META, 1n << 256n);
    expect(results.jpyc).toEqual({ ok: false, reason: 'invalid' });
    expect(results.usdc.ok).toBe(true);
  });

  it('pins quote storage bytes, hashes and positional storage arguments', async () => {
    const results = await quoteBoth();
    expect(results.jpyc.ok && results.usdc.ok).toBe(true);
    const [key, raw, options] = h.set.mock.calls[0];
    expect(key).toBe(`store:intent:${SALT}`);
    expect(options).toEqual({ nx: true, ttlSec: 720 });
    expect(createHash('sha256').update(raw).digest('hex')).toBe('fec2e593d004e0404ebeb425ea4efee604f199602371303130d7838e28d0912d');
    const [, keys, args] = h.eval.mock.calls[0];
    expect(keys).toEqual([`store:usdc:intent:${SALT}`, `store:usdc:nonce:${JSON.parse(args[0]).nonce}`]);
    expect(args.slice(1)).toEqual([SALT, '720']);
    expect(createHash('sha256').update(args[0]).digest('hex')).toBe('5f396f95de86f16f0d74565b68bc0f306b5fd3d22895e5bfd4a2f4c106b4d442');
  });
});

describe('R1 real hosted challenge → client authorization → server validation', () => {
  it.each(['jpyc', 'usdc'] as const)('%s retains v1/v2 wire and payer/query representation', async (rail) => {
    const { GET } = await import('@/app/api/paid/hosted/[id]/route');
    const jp = await import('@/lib/x402/hostedPurchaseWire');
    const us = await import('@/lib/x402/hostedUsdcPurchaseWire');
    const suffix = rail === 'usdc' ? '&rail=usdc' : '';
    const url = `https://open-pay.jp/api/paid/hosted/${RESOURCE}?payer=${PAYER}${suffix}`;
    const response = await GET(new Request(url.replace(PAYER, PAYER.toLowerCase())), { params: Promise.resolve({ id: RESOURCE }) });
    expect(response.status).toBe(402);
    const raw = await response.text();
    const body = JSON.parse(raw);
    const v2Raw = response.headers.get('PAYMENT-REQUIRED')!;
    const v2 = JSON.parse(Buffer.from(v2Raw, 'base64').toString('utf8'));
    expect(body.accepts[0].resource).toBe(url);
    expect(v2.resource.url).toBe(url);
    expect(createHash('sha256').update(raw).digest('hex')).toBe(rail === 'jpyc'
      ? '7f515a49038aa39b6e08038731fe65cdc76f7e963a21bbb8fadddd2245ee8ffd'
      : '5945bacb12b9be1cd860c83f011d3700da1d05778c3f1a7ea89443dd695f8ed4');
    expect(createHash('sha256').update(v2Raw).digest('hex')).toBe(rail === 'jpyc'
      ? '4654ac97c3cf95721332e45e809107f1b92794a97ae3380a4a210cc9daf6bb83'
      : 'f5bee75c27f543058ed3825fd715ea1230fb8863570f8909263063af689a441e');

    const payload = (() => {
      if (rail === 'jpyc') {
        const quote = jp.normalizeHostedPaymentRequired(body, META.priceJpyc, MERCHANT);
        const authorization = jp.createHostedPurchaseAuthorization(quote, PAYER, NOW / 1000);
        expect(authorization).toEqual({ from: PAYER, validAfter: '0', validBefore: '1900000600', intentSalt: SALT });
        return jp.hostedPaymentPayload(quote, authorization, SIGNATURE);
      }
      const quote = us.normalizeHostedUsdcPaymentRequired(body, {
        resourceId: RESOURCE, payer: PAYER, merchant: MERCHANT, priceJpyc: META.priceJpyc, title: META.title, selectedRail: 'usdc',
      }, NOW);
      const authorization = us.createHostedUsdcAuthorization(quote, PAYER, NOW / 1000);
      expect(authorization).toEqual({ from: PAYER, to: MERCHANT, value: '2000000', validAfter: '0', validBefore: '1900000180', nonce: quote.nonce });
      return us.hostedUsdcPaymentPayload(quote, authorization, SIGNATURE);
    })();
    for (const version of [1, 2]) {
      const wire = version === 1 ? payload : {
        x402Version: 2, resource: v2.resource, accepted: v2.accepts[0], payload: payload.payload,
      };
      const submitted = await GET(new Request(url, { headers: {
        [version === 1 ? 'X-PAYMENT' : 'PAYMENT-SIGNATURE']: jp.encodeHostedPaymentHeader(wire),
      } }), { params: Promise.resolve({ id: RESOURCE }) });
      expect(submitted.status, await submitted.clone().text()).toBe(402);
      if (rail === 'jpyc') {
        expect(await submitted.json()).toEqual({ ok: false, error: 'fixture_stop' });
        const forwarded = await h.verify.mock.calls.at(-1)![0].json();
        expect(forwarded.paymentRequirements).toEqual(body.accepts[0]);
        expect(forwarded.paymentPayload).toEqual(payload);
        const { buildPurchaseAuthorizationClaim, getPurchaseIntent } = await import('@/lib/x402/purchaseIntent');
        const intent = await getPurchaseIntent(SALT);
        if (!intent || typeof intent === 'string') throw new Error('missing intent');
        expect(buildPurchaseAuthorizationClaim({ intent, paymentPayload: payload, facilitatorBody: forwarded, now: NOW }).ok).toBe(true);
        const mismatches = [url + '&rail=usdc', url.replace(PAYER, PAYER.toLowerCase())];
        for (const resource of mismatches) {
          expect(buildPurchaseAuthorizationClaim({ intent, paymentPayload: payload, facilitatorBody: {
            ...forwarded, paymentRequirements: { ...forwarded.paymentRequirements, resource },
          }, now: NOW })).toEqual({ ok: false, reason: 'intent_mismatch' });
        }
      } else {
        expect((await submitted.json()).error).toBe('fixture_stop');
        const [endpoint, forwarded, cdp] = h.postFacilitator.mock.calls.at(-1)!;
        expect(endpoint).toBe('/verify');
        expect(forwarded.paymentRequirements).toEqual(body.accepts[0]);
        expect(forwarded.paymentPayload).toEqual(payload);
        expect(cdp.resource.resourceUrl).toBe(url);
      }
    }
    expect(rail === 'jpyc' ? h.verify : h.postFacilitator).toHaveBeenCalledTimes(2);
  });
});
