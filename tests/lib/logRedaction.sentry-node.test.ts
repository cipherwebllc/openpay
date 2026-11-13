// @vitest-environment node
// 本物の Sentry の node の SDK に instrumentation.ts の nodejs の設定 (beforeSend・beforeSendTransaction) を渡し、
// server の logger が渡す元の Error (cause の連なり・AggregateError の子) の送信の中身を見る (第 10 回レビュー PR-40 の
// Codex 指摘 7)。差し替えるのは送信 (transport) だけ。server には location が無いので、span の「自分の app」は受けた
// request の origin で決まる (その scrubber の形も、ここで node の環境のまま見る)。
import type { Envelope, TransactionEvent } from '@sentry/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sent = vi.hoisted(() => ({ envelopes: [] as unknown[] }));

vi.mock('@sentry/nextjs', async () => {
  const sdk = await import('@sentry/node');
  return {
    ...sdk,
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

import * as Sentry from '@sentry/nextjs';
import { logger } from '@/lib/logger';
import { redactLogText, scrubSentryServerTransaction } from '@/lib/telemetryRedaction';
import {
  API_KEY,
  BUNDLER_ORIGIN,
  RPC_DETAILS,
  leakedMarkers,
  rpcRequestError,
  userOperationExecutionError,
} from '../helpers/viemRequestErrors';

type SentEvent = {
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  exception?: { values: Array<{ type: string; value: string }> };
};

// node の contextLines (既定の integration) は frame の file の source の行 (pre_context・context_line・post_context) を
// 付ける。error の文ではなく source の写しで、ここではテストの helper の行 (値の作り方を書いた行) が入るので、漏れの検査
// からは外す (frame の filename・function は検査に残す)。
function withoutSourceContext(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, item: unknown) =>
      key === 'pre_context' || key === 'context_line' || key === 'post_context' ? undefined : item,
    ),
  );
}

function sentEvents(): SentEvent[] {
  return (sent.envelopes as Envelope[]).flatMap((envelope) =>
    envelope[1]
      .filter(([header]) => header.type === 'event')
      .map(([, payload]) => payload as SentEvent),
  );
}

describe('本物の Sentry の node の SDK を通した送信 (instrumentation.ts の nodejs の設定)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://public@o0.ingest.sentry.io/1');
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { register } = await import('@/instrumentation');
    await register();
    expect(Sentry.getClient()?.getOptions().beforeSend).toBeDefined();
  });

  beforeEach(() => {
    sent.envelopes.length = 0;
  });

  afterAll(async () => {
    await Sentry.close();
    errorSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it('logger.error({ error: AggregateError }) → 子と cause の連なりが落ちずに別の exception として送られ、どれも伏せてある', async () => {
    const child = userOperationExecutionError();
    const error = new AggregateError(
      [child, new Error('AA21 prefund')],
      `batch send failed: ${rpcRequestError().message}`,
      { cause: rpcRequestError(`HTTPS://api.example/v2/${API_KEY}`) },
    );
    logger.error('relay.jpyc.submit_failed', { error });
    await Sentry.flush(2000);

    expect(JSON.stringify(sent.envelopes)).not.toContain(API_KEY);
    expect(leakedMarkers(withoutSourceContext(sent.envelopes))).toEqual([]);
    const events = sentEvents();
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event.tags?.event).toBe('relay.jpyc.submit_failed');
    const values = event.exception!.values;
    expect(values.map((value) => value.type).sort()).toEqual(
      ['AggregateError', 'Error', 'RpcRequestError', 'RpcRequestError', 'UserOperationExecutionError'].sort(),
    );
    expect(values.find((value) => value.type === 'UserOperationExecutionError')?.value).toBe(redactLogText(child.message));
    for (const value of values.filter((item) => item.type === 'RpcRequestError')) {
      expect(value.value).toContain(`URL: ${BUNDLER_ORIGIN}\n`);
      expect(value.value).toContain(`Details: ${RPC_DETAILS}`);
    }
    expect(values.at(-1)!.value).toBe(`batch send failed: ${redactLogText(rpcRequestError().message)}`);
  });
});

describe('server の transaction の span (location が無い環境)', () => {
  const OWN = 'https://open-pay.jp';
  const KEYED_RPC_URL = `https://polygon-mainnet.g.alchemy.example/v2/${API_KEY}`;

  function span(op: string, description: string, data: Record<string, unknown>) {
    return { op, description, data, span_id: '3'.repeat(16), trace_id: '1'.repeat(32), start_timestamp: 1 };
  }

  // @sentry/node-core の undici-instrumentation.js (url.full・url.path・url.query・server.address) と
  // @sentry/opentelemetry の parseSpanDescription (description `<METHOD> <URL>`・data.url) が付ける形。
  function rawServerTransaction(withRequest: boolean): TransactionEvent {
    return {
      type: 'transaction',
      transaction: 'POST /api/relay',
      ...(withRequest ? { request: { url: `${OWN}/api/relay?t=secret` } } : {}),
      contexts: {
        trace: {
          trace_id: '1'.repeat(32),
          span_id: '2'.repeat(16),
          op: 'http.server',
          data: { url: `${OWN}/api/relay`, 'url.path': '/api/relay', 'http.target': '/api/relay' },
        },
      },
      spans: [
        span('http.client', `POST ${KEYED_RPC_URL}`, {
          url: KEYED_RPC_URL,
          'url.full': KEYED_RPC_URL,
          'url.path': `/v2/${API_KEY}`,
          'server.address': 'polygon-mainnet.g.alchemy.example',
          'http.request.method': 'POST',
        }),
        span('http.client', `GET ${OWN}/api/discovery/abc`, { url: `${OWN}/api/discovery/abc`, 'url.path': '/api/discovery/abc' }),
      ],
    } as TransactionEvent;
  }

  it('別の origin への span は description と url を origin だけにし、path の欄を落とす。受けた request (http.server) と自分の origin への span は今までのまま', () => {
    expect(globalThis.location).toBeUndefined();
    const event = scrubSentryServerTransaction(rawServerTransaction(true))!;
    expect(JSON.stringify(event)).not.toContain(API_KEY);
    const [rpc, self] = event.spans!;
    expect(rpc.description).toBe('POST https://polygon-mainnet.g.alchemy.example');
    expect(rpc.data).toEqual({
      url: 'https://polygon-mainnet.g.alchemy.example',
      'url.full': 'https://polygon-mainnet.g.alchemy.example',
      'server.address': 'polygon-mainnet.g.alchemy.example',
      'http.request.method': 'POST',
    });
    expect(self).toEqual(rawServerTransaction(true).spans![1]);
    expect(event.contexts?.trace?.data).toEqual(rawServerTransaction(true).contexts!.trace!.data);
    expect(event.request?.url).toBe(OWN);
  });

  it('受けた request が event に無いときは、絶対 URL の span を全部別の origin として扱う (http.server は今までのまま)', () => {
    const event = scrubSentryServerTransaction(rawServerTransaction(false))!;
    expect(JSON.stringify(event)).not.toContain(API_KEY);
    expect(event.spans!.map((item) => item.description)).toEqual([
      'POST https://polygon-mainnet.g.alchemy.example',
      `GET ${OWN}`,
    ]);
    expect(event.contexts?.trace?.data).toEqual(rawServerTransaction(false).contexts!.trace!.data);
  });
});
