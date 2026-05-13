// paymentLog → lib/logger → @sentry/nextjs の 1 経路を mock 切り換えで実走させる
// integration test。paymentLog.test.ts は @/lib/logger を完全 mock しているため、
// lib/logger.ts → Sentry.captureMessage の橋渡しが paymentLog 経由で生きていることを
// 直接 verify できていない。本 file は @/lib/logger を mock せず @sentry/nextjs のみ
// mock することで、renaming / API 変更があった際に silent 壊れを検知する。

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Address, Hex } from 'viem';

const capturedMessages: Array<{ msg: string; opts: unknown }> = [];

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn((msg: string, opts: unknown) => {
    capturedMessages.push({ msg, opts });
  }),
}));

// @/lib/logger は **mock しない** — 実コードを通す。
// 結果として paymentLog → logger.warn → Sentry.captureMessage の 1 経路が走る。
import { logPaymentEvent } from '@/lib/paymentLog';

const TOKEN = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29' as Address;
const MERCHANT = '0x1111111111111111111111111111111111111111' as Address;
const TX = `0x${'b'.repeat(64)}` as Hex;

afterEach(() => {
  capturedMessages.length = 0;
  vi.restoreAllMocks();
});

describe('paymentLog → Sentry integration (実 logger.ts 経由)', () => {
  it('fetch reject 時、Sentry.captureMessage に payment-log.client-post-failed が届く', async () => {
    // log level filter を warn 以上に。NEXT_PUBLIC_LOG_LEVEL 未設定なら既定 warn。
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

    expect(capturedMessages).toHaveLength(1);
    const [{ msg, opts }] = capturedMessages;
    expect(msg).toBe('payment-log.client-post-failed');
    const o = opts as { level: string; extra: Record<string, unknown> };
    expect(o.level).toBe('warning');
    // extra fields は paymentLog が構築した body
    expect(o.extra).toMatchObject({
      flow: 'batch',
      result: 'error',
      chainId: 137,
      txHash: TX,
      error: 'Failed to fetch',
    });
  });

  it('fetch 非 2xx 時も同じ event 名で Sentry capture (http_<status>)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    );
    await logPaymentEvent({
      flow: 'direct',
      result: 'success',
      chainId: 137,
      tokenAddress: TOKEN,
      merchant: MERCHANT,
      merchantAmount: '500',
      txHash: TX,
    });

    expect(capturedMessages).toHaveLength(1);
    const [{ opts }] = capturedMessages;
    const o = opts as { extra: { error: string } };
    expect(o.extra.error).toBe('http_503');
  });

  it('fetch 成功時 (2xx) は Sentry に 1 件も届かない', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
    );
    await logPaymentEvent({
      flow: 'batch',
      result: 'success',
      chainId: 137,
      tokenAddress: TOKEN,
      merchant: MERCHANT,
      merchantAmount: '100',
    });
    expect(capturedMessages).toHaveLength(0);
  });
});
