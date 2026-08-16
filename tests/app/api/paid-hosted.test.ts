import { NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';

const routeMocks = vi.hoisted(() => ({
  env: {
    enableCreatorStore: true,
    enableX402Facilitator: true,
  },
  verify: vi.fn(),
  settle: vi.fn(),
  getHostedProduct: vi.fn(),
  getHostedContent: vi.fn(),
  hostedPurchaseMetadata: vi.fn(),
  sellerDisclosureComplete: vi.fn(),
  createRequirements: vi.fn(),
  buildClaim: vi.fn(),
  checkQuoteRateLimit: vi.fn(),
  claimSettlement: vi.fn(),
  claimSigned: vi.fn(),
  createQuoted: vi.fn(),
  extractIntentSalt: vi.fn(),
  finalize: vi.fn(),
  getIntent: vi.fn(),
  markFailedPrebroadcast: vi.fn(),
  markIndeterminate: vi.fn(),
  authorizationMatches: vi.fn(),
  readAnchorBlock: vi.fn(),
  readSettledAccess: vi.fn(),
  reconcile: vi.fn(),
  recordTransaction: vi.fn(),
  preBroadcastRejection: vi.fn(),
  associateRail: vi.fn(),
  claimRail: vi.fn(),
  releaseRail: vi.fn(),
  claimedFacilitatorBody: null as Record<string, unknown> | null,
}));

vi.mock('@/lib/env', () => ({
  env: routeMocks.env,
}));

vi.mock('@/app/api/facilitator/verify/route', () => ({
  POST: routeMocks.verify,
}));

vi.mock('@/app/api/facilitator/settle/route', () => ({
  POST: routeMocks.settle,
}));

vi.mock('@/lib/x402/hostedStore', () => ({
  getHostedProduct: routeMocks.getHostedProduct,
  getHostedContent: routeMocks.getHostedContent,
  hostedPurchaseMetadata: routeMocks.hostedPurchaseMetadata,
  sellerDisclosureComplete: routeMocks.sellerDisclosureComplete,
}));

vi.mock('@/lib/x402/purchaseIntent', () => ({
  PURCHASE_DEPLOYMENT_VERSION: 'creator-store.purchase.v1',
  PURCHASE_QUOTE_TTL_SEC: 600,
  buildPurchaseAuthorizationClaim: routeMocks.buildClaim,
  checkPurchaseQuoteRateLimit: routeMocks.checkQuoteRateLimit,
  claimPurchaseSettlement: routeMocks.claimSettlement,
  claimSignedPurchaseIntent: routeMocks.claimSigned,
  createQuotedPurchaseIntent: routeMocks.createQuoted,
  extractPurchaseIntentSalt: routeMocks.extractIntentSalt,
  finalizeHostedPurchase: routeMocks.finalize,
  getPurchaseIntent: routeMocks.getIntent,
  markPurchaseFailedPrebroadcast: routeMocks.markFailedPrebroadcast,
  markPurchaseIndeterminate: routeMocks.markIndeterminate,
  purchaseAuthorizationMatches: routeMocks.authorizationMatches,
  readPurchaseAnchorBlock: routeMocks.readAnchorBlock,
  readSettledPurchaseAccess: routeMocks.readSettledAccess,
  reconcilePurchaseIntent: routeMocks.reconcile,
  recordPurchaseTransaction: routeMocks.recordTransaction,
}));

vi.mock('@/lib/x402/requirements', () => ({
  createJpycPaymentRequirements: routeMocks.createRequirements,
}));

vi.mock('@/lib/x402/facilitatorConfig', () => ({
  x402FacilitatorConfig: {
    chainId: 80002,
    jpycDecimals: 18,
  },
}));

vi.mock('@/lib/relay/forwarderIntent', () => ({
  FORWARDER_COMMIT_VERSION: `0x${'c1'.repeat(32)}`,
}));

vi.mock('@/lib/x402/paymentRedelivery', () => ({
  isFacilitatorPreBroadcastRejection: routeMocks.preBroadcastRejection,
}));

vi.mock('@/lib/x402/storeRailSelection', () => ({
  associateStoreRailIntent: routeMocks.associateRail,
  claimStoreRailSelection: routeMocks.claimRail,
  releaseActiveStoreRail: routeMocks.releaseRail,
}));

const RESOURCE_ID = `h_${'1'.repeat(32)}`;
const INTENT_SALT = `0x${'11'.repeat(32)}`;
const UNKNOWN_SALT = `0x${'22'.repeat(32)}`;
const RECOVER_SALT = `0x${'33'.repeat(32)}`;
const TX_HASH = `0x${'ab'.repeat(32)}`;
const NONCE = `0x${'99'.repeat(32)}`;
const COMMIT_VERSION = `0x${'c1'.repeat(32)}`;
const SIGNATURE_ONE = `0x${'01'.repeat(65)}`;
const SIGNATURE_TWO = `0x${'02'.repeat(65)}`;
const PAYER = getAddress('0xAbCAbCabcAbCAbcAbcAbCABcabcAbCABcaBCaBcA');
const SELLER = getAddress('0x1234567890123456789012345678901234567890');
const TOKEN = getAddress('0x00000000000000000000000000000000000Ca11a');
const FORWARDER = getAddress(
  '0x752b7aad0089286eb7b553d84d05233d80c9fcb4',
);
const FEE_RECEIVER = getAddress(
  '0x428483d2bd5E9f0e9f8E9f8e9F8E9F8E9f8e9F8e',
);

type HostedRoute = {
  GET: (
    req: Request,
    context: { params: Promise<{ id: string }> },
  ) => Promise<Response>;
};

type IntentState =
  | 'quoted'
  | 'signed'
  | 'settling'
  | 'indeterminate'
  | 'settled';

function productFixture() {
  return {
    kind: 'hosted',
    id: RESOURCE_ID,
    owner: SELLER,
    payTo: SELLER,
    priceJpyc: '5',
    title: 'Durable hosted note',
    description: 'A creator-store test product',
    emoji: '🧪',
    contentRevision: 7,
    saleActive: true,
    contentAvailable: true,
    discoverable: false,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
}

function claimFixture(signatureFingerprint = `0x${'a1'.repeat(32)}`) {
  return {
    payer: PAYER,
    token: TOKEN,
    chainId: 80002,
    forwarder: FORWARDER,
    commitVersion: COMMIT_VERSION,
    merchant: SELLER,
    merchantValue: (5n * 10n ** 18n).toString(),
    feeReceiver: FEE_RECEIVER,
    feeValue: (1n * 10n ** 18n).toString(),
    validAfter: '0',
    validBefore: '1999999999',
    nonce: NONCE,
    signatureFingerprint,
    resourceId: RESOURCE_ID,
    contentRevision: 7,
    deploymentVersion: 'creator-store.purchase.v1',
    anchorBlock: '123456',
  };
}

function intentFixture(state: IntentState = 'quoted') {
  const base = {
    version: 1,
    state,
    intentSalt: INTENT_SALT,
    resourceId: RESOURCE_ID,
    contentRevision: 7,
    contentRef: `x402:hosted:${RESOURCE_ID}:content:7`,
    metadata: {
      title: 'Durable hosted note',
      description: 'A creator-store test product',
      emoji: '🧪',
      seller: SELLER,
    },
    payerHint: PAYER,
    token: TOKEN,
    chainId: 80002,
    forwarder: FORWARDER,
    commitVersion: COMMIT_VERSION,
    merchant: SELLER,
    merchantValue: (5n * 10n ** 18n).toString(),
    feeReceiver: FEE_RECEIVER,
    feeValue: (1n * 10n ** 18n).toString(),
    deploymentVersion: 'creator-store.purchase.v1',
    anchorBlock: '123456',
    authorizationValidBeforeMax: '2000000000',
    quoteExpiresAt: Date.now() + 60_000,
    createdAt: 1_700_000_000_000,
    bindingHash: `0x${'b1'.repeat(32)}`,
  };
  if (state === 'quoted') return base;

  const claimed = {
    ...base,
    state,
    claim: claimFixture(),
    authorizationHash: `0x${'d1'.repeat(32)}`,
    ...(typeof routeMocks.claimedFacilitatorBody?.reservationToken ===
    'string'
      ? {
          reservationToken:
            routeMocks.claimedFacilitatorBody.reservationToken,
        }
      : {}),
    signedAt: 1_700_000_001_000,
    nextReconcileAt: 1_700_000_002_000,
  };
  if (state === 'signed') return claimed;

  const settling = {
    ...claimed,
    state,
    attemptId: 'attempt-1',
    attempt: 1,
    settlementStartedAt: 1_700_000_002_000,
    leaseUntil: 1_700_000_032_000,
  };
  if (state === 'settling') return settling;
  if (state === 'indeterminate') {
    return {
      ...settling,
      state,
      indeterminateAt: 1_700_000_003_000,
    };
  }
  return {
    ...settling,
    state,
    txHash: TX_HASH,
    settledAt: 1_700_000_004_000,
  };
}

function requirementFixture() {
  return {
    scheme: 'exact',
    network: 'eip155:80002',
    maxAmountRequired: (6n * 10n ** 18n).toString(),
    resource: `https://open-pay.jp/api/paid/hosted/${RESOURCE_ID}?payer=${PAYER}`,
    description: 'Durable hosted note',
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
        merchant: SELLER,
        merchantValue: (5n * 10n ** 18n).toString(),
        feeReceiver: FEE_RECEIVER,
        feeValue: (1n * 10n ** 18n).toString(),
        commitVersion: COMMIT_VERSION,
      },
    },
  };
}

