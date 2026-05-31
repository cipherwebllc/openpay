import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Address, Hex } from 'viem';

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { logger } from '@/lib/logger';
import {
  buildPaymentLogEvent,
  logPaymentEvent,
  PAYMENT_LOG_FAILURE_EVENT,
  type PaymentLogContext,
} from '@/lib/paymentLog';

const MERCHANT = '0x1111111111111111111111111111111111111111' as Address;
const TOKEN = '0x2222222222222222222222222222222222222222' as Address;
const CUSTOMER = '0x3333333333333333333333333333333333333333' as Address;
const FEE_RECV = '0x4444444444444444444444444444444444444444' as Address;
const USEROP = `0x${'a'.repeat(64)}` as Hex;
const TX = `0x${'b'.repeat(64)}` as Hex;

function batchCtx(): PaymentLogContext {
  return {
    flow: 'batch',
    chainId: 137,
    tokenAddress: TOKEN,
    merchant: MERCHANT,
    merchantAmount: 1000n * 10n ** 18n,
    customer: CUSTOMER,
    feeReceiver: FEE_RECV,
    feeAmount: 10n * 10n ** 18n,
  };
}

function directCtx(): PaymentLogContext {
  return {
    flow: 'direct',
    chainId: 137,
    tokenAddress: TOKEN,
    merchant: MERCHANT,
    merchantAmount: 500n,
    customer: CUSTOMER,
  };
}

describe('buildPaymentLogEvent', () => {
  it('success: bigint を 10 進文字列化、userOpHash / txHash / blockNumber を含む', () => {
    const event = buildPaymentLogEvent(batchCtx(), {
      result: 'success',
      userOpHash: USEROP,
      txHash: TX,
      blockNumber: 12345n,
    });
    expect(event).toEqual({
      flow: 'batch',
      result: 'success',
      chainId: 137,
      tokenAddress: TOKEN,
      merchant: MERCHANT,
      merchantAmount: '1000000000000000000000',
      customer: CUSTOMER,
      feeReceiver: FEE_RECV,
      feeAmount: '10000000000000000000',
      // v3: 分離記録の印 (LOG_FEE_BREAKDOWN_VERSION)。saleAmount / networkFeeEquivalent は
      // ctx 未指定なので undefined (toEqual は undefined プロパティを無視)。
      feeBreakdownVersion: 1,
      userOpHash: USEROP,
      txHash: TX,
      blockNumber: '12345',
    });
    // errorMessage は付かない
    expect(event.errorMessage).toBeUndefined();
  });

  it('reverted も success と同じ shape (userOpHash 等を含む) で出る', () => {
    const event = buildPaymentLogEvent(batchCtx(), {
      result: 'reverted',
      userOpHash: USEROP,
      txHash: TX,
      blockNumber: 1n,
    });
    expect(event.result).toBe('reverted');
    expect(event.userOpHash).toBe(USEROP);
    expect(event.errorMessage).toBeUndefined();
  });

  it('error: errorMessage 500 文字 cap、userOpHash/blockNumber は含まない', () => {
    const longMsg = 'x'.repeat(1000);
    const event = buildPaymentLogEvent(batchCtx(), {
      result: 'error',
      errorMessage: longMsg,
    });
    expect(event.result).toBe('error');
    expect(event.errorMessage).toHaveLength(500);
    expect(event.userOpHash).toBeUndefined();
    expect(event.blockNumber).toBeUndefined();
    // ctx の必須 field は維持
    expect(event.merchant).toBe(MERCHANT);
    expect(event.feeAmount).toBe('10000000000000000000');
  });

  it('error: txHash があれば保持 (途中で失敗したケース)', () => {
    const event = buildPaymentLogEvent(directCtx(), {
      result: 'error',
      errorMessage: 'receipt error',
      txHash: TX,
    });
    expect(event.txHash).toBe(TX);
    expect(event.flow).toBe('direct');
  });

  it('direct flow (feeReceiver / feeAmount なし): undefined を保持', () => {
    const event = buildPaymentLogEvent(directCtx(), {
      result: 'success',
      txHash: TX,
      blockNumber: 100n,
    });
    expect(event.feeReceiver).toBeUndefined();
    expect(event.feeAmount).toBeUndefined();
    expect(event.userOpHash).toBeUndefined();
    expect(event.txHash).toBe(TX);
  });

  it('customer 欠落でも構築できる (wallet 未接続時の error log 用途)', () => {
    const ctx = { ...directCtx(), customer: undefined };
    const event = buildPaymentLogEvent(ctx, {
      result: 'error',
      errorMessage: 'user rejected',
    });
    expect(event.customer).toBeUndefined();
    expect(event.errorMessage).toBe('user rejected');
  });

  it('errorMessage が 500 文字未満ならそのまま保持', () => {
    const event = buildPaymentLogEvent(batchCtx(), {
      result: 'error',
      errorMessage: 'short',
    });
    expect(event.errorMessage).toBe('short');
  });

  it('blockNumber=0n も "0" として serialize される', () => {
    const event = buildPaymentLogEvent(directCtx(), {
      result: 'success',
      txHash: TX,
      blockNumber: 0n,
    });
    expect(event.blockNumber).toBe('0');
  });

  it('merchantAmount = uint256 上限値も精度欠落なく文字列化', () => {
    const max = 2n ** 256n - 1n;
    const ctx = { ...batchCtx(), merchantAmount: max };
    const event = buildPaymentLogEvent(ctx, {
      result: 'success',
      userOpHash: USEROP,
      txHash: TX,
      blockNumber: 1n,
    });
    expect(event.merchantAmount).toBe(max.toString());
    expect(BigInt(event.merchantAmount)).toBe(max);
  });
});

