// 本物の Sentry の browser SDK に instrumentation-client.ts の実際の設定 (beforeBreadcrumb・beforeSend・
// beforeSendTransaction) を渡し、scrubber が失敗する入力 (凍結した object・throw する getter・配列の accessor・Proxy) で、
// (a) app の呼び出し元に throw が届かないこと、(b) 伏せられなかった breadcrumb / event が transport に出ないこと
// (Sentry は hook の例外を内部の event として beforeSend を通さずに送るので、その envelope も出ないこと) を見る
// (第 10 回レビュー PR-40 の Codex 2 回目の指摘)。差し替えるのは送信 (transport) だけ。
import type { Envelope, TraceContext, TransactionEvent } from '@sentry/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sent = vi.hoisted(() => ({ envelopes: [] as unknown[] }));

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
import { redactLogText } from '@/lib/telemetryRedaction';
import { API_KEY, leakedMarkers, rpcRequestError, userOperationExecutionError } from '../helpers/viemRequestErrors';

type SentPayload = {
  type?: string;
  message?: string;
  transaction?: string;
  exception?: { values: Array<{ type: string; value: string }> };
  breadcrumbs?: Array<{ category?: string; message?: string; data?: Record<string, unknown> }>;
};

function sentItems(type: 'event' | 'transaction'): SentPayload[] {
  return (sent.envelopes as Envelope[]).flatMap((envelope) =>
    envelope[1]
      .filter(([header]) => header.type === type)
      .map(([, payload]) => payload as SentPayload),
  );
}

const TRACE_IDS = { trace_id: '1'.repeat(32), span_id: '2'.repeat(16) };
const boom = (): never => {
  throw userOperationExecutionError();
};

function transactionEvent(trace: TraceContext, name: string): TransactionEvent {
  const now = Date.now() / 1000;
  return { type: 'transaction', transaction: name, start_timestamp: now - 1, timestamp: now, contexts: { trace }, spans: [] };
}

describe('本物の Sentry SDK: scrubber が失敗する入力 (instrumentation-client.ts の設定)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://public@o0.ingest.sentry.io/1');
    vi.stubEnv('NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE', '0');
    vi.stubEnv('NEXT_PUBLIC_SENTRY_REPLAY_ERROR_SAMPLE_RATE', '0');
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

  it('凍結した data の addBreadcrumb は投げず、伏せる所が無ければそのまま・あれば伏せた写しが積まれる (元は書き換えない)', async () => {
    const raw = rpcRequestError().message;
    const keyed = Object.freeze({ note: raw, list: Object.freeze([raw, 1]) });
    expect(() => Sentry.addBreadcrumb({ category: 'custom', data: Object.freeze({ note: 'safe' }) })).not.toThrow();
    expect(() => Sentry.addBreadcrumb(Object.freeze({ category: 'custom', message: raw, data: keyed }))).not.toThrow();
    Sentry.captureMessage('probe');
    await Sentry.flush(2000);

    expect(JSON.stringify(sent.envelopes)).not.toContain(API_KEY);
    expect(leakedMarkers(sent.envelopes)).toEqual([]);
    const [event] = sentItems('event');
    expect(event.message).toBe('probe');
    const custom = event.breadcrumbs!.filter((crumb) => crumb.category === 'custom');
    expect(custom.map((crumb) => crumb.data)).toEqual([
      { note: 'safe' },
      { note: redactLogText(raw), list: [redactLogText(raw), 1] },
    ]);
    expect(custom[1].message).toBe(redactLogText(raw));
    expect(keyed.note).toBe(raw);
  });

  it('throw する getter・配列の accessor・Proxy を data に持つ breadcrumb は、呼び出し元に投げず、積まない', async () => {
    const inputs: unknown[] = [
      Object.defineProperty({}, 'note', { enumerable: true, get: boom }),
      { arguments: Object.defineProperty([] as unknown[], 0, { enumerable: true, get: boom }) },
      new Proxy({}, { ownKeys: boom }),
    ];
    for (const data of inputs) {
      expect(() => Sentry.addBreadcrumb({ category: 'custom', message: 'unreadable', data: data as Record<string, unknown> })).not.toThrow();
    }
    Sentry.addBreadcrumb({ category: 'custom', message: 'readable' });
    // Dedupe は同じ文の event を続けて落とすので、上のテストと文を変える。
    Sentry.captureMessage('probe.unreadable');
    await Sentry.flush(2000);

    expect(JSON.stringify(sent.envelopes)).not.toContain(API_KEY);
    expect(leakedMarkers(sent.envelopes)).toEqual([]);
    const [event] = sentItems('event');
    expect(event.breadcrumbs!.filter((crumb) => crumb.category === 'custom').map((crumb) => crumb.message)).toEqual(['readable']);
  });

  it('凍結した trace の transaction は、伏せる所が無ければ transport に届く (内部の error の event に置き換わらない)', async () => {
    Sentry.captureEvent(transactionEvent(Object.freeze({ ...TRACE_IDS, op: 'ui.action', description: 'safe' }), 'frozen.safe'));
    await Sentry.flush(2000);

    expect(sentItems('transaction').map((item) => item.transaction)).toEqual(['frozen.safe']);
    expect(sentItems('event')).toEqual([]);
  });

  it('getter が viem の error を投げる trace の transaction は、送らない (内部の error の event も出さない)・呼び出し元に投げない', async () => {
    let reads = 0;
    const trace = Object.defineProperty({ ...TRACE_IDS, op: 'http.client' }, 'description', {
      enumerable: true,
      get: () => {
        reads += 1;
        // SDK の読み (normalize など) には 'safe' を返し、scrubber の読みで投げる (Codex の再現と同じ形)。
        return reads > 2 ? boom() : 'safe';
      },
    });
    expect(() => Sentry.captureEvent(transactionEvent(trace, 'getter.throws'))).not.toThrow();
    await Sentry.flush(2000);

    expect(reads).toBeGreaterThan(2);
    expect(JSON.stringify(sent.envelopes)).not.toContain(API_KEY);
    expect(leakedMarkers(sent.envelopes)).toEqual([]);
    expect(sentItems('transaction')).toEqual([]);
    expect(sentItems('event')).toEqual([]);
  });

  it('凍結した exception の error の event は、伏せる所が無ければ届き、あれば送らない (内部の error の event も出さない)', async () => {
    Sentry.captureEvent({ exception: { values: [Object.freeze({ type: 'Error', value: 'AA21 prefund' })] } });
    Sentry.captureEvent({ exception: { values: [Object.freeze({ type: 'RpcRequestError', value: rpcRequestError().message })] } });
    await Sentry.flush(2000);

    expect(JSON.stringify(sent.envelopes)).not.toContain(API_KEY);
    expect(leakedMarkers(sent.envelopes)).toEqual([]);
    const events = sentItems('event');
    expect(events.map((event) => event.exception?.values.map((value) => [value.type, value.value]))).toEqual([
      [['Error', 'AA21 prefund']],
    ]);
  });
});
