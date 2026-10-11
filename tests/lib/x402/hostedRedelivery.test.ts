import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: h.warn, error: vi.fn() },
}));

import {
  HOSTED_REDELIVERY_EXPIRED_ERROR,
  HOSTED_REDELIVERY_WINDOW_MS,
  hostedRedeliveryExpiredResponse,
  hostedRedeliveryOpen,
} from '@/lib/x402/hostedRedelivery';
import { PAYMENT_REDELIVERY_TTL_SEC } from '@/lib/x402/paymentRedelivery';

const RESOURCE_ID = `h_${'1'.repeat(32)}`;
const TX_HASH = `0x${'ab'.repeat(32)}` as const;
const SETTLED_AT = 1_900_000_000_000;

beforeEach(() => {
  h.warn.mockReset();
});

describe('hosted 購入の確定後の再送の窓', () => {
  it('自社商品・agent 注文の再配信 record と同じ定数 (30 分) を使う', () => {
    expect(HOSTED_REDELIVERY_WINDOW_MS).toBe(PAYMENT_REDELIVERY_TTL_SEC * 1_000);
    expect(HOSTED_REDELIVERY_WINDOW_MS).toBe(30 * 60 * 1_000);
  });

  it('settledAt から窓の内側だけ開く (ちょうど 30 分で閉じる)', () => {
    expect(hostedRedeliveryOpen(SETTLED_AT, SETTLED_AT)).toBe(true);
    expect(hostedRedeliveryOpen(SETTLED_AT, SETTLED_AT + HOSTED_REDELIVERY_WINDOW_MS - 1)).toBe(true);
    expect(hostedRedeliveryOpen(SETTLED_AT, SETTLED_AT + HOSTED_REDELIVERY_WINDOW_MS)).toBe(false);
    // server 間の時計のずれで settledAt が少し未来でも、買い手の再試行は止めない。
    expect(hostedRedeliveryOpen(SETTLED_AT, SETTLED_AT - 1_000)).toBe(true);
  });

  it('409 は本文を含まず、機械向けの code と人向けの文言 (en/ja) を返し、warn を 1 回出す', async () => {
    const response = hostedRedeliveryExpiredResponse({
      rail: 'usdc',
      resourceId: RESOURCE_ID,
      chainId: 8453,
      txHash: TX_HASH,
      settledAt: SETTLED_AT,
      now: SETTLED_AT + 31 * 60_000 + 500,
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
      message: 'This purchase is already settled. Resending the payment header returns the content only within 30 minutes of settlement. Do not pay again: sign in with the paying wallet (SIWE) and open it from your library (/store/library).',
      messageJa: 'この購入は確定済みです。支払いの署名ヘッダーを再送して中身を受け取れるのは、確定から 30 分以内だけです。もう一度支払わずに、支払ったウォレットでサインインして、ライブラリ（/store/library）から開いてください。',
    });
    expect(body).not.toHaveProperty('value');
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledWith('x402.hosted.redelivery_expired', {
      rail: 'usdc', resourceId: RESOURCE_ID, ageSec: 31 * 60,
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
      now: SETTLED_AT + HOSTED_REDELIVERY_WINDOW_MS,
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false, error: HOSTED_REDELIVERY_EXPIRED_ERROR, network: 'eip155:137', txHash: TX_HASH,
    });
    expect(h.warn).toHaveBeenCalledTimes(1);
  });
});
