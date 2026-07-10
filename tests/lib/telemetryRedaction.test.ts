import { describe, expect, it } from 'vitest';
import {
  redactUrlForTelemetry,
  scrubSentryBreadcrumb,
  scrubSentryTransaction,
} from '@/lib/telemetryRedaction';

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
      });

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
    });

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
    });

    expect(event.request?.url).toBe('https://hooks.example.com');
    expect(event.contexts?.trace?.data?.['http.url']).toBe(
      'https://hooks.example.com',
    );
    expect(event.spans?.[0].data['http.url']).toBe('https://hooks.example.com');
    expect(event.spans?.[0].data['url.full']).toBe('https://hooks.example.com');
    expect(JSON.stringify(event)).not.toContain(SECRET);
  });
});
