import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

import { logger } from '@/lib/logger';
import * as Sentry from '@sentry/nextjs';

let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.mocked(Sentry.captureMessage).mockClear();
  vi.mocked(Sentry.captureException).mockClear();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

function lastJSON(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const last = spy.mock.calls.at(-1);
  expect(last).toBeDefined();
  return JSON.parse(last![0] as string);
}

describe('logger', () => {
  it('error は console.error に JSON 出力', () => {
    logger.error('boom', { code: 42 });
    const j = lastJSON(errorSpy);
    expect(j.level).toBe('error');
    expect(j.msg).toBe('boom');
    expect(j.code).toBe(42);
    expect(typeof j.ts).toBe('string');
  });

  it('warn は console.warn に', () => {
    logger.warn('hmm');
    expect(lastJSON(warnSpy).level).toBe('warn');
  });

  it('既定 level=warn のため info は出力されない', () => {
    logger.info('quiet');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('Error オブジェクトは name/message/stack に展開', () => {
    const e = new Error('failure-x');
    logger.error('payment.failed', { error: e });
    const j = lastJSON(errorSpy);
    const err = j.error as { name: string; message: string; stack: string };
    expect(err.name).toBe('Error');
    expect(err.message).toBe('failure-x');
    expect(err.stack).toContain('failure-x');
  });

  it('bigint をフィールドに含めても throw しない (top-level)', () => {
    expect(() => logger.error('big', { n: 999999999999n })).not.toThrow();
    expect(lastJSON(errorSpy).n).toBe('999999999999');
  });

  it('bigint がネストしていても throw しない (replacer 経由)', () => {
    expect(() =>
      logger.error('nested', { data: { block: 12345n, ok: true } }),
    ).not.toThrow();
    const j = lastJSON(errorSpy);
    expect((j.data as { block: string }).block).toBe('12345');
  });

  it('複数フィールドの順序保持と型を確認', () => {
    logger.error('event', {
      a: 'x',
      b: 1,
      c: true,
      d: null,
    });
    const j = lastJSON(errorSpy);
    expect(j.a).toBe('x');
    expect(j.b).toBe(1);
    expect(j.c).toBe(true);
    expect(j.d).toBeNull();
  });

  describe('Sentry 連携', () => {
    it('logger.error → Sentry.captureMessage が呼ばれる (Error 無し)', () => {
      logger.error('payment.failed', { code: 42 });
      expect(Sentry.captureMessage).toHaveBeenCalledOnce();
      const [msg, opts] = vi.mocked(Sentry.captureMessage).mock.calls[0];
      expect(msg).toBe('payment.failed');
      const o = opts as { level: string; extra: { code: number } };
      expect(o.level).toBe('error');
      expect(o.extra.code).toBe(42);
      expect(Sentry.captureException).not.toHaveBeenCalled();
    });

    it('logger.warn → Sentry.captureMessage に warning level で送信 (Sentry SeverityLevel に変換)', () => {
      logger.warn('webhook.non_ok', { status: 500 });
      const [msg, opts] = vi.mocked(Sentry.captureMessage).mock.calls[0];
      expect(msg).toBe('webhook.non_ok');
      expect((opts as { level: string }).level).toBe('warning');
    });

    it('logger.error に Error オブジェクトを含む → captureException で stack 保持', () => {
      const e = new Error('AA21 prefund');
      logger.error('payment.failed', { error: e });
      expect(Sentry.captureException).toHaveBeenCalledOnce();
      const [arg, opts] = vi.mocked(Sentry.captureException).mock.calls[0];
      expect(arg).toBe(e);
      const o = opts as { level: string; tags: { event: string } };
      expect(o.level).toBe('error');
      expect(o.tags.event).toBe('payment.failed');
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });

    it('logger.info / logger.debug は Sentry に送信しない (event ノイズ防止)', () => {
      logger.info('payment.success', { txHash: '0xabc' });
      logger.debug('detail', {});
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
      expect(Sentry.captureException).not.toHaveBeenCalled();
    });

    it('複数フィールドのうち最初の Error を captureException に渡す', () => {
      const e1 = new Error('first');
      logger.error('event', { ctx: 'a', error: e1, other: 'b' });
      const [arg] = vi.mocked(Sentry.captureException).mock.calls[0];
      expect(arg).toBe(e1);
    });
  });
});
