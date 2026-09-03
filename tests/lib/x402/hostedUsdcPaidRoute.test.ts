import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress, type Hex } from 'viem';

// 署名 fingerprint と authorizationHash は **入力に依存する** 形で fake する (定数を返すと
// 「別の署名で settled intent の内容を引き出せるか」を一切検証できない = B4 の穴が素通りする)。
// 実装 (paymentRedelivery / storeUsdcIntent の canonicalHash) と同じ sha256 の性質だけ模す。
function fakeFingerprint(signature: unknown): string {
  return createHash('sha256').update(String(signature)).digest('hex');
}
function fakeAuthHash(claim: unknown): string {
  return createHash('sha256').update(JSON.stringify(claim)).digest('hex');
}

const mocks = vi.hoisted(() => ({
  getProduct: vi.fn(),
  getContent: vi.fn(),
  metadata: vi.fn(),
  disclosure: vi.fn(),
  quoteLimit: vi.fn(),
  quoteRate: vi.fn(),
  anchor: vi.fn(),
  createIntent: vi.fn(),
  findIntent: vi.fn(),
  claimSigned: vi.fn(),
  claimSettlement: vi.fn(),
  recordTransaction: vi.fn(),
  markIndeterminate: vi.fn(),
  finalize: vi.fn(),
  readAccess: vi.fn(),
  postFacilitator: vi.fn(),
  recordPurchase: vi.fn(),
  metric: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return { ...actual, after: vi.fn((task: () => void) => task()) };
});
vi.mock('@/lib/net/ipHash', () => ({
  clientIp: () => '127.0.0.1',
  hashIp: () => 'ip-hash',
}));
vi.mock('@/lib/metrics', () => ({ recordMetric: mocks.metric }));
vi.mock('@/lib/push/notify', () => ({ notifyPaymentReceived: mocks.notify }));
vi.mock('@/lib/x402/hostedStore', () => ({
  getHostedProduct: mocks.getProduct,
  getHostedContent: mocks.getContent,
  hostedPurchaseMetadata: mocks.metadata,
  sellerDisclosureComplete: mocks.disclosure,
}));
vi.mock('@/lib/x402/paymentRedelivery', () => ({
  paymentSignatureFingerprint: (signature: unknown) => fakeFingerprint(signature),
}));
vi.mock('@/lib/x402/purchaseIntent', () => ({
  checkPurchaseQuoteRateLimit: mocks.quoteLimit,
}));
vi.mock('@/lib/x402/purchaseStats', () => ({
  recordHostedPurchase: mocks.recordPurchase,
}));
vi.mock('@/lib/x402/storeUsdcIntent', () => ({
  STORE_USDC_DEPLOYMENT_VERSION: 'creator-store-usdc-vanilla-v1',
  STORE_USDC_INTENT_TTL_SEC: 600,
  claimSignedStoreUsdcIntent: mocks.claimSigned,
  claimStoreUsdcSettlement: mocks.claimSettlement,
  createQuotedStoreUsdcIntent: mocks.createIntent,
  finalizeStoreUsdcPurchase: mocks.finalize,
  findStoreUsdcIntentByNonce: mocks.findIntent,
  markStoreUsdcIndeterminate: mocks.markIndeterminate,
  readSettledStoreUsdcAccess: mocks.readAccess,
  recordStoreUsdcTransaction: mocks.recordTransaction,
  storeUsdcAuthorizationHash: (claim: unknown) => fakeAuthHash(claim),
}));
vi.mock('@/lib/x402/storeUsdcOnchain', () => ({
  STORE_USDC_ADDRESS: getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
  STORE_USDC_CHAIN_ID: 8453,
  readStoreUsdcAnchorBlock: mocks.anchor,
}));
vi.mock('@/lib/x402/storeUsdcRateProvider', () => ({
  quoteStoreJpycInUsdc: mocks.quoteRate,
}));
vi.mock('@/lib/x402/vanillaGate', () => ({
  postFacilitator: mocks.postFacilitator,
}));

import { handleHostedUsdcPaidGet } from '@/lib/x402/hostedUsdcPaidRoute';

const NOW = 1_900_000_000_000;
const RESOURCE_ID = `h_${'1'.repeat(32)}`;
const INTENT_SALT = `0x${'22'.repeat(32)}` as Hex;
const NONCE = `0x${'33'.repeat(32)}` as Hex;
const TX_HASH = `0x${'44'.repeat(32)}` as Hex;
const PAYER = getAddress('0x1111111111111111111111111111111111111111');
const SELLER = getAddress('0x2222222222222222222222222222222222222222');
const USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const SIGNATURE = `0x${'55'.repeat(65)}`;
// 形式だけ正しい別署名 (nonce を知った第三者が投げうる payload の再現用)。
const FORGED_SIGNATURE = `0x${'66'.repeat(65)}`;

const paymentSnapshot = {
  version: 1,
  rail: 'usdc',
  asset: USDC,
  assetSymbol: 'USDC',
  chainId: 8453,
  paidAtomic: '2000000',
  priceJpyc: '300',
  quote: {
    rateScaled: '150000000',
    rateFetchedAt: NOW,
    fxQuoteExpiresAt: NOW + 180_000,
    rounding: 'ceil',
  },
};

function product(usdcEnabled = true) {
  return {
    kind: 'hosted',
    id: RESOURCE_ID,
    owner: SELLER,
    payTo: SELLER,
    title: 'Base USDC product',
    priceJpyc: '300',
    contentKind: 'text',
    label: 'prompt',
    contentRevision: 2,
    saleActive: true,
    contentAvailable: true,
    ...(usdcEnabled ? { usdcEnabled: true } : {}),
    createdAt: NOW - 10_000,
  };
}

function intent(state: string = 'quoted') {
  const base = {
    version: 1,
    deploymentVersion: 'creator-store-usdc-vanilla-v1',
    state,
    intentSalt: INTENT_SALT,
    parentIntentId: '7'.repeat(64),
    resourceId: RESOURCE_ID,
    contentRevision: 2,
    contentRef: `x402:hosted:${RESOURCE_ID}:content:2`,
    metadata: {
      owner: SELLER,
      payTo: SELLER,
      title: 'Base USDC product',
      priceJpyc: '300',
      contentKind: 'text',
      label: 'prompt',
    },
    payerHint: PAYER,
    token: USDC,
    chainId: 8453,
    merchant: SELLER,
    usdcQuoteAtomic: '2000000',
    rateScaled: '150000000',
    rateFetchedAt: NOW,
    rounding: 'ceil',
    anchorBlock: '90',
    nonce: NONCE,
    createdAt: NOW,
    intentExpiresAt: NOW + 600_000,
    fxQuoteExpiresAt: NOW + 180_000,
    authorizationValidBeforeMax: String(Math.floor((NOW + 180_000) / 1_000)),
    bindingHash: '8'.repeat(64),
  };
  if (state === 'quoted') return base;
  // claim の key 順は route の exactClaim が組む literal と揃える (canonicalHash が
  // JSON.stringify 依存のため)。authorizationHash は claim から導出する = 保存済 claim と
  // 1 文字でも違う payload は hash 不一致になる。
  const claim = {
    payer: PAYER,
    to: SELLER,
    value: '2000000',
    validAfter: '0',
    validBefore: base.authorizationValidBeforeMax,
    nonce: NONCE,
    signatureFingerprint: fakeFingerprint(SIGNATURE),
  };
  const claimed = {
    ...base,
    state,
    claim,
    authorizationHash: fakeAuthHash(claim),
    signedAt: NOW + 1_000,
  };
  if (state === 'signed') return claimed;
  const settling = {
    ...claimed,
    state,
    attemptId: '9'.repeat(64),
    settlementStartedAt: NOW + 2_000,
    leaseUntil: NOW + 62_000,
  };
  if (state !== 'settled') return settling;
  return { ...claimed, state, txHash: TX_HASH, settledAt: NOW + 3_000 };
}

function paymentHeader(value = '2000000', signature = SIGNATURE): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: 'exact',
      network: 'base',
      payload: {
        signature,
        authorization: {
          from: PAYER,
          to: SELLER,
          value,
          validAfter: '0',
          validBefore: String(Math.floor((NOW + 180_000) / 1_000)),
          nonce: NONCE,
        },
      },
    }),
    'utf8',
  ).toString('base64');
}

