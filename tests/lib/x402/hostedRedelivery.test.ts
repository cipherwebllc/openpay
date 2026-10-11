import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: h.warn, error: vi.fn() },
}));

import {
  HOSTED_REDELIVERY_AFTER_VALID_BEFORE_MS,
  HOSTED_REDELIVERY_EXPIRED_ERROR,
  hostedRedeliveryExpiredResponse,
  hostedRedeliveryOpen,
} from '@/lib/x402/hostedRedelivery';
import { PAYMENT_REDELIVERY_TTL_SEC } from '@/lib/x402/paymentRedelivery';
import { PURCHASE_QUOTE_TTL_SEC } from '@/lib/x402/purchaseIntent';
import { STORE_USDC_INTENT_TTL_SEC } from '@/lib/x402/storeUsdcIntent';

const RESOURCE_ID = `h_${'1'.repeat(32)}`;
const TX_HASH = `0x${'ab'.repeat(32)}` as const;
const MINUTE = 60_000;
// 署名の validBefore (秒)。確定はその 5 分前に記録された。
const VALID_BEFORE_SEC = 1_900_000_000;
const VALID_BEFORE_MS = VALID_BEFORE_SEC * 1_000;
const VALID_BEFORE = String(VALID_BEFORE_SEC);
const SETTLED_AT = VALID_BEFORE_MS - 5 * MINUTE;
const DEADLINE = VALID_BEFORE_MS + HOSTED_REDELIVERY_AFTER_VALID_BEFORE_MS;

beforeEach(() => {
  h.warn.mockReset();
});

describe('hosted 購入の確定後の再送の窓', () => {
  it('署名の validBefore から 20 分。見積もりから最大 30 分で、自社商品・agent 注文の再配信 record の TTL と同じ長さ', () => {
    expect(HOSTED_REDELIVERY_AFTER_VALID_BEFORE_MS).toBe(20 * MINUTE);
    // validBefore の上限は見積もりから 10 分 (JPYC: quote の期限・USDC: intent の期限で FX quote を頭打ち)。
    expect(PURCHASE_QUOTE_TTL_SEC * 1_000 + HOSTED_REDELIVERY_AFTER_VALID_BEFORE_MS)
      .toBe(PAYMENT_REDELIVERY_TTL_SEC * 1_000);
    expect(STORE_USDC_INTENT_TTL_SEC * 1_000 + HOSTED_REDELIVERY_AFTER_VALID_BEFORE_MS)
      .toBe(PAYMENT_REDELIVERY_TTL_SEC * 1_000);
  });

  it('validBefore + 20 分の内側だけ開く (ちょうどで閉じる)', () => {
    const claim = { validBefore: VALID_BEFORE };
    expect(hostedRedeliveryOpen(claim, SETTLED_AT)).toBe(true);
    expect(hostedRedeliveryOpen(claim, VALID_BEFORE_MS)).toBe(true);
    expect(hostedRedeliveryOpen(claim, DEADLINE - 1)).toBe(true);
    expect(hostedRedeliveryOpen(claim, DEADLINE)).toBe(false);
    expect(hostedRedeliveryOpen(claim, DEADLINE + 365 * 24 * 60 * MINUTE)).toBe(false);
  });

  it('数値にならない validBefore は再配信しない側に倒れる', () => {
    expect(hostedRedeliveryOpen({ validBefore: 'not-a-number' }, SETTLED_AT)).toBe(false);
  });

  it('409 は本文を含まず、機械向けの code と人向けの文言 (en/ja) を返し、warn を 1 回出す', async () => {
    const response = hostedRedeliveryExpiredResponse({
      rail: 'usdc',
      resourceId: RESOURCE_ID,
      chainId: 8453,
      txHash: TX_HASH,
      settledAt: SETTLED_AT,
      validBefore: VALID_BEFORE,
      now: DEADLINE + 500,
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toEqual({
      ok: false,
      error: HOSTED_REDELIVERY_EXPIRED_ERROR,
      state: 'settled',
      resourceId: RESOURCE_ID,
      txHash: TX_HASH,
      network: 'eip155:8453',
      library: '/store/library',
      contentApi: `/api/store/content/${RESOURCE_ID}`,
      message: 'This purchase is already settled. Resending the payment header returns the content only until 20 minutes after the signed payment authorization expires (validBefore). Do not pay again: sign in with the paying wallet (SIWE) and open it from your library (/store/library).',
      messageJa: 'この購入は確定済みです。支払いの署名ヘッダーを再送して中身を受け取れるのは、署名した支払いの有効期限（validBefore）から 20 分後までだけです。もう一度支払わずに、支払ったウォレットでサインインして、ライブラリ（/store/library）から開いてください。',
    });
    expect(body).not.toHaveProperty('value');
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledWith('x402.hosted.redelivery_expired', {
      rail: 'usdc', resourceId: RESOURCE_ID, ageSec: 25 * 60, sinceValidBeforeSec: 20 * 60,
    });
  });

  it('warn (console・Sentry) が throw しても 409 応答は変わらない (掟 13)', async () => {
    h.warn.mockImplementation(() => {
      throw new Error('sentry transport down');
    });
    const response = hostedRedeliveryExpiredResponse({
      rail: 'jpyc',
      resourceId: RESOURCE_ID,
      chainId: 137,
      txHash: TX_HASH,
      settledAt: SETTLED_AT,
      validBefore: VALID_BEFORE,
      now: DEADLINE,
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false, error: HOSTED_REDELIVERY_EXPIRED_ERROR, network: 'eip155:137', txHash: TX_HASH,
    });
    expect(h.warn).toHaveBeenCalledTimes(1);
  });
});
