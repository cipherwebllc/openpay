import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: h.info, warn: h.warn, error: vi.fn() },
}));

import {
  HOSTED_ALREADY_SETTLED_ERROR,
  hostedAlreadySettledResponse,
} from '@/lib/x402/hostedRedelivery';

const RESOURCE_ID = `h_${'1'.repeat(32)}`;
const TX_HASH = `0x${'ab'.repeat(32)}` as const;
const SETTLED_AT = 1_900_000_000_000;

beforeEach(() => {
  h.info.mockReset();
  h.warn.mockReset();
});

describe('確定済みの hosted 購入への再送の 409', () => {
  it('error code は purchase_already_settled', () => {
    expect(HOSTED_ALREADY_SETTLED_ERROR).toBe('purchase_already_settled');
  });

  it('本文を含まず、機械向けの code・購入の証拠・取り直し先と、人向けの文言 (en/ja) を返し、info を 1 回出す', async () => {
    const response = hostedAlreadySettledResponse({
      rail: 'usdc',
      resourceId: RESOURCE_ID,
      chainId: 8453,
      txHash: TX_HASH,
      settledAt: SETTLED_AT,
      now: SETTLED_AT + 1_500,
    });
    expect(response.status).toBe(409);
    expect(response.headers.has('PAYMENT-RESPONSE')).toBe(false);
    expect(response.headers.has('X-PAYMENT-RESPONSE')).toBe(false);
    const body = await response.json();
    expect(body).toEqual({
      ok: false,
      error: HOSTED_ALREADY_SETTLED_ERROR,
      state: 'settled',
      resourceId: RESOURCE_ID,
      txHash: TX_HASH,
      network: 'eip155:8453',
      library: '/store/library',
      contentApi: `/api/store/content/${RESOURCE_ID}`,
      message: 'This purchase is already settled. Do not pay again: sign in with the paying wallet (SIWE) and open it from your library (/store/library).',
      messageJa: 'この購入は確定済みです。もう一度支払わずに、支払ったウォレットでサインインしてライブラリ（/store/library）から開いてください。',
    });
    expect(body).not.toHaveProperty('value');
    // 窓 0 では正規の再試行もここを通るので、Sentry に送る warn は出さない。
    expect(h.warn).not.toHaveBeenCalled();
    expect(h.info).toHaveBeenCalledTimes(1);
    expect(h.info).toHaveBeenCalledWith('x402.hosted.redelivery_refused', {
      rail: 'usdc', resourceId: RESOURCE_ID, ageSec: 1,
    });
  });

  it('contentApi の resourceId は URL の path として符号化する', async () => {
    const response = hostedAlreadySettledResponse({
      rail: 'jpyc',
      resourceId: 'h_a/b?c',
      chainId: 137,
      txHash: TX_HASH,
      settledAt: SETTLED_AT,
      now: SETTLED_AT,
    });
    await expect(response.json()).resolves.toMatchObject({
      resourceId: 'h_a/b?c',
      network: 'eip155:137',
      contentApi: '/api/store/content/h_a%2Fb%3Fc',
    });
  });

  // hooks/useHostedStorePurchase (PR-0) は error code の名前ではなく、この形で確定として扱う。
  it.each([
    ['jpyc', 137],
    ['jpyc', 80002],
    ['usdc', 8453],
  ] as const)('契約: %s (chain %i) の 409 はブラウザが確定として扱う形 (409・state settled・正規の txHash・resourceId 一致)', async (rail, chainId) => {
    const response = hostedAlreadySettledResponse({
      rail,
      resourceId: RESOURCE_ID,
      chainId,
      txHash: TX_HASH,
      settledAt: SETTLED_AT,
      now: SETTLED_AT + 1_000,
    });
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(409);
    expect(body.state).toBe('settled');
    expect(body.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(body.resourceId).toBe(RESOURCE_ID);
  });
});