function paymentPayload(input?: {
  intentSalt?: string;
  omitIntentSalt?: boolean;
  signature?: string;
}) {
  const authorization: Record<string, string> = {
    from: PAYER,
    validAfter: '0',
    validBefore: '1999999999',
  };
  if (!input?.omitIntentSalt) {
    authorization.intentSalt = input?.intentSalt ?? INTENT_SALT;
  }
  return {
    x402Version: 1,
    scheme: 'exact',
    network: 'eip155:80002',
    payload: {
      signature: input?.signature ?? SIGNATURE_ONE,
      authorization,
    },
  };
}

function paymentHeader(input?: Parameters<typeof paymentPayload>[0]): string {
  return Buffer.from(JSON.stringify(paymentPayload(input)), 'utf8').toString(
    'base64',
  );
}

function request(path: string, headers?: HeadersInit): Request {
  return new Request(`http://test.local${path}`, { headers });
}

async function loadRoute(): Promise<HostedRoute> {
  vi.resetModules();
  return (await import('@/app/api/paid/hosted/[id]/route')) as HostedRoute;
}

// GET の唯一の出口を必ずこの helper 経由で呼び、成功・失敗・pending の全検証で
// 共有キャッシュから購入状態や本文が隣の利用者へ波及しない no-store を固定する。
async function callHosted(
  route: HostedRoute,
  path: string,
  headers?: HeadersInit,
): Promise<Response> {
  const response = await route.GET(request(path, headers), {
    params: Promise.resolve({ id: RESOURCE_ID }),
  });
  expect(response.headers.get('cache-control')).toBe('no-store');
  return response;
}

