import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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


function ownSourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(tsx?|m?js)$/.test(entry.name)) files.push(path);
    }
  };
  for (const dir of ['app', 'components', 'hooks', 'lib']) walk(dir);
  return [...files, 'instrumentation-client.ts', 'public/sw.js'];
}

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

  it('手元 (localhost 等) から送る event の environment は local-<network> にする', async () => {
    // テストの jsdom のページは http://test.local (手元扱い)。本番のホスト名の判定は tests/lib/sentryEnvironment.test.ts。
    expect(window.location.hostname).toBe('test.local');
    vi.stubEnv('NEXT_PUBLIC_NETWORK_ENV', 'mainnet');
    await import('@/instrumentation-client');
    expect((sentry.init.mock.calls[0][0] as { environment: string }).environment).toBe('local-mainnet');
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

  it('ignoreErrors が端末の容量不足による IndexedDB の作成失敗 (ウォレット SDK 起因) を落とす', async () => {
    await import('@/instrumentation-client');
    const options = sentry.init.mock.calls[0][0] as { ignoreErrors: RegExp[] };
    const matches = (msg: string) => options.ignoreErrors.some((re) => re.test(msg));
    // 2026-10-04 mainnet 実観測 (iPhone / Mobile Safari・トップ・OPENPAY-3C)
    expect(
      matches('UnknownError: Error creating Records table (13) - database or disk is full'),
    ).toBe(true);
    // 似て非なる実シグナルは落とさない
    expect(matches('QuotaExceededError: The quota has been exceeded.')).toBe(false);
    expect(matches('Error: database query failed')).toBe(false);
  });

  it('ignoreErrors がアプリ内ブラウザ (WKWebView) の破棄で届かなかったネイティブ宛てメッセージを落とす', async () => {
    await import('@/instrumentation-client');
    const options = sentry.init.mock.calls[0][0] as { ignoreErrors: RegExp[] };
    const matches = (msg: string) => options.ignoreErrors.some((re) => re.test(msg));
    // 2026-09-23 mainnet 実観測 (/:locale/create)
    expect(matches('Error: The WKWebView was deallocated before the message was delivered')).toBe(true);
    // 似て非なる実シグナルは落とさない
    expect(matches('Error: message was not delivered to the shop')).toBe(false);
  });

  it('ignoreErrors が WalletConnect の proposal 期限切れと拡張機能 API の失敗を落とす', async () => {
    await import('@/instrumentation-client');
    const options = sentry.init.mock.calls[0][0] as { ignoreErrors: RegExp[] };
    const matches = (msg: string) => options.ignoreErrors.some((re) => re.test(msg));
    // 2026-09 に Sentry で観測 (トップ)
    expect(matches('Error: Proposal expired')).toBe(true);
    expect(matches('Proposal expired')).toBe(true);
    expect(matches('Error: Invalid call to runtime.sendMessage(). Tab not found.')).toBe(true);
    // 似て非なる実シグナルは落とさない
    expect(matches('Error: Proposal expired before the order was paid')).toBe(false);
    expect(matches('Error: quote expired')).toBe(false);
    expect(matches('Error: Invalid call to relay settle')).toBe(false);
  });

  // 上の環境由来フィルタが自前の失敗を隠さない前提: 自前コードはこれらのブラウザ機能を使わない。
  // 使い始めたらテストが落ちるので、そのときは該当フィルタを見直す。
  it.each([
    ['IndexedDB (容量不足フィルタ)', /\bindexedDB\b/],
    ['WKWebView のネイティブ宛てメッセージ (WKWebView 破棄フィルタ)', /\bmessageHandlers\b/],
    ['拡張機能 API (runtime.sendMessage フィルタ)', /\b(?:chrome|browser)\.runtime\b/],
    // フィルタ自身 (instrumentation-client.ts の正規表現) は除いて、自前のエラー文言に使っていないことを見る。
    ['WalletConnect の期限切れ文言 (Proposal expired フィルタ)', /Proposal expired/],
  ])('自前コードは %s を使わない', (_label, pattern) => {
    const users = ownSourceFiles()
      .filter((file) => file !== 'instrumentation-client.ts')
      .filter((file) => pattern.test(readFileSync(file, 'utf8')));
    expect(users).toEqual([]);
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
