import { describe, expect, it, vi } from 'vitest';
import type { Envelope, Event } from '@sentry/core';
import type { ReplayFrameEvent } from '@sentry/nextjs';
import { scrubReplayEnvelope, scrubReplayEvent, scrubReplayRecordingEvent } from '@/lib/sentryReplay';

// Next の server entry ではなく実 browser SDK で遅延登録と送信まで検証する。
vi.mock('@sentry/nextjs', async () => {
  const sdk = await import('@sentry/browser');
  return {
    ...sdk,
    replayIntegration: (options: Parameters<typeof sdk.replayIntegration>[0]) =>
      sdk.replayIntegration({ ...options, stickySession: false, minReplayDuration: 0 }),
  };
});

const SECRET = 'Bearer-replay-secret';
const urls = [
  `https://open-pay.jp/agent#proof=${SECRET}`,
  `https://open-pay.jp/ja/orders/kitchen?t=${SECRET}`,
  `https://open-pay.jp/api/order/status?t=${SECRET}`,
  `https://open-pay.jp/ja/orders/pickup?s=${SECRET}`,
];

function recordingEnvelope(raw: string | Uint8Array): Envelope {
  return [{ event_id: 'replay-id', sent_at: '' }, [
    [{ type: 'replay_event' }, {
      type: 'replay_event', replay_id: 'replay-id', segment_id: 2, replay_type: 'session',
      urls: [], error_ids: [], trace_ids: [], segment_names: [],
    }],
    [{ type: 'replay_recording', length: raw.length }, raw],
  ]];
}

describe('scrubReplayEvent', () => {
  it.each(urls)('removes credentials from %s without mutating the input', (url) => {
    const event = {
      type: 'replay_event' as const, replay_id: 'replay-id', segment_id: 2,
      urls: [url], initialUrl: url,
      request: { url, query_string: `t=${SECRET}`, headers: { Referer: url, 'x-safe': 'kept' } },
    };
    const original = structuredClone(event);
    const clean = scrubReplayEvent(event);
    expect(clean).toEqual({
      ...event, urls: ['https://open-pay.jp'], initialUrl: 'https://open-pay.jp',
      request: { url: 'https://open-pay.jp', headers: { Referer: 'https://open-pay.jp', 'x-safe': 'kept' } },
    });
    expect(JSON.stringify(clean)).not.toContain(SECRET);
    expect(event).toEqual(original);
  });

  it('scrubs relative URLs, userinfo/path tokens, and invalid URLs', () => {
    expect(scrubReplayEvent({ type: 'replay_event', urls: [
      `/agent#proof=${SECRET}`, `https://user:${SECRET}@hooks.example/${SECRET}`, `https://[invalid]?t=${SECRET}`,
    ] }).urls).toEqual([window.location.origin, 'https://hooks.example', '[invalid-url]']);
  });

  it('leaves non-Replay events and sparse Replay metadata alone', () => {
    const error: Event = { message: 'payment failed', request: { url: urls[0] } };
    expect(scrubReplayEvent(error)).toBe(error);
    expect(scrubReplayEvent({ type: 'replay_event' })).toEqual({ type: 'replay_event' });
  });
});

describe('scrubReplayRecordingEvent', () => {
  it.each(['navigation.push', 'navigation.navigate', 'navigation.reload', 'navigation.back_forward', 'resource.fetch', 'resource.xhr', 'resource.script'])(
    'scrubs %s descriptions and previous URL, keeping timing/status', (op) => {
      const event: ReplayFrameEvent = {
        type: 5, timestamp: 123,
        data: { tag: 'performanceSpan', payload: {
          op, description: urls[0], startTimestamp: 1, endTimestamp: 2,
          data: { previous: urls[1], url: urls[2], statusCode: 200, method: 'GET' },
        } },
      };
      const original = structuredClone(event);
      expect(scrubReplayRecordingEvent(event)).toEqual({
        ...event, data: { tag: 'performanceSpan', payload: {
          ...event.data.payload, description: 'https://open-pay.jp',
          data: { previous: 'https://open-pay.jp', url: 'https://open-pay.jp', statusCode: 200, method: 'GET' },
        } },
      });
      expect(event).toEqual(original);
    },
  );

  it.each(['navigation', 'fetch', 'replay.hydrate-error', 'ui.slowClickDetected', 'ui.multiClick'])(
    'scrubs %s breadcrumb URL fields even outside beforeBreadcrumb categories', (category) => {
      const frame: ReplayFrameEvent = {
        type: 5, timestamp: 123,
        data: { tag: 'breadcrumb', payload: {
          category, type: 'default', timestamp: 1, message: urls[0],
          data: { url: urls[0], from: urls[1], to: urls[2], 'http.query': `t=${SECRET}`, clickCount: 3 },
        } },
      };
      const original = structuredClone(frame);
      const clean = scrubReplayRecordingEvent(frame);
      expect(clean.data.payload).toMatchObject({
        category, message: 'https://open-pay.jp',
        data: { url: 'https://open-pay.jp', from: 'https://open-pay.jp', to: 'https://open-pay.jp', clickCount: 3 },
      });
      expect(JSON.stringify(clean)).not.toContain(SECRET);
      expect(frame).toEqual(original);
    },
  );

  it('keeps non-URL span descriptions and console messages', () => {
    const span: ReplayFrameEvent = { type: 5, timestamp: 1, data: { tag: 'performanceSpan', payload: {
      op: 'paint', description: 'first-contentful-paint', startTimestamp: 1, endTimestamp: 2,
    } } };
    expect(scrubReplayRecordingEvent(span)).toEqual(span);
    const breadcrumb: ReplayFrameEvent = { type: 5, timestamp: 1, data: { tag: 'breadcrumb', payload: {
      category: 'console', type: 'default', timestamp: 1, message: 'payment complete',
    } } };
    expect(scrubReplayRecordingEvent(breadcrumb)).toEqual(breadcrumb);
  });
});

