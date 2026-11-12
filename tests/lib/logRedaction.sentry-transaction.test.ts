// 本物の Sentry の browser SDK に instrumentation-client.ts の実際の設定 (beforeBreadcrumb・beforeSendTransaction) を渡し、
// 本物の viem の http transport が key を path に持つ RPC へ送って失敗したときの transaction の中身を見る
// (第 10 回レビュー PR-40 の Codex 指摘 1・2)。transaction は beforeSend を通らないので、error の event とは別に見る。
// 差し替えるのは送信 (transport) と、fetch の応答だけ (Sentry が包む前の fetch を置く)。span を作るのは
// browserTracingIntegration の fetch の計測 (@sentry/nextjs の client が既定で入れるもの。ここでは browser 版を足す)。
import type { Envelope } from '@sentry/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPublicClient, http } from 'viem';
import { polygon } from 'viem/chains';

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
import { API_KEY, leakedMarkers } from '../helpers/viemRequestErrors';

const RPC_ORIGIN = 'https://api.example';
// RPC の上書きの URL は path に key を持つ形がある (Alchemy の /v2/<key> など)。
const KEYED_RPC_URL = `${RPC_ORIGIN}/v2/${API_KEY}`;

type SentSpan = { op?: string; description?: string; data?: Record<string, unknown> };
type SentTransaction = {
  type?: string;
  transaction?: string;
  spans?: SentSpan[];
  breadcrumbs?: Array<{ category?: string; message?: string; data?: Record<string, unknown> }>;
};

function sentTransactions(): SentTransaction[] {
  return (sent.envelopes as Envelope[]).flatMap((envelope) =>
    envelope[1]
      .filter(([header]) => header.type === 'transaction')
      .map(([, payload]) => payload as SentTransaction),
  );
}

describe('本物の Sentry SDK を通した transaction (instrumentation-client.ts の設定)', () => {
  const fetchStub = vi.fn(async (input: RequestInfo | URL) =>
    String(input).startsWith(RPC_ORIGIN)
      ? new Response('bad gateway', { status: 502 })
      : new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://public@o0.ingest.sentry.io/1');
    vi.stubEnv('NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE', '0');
    vi.stubEnv('NEXT_PUBLIC_SENTRY_REPLAY_ERROR_SAMPLE_RATE', '0');
    // Sentry が包む前の fetch と console を置く (SDK は init のときに包む)。
    vi.stubGlobal('fetch', fetchStub);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await import('@/instrumentation-client');
    Sentry.addIntegration(Sentry.browserTracingIntegration({ instrumentPageLoad: false, instrumentNavigation: false }));
    expect(Sentry.getClient()?.getOptions().beforeSendTransaction).toBeDefined();
  });

  beforeEach(() => {
    sent.envelopes.length = 0;
    Sentry.getIsolationScope().clearBreadcrumbs();
    Sentry.getCurrentScope().clearBreadcrumbs();
  });

  afterAll(async () => {
    await Sentry.close();
    warnSpy.mockRestore();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('失敗した RPC の span (description・url) と、その後に console に出た文の breadcrumb に key が残らず、自分の app の span は今までのまま', async () => {
    let rpcMessage = '';
    await Sentry.startSpan({ name: 'pay.balance', op: 'ui.action', forceTransaction: true }, async () => {
      const client = createPublicClient({ chain: polygon, transport: http(KEYED_RPC_URL, { retryCount: 0 }) });
      try {
        await client.getBlockNumber();
      } catch (error) {
        rpcMessage = (error as Error).message;
      }
      // 伏せる前の版の lib/crossChain/balance.ts と同じ形 (error の文をそのまま console.warn に出す)。
      console.warn(`[xchain-diag] Polygon (137): FAILED after 3ms — ${rpcMessage}`);
      await fetch('/api/log/payment', { method: 'POST', body: '{}' });
    });
    await Sentry.flush(2000);

    // 前提: viem の文は key つきの URL を持ち、fetch は Sentry が包んだものを通った (span ができた)。
    expect(rpcMessage).toContain(`URL: ${KEYED_RPC_URL}`);
    expect(fetchStub).toHaveBeenCalledWith(KEYED_RPC_URL, expect.anything());

    expect(JSON.stringify(sent.envelopes)).not.toContain(API_KEY);
    expect(leakedMarkers(sent.envelopes)).toEqual([]);
    const transactions = sentTransactions();
    expect(transactions).toHaveLength(1);
    const [transaction] = transactions;
    expect(transaction.transaction).toBe('pay.balance');

    const httpSpans = (transaction.spans ?? []).filter((span) => span.op === 'http.client');
    const rpcSpan = httpSpans.find((span) => span.description?.startsWith('POST https://'));
    expect(rpcSpan?.description).toBe(`POST ${RPC_ORIGIN}`);
    expect(rpcSpan?.data).toMatchObject({
      url: RPC_ORIGIN,
      'http.url': RPC_ORIGIN,
      'url.full': RPC_ORIGIN,
      'server.address': 'api.example',
      'http.method': 'POST',
    });
    // 自分の app への request (相対 path) は今までと同じ。
    const ownSpan = httpSpans.find((span) => span.description === 'POST /api/log/payment');
    expect(ownSpan?.data).toMatchObject({ url: '/api/log/payment', 'http.method': 'POST' });

    const consoleCrumb = transaction.breadcrumbs?.find((crumb) => crumb.category === 'console');
    expect(consoleCrumb?.message).toBe(`[xchain-diag] Polygon (137): FAILED after 3ms — ${redactLogText(rpcMessage)}`);
    expect(consoleCrumb?.message).toContain(`URL: ${RPC_ORIGIN}\n`);
    expect((consoleCrumb?.data as { arguments: string[] }).arguments).toEqual([consoleCrumb?.message]);
  });
});