function signatureFromPayload(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '';
  const payload = (value as { payload?: unknown }).payload;
  if (typeof payload !== 'object' || payload === null) return '';
  const signature = (payload as { signature?: unknown }).signature;
  return typeof signature === 'string' ? signature : '';
}

beforeEach(() => {
  routeMocks.env.enableCreatorStore = true;
  routeMocks.env.enableX402Facilitator = true;
  routeMocks.claimedFacilitatorBody = null;

  for (const mock of [
    routeMocks.verify,
    routeMocks.settle,
    routeMocks.getHostedProduct,
    routeMocks.getHostedContent,
    routeMocks.hostedPurchaseMetadata,
    routeMocks.sellerDisclosureComplete,
    routeMocks.createRequirements,
    routeMocks.buildClaim,
    routeMocks.checkQuoteRateLimit,
    routeMocks.claimSettlement,
    routeMocks.claimSigned,
    routeMocks.createQuoted,
    routeMocks.extractIntentSalt,
    routeMocks.finalize,
    routeMocks.getIntent,
    routeMocks.markFailedPrebroadcast,
    routeMocks.markIndeterminate,
    routeMocks.authorizationMatches,
    routeMocks.readAnchorBlock,
    routeMocks.readSettledAccess,
    routeMocks.reconcile,
    routeMocks.recordTransaction,
    routeMocks.preBroadcastRejection,
    routeMocks.associateRail,
    routeMocks.claimRail,
    routeMocks.releaseRail,
  ]) {
    mock.mockReset();
  }

  routeMocks.getHostedProduct.mockResolvedValue(productFixture());
  routeMocks.getHostedContent.mockResolvedValue({
    kind: 'text',
    value: 'paid content',
  });
  routeMocks.hostedPurchaseMetadata.mockReturnValue(
    intentFixture().metadata,
  );
  routeMocks.sellerDisclosureComplete.mockResolvedValue(true);
  routeMocks.createRequirements.mockReturnValue([requirementFixture()]);
  routeMocks.checkQuoteRateLimit.mockResolvedValue(true);
  routeMocks.readAnchorBlock.mockResolvedValue(123456n);
  routeMocks.createQuoted.mockResolvedValue({
    ok: true,
    intent: intentFixture(),
  });
  routeMocks.extractIntentSalt.mockImplementation((value: unknown) => {
    if (typeof value !== 'object' || value === null) return null;
    const payload = (value as { payload?: unknown }).payload;
    if (typeof payload !== 'object' || payload === null) return null;
    const authorization = (payload as { authorization?: unknown })
      .authorization;
    if (typeof authorization !== 'object' || authorization === null) {
      return null;
    }
    const salt = (authorization as { intentSalt?: unknown }).intentSalt;
    return typeof salt === 'string' ? salt.toLowerCase() : null;
  });
  routeMocks.getIntent.mockImplementation(async (salt: string) =>
    salt.toLowerCase() === INTENT_SALT ? intentFixture() : null,
  );
  routeMocks.buildClaim.mockImplementation(
    (input: { paymentPayload: unknown }) => {
      const fingerprint =
        signatureFromPayload(input.paymentPayload) === SIGNATURE_TWO
          ? `0x${'a2'.repeat(32)}`
          : `0x${'a1'.repeat(32)}`;
      return {
        ok: true,
        claim: claimFixture(fingerprint),
        authorizationHash: `0x${'d1'.repeat(32)}`,
        signatureFingerprint: fingerprint,
      };
    },
  );
  routeMocks.authorizationMatches.mockReturnValue(true);
  routeMocks.verify.mockResolvedValue(
    NextResponse.json({
      isValid: true,
      payer: PAYER,
      reservationToken: 'reservation-1',
    }),
  );
  routeMocks.claimSigned.mockImplementation(
    async (input: { reservationToken?: string }) => {
      routeMocks.claimedFacilitatorBody =
        input.reservationToken === undefined
          ? null
          : { reservationToken: input.reservationToken };
      return {
        ok: true,
        kind: 'claimed',
        intent: intentFixture('signed'),
      };
    },
  );
  routeMocks.claimSettlement.mockImplementation(async () => ({
    ok: true,
    kind: 'claimed',
    intent: intentFixture('settling'),
  }));
  routeMocks.settle.mockResolvedValue(
    NextResponse.json({
      success: true,
      transaction: TX_HASH,
      network: 'eip155:80002',
      payer: PAYER,
    }),
  );
  routeMocks.preBroadcastRejection.mockReturnValue(false);
  routeMocks.associateRail.mockResolvedValue({
    ok: true,
    parentIntentId: 'e'.repeat(64),
  });
  routeMocks.claimRail.mockResolvedValue({ ok: true, kind: 'claimed' });
  routeMocks.releaseRail.mockResolvedValue(true);
  routeMocks.recordTransaction.mockResolvedValue('updated');
  routeMocks.markIndeterminate.mockResolvedValue('updated');
  routeMocks.markFailedPrebroadcast.mockResolvedValue('updated');
  routeMocks.finalize.mockResolvedValue({
    ok: true,
    kind: 'finalized',
    intent: intentFixture('settled'),
    ownership: {},
    purchase: {},
  });
  routeMocks.readSettledAccess.mockResolvedValue({
    ok: true,
    intent: intentFixture('settled'),
    ownership: {},
    purchase: {},
    grant: {},
  });
  routeMocks.reconcile.mockResolvedValue({
    ok: true,
    state: 'pending',
  });
});

