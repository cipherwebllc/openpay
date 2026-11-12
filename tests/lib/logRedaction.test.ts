// viem の error の文 (key つきの URL・署名済みの UserOperation の本文) を、log の出口で伏せる (第 10 回レビュー PR-40)。
// 出口 = logger の console・logger が Sentry へ渡す引数・Sentry の beforeSend / beforeBreadcrumb・決済の監査 log・Replay の録画。
// error は node_modules/viem の class を実際に new して作る (tests/helpers/viemRequestErrors.ts)。
// 本物の Sentry の SDK を通した送信の中身は tests/lib/logRedaction.sentry.test.ts が見る。
import type { Event } from '@sentry/core';
import type { Breadcrumb, ReplayFrameEvent } from '@sentry/nextjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  captureRequestError: vi.fn(),
  captureRouterTransitionStart: vi.fn(),
}));
vi.mock('@sentry/nextjs', () => sentry);
vi.mock('@/lib/sentryReplayLazy', () => ({ installSentryReplay: vi.fn() }));

import { logger } from '@/lib/logger';
import { buildPaymentLogEvent, logPaymentEvent, type PaymentLogContext } from '@/lib/paymentLog';
import { scrubReplayRecordingEvent } from '@/lib/sentryReplay';
import { redactLogData, redactLogText } from '@/lib/telemetryRedaction';
import {
  API_KEY,
  BUNDLER_ORIGIN,
  BUNDLER_URL,
  CALL_DATA,
  RPC_DETAILS,
  SENDER,
  SHORT_FACTORY_DATA,
  SIGNATURE,
  USER_OP_HASH,
  VIEM_ERROR_CASES,
  collectStrings,
  leakedMarkers,
  rpcRequestError,
  userOperationExecutionError,
} from '../helpers/viemRequestErrors';

const EVENT = 'circle.broadcast.response-lost';

function frames(stack: string | undefined): string[] {
  return (stack ?? '').split('\n').filter((line) => line.startsWith('    at '));
}

