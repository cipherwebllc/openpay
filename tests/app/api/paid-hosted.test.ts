import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress, serializeSignature, type Hex } from 'viem';
import { createLicenseDefinition } from '@/lib/license/definition';
import { paymentSignatureFingerprint } from '@/lib/x402/paymentRedelivery';
import { forwardingCases, paidRouteWire, unforwardedHeaders, v2PaymentHeader } from '../../helpers/paidRouteWire';

const routeMocks = vi.hoisted(() => ({
  env: {
    enableCreatorStore: true,
    enableLicenseNft: false,
    enableX402Facilitator: true,
    feeReceiver: `0x${'3'.repeat(40)}`,
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
  after: vi.fn(),
  recipient: vi.fn(),
  worker: vi.fn(),
  recordPurchase: vi.fn(),
  metric: vi.fn(),
  notify: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  rights: vi.fn(),
  // 第 9 回レビュー B-02: 権利照合 RPC の同時実行枠 (lib/license/rightsBudget)。再送は再送用の鍵 (resend) を使い、
  // 認証済み経路 (content / library / holders) の鍵 (auth) には触れない。あわせて実物の resolver が使う RPC client。
  resendAcquire: vi.fn<() => Promise<string | null>>(),
  resendRelease: vi.fn<(token: string) => Promise<void>>(),
  authAcquire: vi.fn<() => Promise<string | null>>(),
  authRelease: vi.fn<(token: string) => Promise<void>>(),
  proof: vi.fn(),
  licenseRpc: vi.fn(),
  rpcGetBlock: vi.fn(),
  rpcReadContract: vi.fn(),
}));

vi.mock('@/lib/x402/purchaseStats', () => ({ recordHostedPurchase: routeMocks.recordPurchase }));
vi.mock('@/lib/metrics', () => ({ recordMetric: routeMocks.metric }));
vi.mock('@/lib/push/notify', () => ({ notifyPaymentReceived: routeMocks.notify }));
vi.mock('next/server', async (original) => ({ ...await original<typeof import('next/server')>(), after: routeMocks.after }));
vi.mock('@/lib/license/recipient', () => ({ checkLicenseRecipient: routeMocks.recipient }));
vi.mock('@/lib/license/minter', () => ({ runLicenseWorker: routeMocks.worker }));

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

// 署名の指紋は本物を使い、broadcast 前拒否の判定だけ差し替える。
vi.mock('@/lib/x402/paymentRedelivery', async (original) => ({
  ...await original<typeof import('@/lib/x402/paymentRedelivery')>(),
  isFacilitatorPreBroadcastRejection: routeMocks.preBroadcastRejection,
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: routeMocks.info, warn: routeMocks.warn, error: vi.fn() },
}));
vi.mock('@/lib/license/rights', () => ({ resolveLicenseRights: routeMocks.rights }));
vi.mock('@/lib/license/rightsBudget', () => ({
  acquireLicenseResendRightsBudget: routeMocks.resendAcquire,
  releaseLicenseResendRightsBudget: routeMocks.resendRelease,
  acquireLicenseRightsBudget: routeMocks.authAcquire,
  releaseLicenseRightsBudget: routeMocks.authRelease,
}));
// 実物の resolveLicenseRights を使うテスト (B-02) 向け: 証明の KV と RPC client だけ差し替える。
vi.mock('@/lib/license/jobs', () => ({ readLicenseProof: routeMocks.proof }));
vi.mock('@/lib/license/rpc', () => ({ licenseRpc: routeMocks.licenseRpc }));

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
  routeMocks.resendAcquire.mockReset().mockResolvedValue('lease');
  routeMocks.resendRelease.mockReset().mockResolvedValue(undefined);
  routeMocks.authAcquire.mockReset().mockResolvedValue('auth-lease');
  routeMocks.authRelease.mockReset().mockResolvedValue(undefined);
  routeMocks.after.mockReset(); routeMocks.recipient.mockReset(); routeMocks.worker.mockReset();
  routeMocks.recipient.mockResolvedValue('supported'); routeMocks.worker.mockResolvedValue({ ok: true });
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
  it('takedown refuses fresh quotes and settled redelivery never verifies or charges again', async () => {
    routeMocks.getHostedProduct.mockResolvedValue({ ...productFixture(), saleActive: false, contentAvailable: false });
    routeMocks.getHostedContent.mockResolvedValue(null);
    // 確定済みの購入への再送は、取り下げに関係なく本文を読まずに 409 (下の「確定済みの購入への署名ヘッダー再送」で固定する)。
    const settled = { ...intentFixture('settled'), settledAt: Date.now() - 60_000 };
    routeMocks.getIntent.mockResolvedValue(settled);
    routeMocks.readSettledAccess.mockResolvedValue({ ok: true, intent: settled, ownership: {}, purchase: {}, grant: {} });
    const route = await loadRoute();
    const path = `/api/paid/hosted/${RESOURCE_ID}?payer=${PAYER}`;
    expect((await callHosted(route, path)).status).toBe(404);
    const paid = await callHosted(route, path, { 'X-PAYMENT': paymentHeader() });
    expect(paid.status).toBe(409);
    expect(await paid.json()).toMatchObject({ ok: false, error: 'purchase_already_settled', state: 'settled', txHash: TX_HASH });
    expect(paid.headers.has('PAYMENT-REQUIRED')).toBe(false);
    expect(routeMocks.getHostedContent).not.toHaveBeenCalled();
    expect(routeMocks.createQuoted).not.toHaveBeenCalled();
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.claimSigned).not.toHaveBeenCalled();
    expect(routeMocks.claimSettlement).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });

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

  it('settle だけに hosted の印を付け (買い手の IP の relay-admission の枠と分ける)、転送ヘッダは従来どおり', async () => {
    const route = await loadRoute();
    const { isHostedSettleRequest } = await import('@/lib/x402/hostedSettleRequest');
    const response = await callHosted(
      route,
      `/api/paid/hosted/${RESOURCE_ID}?payer=${PAYER}`,
      { 'X-PAYMENT': paymentHeader(), 'x-vercel-forwarded-for': '172.71.0.1', 'cf-connecting-ip': '203.0.113.5' },
    );
    expect(response.status).toBe(200);
    const settleRequest = routeMocks.settle.mock.calls[0][0] as Request;
    expect(isHostedSettleRequest(settleRequest)).toBe(true);
    expect(isHostedSettleRequest(routeMocks.verify.mock.calls[0][0] as Request)).toBe(false);
    expect(settleRequest.headers.get('cf-connecting-ip')).toBe('203.0.113.5');
    expect(settleRequest.headers.get('x-vercel-forwarded-for')).toBe('172.71.0.1');
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

// license の追加分岐でも、デジタルの既存 payload/error は上の固定テストで維持する。
describe('license hosted admission', () => {
  afterEach(() => { routeMocks.env.enableLicenseNft = false; vi.unstubAllEnvs(); });
  it('public listing admits unlisted sellers and rollback blocks their next quote', async () => {
    routeMocks.env.enableLicenseNft = true;
    vi.stubEnv('LICENSE_NFT_SELLER_ALLOWLIST', ''); vi.stubEnv('ENABLE_LICENSE_NFT_PUBLIC', '1');
    routeMocks.getHostedProduct.mockResolvedValue({ ...productFixture(), productKind: 'license', license: { tokenId: NONCE }, registration: { status: 'registered' } });
    routeMocks.recipient.mockResolvedValue('supported');
    const route = await loadRoute();
    expect((await callHosted(route, `/api/paid/hosted/${RESOURCE_ID}?payer=${PAYER}`)).status).toBe(402);
    vi.stubEnv('ENABLE_LICENSE_NFT_PUBLIC', '0'); routeMocks.createQuoted.mockClear();
    expect((await callHosted(route, `/api/paid/hosted/${RESOURCE_ID}?payer=${PAYER}`)).status).toBe(404);
    expect(routeMocks.createQuoted).not.toHaveBeenCalled();
  });
  it('hosted 商品の成功応答にも表示専用の sellerRole を返す', async () => {
    routeMocks.env.enableLicenseNft = true;
    const settled = intentFixture('settled');
    routeMocks.readSettledAccess.mockResolvedValue({
      ok: true,
      intent: { ...settled, metadata: { ...settled.metadata, productKind: 'license', owner: getAddress(routeMocks.env.feeReceiver) } },
      ownership: {}, purchase: {}, grant: {},
    });
    const response = await callHosted(await loadRoute(), `/api/paid/hosted/${RESOURCE_ID}?payer=${PAYER}`, { 'x-payment': paymentHeader() });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ productKind: 'license', sellerRole: 'operator' });
    expect(JSON.stringify(routeMocks.claimedFacilitatorBody)).not.toContain('sellerRole');
    expect(Buffer.from(response.headers.get('X-PAYMENT-RESPONSE')!, 'base64').toString()).not.toContain('sellerRole');
  });
  it.each(['operator', 'third_party'] as const)('quote に表示専用の sellerRole=%s を追加し、snapshot と wire は変えない', async (role) => {
    routeMocks.env.enableLicenseNft = true;
    const owner = role === 'operator' ? getAddress(routeMocks.env.feeReceiver) : SELLER;
    vi.stubEnv('LICENSE_NFT_SELLER_ALLOWLIST', owner);
    routeMocks.getHostedProduct.mockResolvedValue({ ...productFixture(), owner, productKind: 'license', license: { tokenId: NONCE }, registration: { status: 'registered' } });
    routeMocks.recipient.mockResolvedValue('supported');
    const response = await callHosted(await loadRoute(), `/api/paid/hosted/${RESOURCE_ID}?payer=${PAYER}`);
    expect(response.status).toBe(402);
    const body = await response.json();
    expect(body.sellerRole).toBe(role);
    expect(JSON.stringify(body.accepts)).not.toContain('sellerRole');
    expect(JSON.stringify(routeMocks.createQuoted.mock.calls, (_key, value) => typeof value === 'bigint' ? value.toString() : value)).not.toContain('sellerRole');
    expect(Buffer.from(response.headers.get('PAYMENT-REQUIRED')!, 'base64').toString()).not.toContain('sellerRole');
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });
  it('returns 404 while disabled before any quote or verify work', async () => {
    routeMocks.getHostedProduct.mockResolvedValue({ ...productFixture(), productKind: 'license' });
    const { GET } = await import('@/app/api/paid/hosted/[id]/route');
    const response = await GET(new Request(`https://open-pay.jp/api/paid/hosted/${RESOURCE_ID}?payer=${PAYER}`), { params: Promise.resolve({ id: RESOURCE_ID }) });
    expect(response.status).toBe(404); expect(routeMocks.createQuoted).not.toHaveBeenCalled(); expect(routeMocks.verify).not.toHaveBeenCalled();
  });
  it('returns 409 for pending registration instead of issuing a 402', async () => {
    routeMocks.env.enableLicenseNft = true; vi.stubEnv('LICENSE_NFT_SELLER_ALLOWLIST', SELLER);
    routeMocks.getHostedProduct.mockResolvedValue({ ...productFixture(), productKind: 'license', saleActive: false, registration: { status: 'pending', attempts: 0 } });
    const { GET } = await import('@/app/api/paid/hosted/[id]/route');
    const response = await GET(new Request(`https://open-pay.jp/api/paid/hosted/${RESOURCE_ID}?payer=${PAYER}`), { params: Promise.resolve({ id: RESOURCE_ID }) });
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ ok: false, error: 'license_registration_pending' }); expect(routeMocks.createQuoted).not.toHaveBeenCalled();
  });
  it.each(['unsupported', 'unknown'])('simulates receiver before requesting a purchase signature: %s', async (result) => {
    routeMocks.env.enableLicenseNft = true; vi.stubEnv('LICENSE_NFT_SELLER_ALLOWLIST', SELLER);
    routeMocks.getHostedProduct.mockResolvedValue({ ...productFixture(), productKind: 'license', license: { tokenId: NONCE }, registration: { status: 'registered' } });
    routeMocks.recipient.mockResolvedValue(result);
    const response = await callHosted(await loadRoute(), `/api/paid/hosted/${RESOURCE_ID}?payer=${PAYER}`);
    expect(response.status).toBe(result === 'unsupported' ? 409 : 503); expect(routeMocks.createQuoted).not.toHaveBeenCalled();
    expect(routeMocks.recipient).toHaveBeenCalledWith({ tokenId: NONCE }, PAYER);
  });
  it('defers the isolated mint attempt to after() and returns without awaiting the worker', async () => {
    routeMocks.env.enableLicenseNft = true;
    const settled = intentFixture('settled');
    routeMocks.finalize.mockResolvedValue({ ok: true, kind: 'finalized', intent: { ...settled, metadata: { ...settled.metadata, productKind: 'license' } } });
    const response = await callHosted(await loadRoute(), `/api/paid/hosted/${RESOURCE_ID}?payer=${PAYER}`, { 'x-payment': paymentHeader() });
    expect(response.status).toBe(200); expect(routeMocks.worker).not.toHaveBeenCalled();
    routeMocks.worker.mockRejectedValue(new Error('isolated worker outage'));
    const tasks = routeMocks.after.mock.calls.map(([task]) => task as () => Promise<void>);
    expect(tasks).toHaveLength(2); await expect(tasks[1]!()).resolves.toBeUndefined(); expect(routeMocks.worker).toHaveBeenCalledTimes(1);
  });
});