describe('scrubReplayEnvelope', () => {
  it.each([true, false])('processor を通さない Replay metadata も scrub する (recording: %s)', (withRecording) => {
    const envelope = recordingEnvelope('{"segment_id":2}\n[]');
    envelope[1][0][1] = {
      type: 'replay_event', replay_id: 'replay-id', segment_id: 2, replay_type: 'session',
      urls, error_ids: [], trace_ids: [], segment_names: [],
      request: { url: urls[1], query_string: `t=${SECRET}`, headers: { Referer: urls[0], 'x-safe': 'kept' } },
    };
    if (!withRecording) envelope[1].pop();
    const original = structuredClone(envelope);
    const clean = scrubReplayEnvelope(envelope);
    expect(clean[1][0][1]).toMatchObject({
      urls: urls.map(() => 'https://open-pay.jp'),
      request: { url: 'https://open-pay.jp', headers: { Referer: 'https://open-pay.jp', 'x-safe': 'kept' } },
    });
    expect(JSON.stringify(clean)).not.toContain(SECRET);
    expect(envelope).toEqual(original);
  });

  it.each([0, 1, 2, 3, 4, 5, 6])('全 frame type %s の深い DOM 属性/配列にある token URL を除去する', (type) => {
    const attributes = {
      href: `/ja/order/status?t=${SECRET}&lang=ja`,
      src: `https://media.example/image?s=${SECRET}#section`,
      'data-link': `/agent#proof=${SECRET}`,
      style: `background: url("/image?token=${SECRET}&size=20")`,
    };
    const frames = [{ type, timestamp: 123, data: {
      node: { id: 4, childNodes: [{ id: 5, attributes }] },
      attributes: [{ id: 5, attributes: { href: attributes.href } }],
      adds: [{ parentId: 4, node: { id: 6, attributes } }],
    } }];
    const raw = '{"segment_id":2}\n' + JSON.stringify(frames);
    const envelope = recordingEnvelope(raw);
    const clean = scrubReplayEnvelope(envelope);
    const recording = clean[1][1][1] as string;
    expect(recording).not.toContain(SECRET);
    const cleanFrames = JSON.parse(recording.slice(recording.indexOf('\n') + 1));
    expect(cleanFrames[0].data.node.childNodes[0].attributes).toEqual({
      href: '/ja/order/status?t=[Filtered]&lang=ja',
      src: 'https://media.example/image?s=[Filtered]#section',
      'data-link': '/agent#proof=[Filtered]',
      style: 'background: url("/image?token=[Filtered]&size=20")',
    });
    expect(cleanFrames[0].data.attributes[0]).toEqual({
      id: 5, attributes: { href: '/ja/order/status?t=[Filtered]&lang=ja' },
    });
    expect(clean[1][1][0].length).toBe(new TextEncoder().encode(recording).length);
    expect(envelope[1][1][1]).toBe(raw);
  });

  it.each(['?t=', '?s=', '#proof=', '?token=', '#token=', '?lang=ja&token=', '?TOKEN=', '?%74%6f%6B%65%6e='])(
    '%s の値を大小文字/percent encoding/位置にかかわらず除去する', (query) => {
      const raw = '{"segment_id":2}\n' + JSON.stringify([
        { type: 3, data: { attributes: [{ id: 5, attributes: { href: `/target${query}${SECRET}&keep=yes` } }] } },
      ]);
      const clean = scrubReplayEnvelope(recordingEnvelope(raw));
      expect(clean[1][1][1]).not.toContain(SECRET);
      expect(clean[1][1][1]).toContain(`/target${query}[Filtered]&keep=yes`);
    },
  );

  it('重複パラメータと入れ子 URL も除去し、非機密 URL/DOM 文字列/数値は保持する', () => {
    const data = {
      href: `/target?t=${SECRET}&token=${SECRET}#proof=${SECRET}`,
      nested: `https://example.com/?next=https://other.example/?token=${SECRET}&lang=en`,
      safe: '/styles/main.css?v=123#section',
      srcset: '/a.png?v=1 1x, /b.png?v=2 2x',
      textContent: '日本語と token という単語は保持',
      nodeId: 12, checked: true, value: null,
    };
    const raw = '{"segment_id":2}\n' + JSON.stringify([{ type: 6, data }]);
    const clean = scrubReplayEnvelope(recordingEnvelope(raw));
    const recording = clean[1][1][1] as string;
    expect(recording).not.toContain(SECRET);
    expect(JSON.parse(recording.slice(recording.indexOf('\n') + 1))).toEqual([{ type: 6, data: {
      ...data,
      href: '/target?t=[Filtered]&token=[Filtered]#proof=[Filtered]',
      nested: 'https://example.com/?next=https://other.example/?token=[Filtered]&lang=en',
    } }]);
  });

  it.each([
    `/ja/orders/kitchen?t=${SECRET}`,
    `/ja/orders/pickup?s=${SECRET}`,
    `/agent#proof=${SECRET}`,
    `/target?lang=ja&%74oken=${SECRET}`,
    `fragment&token=${SECRET}`,
  ])('percent-encoded な入れ子 URL の token を除去する: %s', (nested) => {
    const href = `/redirect?next=${encodeURIComponent(nested)}&lang=ja`;
    const raw = '{"segment_id":2}\n' + JSON.stringify([
      { type: 2, data: { node: { attributes: { href } } } },
    ]);
    const clean = scrubReplayEnvelope(recordingEnvelope(raw));
    const recording = clean[1][1][1] as string;
    expect(recording).not.toContain(SECRET);
    const frames = JSON.parse(recording.slice(recording.indexOf('\n') + 1));
    expect(frames[0].data.node.attributes.href).toBe(
      `/redirect?next=${encodeURIComponent(nested.replace(SECRET, '[Filtered]'))}&lang=ja`,
    );
  });

  it('入れ子の各 URL が個別に percent-encode されても除去する', () => {
    const nested = `/redirect?next=${encodeURIComponent(`/agent#proof=${SECRET}`)}`;
    const raw = '{"segment_id":2}\n' + JSON.stringify([
      { type: 3, data: { href: `/outer?next=${encodeURIComponent(nested)}` } },
    ]);
    const clean = scrubReplayEnvelope(recordingEnvelope(raw));
    expect(clean[1][1][1]).not.toContain(SECRET);
    expect(clean[1][1][1]).toContain(encodeURIComponent(
      `/redirect?next=${encodeURIComponent('/agent#proof=[Filtered]')}`,
    ));
  });

  it('非機密の encoded URL は大小文字や余分な encoding も含めそのまま保持する', () => {
    const href = '/redirect?next=%2fmenu%3flang%3dja%26label%3d%E6%97%A5%E6%9C%AC%23section&text=a+b';
    const raw = '{"segment_id":2}\n' + JSON.stringify([{ type: 2, data: { href } }]);
    expect(scrubReplayEnvelope(recordingEnvelope(raw))[1][1][1]).toBe(raw);
  });

  it('入れ子 URL の encoding が不正なら Replay を捨て、決済エラーは保持する', () => {
    const raw = '{"segment_id":2}\n' + JSON.stringify([
      { type: 2, data: { href: `/redirect?next=%2Ftarget%3Ft%3D${SECRET}%ZZ` } },
    ]);
    const envelope = recordingEnvelope(raw);
    const error: Envelope[1][number] = [{ type: 'event' }, { message: 'payment failed' }];
    (envelope[1] as Array<Envelope[1][number]>).push(error);
    expect(scrubReplayEnvelope(envelope)).toEqual([envelope[0], [error]]);
  });

  it('scrubs every rrweb Meta href, retaining snapshots, dimensions and UTF-8 byte lengths', () => {
    const frames = [
      ...urls.map((href) => ({ type: 4, timestamp: 123, data: { href, width: 1280, height: 720 } })),
      { type: 2, timestamp: 124, data: { node: { textContent: '日本語' } } },
    ];
    const raw = '{"segment_id":2}\n' + JSON.stringify(frames);
    const envelope = recordingEnvelope(raw);
    const clean = scrubReplayEnvelope(envelope);
    const recording = clean[1][1][1] as string;
    expect(JSON.parse(recording.slice(recording.indexOf('\n') + 1))).toEqual([
      ...urls.map(() => ({ type: 4, timestamp: 123, data: { href: 'https://open-pay.jp', width: 1280, height: 720 } })),
      frames.at(-1),
    ]);
    expect(recording.startsWith('{"segment_id":2}\n')).toBe(true);
    expect(clean[1][1][0].length).toBe(new TextEncoder().encode(recording).length);
    expect(recording).not.toContain(SECRET);
    expect(envelope[1][1][1]).toBe(raw);
  });

  it.each(['malformed', '{"segment_id":0}\n{', '{"segment_id":0}\n{}', new Uint8Array([1, 2, 3])])(
    'drops only Replay on unsupported recording %s, preserving error telemetry', (raw) => {
      const error: Envelope[1][number] = [{ type: 'event' }, { message: 'payment failed' }];
      const envelope = recordingEnvelope(raw);
      // 想定外の混在 envelope でも独立した error telemetry は保持する。
      (envelope[1] as Array<Envelope[1][number]>).push(error);
      expect(scrubReplayEnvelope(envelope)).toEqual([envelope[0], [error]]);
    },
  );

  it('passes through unrelated envelopes by identity', () => {
    const envelope: Envelope = [{ event_id: 'error-id', sent_at: '' }, [[{ type: 'event' }, { message: 'payment failed' }]]];
    expect(scrubReplayEnvelope(envelope)).toBe(envelope);
  });
});