describe('redactLogText (伏せる関数)', () => {
  it.each(VIEM_ERROR_CASES)('%s の message と stack から key つきの URL と本文を伏せ、ほかの行は残す', (_name, make) => {
    const error = make();
    // 前提: 伏せる前の文には、key と署名と callData と短い欄が実際に入っている。
    expect(leakedMarkers(error.message)).toEqual(expect.arrayContaining([API_KEY, '/v2/1/rpc', '5a5a5a5a5a5a5a5a', 'f00df00df00df00d']));
    expect(error.stack).toContain(SIGNATURE);

    const message = redactLogText(error.message);
    expect(leakedMarkers(message)).toEqual([]);
    expect(message).toContain(`URL: ${BUNDLER_ORIGIN}\n`);
    expect(message).toContain('Request body: [redacted]\n');
    // Request body の行の後ろ (Details・Version) は残る。
    expect(message).toContain('\nDetails: ');
    expect(message).toMatch(/\nVersion: viem@\d/);

    const stack = redactLogText(error.stack ?? '');
    expect(leakedMarkers(stack)).toEqual([]);
    expect(frames(stack)).toEqual(frames(error.stack));
    expect(frames(stack).length).toBeGreaterThan(0);
  });

  it('RpcRequestError の文は、URL の origin と Request body の伏せ字と Details だけになる', () => {
    const error = rpcRequestError();
    expect(redactLogText(error.message)).toBe(
      `RPC Request failed.\n\nURL: ${BUNDLER_ORIGIN}\nRequest body: [redacted]\n\nDetails: ${RPC_DETAILS}\nVersion: viem@${error.version}`,
    );
  });

  it('Request body の行の外に並ぶ長い 16 進 (Request Arguments の callData・paymasterData・signature) を伏せ、アドレスは残す', () => {
    const message = redactLogText(userOperationExecutionError().message);
    expect(message).toMatch(/\n {2}callData: +\[redacted\]\n/);
    expect(message).toMatch(/\n {2}paymasterData: +\[redacted\]\n/);
    expect(message).toMatch(/\n {2}signature: +\[redacted\]\n/);
    expect(message).toContain(`sender:         ${SENDER}`);
  });

  it('16 進は 129 桁から伏せる (128 桁まで・64 桁の hash・40 桁のアドレスは残す・0x の有無を問わない)', () => {
    const hex128 = 'ab'.repeat(64);
    const hex129 = `${hex128}c`;
    expect(redactLogText(`sig 0x${hex128} end`)).toBe(`sig 0x${hex128} end`);
    expect(redactLogText(`sig 0x${hex129} end`)).toBe('sig [redacted] end');
    expect(redactLogText(`sig ${hex129} end`)).toBe('sig [redacted] end');
    expect(redactLogText(`sig ${hex129.toUpperCase()} end`)).toBe('sig [redacted] end');
    expect(redactLogText(SIGNATURE)).toBe('[redacted]');
    const kept = `userOpHash ${USER_OP_HASH} tx 0x${'b'.repeat(64)} sender ${SENDER} amount 700000000000000000000 chainId 137`;
    expect(redactLogText(kept)).toBe(kept);
  });

  it('Request body は行末まで (改行が無ければ文末まで) を伏せる', () => {
    expect(redactLogText(`a\nRequest body: {"x":"${SHORT_FACTORY_DATA}"}\nb`)).toBe('a\nRequest body: [redacted]\nb');
    expect(redactLogText(`a Request body: {"x":"${SHORT_FACTORY_DATA}"} tail`)).toBe('a Request body: [redacted]');
    expect(redactLogText('Request body:{"x":1}')).toBe('Request body: [redacted]');
  });

  it('URL: は origin だけにし (userinfo・path・query・fragment を落とす)、URL: の付かない URL には触れない', () => {
    expect(redactLogText(`URL: https://user:pass@rpc.example:8443/v2/${API_KEY}?k=${API_KEY}#${API_KEY}\nnext`))
      .toBe('URL: https://rpc.example:8443\nnext');
    expect(redactLogText('URL: http://127.0.0.1:8545/path')).toBe('URL: http://127.0.0.1:8545');
    const plain = 'see https://docs.example/guide?x=1 for details';
    expect(redactLogText(plain)).toBe(plain);
  });

  it.each(VIEM_ERROR_CASES)('%s: 2 回通しても、JSON にした後でもう一度通しても、同じ結果のまま (後ろの文を消さない)', (_name, make) => {
    const once = redactLogText(make().message);
    expect(redactLogText(once)).toBe(once);
    // console の breadcrumb には logger の JSON (改行が \n の 2 文字になった 1 行) が入る。
    const json = JSON.stringify({ msg: EVENT, error: once, userOpHash: USER_OP_HASH });
    expect(redactLogText(json)).toBe(json);
  });

  it('伏せていない文が JSON の 1 行になっていても、key と本文は残らない', () => {
    const json = JSON.stringify({ error: rpcRequestError().message, userOpHash: USER_OP_HASH });
    expect(leakedMarkers(redactLogText(json))).toEqual([]);
  });

  it('redactLogData は入れ子の文字列を伏せた写しを返し、元は書き換えない', () => {
    const raw = rpcRequestError().message;
    const input = { a: [raw, { b: raw, n: 1, ok: true, none: null }], hash: USER_OP_HASH };
    const output = redactLogData(input);
    expect(leakedMarkers(output)).toEqual([]);
    expect(output).toEqual({
      a: [redactLogText(raw), { b: redactLogText(raw), n: 1, ok: true, none: null }],
      hash: USER_OP_HASH,
    });
    expect(input.a[0]).toBe(raw);
    expect((input.a[1] as { b: string }).b).toBe(raw);
  });
});