describe('license sold-out response', () => {
  it('returns the exact sold_out marker after verify and before settlement', async () => {
    routeMocks.claimSigned.mockResolvedValue({ ok: false, reason: 'sold_out' });
    const route = await loadRoute();
    const response = await callHosted(route, `/api/paid/hosted/${RESOURCE_ID}?payer=${PAYER}`, { 'x-payment': paymentHeader() });
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ ok: false, error: 'sold_out' });
    expect(routeMocks.verify).toHaveBeenCalledTimes(1); expect(routeMocks.claimSettlement).not.toHaveBeenCalled(); expect(routeMocks.settle).not.toHaveBeenCalled();
  });
  it('denies persisted license replay while OFF without looking up current product or settling', async () => {
    const original = intentFixture('settled'); routeMocks.getIntent.mockResolvedValue({ ...original, metadata: { ...original.metadata, productKind: 'license' } });
    const route = await loadRoute();
    const response = await callHosted(route, `/api/paid/hosted/${RESOURCE_ID}?payer=${PAYER}`, { 'x-payment': paymentHeader() });
    expect(response.status).toBe(404); expect(routeMocks.getHostedProduct).not.toHaveBeenCalled(); expect(routeMocks.settle).not.toHaveBeenCalled(); expect(routeMocks.readSettledAccess).not.toHaveBeenCalled();
  });
});


