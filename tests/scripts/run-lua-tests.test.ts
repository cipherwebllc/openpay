// @vitest-environment node
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LUA_REAL_TEST_FILES } from '../../scripts/lib/luaRealTests.mjs';

const h = vi.hoisted(() => ({ spawn: vi.fn(), readFileSync: vi.fn(), rmSync: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: h.spawn }));
vi.mock('node:fs', async (original) => ({
  ...await original<typeof import('node:fs')>(),
  mkdtempSync: () => '/unused-lua-runner-test',
  readFileSync: h.readFileSync,
  rmSync: h.rmSync,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

type Report = { numFailedTests: number; numPassedTests: number; numTotalTests: number; testResults: { name: string; status?: string; message?: string }[] };
const passingReport = (): Report => ({
  numFailedTests: 0,
  numPassedTests: LUA_REAL_TEST_FILES.length,
  numTotalTests: LUA_REAL_TEST_FILES.length,
  testResults: LUA_REAL_TEST_FILES.map((file) => ({ name: resolve(file), status: 'passed' })),
});
const NO_UNHANDLED = JSON.stringify({ count: 0, messages: [] });

// 1 attempt ごとに、vitest の JSON (result.json) と未処理エラーの集計 (unhandled.json) を返す子プロセスを差し込む。
// unhandled が null = reporter が書かなかった (vitest が最後まで進まなかった)。
function stubAttempts(attempts: { report: Report; unhandled: string | null }[]) {
  h.spawn.mockImplementation(() => {
    const { report, unhandled } = attempts[h.spawn.mock.calls.length - 1];
    h.readFileSync.mockImplementation((path: string) => {
      if (path.endsWith('result.json')) return JSON.stringify(report);
      if (path.endsWith('unhandled.json') && unhandled !== null) return unhandled;
      throw new Error(`ENOENT: ${path}`);
    });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0));
    return child;
  });
}

async function runRunner(maxAttempts: number) {
  vi.resetModules();
  vi.stubEnv('LUA_TESTS_MAX_ATTEMPTS', String(maxAttempts));
  vi.stubEnv('LUA_TESTS_ATTEMPT_TIMEOUT_MS', '60000');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const exited = new Error('process.exit');
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw exited; });
  await expect(import('../../scripts/run-lua-tests.mjs')).rejects.toBe(exited);
  return { exitCode: exit.mock.calls[0]?.[0], errors: error.mock.calls.flat().join('\n') };
}

describe('real-Lua runner retry visibility', () => {
  it.each([
    { name: 'first-attempt success', outcomes: [true], maxAttempts: 3, exitCode: 0 },
    { name: 'second-attempt success', outcomes: [false, true], maxAttempts: 3, exitCode: 0 },
    { name: 'third-attempt success', outcomes: [false, false, true], maxAttempts: 3, exitCode: 0 },
    { name: 'exhausted retries', outcomes: [false, false, false], maxAttempts: 3, exitCode: 1 },
    { name: 'failure with retries disabled', outcomes: [false], maxAttempts: 1, exitCode: 1 },
  ])('$name preserves the exit code and warns for each retry', async ({ outcomes, maxAttempts, exitCode }) => {
    vi.resetModules();
    vi.stubEnv('LUA_TESTS_MAX_ATTEMPTS', String(maxAttempts));
    vi.stubEnv('LUA_TESTS_ATTEMPT_TIMEOUT_MS', '60000');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exited = new Error('process.exit');
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw exited; });
    const warningsAtSpawn: number[] = [];

    h.spawn.mockImplementation(() => {
      const attempt = h.spawn.mock.calls.length;
      // A retry must already be visible even if the next child never finishes.
      warningsAtSpawn.push(warning.mock.calls.length);
      const child = new EventEmitter();
      const ok = outcomes[attempt - 1];
      const report = JSON.stringify({
        numFailedTests: ok ? 0 : 1,
        numPassedTests: ok ? LUA_REAL_TEST_FILES.length : LUA_REAL_TEST_FILES.length - 1,
        numTotalTests: LUA_REAL_TEST_FILES.length,
        testResults: LUA_REAL_TEST_FILES.map((file) => ({ name: resolve(file) })),
      });
      h.readFileSync.mockImplementation((path: string) => (path.endsWith('unhandled.json') ? NO_UNHANDLED : report));
      queueMicrotask(() => child.emit('exit', ok ? 0 : 1));
      return child;
    });

    await expect(import('../../scripts/run-lua-tests.mjs')).rejects.toBe(exited);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(exitCode);
    expect(h.spawn).toHaveBeenCalledTimes(outcomes.length);
    expect(h.rmSync).toHaveBeenCalledTimes(outcomes.length);
    expect(warningsAtSpawn).toEqual(outcomes.map((_, index) => index));
    expect(warning.mock.calls).toEqual(outcomes.slice(1).map((_, index) => [
      expect.stringMatching(new RegExp(`^::warning::.*attempt ${index + 2}/${maxAttempts}`)),
    ]));
  });
});

