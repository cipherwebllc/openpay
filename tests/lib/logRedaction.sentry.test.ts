// 本物の Sentry の browser SDK に、instrumentation-client.ts の実際の設定 (beforeSend・beforeBreadcrumb) を渡し、
// 本物の logger と本物の viem の error で、送信される envelope の中身を見る (第 10 回レビュー PR-40)。
// SDK が error をどの欄へ写すか (exception・cause の連鎖・extra の normalize・console の breadcrumb) を手で
// 組み立てずに確かめるためのテスト。差し替えるのは送信 (transport) だけ。
import type { Envelope } from '@sentry/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sent = vi.hoisted(() => ({ envelopes: [] as unknown[] }));

// Next の server entry ではなく実 browser SDK を使う (tests/lib/sentryReplay.test.ts と同じ)。
vi.mock('@sentry/nextjs', async () => {
  const sdk = await import('@sentry/browser');
  return {
    ...sdk,
    captureRouterTransitionStart: () => undefined,
    init: (options: Parameters<typeof sdk.init>[0]) =>
      sdk.init({
        ...options,
        transport: () => ({
          send: async (envelope: Envelope) => {
            sent.envelopes.push(envelope);
            return { statusCode: 200 };
          },
          flush: async () => true,
        }),
      }),
  };
});
vi.mock('@/lib/sentryReplayLazy', () => ({ installSentryReplay: vi.fn() }));

import * as Sentry from '@sentry/nextjs';
import { logger } from '@/lib/logger';
import { redactLogText } from '@/lib/telemetryRedaction';
import {
  API_KEY,
  BUNDLER_ORIGIN,
  RPC_DETAILS,
  USER_OP_HASH,
  VIEM_ERROR_CASES,
  leakedMarkers,
  rpcRequestError,
  userOperationExecutionError,
} from '../helpers/viemRequestErrors';

type SentFrame = { function?: string; filename?: string; lineno?: number };
type SentEvent = {
  type?: string;
  message?: string;
  level?: string;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  exception?: { values: Array<{ type: string; value: string; stacktrace?: { frames: SentFrame[] } }> };
  breadcrumbs?: Array<{ category?: string; message?: string; data?: Record<string, unknown> }>;
};

// Sentry の browser の stack parser は、stack の先頭に入った message の `URL: <url>` の行を frame として読む。
function urlLineFrames(event: SentEvent): SentFrame[] {
  return event.exception!.values.flatMap((value) =>
    (value.stacktrace?.frames ?? []).filter((frame) => frame.function === 'URL: '),
  );
}

function sentEvents(): SentEvent[] {
  return (sent.envelopes as Envelope[]).flatMap((envelope) =>
    envelope[1]
      .filter(([header]) => header.type === 'event')
      .map(([, payload]) => payload as SentEvent),
  );
}