describe('R2 hosted JPYC response pinning', () => {
  const path = `/api/paid/hosted/${RESOURCE_ID}?payer=${PAYER}`;

  let clock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clock = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_005_000);
    routeMocks.recordPurchase.mockReset();
    routeMocks.metric.mockReset();
    routeMocks.notify.mockReset();
  });

  afterEach(() => { clock.mockRestore(); });

  it('pins the fixed-salt v1 challenge body and encoded v2 header', async () => {
    const route = await loadRoute();
    expect(await paidRouteWire(await callHosted(route, path))).toMatchSnapshot();
  });

  describe.each(['v1', 'v2'] as const)('%s wire', (version) => {
    it.each([
      ['success', 200], ['pending', 202], ['verification rejected', 402],
      ['storage unavailable', 503], ['conflict', 409], ['malformed', 400],
      ['not found', 404],
    ] as const)('pins %s', async (scenario, status) => {
      const route = await loadRoute();
      const challenge = await callHosted(route, path);
      const headerName = version === 'v1' ? 'X-PAYMENT' : 'PAYMENT-SIGNATURE';
      let header = version === 'v1'
        ? paymentHeader()
        : v2PaymentHeader(challenge, paymentPayload().payload);
      if (scenario === 'pending') routeMocks.getIntent.mockResolvedValue(intentFixture('settling'));
      if (scenario === 'verification rejected') {
        routeMocks.verify.mockResolvedValue(NextResponse.json({ isValid: false, invalidReason: 'signature_mismatch' }));
      }
      if (scenario === 'storage unavailable') routeMocks.getIntent.mockResolvedValue('storage');
      if (scenario === 'conflict') routeMocks.getIntent.mockResolvedValue({ ...intentFixture(), resourceId: 'another-product' });
      if (scenario === 'malformed') header = 'not-json';
      if (scenario === 'not found') routeMocks.getIntent.mockResolvedValue(null);
      const response = await callHosted(route, path, { [headerName]: header });
      expect(response.status).toBe(status);
      expect(await paidRouteWire(response)).toMatchSnapshot();
    });
  });

  it.each(forwardingCases)('forwards only the allowlist to verify and settle: $name', async ({ incoming, expected }) => {
    const route = await loadRoute();
    const response = await callHosted(route, path, {
      ...incoming, ...unforwardedHeaders, 'X-PAYMENT': paymentHeader(),
    });
    expect(response.status).toBe(200);
    for (const handler of [routeMocks.verify, routeMocks.settle]) {
      expect(handler).toHaveBeenCalledTimes(1);
      const forwarded = handler.mock.calls[0]![0] as Request;
      expect(Object.fromEntries(forwarded.headers)).toEqual(expected);
    }
  });

  it.each(['scheduled', 'fallback'] as const)('runs post-response work exactly once via %s', async (mode) => {
    // An unresolved ancillary promise must not hold the paid response open.
    routeMocks.recordPurchase.mockReturnValue(new Promise(() => {}));
    if (mode === 'fallback') routeMocks.after.mockImplementation(() => { throw new Error('outside request scope'); });
    const route = await loadRoute();
    const response = await callHosted(route, path, { 'X-PAYMENT': paymentHeader() });
    expect(response.status).toBe(200);
    expect(routeMocks.after).toHaveBeenCalledTimes(1);
    if (mode === 'scheduled') {
      expect(routeMocks.recordPurchase).not.toHaveBeenCalled();
      expect(routeMocks.metric).not.toHaveBeenCalled();
      expect(routeMocks.notify).not.toHaveBeenCalled();
      routeMocks.after.mock.calls[0]![0]();
    }
    expect(routeMocks.recordPurchase).toHaveBeenCalledTimes(1);
    expect(routeMocks.recordPurchase).toHaveBeenCalledWith(RESOURCE_ID);
    expect(routeMocks.metric).toHaveBeenCalledTimes(1);
    expect(routeMocks.metric).toHaveBeenCalledWith('store_purchase');
    expect(routeMocks.notify).toHaveBeenCalledTimes(1);
    expect(routeMocks.notify).toHaveBeenCalledWith(SELLER, 'store', '¥5');
  });

  it('the scheduled task returns a promise that settles only after the count, metric and push all finish (after() keeps them alive)', async () => {
    let finishPurchase!: () => void;
    routeMocks.recordPurchase.mockReturnValue(new Promise<void>((resolve) => { finishPurchase = resolve; }));
    routeMocks.metric.mockResolvedValue(undefined);
    routeMocks.notify.mockResolvedValue(undefined);
    const route = await loadRoute();
    expect((await callHosted(route, path, { 'X-PAYMENT': paymentHeader() })).status).toBe(200);
    const result = routeMocks.after.mock.calls[0]![0]() as unknown;
    expect(result).toBeInstanceOf(Promise);
    let settled = false;
    void (result as Promise<unknown>).then(() => { settled = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false); // 購入数の書き込みが終わるまで after() は環境を保つ
    finishPurchase();
    await result;
    expect(settled).toBe(true);
  });

  it.each(['scheduled', 'fallback'] as const)('does not catch or retry a task failure in %s execution', async (mode) => {
    const failure = new Error('task is expected to be no-throw');
    routeMocks.recordPurchase.mockImplementation(() => { throw failure; });
    const route = await loadRoute();
    if (mode === 'fallback') {
      routeMocks.after.mockImplementation(() => { throw new Error('outside request scope'); });
      await expect(callHosted(route, path, { 'X-PAYMENT': paymentHeader() })).rejects.toBe(failure);
    } else {
      expect((await callHosted(route, path, { 'X-PAYMENT': paymentHeader() })).status).toBe(200);
      expect(() => routeMocks.after.mock.calls[0]![0]()).toThrow(failure);
    }
    expect(routeMocks.after).toHaveBeenCalledTimes(1);
    expect(routeMocks.recordPurchase).toHaveBeenCalledTimes(1);
    expect(routeMocks.metric).not.toHaveBeenCalled();
    expect(routeMocks.notify).not.toHaveBeenCalled();
  });
});

