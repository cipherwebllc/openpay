import type { Event, TransactionEvent } from '@sentry/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  captureRequestError: vi.fn(),
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
});
