import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '@/lib/logger';

let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
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
});