function request(headers?: HeadersInit): Request {
  return new Request(
    `http://test.local/api/paid/hosted/${RESOURCE_ID}?payer=${PAYER}&rail=usdc`,
    { headers },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(NOW + 5_000);
  mocks.getProduct.mockResolvedValue(product());
  mocks.getContent.mockResolvedValue({ kind: 'text', value: 'paid content' });
  mocks.metadata.mockReturnValue(intent().metadata);
  mocks.disclosure.mockResolvedValue(true);
  mocks.quoteLimit.mockResolvedValue(true);
  mocks.quoteRate.mockResolvedValue({
    ok: true,
    quote: {
      rate: 150,
      rateScaled: '150000000',
      fetchedAt: NOW,
      usdcQuoteAtomic: '2000000',
      fxQuoteExpiresAt: NOW + 180_000,
      rounding: 'ceil',
    },
  });
  mocks.anchor.mockResolvedValue(90n);
  mocks.createIntent.mockResolvedValue({ ok: true, intent: intent() });
  mocks.findIntent.mockResolvedValue(intent());
  mocks.claimSigned.mockResolvedValue({
    ok: true,
    kind: 'claimed',
    intent: intent('signed'),
  });
  mocks.claimSettlement.mockResolvedValue({
    ok: true,
    kind: 'claimed',
    intent: intent('settling'),
  });
  mocks.recordTransaction.mockResolvedValue('updated');
  mocks.markIndeterminate.mockResolvedValue('updated');
  mocks.finalize.mockResolvedValue({
    ok: true,
    kind: 'finalized',
    intent: intent('settled'),
    ownership: {},
    purchase: { payment: paymentSnapshot },
  });
  mocks.readAccess.mockResolvedValue({
    ok: true,
    intent: intent('settled'),
    ownership: {},
    purchase: { payment: paymentSnapshot },
  });
  mocks.postFacilitator.mockImplementation(async (path: string) =>
    path === '/verify'
      ? { isValid: true, payer: PAYER }
      : { success: true, transaction: TX_HASH, network: 'base', payer: PAYER },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('hosted USDC paid route', () => {
  it('rail=usdc は Base native USDC の単一 accept と canonical quote/nonce だけを返す', async () => {
    const response = await handleHostedUsdcPaidGet(request(), RESOURCE_ID, PAYER);
    expect(response.status).toBe(402);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.accepts).toHaveLength(1);
    expect(body.accepts[0]).toMatchObject({
      network: 'base',
      asset: USDC,
      payTo: SELLER,
      maxAmountRequired: '2000000',
      extra: {
        decimals: 6,
        assetTransferMethod: 'eip3009',
        openpay: {
          rail: 'usdc',
          nonce: NONCE,
          usdcQuoteAtomic: '2000000',
          rateFetchedAt: NOW,
          rounding: 'ceil',
        },
      },
    });
    const required = JSON.parse(
      Buffer.from(response.headers.get('payment-required') ?? '', 'base64').toString('utf8'),
    );
    expect(required.accepts).toHaveLength(1);
    expect(required.accepts[0]).toMatchObject({
      network: 'eip155:8453',
      amount: '2000000',
      asset: USDC,
    });
    expect(mocks.quoteRate.mock.calls[0]?.[0]).not.toHaveProperty('now');
  });

  it('usdcEnabled=true でない商品は明示 rail でも 404', async () => {
    mocks.getProduct.mockResolvedValue(product(false));
    const response = await handleHostedUsdcPaidGet(request(), RESOURCE_ID, PAYER);
    expect(response.status).toBe(404);
    expect(mocks.quoteRate).not.toHaveBeenCalled();
  });

  it('verify → rail settle admission → facilitator settle → on-chain finalizer の順で解錠する', async () => {
    const response = await handleHostedUsdcPaidGet(
      request({ 'X-PAYMENT': paymentHeader() }),
      RESOURCE_ID,
      PAYER,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      state: 'settled',
      value: 'paid content',
      txHash: TX_HASH,
      payment: paymentSnapshot,
    });
    expect(mocks.postFacilitator.mock.calls.map(([path]) => path)).toEqual([
      '/verify',
      '/settle',
    ]);
    const settleBody = mocks.postFacilitator.mock.calls[1]?.[1];
    expect(settleBody).toMatchObject({
      paymentRequirements: {
        network: 'base',
        asset: USDC,
        maxAmountRequired: '2000000',
      },
      paymentPayload: {
        network: 'base',
        payload: { authorization: { nonce: NONCE, value: '2000000' } },
      },
    });
    expect(mocks.recordTransaction.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.finalize.mock.invocationCallOrder[0]!,
    );
    expect(mocks.finalize.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.readAccess.mock.invocationCallOrder[0]!,
    );
  });

  it('v2 PAYMENT-SIGNATURE は CAIP-2 accept の完全一致だけを facilitator へ渡す', async () => {
    const challenge = await handleHostedUsdcPaidGet(request(), RESOURCE_ID, PAYER);
    const required = JSON.parse(
      Buffer.from(challenge.headers.get('payment-required') ?? '', 'base64').toString('utf8'),
    ) as { accepts: Array<Record<string, unknown>> };
    const v1 = JSON.parse(
      Buffer.from(paymentHeader(), 'base64').toString('utf8'),
    ) as { payload: Record<string, unknown> };
    const encode = (accepted: Record<string, unknown>) =>
      Buffer.from(
        JSON.stringify({
          x402Version: 2,
          accepted,
          payload: v1.payload,
        }),
        'utf8',
      ).toString('base64');

    const paid = await handleHostedUsdcPaidGet(
      request({ 'PAYMENT-SIGNATURE': encode(required.accepts[0]!) }),
      RESOURCE_ID,
      PAYER,
    );
    expect(paid.status).toBe(200);
    expect(mocks.postFacilitator.mock.calls[0]?.[1]).toMatchObject({
      paymentPayload: { network: 'base' },
      paymentRequirements: { network: 'base' },
    });

    vi.clearAllMocks();
    mocks.findIntent.mockResolvedValue(intent());
    const tampered = await handleHostedUsdcPaidGet(
      request({
        'PAYMENT-SIGNATURE': encode({
          ...required.accepts[0],
          amount: '1999999',
        }),
      }),
      RESOURCE_ID,
      PAYER,
    );
    expect(tampered.status).toBe(400);
    expect(mocks.postFacilitator).not.toHaveBeenCalled();
  });

  // settle 開始後は intent が settling として pending index + lease に載っているので、marker が
  // 書けなくても reconciler が拾える → 従来どおり 202 (掟 12: 既存応答を変えない)。
  it.each(['throw', 'non-success', 'missing-tx'] as const)(
    'settle 開始後の %s は marker 保存失敗でも 202 pending',
    async (mode) => {
      mocks.markIndeterminate.mockResolvedValue('storage');
      mocks.postFacilitator.mockImplementation(async (path: string) => {
        if (path === '/verify') return { isValid: true, payer: PAYER };
        if (mode === 'throw') throw new Error('timeout');
        if (mode === 'non-success') return { success: false, transaction: TX_HASH };
        return { success: true };
      });
      const response = await handleHostedUsdcPaidGet(
        request({ 'X-PAYMENT': paymentHeader() }),
        RESOURCE_ID,
        PAYER,
      );
      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toEqual({ ok: true, state: 'pending' });
      expect(mocks.markIndeterminate).toHaveBeenCalledTimes(1);
      expect(mocks.finalize).not.toHaveBeenCalled();
    },
  );

  // B13: settle 成功 (txHash 有) 後の finalize 失敗だけは 202 にしない。「支払いは通った」に
  // 加えて「あとで解錠される」まで約束しないため、JPYC 側 (app/api/paid/hosted/[id] の
  // finalize 失敗分岐) と同一の 503 purchase_provisioning に揃える。
  it.each(['updated', 'storage'] as const)(
    'finality 未達は marker=%s でも entitlement/content を返さず 503 purchase_provisioning',
    async (marker) => {
      mocks.finalize.mockResolvedValue({ ok: false, reason: 'pending_finality' });
      mocks.markIndeterminate.mockResolvedValue(marker);
      const response = await handleHostedUsdcPaidGet(
        request({ 'X-PAYMENT': paymentHeader() }),
        RESOURCE_ID,
        PAYER,
      );
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: 'purchase_provisioning',
      });
      expect(mocks.readAccess).not.toHaveBeenCalled();
      expect(mocks.markIndeterminate).toHaveBeenCalledWith({
        intentSalt: INTENT_SALT,
        attemptId: '9'.repeat(64),
        txHash: TX_HASH,
      });
    },
  );

  it('settle success 後の tx marker 保存障害も課金なしと断定せず 202 pending', async () => {
    mocks.recordTransaction.mockResolvedValue('storage');
    const response = await handleHostedUsdcPaidGet(
      request({ 'X-PAYMENT': paymentHeader() }),
      RESOURCE_ID,
      PAYER,
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      state: 'pending',
    });
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  // B4: 期限は「新規 broadcast の入場条件」であって、既に claim 済みの intent への
  // 完全一致 redelivery には適用しない (JPYC 側 existing-claim-recovery と同じ)。
  describe('B4: 期限切れ後の完全一致 redelivery', () => {
    const EXPIRED_NOW = NOW + 200_000; // fxQuoteExpiresAt (NOW+180s) を過ぎている

    it('settled + FX quote 期限切れでも content を返す (恒久 entitlement)', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(EXPIRED_NOW);
      mocks.findIntent.mockResolvedValue(intent('settled'));
      const response = await handleHostedUsdcPaidGet(
        request({ 'X-PAYMENT': paymentHeader() }),
        RESOURCE_ID,
        PAYER,
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        state: 'settled',
        value: 'paid content',
        txHash: TX_HASH,
      });
      expect(mocks.postFacilitator).not.toHaveBeenCalled();
    });

    it.each(['settling', 'indeterminate'] as const)(
      '%s + 期限切れでも 409 ではなく 202 pending (回復導線を塞がない)',
      async (state) => {
        vi.spyOn(Date, 'now').mockReturnValue(EXPIRED_NOW);
        mocks.findIntent.mockResolvedValue(intent(state));
        const response = await handleHostedUsdcPaidGet(
          request({ 'X-PAYMENT': paymentHeader() }),
          RESOURCE_ID,
          PAYER,
        );
        expect(response.status).toBe(202);
        await expect(response.json()).resolves.toEqual({
          ok: true,
          state: 'pending',
        });
        expect(mocks.postFacilitator).not.toHaveBeenCalled();
      },
    );

    it('quoted (未 claim) は従来どおり期限切れで 409 (回帰)', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(EXPIRED_NOW);
      mocks.findIntent.mockResolvedValue(intent());
      const response = await handleHostedUsdcPaidGet(
        request({ 'X-PAYMENT': paymentHeader() }),
        RESOURCE_ID,
        PAYER,
      );
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: 'purchase_intent_expired',
      });
      expect(mocks.postFacilitator).not.toHaveBeenCalled();
    });

    it('claim 済みでも authorization が不一致なら期限に関係なく 409', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(EXPIRED_NOW);
      mocks.findIntent.mockResolvedValue(intent('settled'));
      const response = await handleHostedUsdcPaidGet(
        request({ 'X-PAYMENT': paymentHeader('1999999') }),
        RESOURCE_ID,
        PAYER,
      );
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: 'authorization_conflict',
      });
    });

    // 期限を飛ばす recovery は **保存済 claim との完全一致** が条件。nonce を知った第三者が
    // 形式だけ正しい別署名を投げても、支払い済みコンテンツは出さない (settled intent の
    // bearer 化を防ぐ)。exactClaim は intent 側の値しか照合しないので、この照合が無いと通る。
    it.each(['settled', 'settling', 'indeterminate', 'signed'] as const)(
      '%s + 期限切れでも署名 fingerprint が違えば 409 (内容を bearer にしない)',
      async (state) => {
        vi.spyOn(Date, 'now').mockReturnValue(EXPIRED_NOW);
        mocks.findIntent.mockResolvedValue(intent(state));
        const response = await handleHostedUsdcPaidGet(
          request({
            'X-PAYMENT': paymentHeader('2000000', FORGED_SIGNATURE),
          }),
          RESOURCE_ID,
          PAYER,
        );
        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toEqual({
          ok: false,
          error: 'authorization_conflict',
        });
        expect(mocks.getContent).not.toHaveBeenCalled();
        expect(mocks.readAccess).not.toHaveBeenCalled();
        expect(mocks.postFacilitator).not.toHaveBeenCalled();
      },
    );

    it('validBefore だけ差し替えた完全一致でない再送も 409', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(EXPIRED_NOW);
      mocks.findIntent.mockResolvedValue(intent('settled'));
      const header = Buffer.from(
        JSON.stringify({
          x402Version: 1,
          scheme: 'exact',
          network: 'base',
          payload: {
            signature: SIGNATURE,
            authorization: {
              from: PAYER,
              to: SELLER,
              value: '2000000',
              validAfter: '0',
              // 上限以下だが保存済 claim とは違う値 (exactClaim 単体では通ってしまう)。
              validBefore: String(Math.floor((NOW + 179_000) / 1_000)),
              nonce: NONCE,
            },
          },
        }),
        'utf8',
      ).toString('base64');
      const response = await handleHostedUsdcPaidGet(
        request({ 'X-PAYMENT': header }),
        RESOURCE_ID,
        PAYER,
      );
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: 'authorization_conflict',
      });
      expect(mocks.readAccess).not.toHaveBeenCalled();
    });

    // failed_prebroadcast は recovery 対象に含めない = 期限判定が先 (B4 以前と同じコード)。
    it('failed_prebroadcast + 期限切れは従来どおり purchase_intent_expired', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(EXPIRED_NOW);
      mocks.findIntent.mockResolvedValue(intent('failed_prebroadcast'));
      const response = await handleHostedUsdcPaidGet(
        request({ 'X-PAYMENT': paymentHeader() }),
        RESOURCE_ID,
        PAYER,
      );
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: 'purchase_intent_expired',
      });
    });

    it('failed_prebroadcast + 期限内は従来どおり purchase_intent_failed', async () => {
      mocks.findIntent.mockResolvedValue(intent('failed_prebroadcast'));
      const response = await handleHostedUsdcPaidGet(
        request({ 'X-PAYMENT': paymentHeader() }),
        RESOURCE_ID,
        PAYER,
      );
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: 'purchase_intent_failed',
      });
    });
  });

  it('レール CAS の敗者と quote amount 改竄は broadcast 前に拒否', async () => {
    mocks.claimSettlement.mockResolvedValue({ ok: false, reason: 'conflict' });
    const loser = await handleHostedUsdcPaidGet(
      request({ 'X-PAYMENT': paymentHeader() }),
      RESOURCE_ID,
      PAYER,
    );
    expect(loser.status).toBe(409);
    expect(mocks.postFacilitator).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    mocks.findIntent.mockResolvedValue(intent());
    const tampered = await handleHostedUsdcPaidGet(
      request({ 'X-PAYMENT': paymentHeader('1999999') }),
      RESOURCE_ID,
      PAYER,
    );
    expect(tampered.status).toBe(409);
    expect(mocks.postFacilitator).not.toHaveBeenCalled();
  });
});
