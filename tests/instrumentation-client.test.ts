import { beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  replayIntegration: vi.fn(() => ({ name: 'Replay' })),
  captureRouterTransitionStart: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => sentry);

describe('instrumentation-client telemetry hooks', () => {
  beforeEach(() => {
    vi.resetModules();
    sentry.init.mockClear();
    sentry.replayIntegration.mockClear();
  });

  it('ignoreErrors が non-Error 拒否の両文言 (value 形式 / DOM Event 形式) を落とす', async () => {
    await import('@/instrumentation-client');
    const options = sentry.init.mock.calls[0][0] as {
      ignoreErrors: RegExp[];
    };
    const matches = (msg: string) =>
      options.ignoreErrors.some((re) => re.test(msg));
    // 既存: 値付きの non-Error 拒否
    expect(
      matches('Non-Error promise rejection captured with value: undefined'),
    ).toBe(true);
    // 2026-08-18 実観測の兄弟パターン: DOM Event が拒否理由のときの別文言
    expect(
      matches('Event `Event` (type=error) captured as promise rejection'),
    ).toBe(true);
    // 実シグナル (自前 Error) は落とさない
    expect(matches('Error: relay settle failed')).toBe(false);
  });

  it('beforeBreadcrumb / beforeSendTransaction に URL scrubber を設定する', async () => {
    await import('@/instrumentation-client');

    expect(sentry.init).toHaveBeenCalledOnce();
    const options = sentry.init.mock.calls[0][0] as {
      beforeBreadcrumb: (breadcrumb: {
        category: string;
        data: Record<string, unknown>;
      }) => unknown;
      beforeSendTransaction: (event: {
        type: 'transaction';
        spans: Array<{
          data: Record<string, unknown>;
          span_id: string;
          trace_id: string;
          start_timestamp: number;
        }>;
      }) => unknown;
    };
    const secret = 'Bearer-instrumentation-secret';
    const url = `https://user:${secret}@hooks.example.com/hook/${secret}?token=${secret}`;

    const breadcrumb = options.beforeBreadcrumb({
      category: 'fetch',
      data: { url },
    });
    const transaction = options.beforeSendTransaction({
      type: 'transaction',
      spans: [
        {
          data: { 'http.url': url },
          span_id: '1'.repeat(16),
          trace_id: '2'.repeat(32),
          start_timestamp: 1,
        },
      ],
    });

    expect(JSON.stringify(breadcrumb)).not.toContain(secret);
    expect(JSON.stringify(transaction)).not.toContain(secret);
    expect(JSON.stringify(breadcrumb)).toContain('https://hooks.example.com');
    expect(JSON.stringify(transaction)).toContain('https://hooks.example.com');
  });
});