describe('logger (console と Sentry へ渡す引数)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  function consoleLine(spy: ReturnType<typeof vi.spyOn>): string {
    expect(spy).toHaveBeenCalledOnce();
    return spy.mock.calls[0][0] as string;
  }

  describe.each(VIEM_ERROR_CASES)('%s', (_name, make) => {
    it('Error を欄に渡す形 ({ error }): console の message・stack と、captureException の Error・extra に残らない', () => {
      const error = make();
      const rawMessage = error.message;
      const rawStack = error.stack;
      const fields = { error, userOpHash: USER_OP_HASH, chainId: 137 };
      logger.error(EVENT, fields);

      const line = consoleLine(errorSpy);
      expect(leakedMarkers(line)).toEqual([]);
      const entry = JSON.parse(line) as { msg: string; level: string; userOpHash: string; chainId: number; error: { name: string; message: string; stack: string } };
      expect(entry).toMatchObject({ msg: EVENT, level: 'error', userOpHash: USER_OP_HASH, chainId: 137 });
      expect(entry.error.name).toBe(error.name);
      expect(entry.error.message).toBe(redactLogText(rawMessage));
      expect(entry.error.message).toContain('Request body: [redacted]');
      expect(frames(entry.error.stack)).toEqual(frames(rawStack));

      expect(sentry.captureMessage).not.toHaveBeenCalled();
      expect(sentry.captureException).toHaveBeenCalledOnce();
      const [sent, options] = sentry.captureException.mock.calls[0] as [Error, { level: string; tags: { event: string }; extra: Record<string, unknown> }];
      expect(leakedMarkers(sent)).toEqual([]);
      expect(leakedMarkers(options)).toEqual([]);
      // grouping に使う type (name) と stack の frame は元と同じ。
      expect(sent).toBeInstanceOf(Error);
      expect(sent.name).toBe(error.name);
      expect(sent.message).toBe(redactLogText(rawMessage));
      expect(frames(sent.stack)).toEqual(frames(rawStack));
      expect(frames(sent.stack).length).toBeGreaterThan(0);
      expect(options.level).toBe('error');
      expect(options.tags).toEqual({ event: EVENT });
      expect(options.extra).toMatchObject({ userOpHash: USER_OP_HASH, chainId: 137 });
      expect(options.extra.error).toEqual({
        name: error.name,
        message: redactLogText(rawMessage),
        stack: redactLogText(rawStack ?? ''),
      });

      // 元の Error と fields は書き換えない。
      expect(error.message).toBe(rawMessage);
      expect(error.stack).toBe(rawStack);
      expect(fields.error).toBe(error);
    });

    it('文を渡す形 ({ error: error.message }): console と captureMessage の extra に残らない', () => {
      const raw = make().message;
      logger.warn(EVENT, { error: raw, userOpHash: USER_OP_HASH });

      const line = consoleLine(warnSpy);
      expect(leakedMarkers(line)).toEqual([]);
      expect(JSON.parse(line)).toMatchObject({ msg: EVENT, level: 'warn', userOpHash: USER_OP_HASH, error: redactLogText(raw) });

      expect(sentry.captureException).not.toHaveBeenCalled();
      expect(sentry.captureMessage).toHaveBeenCalledOnce();
      const [message, options] = sentry.captureMessage.mock.calls[0] as [string, { level: string; tags: { event: string }; extra: Record<string, unknown> }];
      expect(message).toBe(EVENT);
      expect(leakedMarkers(options)).toEqual([]);
      expect(options.level).toBe('warning');
      expect(options.tags).toEqual({ event: EVENT });
      expect(options.extra).toEqual({ error: redactLogText(raw), userOpHash: USER_OP_HASH });
    });

    it('入れ子の形 ({ ctx: { cause: error } }): console と captureMessage の extra に残らない', () => {
      const error = make();
      const fields = { ctx: { cause: error, attempts: [error.message] }, userOpHash: USER_OP_HASH };
      logger.error(EVENT, fields);

      const line = consoleLine(errorSpy);
      expect(leakedMarkers(line)).toEqual([]);
      expect(JSON.parse(line)).toMatchObject({
        msg: EVENT,
        userOpHash: USER_OP_HASH,
        ctx: { cause: { name: error.name, message: redactLogText(error.message) } },
      });

      // 最上位の欄に Error が無いので captureMessage (今までと同じ分岐)。
      expect(sentry.captureException).not.toHaveBeenCalled();
      const [message, options] = sentry.captureMessage.mock.calls[0] as [string, { tags: { event: string }; extra: { ctx: { cause: { message: string; stack: string }; attempts: string[] } } }];
      expect(message).toBe(EVENT);
      expect(leakedMarkers(options)).toEqual([]);
      expect(options.tags).toEqual({ event: EVENT });
      expect(options.extra.ctx.cause.message).toBe(redactLogText(error.message));
      expect(frames(options.extra.ctx.cause.stack)).toEqual(frames(error.stack));
      expect(options.extra.ctx.attempts).toEqual([redactLogText(error.message)]);
      expect(fields.ctx.cause).toBe(error);
    });
  });

  it('captureException に渡す写しは cause の並びも伏せて保つ (Sentry は cause を別の exception として送る)', () => {
    const error = userOperationExecutionError();
    logger.error(EVENT, { error });
    const [sent] = sentry.captureException.mock.calls[0] as [Error & { cause?: Error }];
    expect(sent).not.toBe(error);
    expect(sent.cause).toBeInstanceOf(Error);
    expect(sent.cause).not.toBe(error.cause);
    expect(sent.cause?.name).toBe('RpcRequestError');
    expect(sent.cause?.message).toBe(redactLogText(error.cause.message));
    expect(frames(sent.cause?.stack)).toEqual(frames(error.cause.stack));
    expect(leakedMarkers(sent)).toEqual([]);
  });

  it('最上位の文に伏せる所が無くても、cause にあれば cause を伏せた写しを渡す', () => {
    const cause = rpcRequestError();
    const error = new Error('send failed', { cause });
    logger.error(EVENT, { error });
    const [sent] = sentry.captureException.mock.calls[0] as [Error & { cause?: Error }];
    expect(sent).not.toBe(error);
    expect(sent.message).toBe('send failed');
    expect(frames(sent.stack)).toEqual(frames(error.stack));
    expect(sent.cause?.message).toBe(redactLogText(cause.message));
    expect(leakedMarkers(sent)).toEqual([]);
    expect(error.cause).toBe(cause);
  });

  it('伏せる所が無い Error は、元の Error をそのまま captureException に渡す (cause も)', () => {
    const cause = new Error('AA21 prefund');
    const error = new Error('payment failed', { cause });
    logger.error('payment.failed', { error });
    const [sent] = sentry.captureException.mock.calls[0] as [Error];
    expect(sent).toBe(error);
    expect(sent.cause).toBe(cause);
  });
});

