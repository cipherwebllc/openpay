import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  redactUrlForTelemetry,
  scrubSentryBreadcrumb,
  scrubSentryServerEvent,
  scrubSentryServerTransaction,
  scrubSentryTransaction,
} from '@/lib/telemetryRedaction';
import { IMAGE_LIBRARY_WALLET_HEADER } from '@/lib/images/library';

const SECRET = 'Bearer-secret-must-not-leak';
const SECRET_URL = `https://user:${SECRET}@hooks.example.com/api/webhooks/${SECRET}?token=${SECRET}`;

describe('telemetry URL redaction', () => {
  it('webhook URL は origin + 短縮 sha256 のみになり bearer を含まない', async () => {
    const redacted = await redactUrlForTelemetry(SECRET_URL);

    expect(redacted).toEqual({
      origin: 'https://hooks.example.com',
      hash: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    expect(JSON.stringify(redacted)).not.toContain(SECRET);
    expect(JSON.stringify(redacted)).not.toContain('/api/webhooks/');
  });

  it.each(['fetch', 'xhr'])(
    '%s breadcrumb の URL は userinfo/path/query を除いて origin のみにする',
    (category) => {
      const breadcrumb = scrubSentryBreadcrumb({
        category,
        data: { url: SECRET_URL, method: 'POST' },
      })!;

      expect(breadcrumb.data).toEqual({
        url: 'https://hooks.example.com',
        method: 'POST',
      });
      expect(JSON.stringify(breadcrumb)).not.toContain(SECRET);
    },
  );

  it('navigation breadcrumb の from/to relative URL も現在 origin まで落とす', () => {
    const breadcrumb = scrubSentryBreadcrumb({
      category: 'navigation',
      data: {
        from: `/before?bearer=${SECRET}`,
        to: `/after/${SECRET}`,
      },
    })!;

    expect(breadcrumb.data).toEqual({
      from: window.location.origin,
      to: window.location.origin,
    });
    expect(JSON.stringify(breadcrumb)).not.toContain(SECRET);
  });

  it('BrowserTracing transaction の http.url/request URL を span 含め scrub する', () => {
    const event = scrubSentryTransaction({
      type: 'transaction',
      request: { url: SECRET_URL },
      contexts: {
        trace: {
          trace_id: '1'.repeat(32),
          span_id: '2'.repeat(16),
          data: { 'http.url': SECRET_URL },
        },
      },
      spans: [
        {
          data: { 'http.url': SECRET_URL, 'url.full': SECRET_URL },
          span_id: '3'.repeat(16),
          trace_id: '1'.repeat(32),
          start_timestamp: 1,
        },
      ],
    })!;

    expect(event.request?.url).toBe('https://hooks.example.com');
    expect(event.contexts?.trace?.data?.['http.url']).toBe(
      'https://hooks.example.com',
    );
    expect(event.spans?.[0].data['http.url']).toBe('https://hooks.example.com');
    expect(event.spans?.[0].data['url.full']).toBe('https://hooks.example.com');
    expect(JSON.stringify(event)).not.toContain(SECRET);
  });

  it('server transaction の query 別表現と Referer をすべて scrub する', () => {
    const target = `/api/order/status?t=${SECRET}`;
    const event = scrubSentryServerTransaction({
      type: 'transaction',
      request: {
        url: SECRET_URL,
        query_string: `t=${SECRET}`,
        headers: {
          Referer: SECRET_URL,
          'x-safe': 'kept',
        },
      },
      contexts: {
        trace: {
          trace_id: '1'.repeat(32),
          span_id: '2'.repeat(16),
          data: {
            'http.url': SECRET_URL,
            'url.full': SECRET_URL,
            'url.query': `?t=${SECRET}`,
            'http.target': target,
            'http.request.header.referer': SECRET_URL,
          },
        },
        nextjs: {
          request_path: target,
          router_kind: 'App Router',
        },
      },
      spans: [
        {
          data: {
            'http.url': SECRET_URL,
            'url.full': SECRET_URL,
            'url.query': `?t=${SECRET}`,
            'http.target': target,
            'http.request.header.referer': SECRET_URL,
          },
          span_id: '3'.repeat(16),
          trace_id: '1'.repeat(32),
          start_timestamp: 1,
        },
      ],
    })!;

    expect(event.request).not.toHaveProperty('query_string');
    expect(event.request?.url).toBe('https://hooks.example.com');
    expect(event.request?.headers).toEqual({
      Referer: 'https://hooks.example.com',
      'x-safe': 'kept',
    });
    expect(event.contexts?.trace?.data).toMatchObject({
      'http.url': 'https://hooks.example.com',
      'url.full': 'https://hooks.example.com',
      'http.target': '/api/order/status',
      'http.request.header.referer': 'https://hooks.example.com',
    });
    expect(event.contexts?.trace?.data).not.toHaveProperty('url.query');
    expect(event.contexts?.nextjs?.request_path).toBe('/api/order/status');
    expect(event.spans?.[0].data).toMatchObject({
      'http.url': 'https://hooks.example.com',
      'url.full': 'https://hooks.example.com',
      'http.target': '/api/order/status',
      'http.request.header.referer': 'https://hooks.example.com',
    });
    expect(event.spans?.[0].data).not.toHaveProperty('url.query');
    expect(JSON.stringify(event)).not.toContain(SECRET);
  });

  it('受けた request の本文 (request.data・span の http.request.body.*) を落とす (出品の有料の本文・納品 URL を Sentry へ送らない)', () => {
    const body = JSON.stringify({ title: 'lamp', content: `paid-${SECRET}`, deliveryUrl: SECRET_URL });
    const event = scrubSentryServerEvent({
      request: { method: 'POST', url: 'https://open-pay.jp/api/store/products', data: body },
      contexts: { trace: { trace_id: 't', span_id: 's', data: { 'http.request.body.data': body, 'http.method': 'POST' } } },
      spans: [{ span_id: 'a', trace_id: 't', start_timestamp: 0, data: { 'HTTP.Request.Body.Size': 10, 'http.method': 'POST' } }],
    } as Parameters<typeof scrubSentryServerEvent>[0]);
    expect(event?.request).not.toHaveProperty('data');
    expect(event?.request?.method).toBe('POST');
    expect(event?.contexts?.trace?.data).toEqual({ 'http.method': 'POST' });
    expect(event?.spans?.[0].data).toEqual({ 'http.method': 'POST' });
    expect(JSON.stringify(event)).not.toContain(SECRET);
  });

  it('支払いの署名 (PAYMENT-SIGNATURE・X-PAYMENT)・authorization・cookie を request.headers と span の http.request.header.* から落とす', () => {
    const event = scrubSentryServerEvent({
      request: {
        method: 'POST',
        headers: { 'PAYMENT-SIGNATURE': SECRET, 'X-PAYMENT': SECRET, Authorization: SECRET, cookie: SECRET, 'content-type': 'application/json' },
      },
      contexts: {
        trace: {
          trace_id: 't',
          span_id: 's',
          data: { 'http.request.header.payment_signature': SECRET, 'http.request.header.x_payment': SECRET, 'http.request.header.content_type': 'application/json' },
        },
      },
      spans: [{ span_id: 'a', trace_id: 't', start_timestamp: 0, data: { 'http.request.header.authorization': SECRET, 'http.method': 'POST' } }],
    } as Parameters<typeof scrubSentryServerEvent>[0]);
    expect(event?.request?.headers).toEqual({ 'content-type': 'application/json' });
    expect(event?.contexts?.trace?.data).toEqual({ 'http.request.header.content_type': 'application/json' });
    expect(event?.spans?.[0].data).toEqual({ 'http.method': 'POST' });
    expect(JSON.stringify(event)).not.toContain(SECRET);
  });

  it('Vercel の OIDC の token (x-vercel-oidc-token) を error の event と transaction の両方から落とす', () => {
    const error = scrubSentryServerEvent({
      request: {
        method: 'POST',
        url: 'https://open-pay.jp/api/images/upload',
        headers: { 'x-vercel-oidc-token': SECRET, 'X-Vercel-OIDC-Token': SECRET, 'content-type': 'image/jpeg' },
      },
      contexts: {
        trace: { trace_id: 't', span_id: 's', data: { 'http.request.header.x_vercel_oidc_token': SECRET, 'http.method': 'POST' } },
      },
    } as Parameters<typeof scrubSentryServerEvent>[0]);
    expect(error?.request?.headers).toEqual({ 'content-type': 'image/jpeg' });
    expect(error?.contexts?.trace?.data).toEqual({ 'http.method': 'POST' });
    expect(JSON.stringify(error)).not.toContain(SECRET);

    const transaction = scrubSentryServerTransaction({
      type: 'transaction',
      transaction: 'POST /api/images/upload',
      request: { method: 'POST', headers: { 'x-vercel-oidc-token': SECRET, accept: '*/*' } },
      contexts: {
        trace: { trace_id: 't', span_id: 's', data: { 'http.request.header.x_vercel_oidc_token': SECRET, 'http.method': 'POST' } },
      },
      spans: [{ span_id: 'a', trace_id: 't', start_timestamp: 0, data: { 'HTTP.Request.Header.X_Vercel_OIDC_Token': SECRET, 'http.method': 'POST' } }],
    } as Parameters<typeof scrubSentryServerTransaction>[0]);
    expect(transaction?.request?.headers).toEqual({ accept: '*/*' });
    expect(transaction?.contexts?.trace?.data).toEqual({ 'http.method': 'POST' });
    expect(transaction?.spans?.[0].data).toEqual({ 'http.method': 'POST' });
    expect(JSON.stringify(transaction)).not.toContain(SECRET);
  });

  it('画像の一覧・削除の画面のウォレット (x-openpay-wallet) を error の event と transaction の両方から落とす', () => {
    expect(IMAGE_LIBRARY_WALLET_HEADER).toBe('x-openpay-wallet');
    const wallet = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
    const error = scrubSentryServerEvent({
      request: { method: 'POST', url: 'https://open-pay.jp/api/images/delete', headers: { 'X-OpenPay-Wallet': wallet, accept: '*/*' } },
      contexts: { trace: { trace_id: 't', span_id: 's', data: { 'http.request.header.x_openpay_wallet': wallet, 'http.method': 'POST' } } },
    } as Parameters<typeof scrubSentryServerEvent>[0]);
    expect(error?.request?.headers).toEqual({ accept: '*/*' });
    expect(JSON.stringify(error)).not.toContain(wallet);
    const transaction = scrubSentryServerTransaction({
      type: 'transaction',
      transaction: 'GET /api/images',
      request: { method: 'GET', headers: { 'x-openpay-wallet': wallet } },
      spans: [{ span_id: 'a', trace_id: 't', start_timestamp: 0, data: { 'http.request.header.x_openpay_wallet': wallet } }],
    } as Parameters<typeof scrubSentryServerTransaction>[0]);
    expect(JSON.stringify(transaction)).not.toContain(wallet);
  });

  it('instrumentation.ts の node の Sentry は、受けた request の本文を採らない (httpIntegration の maxIncomingRequestBodySize: none)', () => {
    const source = readFileSync(join(process.cwd(), 'instrumentation.ts'), 'utf8');
    expect(source).toContain("Sentry.httpIntegration({ disableIncomingRequestSpans: true, maxIncomingRequestBodySize: 'none' })");
  });

  it('onRequestError event の nextjs.request_path と Referer から query を落とす', () => {
    const event = scrubSentryServerEvent({
      request: {
        method: 'GET',
        query_string: `t=${SECRET}`,
        headers: { referer: SECRET_URL },
      },
      contexts: {
        nextjs: {
          request_path: `/api/order/status?t=${SECRET}`,
          router_kind: 'App Router',
          router_path: '/api/order/status',
          route_type: 'route',
        },
      },
      breadcrumbs: [
        {
          category: 'http',
          data: { url: SECRET_URL, method: 'GET' },
        },
      ],
    })!;

    expect(event.request).not.toHaveProperty('query_string');
    expect(event.request?.headers?.referer).toBe('https://hooks.example.com');
    expect(event.contexts?.nextjs?.request_path).toBe('/api/order/status');
    expect(event.breadcrumbs?.[0].data?.url).toBe('https://hooks.example.com');
    expect(JSON.stringify(event)).not.toContain(SECRET);
  });

  it('外向き fetch breadcrumb の http.query / http.fragment (Sentry が url と別キーで入れる query 全文) を落とす', () => {
    // @sentry/node-core の getBreadcrumbData と同じ形: url は sanitize 済みでも、query は http.query に丸ごと残る。
    // 上流 API のキーを query で渡す fetch (Etherscan の apikey 等) が、エラー event 経由で Sentry へ出る経路のフェンス。
    const fetchBreadcrumb = () => ({
      category: 'http',
      type: 'http',
      data: {
        url: 'https://api.etherscan.io/v2/api',
        'http.method': 'GET',
        'http.query': `?chainid=137&action=tokentx&apikey=${SECRET}`,
        'http.fragment': `#${SECRET}`,
        status_code: 502,
      },
    });
    const direct = scrubSentryBreadcrumb(fetchBreadcrumb())!;
    expect(direct.data).not.toHaveProperty('http.query');
    expect(direct.data).not.toHaveProperty('http.fragment');
    expect(direct.data?.status_code).toBe(502);

    // server の beforeSend (captureMessage / captureException の event に載った breadcrumb) でも同じ。
    const event = scrubSentryServerEvent({
      message: 'agent.activity.upstream',
      breadcrumbs: [fetchBreadcrumb()],
      contexts: { trace: { data: { 'http.query': `?apikey=${SECRET}`, 'http.fragment': `#${SECRET}` } } },
      spans: [{ data: { 'http.query': `?apikey=${SECRET}` } }],
    } as never)!;
    expect(JSON.stringify(event)).not.toContain(SECRET);
    expect(JSON.stringify(direct)).not.toContain(SECRET);
  });
});

it('delivery redirect and JSON fields are scrubbed by the installed browser/server hooks', () => {
  const ticket = 'header.payload.signature-delivery-secret';
  const url = `https://files.example/private-gate?ticket=${ticket}`;
  const breadcrumb = scrubSentryBreadcrumb({ category: 'fetch', data: { url, ticket, deliveryUrl: url, Location: url }, message: url })!;
  expect(breadcrumb.data).toEqual({ url: 'https://files.example', Location: 'https://files.example' });
  const browser = scrubSentryTransaction({
    type: 'transaction', request: { url },
    contexts: { trace: { trace_id: '1'.repeat(32), span_id: '2'.repeat(16), data: { 'http.response.header.location': url, ticket } } },
  })!;
  const server = scrubSentryServerEvent({
    request: { url, headers: { Location: url } }, breadcrumbs: [breadcrumb],
    contexts: { trace: { trace_id: '1'.repeat(32), span_id: '2'.repeat(16), data: { 'http.response.header.location': url, ticket } } },
  })!;
  for (const scrubbed of [breadcrumb, browser, server]) {
    expect(JSON.stringify(scrubbed)).not.toContain(ticket); expect(JSON.stringify(scrubbed)).not.toContain('/private-gate');
  }
});

describe('認可トークンのヘッダ', () => {
  it('error event の request.headers から認可トークンのヘッダを大文字小文字を問わず落とす', () => {
    const event = scrubSentryServerEvent({
      request: {
        url: 'https://open-pay.jp/api/register/handoff/abc',
        headers: {
          'X-Store-Handoff-Token': SECRET,
          'x-order-token': SECRET,
          'x-safe': 'kept',
        },
      },
    })!;
    expect(JSON.stringify(event)).not.toContain(SECRET);
    expect(event.request?.headers).toEqual({ 'x-safe': 'kept' });
  });
});
