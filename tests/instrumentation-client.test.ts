import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  captureRouterTransitionStart: vi.fn(),
  // 遅延化前の実装でも読める stub。初期化時の呼び出しは下で禁止する。
  replayIntegration: vi.fn(() => ({ name: 'Replay' })),
  addEventProcessor: vi.fn(),
}));
const lazy = vi.hoisted(() => ({ loaded: vi.fn(), installSentryReplay: vi.fn() }));

vi.mock('@sentry/nextjs', () => sentry);
vi.mock('@/lib/sentryReplayLazy', () => {
  lazy.loaded();
  return { installSentryReplay: lazy.installSentryReplay };
});

describe('instrumentation-client telemetry hooks', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    lazy.installSentryReplay.mockReset();
    vi.useFakeTimers();
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://test@o0.ingest.sentry.io/0');
    vi.stubEnv('NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE', '0');
    vi.stubEnv('NEXT_PUBLIC_SENTRY_REPLAY_ERROR_SAMPLE_RATE', '0.2');
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete');
    vi.stubGlobal('requestIdleCallback', undefined);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('初期 bundle に Replay の static import / transport wrapper を含めない', async () => {
    const source = readFileSync('instrumentation-client.ts', 'utf8');
    expect(source).not.toMatch(/(?:from\s+|^import\s*)['"][^'"]*sentryReplay/m);
    expect(source).not.toMatch(/Sentry\.(replayIntegration|makeFetchTransport)/);
    expect(source).toMatch(/import\(['"]@\/lib\/sentryReplayLazy['"]\)/);
    await import('@/instrumentation-client');
    expect(sentry.init.mock.calls[0][0]).not.toHaveProperty('transport');
    expect(sentry.init.mock.calls[0][0].integrations).toEqual([]);
    expect(lazy.loaded).not.toHaveBeenCalled();
  });

  it('load 後の idle callback まで Replay を import せず、sampling は init に保持する', async () => {
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
    const idle = vi.fn();
    vi.stubGlobal('requestIdleCallback', idle);
    await import('@/instrumentation-client');
    expect(sentry.init.mock.calls[0][0]).toMatchObject({
      replaysSessionSampleRate: 0, replaysOnErrorSampleRate: 0.2,
    });
    expect(idle).not.toHaveBeenCalled();
    expect(lazy.loaded).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('load'));
    expect(idle).toHaveBeenCalledOnce();
    expect(lazy.loaded).not.toHaveBeenCalled();
    idle.mock.calls[0][0]();
    await vi.dynamicImportSettled();
    expect(lazy.loaded).toHaveBeenCalledOnce();
    expect(lazy.installSentryReplay).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event('load'));
    expect(idle).toHaveBeenCalledOnce();
  });

  it('load 済みかつ idle API がないブラウザでは timer で遅延登録する', async () => {
    await import('@/instrumentation-client');
    expect(lazy.loaded).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    await vi.dynamicImportSettled();
    expect(lazy.installSentryReplay).toHaveBeenCalledOnce();
  });

  it('Replay の読込/初期化失敗をアプリへ波及させない', async () => {
    lazy.installSentryReplay.mockImplementation(() => { throw new Error('Replay unavailable'); });
    await import('@/instrumentation-client');
    await vi.runAllTimersAsync();
    await vi.dynamicImportSettled();
    expect(lazy.installSentryReplay).toHaveBeenCalledOnce();
    expect(sentry.init).toHaveBeenCalledOnce();
  });

  it('DSN 未設定・両 sampling rate 0 では Replay を読み込まない', async () => {
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', '');
    await import('@/instrumentation-client');
    expect(sentry.init).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://test@o0.ingest.sentry.io/0');
    vi.stubEnv('NEXT_PUBLIC_SENTRY_REPLAY_ERROR_SAMPLE_RATE', '0');
    await import('@/instrumentation-client');
    expect(sentry.init.mock.calls[0][0].integrations).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(lazy.loaded).not.toHaveBeenCalled();
  });

  it('ignoreErrors が non-Error 拒否の両文言 (value 形式 / DOM Event 形式) を落とす', async () => {
    await import('@/instrumentation-client');
    const options = sentry.init.mock.calls[0][0] as {
      ignoreErrors: RegExp[];
    };
    const matches = (msg: string) =>
      options.ignoreErrors.some((re) => re.test(msg));
    // 既存: 値付きの non-Error 拒否
    expect(
      matches('Non-Error promise rejection captured with value: undefined'),
    ).toBe(true);
    // 2026-08-18 実観測の兄弟パターン: DOM Event が拒否理由のときの別文言
    expect(
      matches('Event `Event` (type=error) captured as promise rejection'),
    ).toBe(true);
    // 実シグナル (自前 Error) は落とさない
    expect(matches('Error: relay settle failed')).toBe(false);
  });

  it('ignoreErrors がブラウザ内蔵翻訳起因の 2 文言 (React removeChild / 注入 iframe) を落とす', async () => {
    await import('@/instrumentation-client');
    const options = sentry.init.mock.calls[0][0] as { ignoreErrors: RegExp[] };
    const matches = (msg: string) => options.ignoreErrors.some((re) => re.test(msg));
    // 2026-08-23 mainnet 実観測 (iPhone / Whale・ページ翻訳)
    expect(matches('NotFoundError: The object can not be found here.')).toBe(true);
    expect(
      matches("TypeError: null is not an object (evaluating 'e.contentDocument.body')"),
    ).toBe(true);
    // 似て非なる実シグナルは落とさない
    expect(matches('NotFoundError: order not found')).toBe(false);
    expect(matches("TypeError: null is not an object (evaluating 'order.items')")).toBe(false);
  });

  it('beforeBreadcrumb / beforeSendTransaction に URL scrubber を設定する', async () => {
    await import('@/instrumentation-client');

    expect(sentry.init).toHaveBeenCalledOnce();
    const options = sentry.init.mock.calls[0][0] as {
      beforeBreadcrumb: (breadcrumb: {
        category: string;
        data: Record<string, unknown>;
      }) => unknown;
      beforeSendTransaction: (event: {
        type: 'transaction';
        spans: Array<{
          data: Record<string, unknown>;
          span_id: string;
          trace_id: string;
          start_timestamp: number;
        }>;
      }) => unknown;
    };
    const secret = 'Bearer-instrumentation-secret';
    const url = `https://user:${secret}@hooks.example.com/hook/${secret}?token=${secret}`;

    const breadcrumb = options.beforeBreadcrumb({
      category: 'fetch',
      data: { url },
    });
    const transaction = options.beforeSendTransaction({
      type: 'transaction',
      spans: [
        {
          data: { 'http.url': url },
          span_id: '1'.repeat(16),
          trace_id: '2'.repeat(32),
          start_timestamp: 1,
        },
      ],
    });

    expect(JSON.stringify(breadcrumb)).not.toContain(secret);
    expect(JSON.stringify(transaction)).not.toContain(secret);
    expect(JSON.stringify(breadcrumb)).toContain('https://hooks.example.com');
    expect(JSON.stringify(transaction)).toContain('https://hooks.example.com');
  });
});
