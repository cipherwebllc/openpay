import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const verificationMocks = vi.hoisted(() => ({
  events: [] as string[],
  snapshot: {} as Record<
    string,
    { checkedAt: string; ok: boolean; sourceUrl: string }
  > | null,
}));

vi.mock('@/lib/directory/verification', () => ({
  readDirectoryVerificationSnapshot: async () => {
    verificationMocks.events.push('snapshot');
    return verificationMocks.snapshot;
  },
}));

const SELLER = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const FACILITATOR = 'https://facilitator.payai.network';
const RESOURCE = 'https://open-pay.jp/api/paid/usdc/japan-web3-directory/licensed';

type Route = { GET: (req: Request) => Promise<Response> };

const fetchMock = vi.fn();

async function load(
  flags: { directory?: string; testMode?: string; key?: string } = {},
): Promise<Route> {
  vi.stubEnv('NEXT_PUBLIC_ENABLE_WEB3_DIRECTORY', flags.directory ?? '1');
  vi.stubEnv('X402_NETWORK', 'base');
  vi.stubEnv('X402_PAY_TO_ADDRESS', SELLER);
  vi.stubEnv('X402_FACILITATOR_URL', FACILITATOR);
  vi.stubEnv('X402_TEST_MODE', flags.testMode ?? '');
  vi.stubEnv('X402_RECEIPT_SIGNING_KEY', flags.key ?? `0x${'c3'.repeat(32)}`);
  vi.resetModules();
  const { NextResponse } = await import('next/server');
  const json = NextResponse.json;
  vi.spyOn(NextResponse, 'json').mockImplementation((body, init) => {
    const response = json(body, init);
    if (body && typeof body === 'object' && 'license' in body) {
      expect(response.status).toBe(200);
      expect(body).toHaveProperty('attestation');
      expect(body).toHaveProperty('signer');
      expect(body).toHaveProperty('verify');
      verificationMocks.events.push('content 200');
    }
    return response;
  });
  return (await import(
    '@/app/api/paid/usdc/japan-web3-directory/licensed/route'
  )) as unknown as Route;
}

function req(headers: Record<string, string> = {}): Request {
  return new Request(RESOURCE, { headers });
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64');
}

const V1_PAYLOAD = {
  x402Version: 1,
  scheme: 'exact',
  network: 'base',
  payload: {
    signature: `0x${'11'.repeat(65)}`,
    authorization: {
      from: '0x0000000000000000000000000000000000000001',
      to: SELLER,
      value: '1000000',
      validAfter: '0',
      validBefore: '99999999999',
      nonce: `0x${'22'.repeat(32)}`,
    },
  },
};

function facilitatorOk(payer: string | undefined = '0x0000000000000000000000000000000000000001', unknownPayer = false): void {
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).endsWith('/verify')) {
      verificationMocks.events.push('verify');
      return new Response(
        JSON.stringify({ isValid: true, payer: unknownPayer ? undefined : payer }),
        { status: 200 },
      );
    }
    verificationMocks.events.push('settle');
    return new Response(
      JSON.stringify({
        success: true,
        transaction: `0x${'ab'.repeat(32)}`,
        network: 'base',
        payer: '0x0000000000000000000000000000000000000001',
      }),
      { status: 200 },
    );
  });
}

beforeEach(() => {
  verificationMocks.events = [];
  verificationMocks.snapshot = {};
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('licensed directory route', () => {
  it('flag OFF is inert', async () => {
    const route = await load({ directory: '' });
    expect((await route.GET(req())).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(verificationMocks.events).toEqual([]);
  });

  it('402 → verify → complete content 200 → settle, with a verifiable license', async () => {
    facilitatorOk();
    const route = await load();
    const challenge = await route.GET(req());
    expect(challenge.status).toBe(402);
    expect((await challenge.json()).accepts[0]).toMatchObject({
      maxAmountRequired: '1000000', resource: RESOURCE, network: 'base', payTo: SELLER,
    });
    expect(challenge.headers.get('PAYMENT-REQUIRED')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(verificationMocks.events).toEqual([]);
    verificationMocks.events.push('402');
    const response = await route.GET(req({ 'x-payment': b64(V1_PAYLOAD) }));
    expect(response.status).toBe(200);
    expect(verificationMocks.events).toEqual(['402', 'verify', 'snapshot', 'content 200', 'settle']);
    const body = await response.json();
    const { DIRECTORY_LICENSE, DIRECTORY_LICENSE_PERMISSIONS } = await import('@/lib/directory/licenseTerms');
    const { directoryContentHash, verifyDirectoryLicense, DIRECTORY_LICENSE_EIP712_DOMAIN, DIRECTORY_LICENSE_TYPES } = await import('@/lib/directory/licenseAttestation');
    const { receiptSignerAddress } = await import('@/lib/x402/receipt');
    expect(body.license).toEqual({
      id: DIRECTORY_LICENSE.id, name: DIRECTORY_LICENSE.name, url: DIRECTORY_LICENSE.urlFor('en'),
      licensee: V1_PAYLOAD.payload.authorization.from, issuedAt: expect.any(String),
      ...DIRECTORY_LICENSE_PERMISSIONS,
    });
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.licenseNotice).toBeTruthy();
    expect(body.attestation.message).toEqual({
      licensee: body.license.licensee, licenseId: DIRECTORY_LICENSE.id,
      contentHash: directoryContentHash(body.items), rows: body.items.length,
      issuedAt: Math.floor(Date.parse(body.license.issuedAt) / 1000),
    });
    expect(body.signer).toBe(receiptSignerAddress());
    expect(await verifyDirectoryLicense(body.attestation.message, body.attestation.signature)).toEqual({ valid: true, signer: body.signer });
    expect(body.verify).toEqual({ method: 'EIP-712 recoverTypedDataAddress', domain: DIRECTORY_LICENSE_EIP712_DOMAIN, types: DIRECTORY_LICENSE_TYPES });
  });

  it('snapshot 503 never settles or builds licensed content', async () => {
    facilitatorOk();
    verificationMocks.snapshot = null;
    const route = await load();
    const response = await route.GET(req({ 'x-payment': b64(V1_PAYLOAD) }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'storage_unavailable' });
    expect(verificationMocks.events).toEqual(['verify', 'snapshot']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('unset signing key still delivers the license with null attestation and signer', async () => {
    facilitatorOk();
    const route = await load({ key: '' });
    const response = await route.GET(req({ 'x-payment': b64(V1_PAYLOAD) }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.license.licensee).toBe(V1_PAYLOAD.payload.authorization.from);
    expect(body.attestation).toBeNull();
    expect(body.signer).toBeNull();
    expect(body.verify.method).toBe('EIP-712 recoverTypedDataAddress');
    expect(verificationMocks.events).toEqual(['verify', 'snapshot', 'content 200', 'settle']);
  });

  it('unknown verified payer remains null and signs the zero address', async () => {
    facilitatorOk(undefined, true);
    const route = await load();
    const response = await route.GET(req({ 'x-payment': b64(V1_PAYLOAD) }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.license.licensee).toBeNull();
    const { zeroAddress } = await import('viem');
    expect(body.attestation.message.licensee).toBe(zeroAddress);
    const { verifyDirectoryLicense } = await import('@/lib/directory/licenseAttestation');
    expect((await verifyDirectoryLicense(body.attestation.message, body.attestation.signature)).valid).toBe(true);
    expect((await verifyDirectoryLicense({ ...body.attestation.message, licensee: V1_PAYLOAD.payload.authorization.from }, body.attestation.signature)).valid).toBe(false);
  });
});