// 確定済みの購入への署名ヘッダーの再送では、本文 (value) を返さない (窓 0)。一致に要る値 (payer・resourceId・
// 署名内容・署名の指紋) はオンチェーンの calldata から組み立てられ、server は買い手の再試行と他人を区別できない。
// 本文を返すのは、その request 自身が settle を呼んで成功した初回の応答だけ。確定後の取り直しは SIWE の
// library / content API が担い、ブラウザは 409 の形 (state settled・txHash・resourceId) で確定として扱う。
describe('確定済みの購入への署名ヘッダー再送では本文を返さない (JPYC・窓 0)', () => {
  const path = `/api/paid/hosted/${RESOURCE_ID}?payer=${PAYER}`;
  const SETTLED_AT = 1_700_000_004_000;
  const MINUTE = 60_000;
  let clock: ReturnType<typeof vi.spyOn>;

  function useSettled(intent: Record<string, unknown>) {
    routeMocks.getIntent.mockResolvedValue(intent);
    routeMocks.readSettledAccess.mockResolvedValue({ ok: true, intent, ownership: {}, purchase: {}, grant: {} });
  }

  async function resend(headers: HeadersInit = { 'X-PAYMENT': paymentHeader() }, at = path) {
    return callHosted(await loadRoute(), at, headers);
  }

  /** hooks/useHostedStorePurchase が 409 を確定として扱う条件 (error code の名前は見ない)。 */
  function browserTreatsAsSettled(status: number, body: Record<string, unknown>): boolean {
    return (
      status === 409 &&
      body.state === 'settled' &&
      typeof body.txHash === 'string' &&
      /^0x[0-9a-fA-F]{64}$/.test(body.txHash) &&
      body.resourceId === RESOURCE_ID
    );
  }

  async function expectAlreadySettled(response: Response): Promise<Record<string, unknown>> {
    expect(response.status).toBe(409);
    const text = await response.text();
    expect(text).not.toContain('paid content');
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body).toEqual({
      ok: false,
      error: 'purchase_already_settled',
      state: 'settled',
      resourceId: RESOURCE_ID,
      txHash: TX_HASH,
      network: 'eip155:80002',
      library: '/store/library',
      contentApi: `/api/store/content/${RESOURCE_ID}`,
      message: expect.stringContaining('(/store/library)'),
      messageJa: expect.stringContaining('（/store/library）'),
    });
    expect(body).not.toHaveProperty('value');
    expect(body.message).not.toMatch(/\d+ minutes/);
    expect(body.messageJa).not.toMatch(/\d+ 分/);
    expect(response.headers.has('PAYMENT-RESPONSE')).toBe(false);
    expect(response.headers.has('X-PAYMENT-RESPONSE')).toBe(false);
    return body;
  }

  beforeEach(() => {
    clock = vi.spyOn(Date, 'now').mockReturnValue(SETTLED_AT);
    useSettled({ ...intentFixture('settled'), settledAt: SETTLED_AT });
  });

  afterEach(() => {
    clock.mockRestore();
    routeMocks.env.enableLicenseNft = false;
  });

  it.each([
    ['確定と同じ時刻', 0],
    ['確定の 1 秒後', 1_000],
    ['29 分後', 29 * MINUTE],
    ['1 年後', 365 * 24 * 60 * MINUTE],
  ])('%s の再送でも 409 で本文を読まずに返さず、購入の証拠と library を案内する', async (_label, elapsed) => {
    clock.mockReturnValue(SETTLED_AT + elapsed);
    const response = await resend();
    await expectAlreadySettled(response);
    expect(routeMocks.getHostedContent).not.toHaveBeenCalled();
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
    // 窓 0 では正規の再試行もここを通るので、Sentry に送る warn ではなく info で残す。
    expect(routeMocks.warn).not.toHaveBeenCalled();
    expect(routeMocks.info).toHaveBeenCalledTimes(1);
    expect(routeMocks.info).toHaveBeenCalledWith('x402.hosted.redelivery_refused', {
      rail: 'jpyc', resourceId: RESOURCE_ID, ageSec: Math.floor(elapsed / 1_000),
    });
  });

  it('契約: 409 はブラウザ (PR-0) が確定として扱う形 (409・state settled・正規の txHash・resourceId 一致)', async () => {
    clock.mockReturnValue(SETTLED_AT + 1_000);
    const response = await resend();
    const status = response.status;
    const body = await expectAlreadySettled(response);
    expect(browserTreatsAsSettled(status, body)).toBe(true);
  });

  it('forwarder settle の calldata だけから組み立てたヘッダーでも、確定の 1 秒後から本文を返さない', async () => {
    // claim は署名内容と、本物の署名の指紋 (正規化 + sha256) から導く。保存済み claim との照合も本物と
    // 同じく「authorizationHash と指紋の完全一致」にする (定数を返す mock では一致の検証にならない)。
    type Payload = { payload: { signature: string; authorization: Record<string, string> } };
    const claimFor = (value: unknown) => {
      const { signature, authorization } = (value as Payload).payload;
      const fingerprint = paymentSignatureFingerprint(signature) ?? 'invalid';
      const claim = {
        ...claimFixture(fingerprint),
        payer: getAddress(authorization.from),
        validAfter: authorization.validAfter,
        validBefore: authorization.validBefore,
      };
      return {
        ok: true as const,
        claim,
        authorizationHash: createHash('sha256').update(JSON.stringify(claim)).digest('hex'),
        signatureFingerprint: fingerprint,
      };
    };
    routeMocks.buildClaim.mockImplementation((input: { paymentPayload: unknown }) => claimFor(input.paymentPayload));
    routeMocks.authorizationMatches.mockImplementation(
      (intent: { authorizationHash: string; claim: { signatureFingerprint: string } }, claim: { signatureFingerprint: string }) =>
        createHash('sha256').update(JSON.stringify(claim)).digest('hex') === intent.authorizationHash &&
        claim.signatureFingerprint === intent.claim.signatureFingerprint,
    );

    // 買い手がクライアントで署名して送ったヘッダー。署名は r‖s‖v の 65 byte。
    const r = `0x${'4d'.repeat(32)}` as Hex;
    const s = `0x${'2c'.repeat(32)}` as Hex;
    const buyerSignature = `${r}${s.slice(2)}1b`;
    const buyer = claimFor(paymentPayload({ signature: buyerSignature }));
    useSettled({
      ...intentFixture('settled'),
      settledAt: SETTLED_AT,
      claim: buyer.claim,
      authorizationHash: buyer.authorizationHash,
    });

    // 他人が見るのは forwarder settle の calldata だけ (ヘッダーは漏れていない)。
    const calldata = {
      from: PAYER.toLowerCase(),
      merchant: SELLER.toLowerCase(),
      merchantValue: 5n * 10n ** 18n,
      feeValue: 10n ** 18n,
      validAfter: 0n,
      validBefore: 1_999_999_999n,
      intentSalt: INTENT_SALT,
      v: 27,
      r,
      s,
    };
    const rebuilt = {
      x402Version: 1,
      scheme: 'exact',
      network: 'eip155:80002',
      payload: {
        signature: serializeSignature({ r: calldata.r, s: calldata.s, v: BigInt(calldata.v) }),
        authorization: {
          from: getAddress(calldata.from),
          validAfter: calldata.validAfter.toString(),
          validBefore: calldata.validBefore.toString(),
          intentSalt: calldata.intentSalt,
        },
      },
    };
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
    const thirdPartyPath = `/api/paid/hosted/${RESOURCE_ID}?payer=${calldata.from}`;
    const thirdParty = {
      'X-PAYMENT': encode(rebuilt),
      'x-forwarded-for': '203.0.113.77',
      'user-agent': 'not-the-buyer',
    };
    // 前提: 組み立てた署名は買い手の署名と同じ (server は買い手の再試行と区別できない)。
    expect(rebuilt.payload.signature).toBe(buyerSignature);

    for (const elapsed of [1_000, 29 * MINUTE]) {
      clock.mockReturnValue(SETTLED_AT + elapsed);
      await expectAlreadySettled(await resend(thirdParty, thirdPartyPath));
    }

    // 完全一致の要求は変わらない: v だけ変えた署名は authorization_conflict。
    clock.mockReturnValue(SETTLED_AT + MINUTE);
    const forged = { ...rebuilt, payload: { ...rebuilt.payload, signature: `${r}${s.slice(2)}1c` } };
    const conflict = await resend({ 'X-PAYMENT': encode(forged) }, thirdPartyPath);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ ok: false, error: 'authorization_conflict' });

    expect(routeMocks.getHostedContent).not.toHaveBeenCalled();
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });

  it('初回の購入 (この request 自身が settle した応答) は settledAt に関係なく本文を返す (回帰)', async () => {
    clock.mockReturnValue(SETTLED_AT + 2 * 60 * MINUTE);
    routeMocks.getIntent.mockImplementation(async () => intentFixture());
    // finalize / read-back が古い settledAt を返しても (別 worker の確定等)、この request の settle 成功は本文を返す。
    const response = await resend();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, value: 'paid content', txHash: TX_HASH });
    expect(response.headers.has('PAYMENT-RESPONSE')).toBe(true);
    expect(routeMocks.verify).toHaveBeenCalledTimes(1);
    expect(routeMocks.settle).toHaveBeenCalledTimes(1);
    expect(routeMocks.finalize).toHaveBeenCalledTimes(1);
    expect(routeMocks.getHostedContent).toHaveBeenCalled();
    expect(routeMocks.warn).not.toHaveBeenCalled();
    expect(routeMocks.info).not.toHaveBeenCalledWith('x402.hosted.redelivery_refused', expect.anything());
  });

  it('決済待ちからの再送で route 内の照合が確定させた購入も、確定の直後から本文を返さない', async () => {
    const now = SETTLED_AT + 3 * 60 * MINUTE; // 署名から 3 時間後に照合で確定した
    clock.mockReturnValue(now);
    useSettled({ ...intentFixture('settled'), settledAt: now - 1_000 });
    routeMocks.getIntent.mockResolvedValueOnce(intentFixture('indeterminate'));
    routeMocks.reconcile.mockResolvedValue({ ok: true, state: 'settled', txHash: TX_HASH });
    const response = await resend();
    await expectAlreadySettled(response);
    expect(routeMocks.reconcile).toHaveBeenCalledWith(INTENT_SALT);
    expect(routeMocks.getHostedContent).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
    expect(routeMocks.info).toHaveBeenCalledWith('x402.hosted.redelivery_refused', {
      rail: 'jpyc', resourceId: RESOURCE_ID, ageSec: 1,
    });
  });

  it('signed の再送で、settle の claim が確定済み (別の request が確定させた) を返したときも本文を返さない', async () => {
    const settled = { ...intentFixture('settled'), settledAt: SETTLED_AT };
    routeMocks.getIntent.mockResolvedValue(intentFixture('signed'));
    routeMocks.claimSettlement.mockResolvedValue({ ok: true, kind: 'settled', intent: settled });
    const response = await resend();
    await expectAlreadySettled(response);
    expect(routeMocks.claimSettlement).toHaveBeenCalledTimes(1);
    expect(routeMocks.verify).not.toHaveBeenCalled();
    expect(routeMocks.settle).not.toHaveBeenCalled();
  });

  it('この request の settle が broadcast 前に拒否され、別の request が確定させていたときも本文を返さない', async () => {
    const settled = { ...intentFixture('settled'), settledAt: SETTLED_AT };
    routeMocks.getIntent
      .mockResolvedValueOnce(intentFixture())
      .mockResolvedValueOnce(settled);
    routeMocks.settle.mockResolvedValue(
      NextResponse.json({ success: false, errorReason: 'invalid_signature' }, { status: 400 }),
    );
    routeMocks.preBroadcastRejection.mockReturnValue(true);
    routeMocks.markFailedPrebroadcast.mockResolvedValue('conflict');
    const response = await resend();
    await expectAlreadySettled(response);
    expect(routeMocks.verify).toHaveBeenCalledTimes(1);
    expect(routeMocks.settle).toHaveBeenCalledTimes(1);
    expect(routeMocks.markFailedPrebroadcast).toHaveBeenCalledTimes(1);
    expect(routeMocks.releaseRail).not.toHaveBeenCalled();
  });

  it.each(['settling', 'indeterminate'] as const)('%s のままの再送は時間に関係なく従来どおり 202 pending (回帰)', async (state) => {
    clock.mockReturnValue(SETTLED_AT + 3 * 60 * MINUTE);
    routeMocks.getIntent.mockResolvedValue(intentFixture(state));
    routeMocks.reconcile.mockResolvedValue({ ok: true, state: 'pending' });
    const response = await resend();
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, state: 'pending' });
    expect(routeMocks.warn).not.toHaveBeenCalled();
    expect(routeMocks.info).not.toHaveBeenCalled();
  });

  describe('ライセンス商品の権利の確認は、本文を返さない判定より先に行い、結果も変えない', () => {
    const definition = { definitionHash: `0x${'de'.repeat(32)}` };
    const ownership = { payer: PAYER, resourceId: RESOURCE_ID };

    beforeEach(() => {
      routeMocks.env.enableLicenseNft = true;
      const base = intentFixture('settled');
      const intent = {
        ...base,
        settledAt: SETTLED_AT,
        metadata: { ...base.metadata, owner: SELLER, productKind: 'license', license: definition },
      };
      routeMocks.getIntent.mockResolvedValue(intent);
      routeMocks.readSettledAccess.mockResolvedValue({ ok: true, intent, ownership, purchase: {}, grant: {} });
    });

    it.each([
      [true, 409, 'purchase_already_settled'],
      [false, 404, 'not_found'],
      [null, 503, 'license_rights_unknown'],
    ] as const)('entitled=%s の再送は HTTP %i (%s)', async (entitled, status, error) => {
      clock.mockReturnValue(SETTLED_AT + 1_000);
      routeMocks.rights.mockResolvedValue({ entitled });
      const response = await resend();
      expect(response.status).toBe(status);
      const body = await response.json();
      expect(body.error).toBe(error);
      expect(body).not.toHaveProperty('value');
      expect(routeMocks.getHostedContent).not.toHaveBeenCalled();
      expect(routeMocks.rights).toHaveBeenCalledTimes(1);
      // 再送 (settlement なし) は権利照合の同時実行枠を渡す。鍵は再送用で、認証済み経路の枠ではない (第 9 回レビュー B-02)。
      expect(routeMocks.rights).toHaveBeenCalledWith({
        address: PAYER, productId: RESOURCE_ID, definition, ownership,
        admission: { acquire: routeMocks.resendAcquire, release: routeMocks.resendRelease },
      });
    });
  });

  // 第 9 回レビュー B-02: 決済済みの譲渡可能な license の署名ヘッダー (オンチェーンの calldata から組み立てられる) の
  // 再送が、権利照合の RPC (finalized block・balanceOf) を同時実行の枠の外で走らせない。枠は再送用の鍵で、認証済みの
  // content / library / holders の枠 (auth) には触れない (鍵の独立は tests/lib/license/rightsBudget.test.ts が本物の
  // Lua で確かめる)。resolver は実物を使い、RPC client (lib/license/rpc) と証明の KV (lib/license/jobs) だけ差し替えて、
  // RPC の発行そのものを数える。
  describe('譲渡可能な license の再送は、権利の RPC を同時実行の枠に通す (第 9 回レビュー B-02)', () => {
    const definition = createLicenseDefinition(RESOURCE_ID, {
      transferable: true,
      supply: 10,
      termsUrl: 'https://seller.example/terms',
      termsVersion: '1',
    }, 80002, getAddress(`0x${'44'.repeat(20)}`));
    const grant = {
      intentSalt: INTENT_SALT,
      contentRevision: 7,
      contentRef: `x402:hosted:${RESOURCE_ID}:content:7`,
      metadata: { owner: SELLER, payTo: SELLER, title: 'Durable hosted note', priceJpyc: '5', contentKind: 'text', productKind: 'license', license: definition },
      chainId: 80002,
      nonce: NONCE,
      purchasedAt: SETTLED_AT,
      txHash: TX_HASH,
    };
    const ownership = {
      version: 1,
      policy: 'all-purchased-revisions',
      payer: PAYER,
      resourceId: RESOURCE_ID,
      firstPurchasedAt: SETTLED_AT,
      updatedAt: SETTLED_AT,
      grants: [grant],
      latestGrant: grant,
    };
    const ZERO = '0x0000000000000000000000000000000000000000';
    const balanceOfCalls = () => routeMocks.rpcReadContract.mock.calls
      .filter(([call]) => (call as { functionName: string }).functionName === 'balanceOf').length;
    /** 譲渡可能な license の RPC: balance は現在の保有数、paymentKeyOf は購入 grant の mint 先。 */
    function useChain(balance: bigint, consumedTo: string = PAYER) {
      routeMocks.rpcReadContract.mockImplementation(async ({ functionName }: { functionName: string }) =>
        functionName === 'balanceOf' ? balance : { id: consumedTo === ZERO ? 0n : BigInt(definition.tokenId), to: consumedTo });
    }
    function licenseIntent(state: IntentState) {
      const base = intentFixture(state);
      return { ...base, metadata: { ...base.metadata, owner: SELLER, productKind: 'license', license: definition } };
    }

    beforeEach(async () => {
      routeMocks.env.enableLicenseNft = true;
      clock.mockReturnValue(SETTLED_AT + 1_000);
      const intent = { ...licenseIntent('settled'), settledAt: SETTLED_AT };
      routeMocks.getIntent.mockResolvedValue(intent);
      routeMocks.readSettledAccess.mockResolvedValue({ ok: true, intent, ownership, purchase: {}, grant });
      routeMocks.proof.mockReset().mockResolvedValue({ status: 'minted' });
      routeMocks.rpcGetBlock.mockReset().mockResolvedValue({ number: 100n });
      routeMocks.rpcReadContract.mockReset();
      routeMocks.licenseRpc.mockReset().mockReturnValue({ getBlock: routeMocks.rpcGetBlock, readContract: routeMocks.rpcReadContract });
      useChain(1n);
      const actual = await vi.importActual<typeof import('@/lib/license/rights')>('@/lib/license/rights');
      routeMocks.rights.mockReset().mockImplementation(actual.resolveLicenseRights);
    });

    afterEach(() => {
      // 公開の再送は、どの場合も認証済み経路の枠を取らない・返さない。
      expect(routeMocks.authAcquire).not.toHaveBeenCalled();
      expect(routeMocks.authRelease).not.toHaveBeenCalled();
      routeMocks.rights.mockReset();
      vi.unstubAllEnvs();
    });

    it('枠を使い切っているときは、block・balanceOf の RPC を始めずに既存の 503 license_rights_unknown を返す', async () => {
      routeMocks.resendAcquire.mockResolvedValue(null);
      const response = await resend();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ ok: false, error: 'license_rights_unknown' });
      expect(routeMocks.resendAcquire).toHaveBeenCalledTimes(1);
      expect(routeMocks.resendRelease).not.toHaveBeenCalled();
      expect(routeMocks.licenseRpc).not.toHaveBeenCalled();
      expect(routeMocks.rpcGetBlock).not.toHaveBeenCalled();
      expect(routeMocks.rpcReadContract).not.toHaveBeenCalled();
      expect(routeMocks.getHostedContent).not.toHaveBeenCalled();
      expect(routeMocks.verify).not.toHaveBeenCalled();
      expect(routeMocks.settle).not.toHaveBeenCalled();
    });

    it('枠があり、今も保有していれば従来どおり 409 (本文なし)・RPC は 1 回ずつ・枠は返す', async () => {
      const response = await resend();
      await expectAlreadySettled(response);
      expect(routeMocks.resendAcquire).toHaveBeenCalledTimes(1);
      expect(routeMocks.rpcGetBlock).toHaveBeenCalledTimes(1);
      expect(balanceOfCalls()).toBe(1);
      expect(routeMocks.resendRelease).toHaveBeenCalledTimes(1);
      expect(routeMocks.resendRelease).toHaveBeenCalledWith('lease');
      expect(routeMocks.getHostedContent).not.toHaveBeenCalled();
    });

    it('枠があり、譲渡して保有していなければ従来どおり 404・枠は返す', async () => {
      useChain(0n, PAYER);
      const response = await resend();
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ ok: false, error: 'not_found' });
      expect(routeMocks.rpcGetBlock).toHaveBeenCalledTimes(1);
      expect(balanceOfCalls()).toBe(1);
      expect(routeMocks.resendRelease).toHaveBeenCalledWith('lease');
      expect(routeMocks.getHostedContent).not.toHaveBeenCalled();
    });

    it('譲渡不可の license の再送は枠にも RPC にも触れず、枠を使い切っていても従来どおり 409', async () => {
      const nontransferable = { ...definition, transferable: false };
      const base = { ...licenseIntent('settled'), settledAt: SETTLED_AT };
      const intent = { ...base, metadata: { ...base.metadata, license: nontransferable } };
      const owned = { ...ownership, grants: [{ ...grant, metadata: { ...grant.metadata, license: nontransferable } }] };
      routeMocks.getIntent.mockResolvedValue(intent);
      routeMocks.readSettledAccess.mockResolvedValue({ ok: true, intent, ownership: owned, purchase: {}, grant });
      routeMocks.resendAcquire.mockResolvedValue(null);
      await expectAlreadySettled(await resend());
      expect(routeMocks.resendAcquire).not.toHaveBeenCalled();
      expect(routeMocks.licenseRpc).not.toHaveBeenCalled();
      expect(routeMocks.rpcGetBlock).not.toHaveBeenCalled();
      expect(routeMocks.rpcReadContract).not.toHaveBeenCalled();
    });

    it('並列の再送でも、RPC を同時に始めるのは枠の数まで (残りは既存の 503)', async () => {
      // 実物の枠 (8 枠・lib/license/rightsBudget) の代わりに 2 枠の枠を置き、block の RPC を止めて同時実行を作る。
      const capacity = 2;
      const held = new Set<string>();
      let issued = 0;
      routeMocks.resendAcquire.mockImplementation(async () => {
        if (held.size >= capacity) return null;
        const token = `lease-${issued++}`;
        held.add(token);
        return token;
      });
      routeMocks.resendRelease.mockImplementation(async (token: string) => { held.delete(token); });
      let unblock!: () => void;
      const blocked = new Promise<void>((resolve) => { unblock = resolve; });
      routeMocks.rpcGetBlock.mockImplementation(async () => { await blocked; return { number: 100n }; });

      const route = await loadRoute();
      const parallel = 6;
      const pending: Promise<Response>[] = [];
      for (let sent = 1; sent <= parallel; sent += 1) {
        pending.push(callHosted(route, path, { 'X-PAYMENT': paymentHeader() }));
        // テストの都合 (vitest 5.0.3): 同じ mock module を並列で dynamic import すると、2 本目以降が mock でなく実物
        // (KV に触れる) に解決される。各 request が枠を取りに来た (= route の遅延 import を終えた) のを待ってから次を
        // 送る。先に枠を取った request は block の RPC で止まったままなので、RPC の段では同時に走っている。
        await vi.waitFor(() => expect(routeMocks.resendAcquire).toHaveBeenCalledTimes(sent));
      }
      expect(routeMocks.rpcGetBlock).toHaveBeenCalledTimes(capacity);
      unblock();
      const responses = await Promise.all(pending);
      expect(responses.map((r) => r.status).sort()).toEqual([409, 409, 503, 503, 503, 503]);
      expect(routeMocks.rpcGetBlock).toHaveBeenCalledTimes(capacity);
      expect(balanceOfCalls()).toBe(capacity);
      expect(held.size).toBe(0);
      expect(routeMocks.getHostedContent).not.toHaveBeenCalled();
    });

    it('初回の購入 (この request 自身が settle した応答) は枠に通さず、枠を使い切っていても従来どおり本文を返す', async () => {
      vi.stubEnv('LICENSE_NFT_SELLER_ALLOWLIST', SELLER);
      routeMocks.resendAcquire.mockResolvedValue(null);
      routeMocks.getHostedProduct.mockResolvedValue({ ...productFixture(), productKind: 'license', license: definition, registration: { status: 'registered' } });
      routeMocks.getIntent.mockImplementation(async () => licenseIntent('quoted'));
      routeMocks.finalize.mockResolvedValue({ ok: true, kind: 'finalized', intent: { ...licenseIntent('settled'), settledAt: SETTLED_AT } });
      // mint 前の購入: 保有はまだ 0、paymentKeyOf は未消費 (to = 0)。
      useChain(0n, ZERO);
      const response = await resend();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, value: 'paid content', txHash: TX_HASH, productKind: 'license' });
      expect(response.headers.has('PAYMENT-RESPONSE')).toBe(true);
      expect(routeMocks.settle).toHaveBeenCalledTimes(1);
      expect(routeMocks.rights).toHaveBeenCalledTimes(1);
      expect(routeMocks.rights.mock.calls[0]![0]).not.toHaveProperty('admission');
      expect(routeMocks.resendAcquire).not.toHaveBeenCalled();
      expect(routeMocks.rpcGetBlock).toHaveBeenCalledTimes(1);
      expect(balanceOfCalls()).toBe(1);
    });
  });
});