afterEach(() => {
  vi.resetModules();
});

describe('hosted creator-store paid route', () => {
  it('creator-store または facilitator flag OFF は完全 inert の 404', async () => {
    const route = await loadRoute();

    routeMocks.env.enableCreatorStore = false;
    const creatorOff = await callHosted(
      route,
      `/api/paid/hosted/${RESOURCE_ID}?payer=${PAYER}`,
    );
    expect(creatorOff.status).toBe(404);

    routeMocks.env.enableCreatorStore = true;
    routeMocks.env.enableX402Facilitator = false;
    const facilitatorOff = await callHosted(
      route,
      `/api/paid/hosted/${RESOURCE_ID}?payer=${PAYER}`,
    );
    expect(facilitatorOff.status).toBe(404);
    expect(routeMocks.getHostedProduct).not.toHaveBeenCalled();
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });

  it('payer 必須、402 の v1/v2 両方が server intent と署名期限上限を返す', async () => {
    const route = await loadRoute();
    const noPayer = await callHosted(
      route,
      `/api/paid/hosted/${RESOURCE_ID}`,
    );
    expect(noPayer.status).toBe(422);
    expect(await noPayer.json()).toEqual({
      ok: false,
      error: 'invalid_payer',
    });
    expect(routeMocks.getHostedProduct).not.toHaveBeenCalled();

    const response = await callHosted(
      route,
      `/api/paid/hosted/${RESOURCE_ID}?payer=${PAYER}`,
    );
    expect(response.status).toBe(402);
    const responseBytes = await response.text();
    const baseRequirement = requirementFixture();
    const expectedRequirement = {
      ...baseRequirement,
      extra: {
        ...baseRequirement.extra,
        openpay: {
          ...baseRequirement.extra.openpay,
          intentSalt: INTENT_SALT,
          authorizationValidBeforeMax: '2000000000',
          deploymentVersion: 'creator-store.purchase.v1',
        },
      },
    };
    expect(responseBytes).toBe(
      JSON.stringify({
        x402Version: 1,
        accepts: [expectedRequirement],
        error: 'payment_required',
      }),
    );
    const body = JSON.parse(responseBytes) as {
      accepts: Array<{
        resource: string;
        extra: {
          openpay: {
            intentSalt: string;
            authorizationValidBeforeMax: string;
          };
        };
      }>;
    };
    expect(body.accepts[0].resource).toContain(`payer=${PAYER}`);
    expect(body.accepts[0].extra.openpay).toMatchObject({
      intentSalt: INTENT_SALT,
      authorizationValidBeforeMax: '2000000000',
    });

    const requiredHeader = response.headers.get('PAYMENT-REQUIRED');
    expect(requiredHeader).toBeTruthy();
    const v2 = JSON.parse(
      Buffer.from(requiredHeader ?? '', 'base64').toString('utf8'),
    ) as {
      x402Version: number;
      accepts: Array<{
        extra: {
          openpay: {
            intentSalt: string;
            authorizationValidBeforeMax: string;
          };
        };
      }>;
    };
    expect(v2.x402Version).toBe(2);
    expect(v2.accepts[0].extra.openpay).toMatchObject({
      intentSalt: INTENT_SALT,
      authorizationValidBeforeMax: '2000000000',
    });
    expect(routeMocks.createQuoted).toHaveBeenCalledTimes(1);
    expect(routeMocks.createQuoted.mock.calls[0][0]).not.toHaveProperty(
      'intentSalt',
    );
  });

  it('intentSalt 欠落・未知 salt・recover salt 転用は verify/settle 前に拒否', async () => {
    const route = await loadRoute();
    const cases = [
      {
        header: paymentHeader({ omitIntentSalt: true }),
        status: 400,
        error: 'intent_salt_required',
      },
      {
        header: paymentHeader({ intentSalt: UNKNOWN_SALT }),
        status: 404,
        error: 'purchase_intent_not_found',
      },
      {
        header: paymentHeader({ intentSalt: RECOVER_SALT }),
        status: 404,
        error: 'purchase_intent_not_found',
      },
    ];

    for (const testCase of cases) {
      const response = await callHosted(
        route,
        `/api/paid/hosted/${RESOURCE_ID}?payer=${PAYER}`,
        { 'X-PAYMENT': testCase.header },
      );
      expect(response.status).toBe(testCase.status);
      expect(await response.json()).toMatchObject({ error: testCase.error });
    }
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.claimSigned).not.toHaveBeenCalled();
    expect(routeMocks.claimSettlement).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });

  it('verify → signed CAS → settling CAS の順でのみ settle/finalize する', async () => {
    const route = await loadRoute();
    const response = await callHosted(
      route,
      `/api/paid/hosted/${RESOURCE_ID}?payer=${PAYER}`,
      { 'X-PAYMENT': paymentHeader() },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      state: 'settled',
      resourceId: RESOURCE_ID,
      contentRevision: 7,
      value: 'paid content',
      txHash: TX_HASH,
    });
    expect(routeMocks.verify).toHaveBeenCalledTimes(1);
    expect(routeMocks.claimSigned).toHaveBeenCalledTimes(1);
    expect(routeMocks.claimSettlement).toHaveBeenCalledTimes(1);
    expect(routeMocks.settle).toHaveBeenCalledTimes(1);
    expect(routeMocks.recordTransaction).toHaveBeenCalledTimes(1);
    expect(routeMocks.finalize).toHaveBeenCalledTimes(1);
    expect(routeMocks.readSettledAccess).toHaveBeenCalledTimes(1);

    const order = (mock: { mock: { invocationCallOrder: number[] } }) =>
      mock.mock.invocationCallOrder[0];
    expect(order(routeMocks.verify)).toBeLessThan(order(routeMocks.claimSigned));
    expect(order(routeMocks.claimSigned)).toBeLessThan(
      order(routeMocks.claimSettlement),
    );
    expect(order(routeMocks.claimSettlement)).toBeLessThan(
      order(routeMocks.settle),
    );
    expect(order(routeMocks.settle)).toBeLessThan(
      order(routeMocks.recordTransaction),
    );
    expect(order(routeMocks.recordTransaction)).toBeLessThan(
      order(routeMocks.finalize),
    );
    expect(order(routeMocks.finalize)).toBeLessThan(
      order(routeMocks.readSettledAccess),
    );

    const signedInput = routeMocks.claimSigned.mock.calls[0][0] as {
      reservationToken?: string;
      facilitatorBody?: unknown;
    };
    expect(signedInput.reservationToken).toBe('reservation-1');
    expect(signedInput).not.toHaveProperty('facilitatorBody');
    const settleRequest = routeMocks.settle.mock.calls[0][0] as Request;
    expect(await settleRequest.json()).toMatchObject({
      reservationToken: 'reservation-1',
    });
  });

  it('署名/body は恒久保存せず、現在の完全一致 payload と reservation token だけで broadcast する', async () => {
    routeMocks.getIntent.mockResolvedValue(intentFixture('signed'));
    routeMocks.claimedFacilitatorBody = {
      reservationToken: 'durable-reservation',
    };
    const route = await loadRoute();
    const response = await callHosted(
      route,
      `/api/paid/hosted/${RESOURCE_ID}?payer=${PAYER}`,
      { 'X-PAYMENT': paymentHeader() },
    );

    expect(response.status).toBe(200);
    const settleRequest = routeMocks.settle.mock.calls[0][0] as Request;
    const body = (await settleRequest.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      reservationToken: 'durable-reservation',
      paymentPayload: paymentPayload(),
    });
  });

  it('intent KV 障害は fail-closed で verify/settle しない', async () => {
    routeMocks.getIntent.mockResolvedValue('storage');
    const route = await loadRoute();
    const response = await callHosted(
      route,
      `/api/paid/hosted/${RESOURCE_ID}?payer=${PAYER}`,
      { 'X-PAYMENT': paymentHeader() },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: 'storage_unavailable',
    });
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.claimSigned).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });

  it('quoted→signed CAS 障害は verify 後でも settle 前に fail-closed', async () => {
    routeMocks.claimSigned.mockResolvedValue({
      ok: false,
      reason: 'storage',
    });
    const route = await loadRoute();
    const response = await callHosted(
      route,
      `/api/paid/hosted/${RESOURCE_ID}?payer=${PAYER}`,
      { 'X-PAYMENT': paymentHeader() },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: 'storage_unavailable',
    });
    expect(routeMocks.verify).toHaveBeenCalledTimes(1);
    expect(routeMocks.claimSigned).toHaveBeenCalledTimes(1);
    expect(routeMocks.claimSettlement).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });

  it('同じ intent の別署名は conflict で再 verify/broadcast しない', async () => {
    routeMocks.getIntent.mockResolvedValue(intentFixture('signed'));
    routeMocks.authorizationMatches.mockReturnValue(false);
    const route = await loadRoute();
    const response = await callHosted(
      route,
      `/api/paid/hosted/${RESOURCE_ID}?payer=${PAYER}`,
      {
        'X-PAYMENT': paymentHeader({
          signature: SIGNATURE_TWO,
        }),
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: 'authorization_conflict',
    });
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.claimSigned).not.toHaveBeenCalled();
    expect(routeMocks.claimSettlement).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });

  it('broadcast 呼出後の応答喪失は indeterminate にして 202 pending', async () => {
    routeMocks.settle.mockRejectedValue(
      new Error('connection lost after broadcast'),
    );
    const route = await loadRoute();
    const response = await callHosted(
      route,
      `/api/paid/hosted/${RESOURCE_ID}?payer=${PAYER}`,
      { 'X-PAYMENT': paymentHeader() },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, state: 'pending' });
    expect(routeMocks.markIndeterminate).toHaveBeenCalledWith({
      intentSalt: INTENT_SALT,
      attemptId: 'attempt-1',
    });
    expect(routeMocks.recordTransaction).not.toHaveBeenCalled();
    expect(routeMocks.finalize).not.toHaveBeenCalled();
  });

  it('settle 成功後の finalizer 障害は偽成功せず 503 provisioning', async () => {
    routeMocks.finalize.mockResolvedValue({
      ok: false,
      reason: 'storage',
    });
    const route = await loadRoute();
    const response = await callHosted(
      route,
      `/api/paid/hosted/${RESOURCE_ID}?payer=${PAYER}`,
      { 'X-PAYMENT': paymentHeader() },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'purchase_provisioning',
    });
    expect(routeMocks.recordTransaction).toHaveBeenCalledWith({
      intentSalt: INTENT_SALT,
      attemptId: 'attempt-1',
      txHash: TX_HASH,
    });
    expect(routeMocks.markIndeterminate).toHaveBeenCalledWith({
      intentSalt: INTENT_SALT,
      attemptId: 'attempt-1',
      txHash: TX_HASH,
    });
    expect(routeMocks.readSettledAccess).not.toHaveBeenCalled();
  });

  it('settled shortcut でも ownership/purchase 整合なしには本文を返さない', async () => {
    routeMocks.getIntent.mockResolvedValue(intentFixture('settled'));
    routeMocks.readSettledAccess.mockResolvedValue({
      ok: false,
      reason: 'conflict',
    });
    const route = await loadRoute();
    const response = await callHosted(
      route,
      `/api/paid/hosted/${RESOURCE_ID}?payer=${PAYER}`,
      { 'X-PAYMENT': paymentHeader() },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'purchase_inconsistent',
    });
    expect(routeMocks.readSettledAccess).toHaveBeenCalledWith(INTENT_SALT);
    expect(routeMocks.buildClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        use: 'existing-claim-recovery',
      }),
    );
    expect(routeMocks.getHostedContent).not.toHaveBeenCalled();
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });
});