// assertion の失敗 (numFailedTests) に載らない壊れ方も、その attempt の失敗に数える (以前は素通りした)。
describe('real-Lua runner: failures outside assertions', () => {
  it.each([
    {
      name: 'an import-time exception (file-level failure)',
      attempt: () => {
        const report = passingReport();
        report.testResults[0] = { name: report.testResults[0].name, status: 'failed', message: 'probe: import-time failure' };
        report.numPassedTests -= 1;
        report.numTotalTests -= 1;
        return { report, unhandled: NO_UNHANDLED };
      },
      reason: /file-level failure: .*probe: import-time failure/,
    },
    {
      name: 'an afterAll exception (all tests passed)',
      attempt: () => {
        const report = passingReport();
        report.testResults[0] = { ...report.testResults[0], status: 'failed', message: 'probe: afterAll failure' };
        return { report, unhandled: NO_UNHANDLED };
      },
      reason: /file-level failure: .*probe: afterAll failure/,
    },
    {
      name: 'an unhandled rejection',
      attempt: () => ({ report: passingReport(), unhandled: JSON.stringify({ count: 1, messages: ['Error: probe-unhandled'] }) }),
      reason: /1 unhandled error\(s\): Error: probe-unhandled/,
    },
    {
      name: 'a missing unhandled-error summary',
      attempt: () => ({ report: passingReport(), unhandled: null }),
      reason: /unhandled-error summary not written/,
    },
  ])('$name fails every attempt and exits 1', async ({ attempt, reason }) => {
    stubAttempts([attempt(), attempt()]);
    const { exitCode, errors } = await runRunner(2);
    expect(exitCode).toBe(1);
    expect(h.spawn).toHaveBeenCalledTimes(2);
    expect(errors).toMatch(reason);
    expect(errors).toContain('2 attempts exhausted');
  });

  it('a clean attempt after such a failure still passes (the retry semantics are unchanged)', async () => {
    stubAttempts([
      { report: passingReport(), unhandled: JSON.stringify({ count: 1, messages: ['Error: probe-unhandled'] }) },
      { report: passingReport(), unhandled: NO_UNHANDLED },
    ]);
    const { exitCode } = await runRunner(3);
    expect(exitCode).toBe(0);
    expect(h.spawn).toHaveBeenCalledTimes(2);
  });

  it('runs vitest with the unhandled-error reporter and tells it where to write', async () => {
    stubAttempts([{ report: passingReport(), unhandled: NO_UNHANDLED }]);
    await runRunner(1);
    const [, args, options] = h.spawn.mock.calls[0];
    expect(args).toContain('--reporter=./scripts/lib/unhandledErrorsReporter.mjs');
    expect(options.env.RUN_TESTS_UNHANDLED_OUT).toBe('/unused-lua-runner-test/unhandled.json');
  });
});