describe('Sentry の beforeSend / beforeBreadcrumb (設定ファイルが実際に渡している hook)', () => {
  type Hooks = {
    beforeSend: (event: Event) => Event;
    beforeBreadcrumb?: (breadcrumb: Breadcrumb) => Breadcrumb;
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function installedHooks(runtime: 'client' | 'nodejs' | 'edge'): Promise<Hooks> {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://test@o0.ingest.sentry.io/0');
    if (runtime === 'client') {
      vi.stubEnv('NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE', '0');
      vi.stubEnv('NEXT_PUBLIC_SENTRY_REPLAY_ERROR_SAMPLE_RATE', '0');
      await import('@/instrumentation-client');
    } else {
      vi.stubEnv('NEXT_RUNTIME', runtime);
      const { register } = await import('@/instrumentation');
      await register();
    }
    expect(sentry.init).toHaveBeenCalledOnce();
    return sentry.init.mock.calls[0][0] as Hooks;
  }

  // logger を通らずに届く error (未捕捉の例外・error boundary・onRequestError) の event。Sentry は message を
  // exception.values[].value に、cause を別の exception に、console に出た文を breadcrumb の message と data.arguments に入れる。
  function rawEvent(): Event {
    const error = userOperationExecutionError();
    return {
      message: `unhandled: ${error.message}`,
      exception: {
        values: [
          { type: 'RpcRequestError', value: error.cause.message },
          {
            type: 'UserOperationExecutionError',
            value: error.message,
            // browser の stack parser が message の `URL:` の行から読む frame (本物の SDK での形は logRedaction.sentry.test.ts)。
            stacktrace: {
              frames: [
                { filename: 'https://open-pay.jp/_next/static/chunks/1-a.js', function: 'send', lineno: 1, colno: 2, in_app: true },
                { filename: BUNDLER_URL, function: 'URL: ', in_app: true },
              ],
            },
          },
        ],
      },
      extra: {
        userOpHash: USER_OP_HASH,
        reason: error.message,
        nested: { list: [error.cause.message, 1], stack: error.stack },
      },
      tags: { event: EVENT },
      breadcrumbs: [
        {
          category: 'console',
          level: 'error',
          message: `send failed ${error.message}`,
          data: {
            logger: 'console',
            arguments: ['send failed', { name: error.name, message: error.message, stack: error.stack }],
          },
        },
        { category: 'ui.click', message: 'button.pay' },
      ],
    };
  }

  it.each(['client', 'nodejs', 'edge'] as const)('%s: message・exception・extra・breadcrumb のどこにも残らない', async (runtime) => {
    const { beforeSend } = await installedHooks(runtime);
    const raw = rawEvent();
    // 前提: 5 つの置き場のそれぞれに、伏せる前の文が入っている。
    for (const part of [raw.message, raw.exception, raw.extra, raw.breadcrumbs?.[0].message, raw.breadcrumbs?.[0].data]) {
      expect(leakedMarkers(part)).toEqual(expect.arrayContaining([API_KEY, '5a5a5a5a5a5a5a5a']));
    }

    const event = beforeSend(raw);
    expect(leakedMarkers(event.message)).toEqual([]);
    expect(leakedMarkers(event.exception)).toEqual([]);
    expect(leakedMarkers(event.extra)).toEqual([]);
    expect(leakedMarkers(event.breadcrumbs?.[0].message)).toEqual([]);
    expect(leakedMarkers(event.breadcrumbs?.[0].data)).toEqual([]);
    expect(leakedMarkers(event)).toEqual([]);

    // 残すもの: event の名前・type・hash・origin・Details。
    expect(event.tags).toEqual({ event: EVENT });
    expect(event.exception?.values?.map((value) => value.type)).toEqual(['RpcRequestError', 'UserOperationExecutionError']);
    expect(event.exception?.values?.[0].value).toBe(redactLogText(rawEvent().exception!.values![0].value!));
    expect(event.exception?.values?.[1].stacktrace?.frames).toEqual([
      { filename: 'https://open-pay.jp/_next/static/chunks/1-a.js', function: 'send', lineno: 1, colno: 2, in_app: true },
      { filename: BUNDLER_ORIGIN, function: 'URL: ', in_app: true },
    ]);
    expect(event.extra?.userOpHash).toBe(USER_OP_HASH);
    expect(event.message).toContain(`URL: ${BUNDLER_ORIGIN}\n`);
    expect(event.message).toContain(`Details: ${RPC_DETAILS}`);
    expect(event.breadcrumbs?.[1]).toEqual({ category: 'ui.click', message: 'button.pay' });
    expect((event.breadcrumbs?.[0].data as { logger: string }).logger).toBe('console');
  });

  it('client: beforeBreadcrumb は console の breadcrumb の message を、積む時点で伏せる', async () => {
    const { beforeBreadcrumb } = await installedHooks('client');
    const raw = rpcRequestError().message;
    const breadcrumb = beforeBreadcrumb!({ category: 'console', level: 'error', message: `send failed ${raw}` });
    expect(leakedMarkers(breadcrumb)).toEqual([]);
    expect(breadcrumb.message).toBe(`send failed ${redactLogText(raw)}`);
  });
});

describe('決済の監査 log (lib/paymentLog.ts → /api/log/payment)', () => {
  const TOKEN = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29' as Address;
  const ctx: PaymentLogContext = {
    flow: 'batch',
    chainId: 137,
    tokenAddress: TOKEN,
    merchant: SENDER as Address,
    merchantAmount: 700n,
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(VIEM_ERROR_CASES)('%s: errorMessage は伏せてから 500 字に切る (Details まで残る)', (_name, make) => {
    const error = make();
    expect(error.message.length).toBeGreaterThan(500);
    const event = buildPaymentLogEvent(ctx, {
      result: 'error',
      errorMessage: error.message,
      userOpHash: USER_OP_HASH as `0x${string}`,
    });
    expect(leakedMarkers(event)).toEqual([]);
    expect(event.errorMessage).toBe(redactLogText(error.message).slice(0, 500));
    expect(event.errorMessage!.length).toBeLessThanOrEqual(500);
    // 切ってから伏せると、本文の途中で切れて Details が落ちる。
    expect(event.errorMessage).toContain('\nDetails: ');
    expect(event.userOpHash).toBe(USER_OP_HASH);
  });

  it('POST する本文にも残らない', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await logPaymentEvent(
      buildPaymentLogEvent(ctx, { result: 'error', errorMessage: userOperationExecutionError().message }),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('/api/log/payment');
    expect(leakedMarkers(init.body)).toEqual([]);
    expect(JSON.parse(init.body).errorMessage).toContain('Request body: [redacted]');
  });

  it('500 字までの文は、今までと同じ (伏せる所が無ければそのまま)', () => {
    const event = buildPaymentLogEvent(ctx, { result: 'error', errorMessage: 'user rejected' });
    expect(event.errorMessage).toBe('user rejected');
  });
});

describe('Replay の録画 (beforeSend を通らない)', () => {
  it('console の breadcrumb の data.arguments を伏せ、渡された frame は書き換えない', () => {
    const error = userOperationExecutionError();
    const frame: ReplayFrameEvent = {
      type: 5,
      timestamp: 1,
      data: {
        tag: 'breadcrumb',
        payload: {
          category: 'console',
          type: 'default',
          timestamp: 1,
          level: 'error',
          message: 'send failed',
          data: {
            logger: 'console',
            arguments: [
              `send failed ${error.message}`,
              { name: error.name, message: error.message, stack: error.stack, cause: { message: error.cause.message } },
            ],
          },
        },
      },
    };
    const original = structuredClone(frame);
    expect(leakedMarkers(frame)).toEqual(expect.arrayContaining([API_KEY, '5a5a5a5a5a5a5a5a', 'c0dec0dec0dec0de']));

    const clean = scrubReplayRecordingEvent(frame);
    expect(leakedMarkers(clean)).toEqual([]);
    const data = (clean.data.payload as unknown as { data: { logger: string; arguments: [string, { name: string; message: string }] } }).data;
    expect(data.logger).toBe('console');
    expect(data.arguments[0]).toBe(`send failed ${redactLogText(error.message)}`);
    expect(data.arguments[1].name).toBe(error.name);
    expect(data.arguments[1].message).toBe(redactLogText(error.message));
    expect(frame).toEqual(original);
  });
});

it('テストの材料: 伏せる前の error は、集めた文字列の中に key と署名と callData を持つ (collectStrings が空振りしていない)', () => {
  const error = userOperationExecutionError();
  const strings = collectStrings({ error });
  expect(strings.join('\n')).toContain(BUNDLER_URL);
  expect(strings.join('\n')).toContain(SIGNATURE);
  expect(strings.join('\n')).toContain(CALL_DATA);
});