describe('本物の Sentry SDK を通した送信 (instrumentation-client.ts の設定)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://public@o0.ingest.sentry.io/1');
    vi.stubEnv('NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE', '0');
    vi.stubEnv('NEXT_PUBLIC_SENTRY_REPLAY_ERROR_SAMPLE_RATE', '0');
    // console を黙らせる spy は、SDK が console を包む前に置く (SDK の breadcrumb は包んだ側で取れる)。
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await import('@/instrumentation-client');
    expect(Sentry.getClient()).toBeDefined();
  });

  beforeEach(() => {
    sent.envelopes.length = 0;
    Sentry.getIsolationScope().clearBreadcrumbs();
    Sentry.getCurrentScope().clearBreadcrumbs();
  });

  afterAll(async () => {
    await Sentry.close();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  describe.each(VIEM_ERROR_CASES)('%s', (_name, make) => {
    it('logger.error({ error }) → exception の event に key・署名・本文が無い (type・frame・tag・hash は残る)', async () => {
      const error = make();
      logger.error('circle.post_submit.unexpected', { error, userOpHash: USER_OP_HASH });
      await Sentry.flush(2000);

      expect(leakedMarkers(sent.envelopes)).toEqual([]);
      const events = sentEvents();
      expect(events).toHaveLength(1);
      const [event] = events;
      expect(event.tags?.event).toBe('circle.post_submit.unexpected');
      expect(event.level).toBe('error');
      expect(event.extra?.userOpHash).toBe(USER_OP_HASH);
      const top = event.exception!.values.at(-1)!;
      expect(top.type).toBe(error.name);
      expect(top.value).toBe(redactLogText(error.message));
      expect(top.value).toContain(`URL: ${BUNDLER_ORIGIN}\n`);
      expect(top.stacktrace?.frames.length).toBeGreaterThan(0);
      // message の `URL:` の行から読まれた frame は origin だけ (key つきの URL が filename に入らない)。
      expect(urlLineFrames(event).length).toBeGreaterThan(0);
      expect(urlLineFrames(event).every((frame) => frame.filename === BUNDLER_ORIGIN)).toBe(true);
      // logger が console.error に出した JSON は、この event の console の breadcrumb にも入る。
      const consoleCrumb = event.breadcrumbs?.find((crumb) => crumb.category === 'console');
      expect(consoleCrumb?.message).toContain(`{"error":{"name":"${error.name}"`);
      expect(consoleCrumb?.message).toContain('Request body: [redacted]');
    });

    it('logger.warn({ error: error.message }) と入れ子 → message の event の extra に無い', async () => {
      const error = make();
      logger.warn('pimlico.send.response-unknown', { error: error.message, userOpHash: USER_OP_HASH });
      logger.error('circle.wait.failed', { ctx: { cause: error }, userOpHash: USER_OP_HASH });
      await Sentry.flush(2000);

      expect(leakedMarkers(sent.envelopes)).toEqual([]);
      const events = sentEvents();
      expect(events.map((event) => event.message)).toEqual(['pimlico.send.response-unknown', 'circle.wait.failed']);
      expect(events.map((event) => event.tags?.event)).toEqual(['pimlico.send.response-unknown', 'circle.wait.failed']);
      expect(events[0].level).toBe('warning');
      expect(events[0].extra).toEqual({ error: redactLogText(error.message), userOpHash: USER_OP_HASH });
      expect(events[1].extra).toMatchObject({
        userOpHash: USER_OP_HASH,
        ctx: { cause: { name: error.name, message: redactLogText(error.message) } },
      });
    });
  });

  it('cause の連鎖は別の exception として送られ、どちらの文も伏せてある', async () => {
    const error = userOperationExecutionError();
    logger.error('circle.post_submit.unexpected', { error });
    await Sentry.flush(2000);

    expect(leakedMarkers(sent.envelopes)).toEqual([]);
    const values = sentEvents()[0].exception!.values;
    expect(values.map((value) => value.type)).toEqual(['RpcRequestError', 'UserOperationExecutionError']);
    expect(values[0].value).toBe(redactLogText(error.cause.message));
    expect(values[0].value).toContain(`Details: ${RPC_DETAILS}`);
  });

  // Codex 指摘 7: logger は元の Error を渡す (伏せた写しを作ると AggregateError の子が落ちていた)。exception.values の
  // 1 つずつ (cause の連なり・AggregateError の子) を beforeSend が伏せる。
  it('AggregateError の子と cause の連なりは、落ちずに別の exception として送られ、どれも伏せてある', async () => {
    const child = userOperationExecutionError();
    const error = new AggregateError(
      [child, new Error('AA21 prefund')],
      `batch send failed: ${rpcRequestError().message}`,
      { cause: rpcRequestError(`HTTPS://api.example/v2/${API_KEY}`) },
    );
    logger.error('circle.post_submit.unexpected', { error });
    await Sentry.flush(2000);

    expect(leakedMarkers(sent.envelopes)).toEqual([]);
    expect(JSON.stringify(sent.envelopes)).not.toContain(API_KEY);
    const [event] = sentEvents();
    const values = event.exception!.values;
    // 子 2 つ (UserOperationExecutionError とその cause・AA21) と、cause の RpcRequestError と、最上位の AggregateError。
    expect(values.map((value) => value.type).sort()).toEqual(
      ['AggregateError', 'Error', 'RpcRequestError', 'RpcRequestError', 'UserOperationExecutionError'].sort(),
    );
    expect(values.find((value) => value.type === 'Error')?.value).toBe('AA21 prefund');
    expect(values.find((value) => value.type === 'UserOperationExecutionError')?.value).toBe(redactLogText(child.message));
    expect(values.at(-1)!.type).toBe('AggregateError');
    expect(values.at(-1)!.value).toBe(`batch send failed: ${redactLogText(rpcRequestError().message)}`);
    for (const value of values.filter((item) => item.type === 'RpcRequestError')) {
      expect(value.value).toContain(`URL: ${BUNDLER_ORIGIN}\n`);
      expect(value.value).toContain(`Details: ${RPC_DETAILS}`);
    }
    expect(urlLineFrames(event).length).toBeGreaterThan(0);
    expect(urlLineFrames(event).every((frame) => frame.filename === BUNDLER_ORIGIN)).toBe(true);
    // Sentry の「送信済み」の印は元の Error に付く (main と同じ)。同じ Error を後でもう一度 capture しても送らない。
    Sentry.captureException(error);
    await Sentry.flush(2000);
    expect(sentEvents()).toHaveLength(1);
  });

  it('logger を通らない error (global-error.tsx の captureException・console.error の文) も、beforeSend と beforeBreadcrumb で伏せる', async () => {
    const error = userOperationExecutionError();
    // 伏せていない文が console の breadcrumb に入る (logger を通らない console.error)。
    console.error(`[third-party] send failed: ${rpcRequestError().message}`);
    Sentry.captureException(error);
    await Sentry.flush(2000);

    expect(leakedMarkers(sent.envelopes)).toEqual([]);
    const [event] = sentEvents();
    expect(event.exception!.values.map((value) => value.type)).toEqual(['RpcRequestError', 'UserOperationExecutionError']);
    expect(event.exception!.values.at(-1)!.value).toBe(redactLogText(error.message));
    // 伏せていない stack から読まれた `URL:` の行の frame も、logger が渡す写しと同じ形 (origin だけ) になる。
    expect(urlLineFrames(event)).toHaveLength(2);
    expect(urlLineFrames(event)).toEqual([
      { function: 'URL: ', filename: BUNDLER_ORIGIN, in_app: true },
      { function: 'URL: ', filename: BUNDLER_ORIGIN, in_app: true },
    ]);
    const consoleCrumb = event.breadcrumbs?.find((crumb) => crumb.category === 'console');
    expect(consoleCrumb?.message).toContain('[third-party] send failed: RPC Request failed.');
    expect(consoleCrumb?.message).toContain(`URL: ${BUNDLER_ORIGIN}\n`);
    expect(consoleCrumb?.message).toContain(`Details: ${RPC_DETAILS}`);
    expect(JSON.stringify(consoleCrumb)).not.toContain(API_KEY);
  });
});