describe('logPaymentEvent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POST /api/log/payment へ JSON body + keepalive で送信', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await logPaymentEvent({
      flow: 'batch',
      result: 'success',
      chainId: 137,
      tokenAddress: TOKEN,
      merchant: MERCHANT,
      merchantAmount: '100',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/log/payment');
    expect(init.method).toBe('POST');
    expect(init.keepalive).toBe(true);
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toMatchObject({ flow: 'batch', result: 'success' });
  });

  it('fetch が throw しても silently 完了 (UI 阻害なし)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Failed to fetch')),
    );
    // throw しないことを確認
    await expect(
      logPaymentEvent({
        flow: 'batch',
        result: 'error',
        chainId: 137,
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: '100',
      }),
    ).resolves.toBeUndefined();
  });

  it('fetch が非 2xx を返しても resolves (server route が graceful degrade 済)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 500 })),
    );
    await expect(
      logPaymentEvent({
        flow: 'direct',
        result: 'success',
        chainId: 137,
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: '100',
      }),
    ).resolves.toBeUndefined();
  });

  it('fetch が throw した場合 Sentry 連携の logger.warn を呼ぶ (production 観測)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Failed to fetch')),
    );
    await logPaymentEvent({
      flow: 'batch',
      result: 'error',
      chainId: 137,
      tokenAddress: TOKEN,
      merchant: MERCHANT,
      merchantAmount: '100',
      txHash: TX,
      errorMessage: 'user rejected',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'payment-log.client-post-failed',
      expect.objectContaining({
        flow: 'batch',
        result: 'error',
        chainId: 137,
        txHash: TX,
        error: 'Failed to fetch',
      }),
    );
  });

  it('fetch が throw した場合 window CustomEvent を dispatch (DevTools observability)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Failed to fetch')),
    );
    const listener = vi.fn();
    window.addEventListener(PAYMENT_LOG_FAILURE_EVENT, listener);
    try {
      const event = {
        flow: 'batch' as const,
        result: 'error' as const,
        chainId: 137,
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: '100',
        errorMessage: 'reverted by user',
      };
      await logPaymentEvent(event);
      expect(listener).toHaveBeenCalledOnce();
      const detail = listener.mock.calls[0][0].detail;
      expect(detail.error).toBe('Failed to fetch');
      expect(detail.event.errorMessage).toBe('reverted by user');
      expect(detail.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      window.removeEventListener(PAYMENT_LOG_FAILURE_EVENT, listener);
    }
  });

  it('fetch が非 2xx を返した場合も CustomEvent を dispatch (http_<status>)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 502 })),
    );
    const listener = vi.fn();
    window.addEventListener(PAYMENT_LOG_FAILURE_EVENT, listener);
    try {
      await logPaymentEvent({
        flow: 'direct',
        result: 'success',
        chainId: 137,
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: '100',
      });
      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.calls[0][0].detail.error).toBe('http_502');
    } finally {
      window.removeEventListener(PAYMENT_LOG_FAILURE_EVENT, listener);
    }
  });

  it('fetch 成功時 (2xx) は failure event を dispatch しない', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
    );
    const listener = vi.fn();
    window.addEventListener(PAYMENT_LOG_FAILURE_EVENT, listener);
    try {
      await logPaymentEvent({
        flow: 'batch',
        result: 'success',
        chainId: 137,
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: '100',
      });
      expect(listener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(PAYMENT_LOG_FAILURE_EVENT, listener);
    }
  });
});
