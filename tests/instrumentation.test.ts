import type { Event, TransactionEvent } from '@sentry/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  captureRequestError: vi.fn(),
  httpIntegration: vi.fn((options: unknown) => ({ name: 'Http', options })),
}));

vi.mock('@sentry/nextjs', () => sentry);

type PrivacyOptions = {
  dataCollection: { urlQueryParams: boolean };
  beforeSend: (event: Event) => Event;
  beforeSendTransaction: (event: TransactionEvent) => TransactionEvent;
};

describe('server instrumentation telemetry hooks', () => {
  beforeEach(() => {
    vi.resetModules();
    sentry.init.mockClear();
    vi.stubEnv(
      'NEXT_PUBLIC_SENTRY_DSN',
      'https://test_sentry@o12345.ingest.us.sentry.io/67890',
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['nodejs', 'edge'])(
    '%s runtime は query 収集を無効化し error/transaction scrubber を設定する',
    async (runtime) => {
      vi.stubEnv('NEXT_RUNTIME', runtime);
      const { register } = await import('@/instrumentation');

      await register();

      expect(sentry.init).toHaveBeenCalledOnce();
      const options = sentry.init.mock.calls[0][0] as PrivacyOptions;
      expect(options.dataCollection).toEqual({ urlQueryParams: false });
      expect(options.beforeSend).toBeTypeOf('function');
      expect(options.beforeSendTransaction).toBeTypeOf('function');
    },
  );

  // 2026-11-24: ブラウザでない自動の接続元が送る壊れた router state header で、Next.js が要求を断るたびに Sentry の
  // error になっていた。この文言だけを両方の runtime で送らない (一覧は lib/sentryServerIgnoreErrors.ts)。
  it.each(['nodejs', 'edge'])('%s runtime は壊れた router state header の error を Sentry に送らない', async (runtime) => {
    vi.stubEnv('NEXT_RUNTIME', runtime);
    const { register } = await import('@/instrumentation');
    const { SENTRY_SERVER_IGNORE_ERRORS } = await import('@/lib/sentryServerIgnoreErrors');

    await register();

    const options = sentry.init.mock.calls[0][0] as { ignoreErrors: RegExp[] };
    expect(options.ignoreErrors).toEqual([...SENTRY_SERVER_IGNORE_ERRORS]);
    expect(options.ignoreErrors.some((p) => p.test('The router state header was sent but could not be parsed.'))).toBe(true);
  });

  it('nodejs runtime は受けた request の本文を採らない (httpIntegration の maxIncomingRequestBodySize: none)', async () => {
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://public@example.ingest.sentry.io/1');
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    const { register } = await import('@/instrumentation');
    await register();
    const options = sentry.init.mock.calls[0][0] as { integrations: unknown[] };
    // @sentry/nextjs の既定の Http の設定 (disableIncomingRequestSpans: true) を保ったまま、本文を採らない。
    const expected = { disableIncomingRequestSpans: true, maxIncomingRequestBodySize: 'none' };
    expect(sentry.httpIntegration).toHaveBeenCalledWith(expected);
    expect(options.integrations).toEqual([{ name: 'Http', options: expected }]);
  });

  // 手元の dev / next start (VERCEL なし) の event は local-<network> にして mainnet の通知に混ぜない。
  it.each([
    ['nodejs', '1', 'mainnet'],
    ['nodejs', undefined, 'local-mainnet'],
    // edge は VERCEL の有無を確かめていないので変えない (本番を local と誤って付けないため)。
    ['edge', undefined, 'mainnet'],
    ['edge', '1', 'mainnet'],
  ])('%s runtime・VERCEL=%s の environment は %s', async (runtime, vercel, expected) => {
    vi.stubEnv('NEXT_RUNTIME', runtime);
    vi.stubEnv('NEXT_PUBLIC_NETWORK_ENV', 'mainnet');
    vi.stubEnv('VERCEL', vercel);
    const { register } = await import('@/instrumentation');

    await register();

    expect((sentry.init.mock.calls[0][0] as { environment: string }).environment).toBe(expected);
  });
});