it('実 SDK の full snapshot にある ?t= リンクと Meta は送信境界で token を除去する', async () => {
  // SDK は jsdom に window があっても Node を除外する。renderer 分岐を使い、
  // SDK 内部を変更せずに browser recorder を検証する。
  vi.stubGlobal('process', { ...process, type: 'renderer' });
  const sdk = await import('@sentry/browser');
  const sent: Envelope[] = [];
  const rawRecordings: string[] = [];
  const originalUrl = window.location.href;
  const link = document.createElement('a');
  const statusToken = 'order-status-token-in-dom';
  link.href = `/ja/order/status?t=${statusToken}`;
  link.textContent = '注文状況';
  document.body.append(link);
  window.history.replaceState(null, '', `/agent#proof=${SECRET}`);
  sdk.init({
    dsn: 'https://public@o0.ingest.sentry.io/1', defaultIntegrations: [],
    integrations: [], replaysSessionSampleRate: 1, replaysOnErrorSampleRate: 0.2,
    transport: () => ({
      send: async (envelope) => {
        sent.push(envelope);
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
  });
  sdk.getClient()!.on('beforeEnvelope', (envelope) => {
    for (const [header, payload] of envelope[1]) {
      if (header.type === 'replay_recording') rawRecordings.push(payload as string);
    }
  });
  expect(sdk.getReplay()).toBeUndefined();
  const { installSentryReplay } = await import('@/lib/sentryReplayLazy');
  installSentryReplay();
  const replay = sdk.getReplay()!;
  try {
    await replay.flush();
    expect(JSON.stringify(sent)).not.toContain(SECRET);
    expect(JSON.stringify(sent)).not.toContain(statusToken);
    expect(rawRecordings.length).toBeGreaterThan(0);
    expect(rawRecordings.join('')).toContain(SECRET);
    const rawFrames = rawRecordings.flatMap((recording) =>
      JSON.parse(recording.slice(recording.indexOf('\n') + 1)) as Array<{ type: number; data: unknown }>,
    );
    // 遅延 addIntegration でも init 時の両 sampling rate が recorder に渡る。
    expect(rawFrames).toContainEqual(expect.objectContaining({
      type: 5, data: expect.objectContaining({ tag: 'options', payload: expect.objectContaining({
        sessionSampleRate: 1, errorSampleRate: 0.2,
      }) }),
    }));
    expect(JSON.stringify(rawFrames.filter((frame) => frame.type === 2))).toContain(statusToken);
    const replayItem = sent.flatMap<Envelope[1][number]>((envelope) => envelope[1])
      .find(([header]) => header.type === 'replay_event');
    expect(replayItem?.[1]).toMatchObject({ urls: [window.location.origin] });
    expect(JSON.stringify(sent)).toContain('/ja/order/status?t=[Filtered]');
    expect(sent.some((envelope) => envelope[1].some(([header]) => header.type === 'replay_recording'))).toBe(true);
  } finally {
    await replay.stop({ flush: false });
    await sdk.close();
    link.remove();
    window.history.replaceState(null, '', originalUrl);
    vi.unstubAllGlobals();
  }
});
