import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { COVERAGE_THRESHOLDS, evaluateCoverage } from '../../scripts/lib/coverageThresholds.mjs';
import UnhandledErrorsReporter, { evaluateUnhandled } from '../../scripts/lib/unhandledErrorsReporter.mjs';

// scripts/run-tests.mjs の合否 (coverage の下限・assertion の外の未処理エラー) を決める純関数を固定する。
// 判定を「常に ok」に変えても source の文字列検査 (workflow-guards) は通ってしまうため、値で確かめる。

function summary(pcts: Partial<Record<keyof typeof COVERAGE_THRESHOLDS, number>>): string {
  const total = Object.fromEntries(
    Object.entries({ ...COVERAGE_THRESHOLDS, ...pcts }).map(([metric, pct]) => [metric, { pct }]),
  );
  return JSON.stringify({ total });
}

describe('evaluateCoverage', () => {
  it('全指標が下限ちょうどなら ok', () => {
    const verdict = evaluateCoverage(summary({}));
    expect(verdict).toMatchObject({ ok: true, readable: true });
    expect(verdict.results.map((r) => r.metric).sort()).toEqual(Object.keys(COVERAGE_THRESHOLDS).sort());
  });

  it.each(Object.keys(COVERAGE_THRESHOLDS) as (keyof typeof COVERAGE_THRESHOLDS)[])(
    '%s が下限を 0.01 割ったら fail',
    (metric) => {
      const verdict = evaluateCoverage(summary({ [metric]: COVERAGE_THRESHOLDS[metric] - 0.01 }));
      expect(verdict.ok).toBe(false);
      expect(verdict.results.find((r) => r.metric === metric)?.pass).toBe(false);
    },
  );

  it('指標が欠けている・数値でないなら fail', () => {
    expect(evaluateCoverage(JSON.stringify({ total: { lines: { pct: 99 } } })).ok).toBe(false);
    expect(evaluateCoverage(summary({ branches: 'Unknown' as unknown as number })).ok).toBe(false);
  });

  it.each([
    ['要約が無い', null],
    ['不正な JSON', '{'],
    ['total が無い', '{}'],
    ['JSON の null', 'null'],
  ])('%s なら読めない扱いで fail', (_label, text) => {
    expect(evaluateCoverage(text)).toEqual({ ok: false, readable: false, results: [] });
  });
});

describe('evaluateUnhandled', () => {
  it('0 件なら ok', () => {
    expect(evaluateUnhandled(JSON.stringify({ count: 0, messages: [] }))).toEqual({
      ok: true,
      readable: true,
      count: 0,
      messages: [],
    });
  });

  it('1 件でもあれば fail (メッセージを返す)', () => {
    const verdict = evaluateUnhandled(JSON.stringify({ count: 1, messages: ['Error: boom'] }));
    expect(verdict).toEqual({ ok: false, readable: true, count: 1, messages: ['Error: boom'] });
  });

  it.each([
    ['書かれていない', null],
    ['不正な JSON', '{'],
    ['count が無い', '{}'],
    ['count が負', JSON.stringify({ count: -1 })],
    ['count が整数でない', JSON.stringify({ count: '0' })],
  ])('%s なら fail (vitest が最後まで進まなかった扱い)', (_label, text) => {
    expect(evaluateUnhandled(text)).toMatchObject({ ok: false, readable: false });
  });
});

describe('UnhandledErrorsReporter', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
    delete process.env.RUN_TESTS_UNHANDLED_OUT;
  });

  it('onFinished の errors を数えて書き、evaluateUnhandled がそれを fail にする', () => {
    dir = mkdtempSync(join(tmpdir(), 'run-tests-verdict-'));
    const out = join(dir, 'unhandled.json');
    process.env.RUN_TESTS_UNHANDLED_OUT = out;
    new UnhandledErrorsReporter().onFinished([], [new Error('probe-uncaught')]);
    const verdict = evaluateUnhandled(readFileSync(out, 'utf8'));
    expect(verdict).toMatchObject({ ok: false, readable: true, count: 1 });
    expect(verdict.messages[0]).toContain('probe-uncaught');
  });

  it('errors が無ければ 0 件を書く', () => {
    dir = mkdtempSync(join(tmpdir(), 'run-tests-verdict-'));
    const out = join(dir, 'unhandled.json');
    process.env.RUN_TESTS_UNHANDLED_OUT = out;
    new UnhandledErrorsReporter().onFinished([]);
    expect(evaluateUnhandled(readFileSync(out, 'utf8')).ok).toBe(true);
  });
});
