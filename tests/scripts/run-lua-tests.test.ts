// @vitest-environment node
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LUA_REAL_TEST_FILES, LUA_WITHOUT_REAL_TEST } from '../../scripts/lib/luaRealTests.mjs';

const h = vi.hoisted(() => ({
  spawn: vi.fn(), readFileSync: vi.fn(), rmSync: vi.fn(), readExecutedLua: vi.fn(), checkLuaRealCoverage: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawn: h.spawn }));
vi.mock('node:fs', async (original) => ({
  ...await original<typeof import('node:fs')>(),
  mkdtempSync: () => '/unused-lua-runner-test',
  readFileSync: h.readFileSync,
  rmSync: h.rmSync,
}));
// 実 Lua テストの網 (repo の Lua の構文木解析) は tests/scripts/lua-sources.test.ts が検証する。ここでは判定の配線だけを見る。
vi.mock('../../scripts/lib/luaSources.mjs', () => ({
  readExecutedLua: h.readExecutedLua,
  checkLuaRealCoverage: h.checkLuaRealCoverage,
}));

beforeEach(() => {
  h.readExecutedLua.mockReturnValue(["return redis.call('GET', KEYS[1])"]);
  h.checkLuaRealCoverage.mockReturnValue({ executed: 1, missing: [], stale: [], errors: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

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
      h.readFileSync.mockReturnValueOnce(JSON.stringify({
        numFailedTests: ok ? 0 : 1,
        numPassedTests: ok ? LUA_REAL_TEST_FILES.length : LUA_REAL_TEST_FILES.length - 1,
        numTotalTests: LUA_REAL_TEST_FILES.length,
        testResults: LUA_REAL_TEST_FILES.map((file) => ({ name: resolve(file) })),
      }));
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

// 第 7 回レビュー C5 / F10: 実 Lua テストで 1 度も実行されなかった Lua を、test が全部通った attempt で判定する。
describe('real-Lua net (Lua executed by the real-Lua tests)', () => {
  async function run(outcomes: boolean[]) {
    vi.resetModules();
    vi.stubEnv('LUA_TESTS_MAX_ATTEMPTS', '3');
    vi.stubEnv('LUA_TESTS_ATTEMPT_TIMEOUT_MS', '60000');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exited = new Error('process.exit');
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw exited; });
    h.spawn.mockImplementation(() => {
      const ok = outcomes[h.spawn.mock.calls.length - 1];
      h.readFileSync.mockReturnValueOnce(JSON.stringify({
        numFailedTests: ok ? 0 : 1,
        numPassedTests: ok ? LUA_REAL_TEST_FILES.length : LUA_REAL_TEST_FILES.length - 1,
        numTotalTests: LUA_REAL_TEST_FILES.length,
        testResults: LUA_REAL_TEST_FILES.map((file) => ({ name: resolve(file) })),
      }));
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', ok ? 0 : 1));
      return child;
    });
    await expect(import('../../scripts/run-lua-tests.mjs')).rejects.toBe(exited);
    return { exit, warn, error };
  }

  it('記録先を子 (vitest) に渡し、通った attempt の記録だけを repo の Lua と突き合わせる', async () => {
    const { exit } = await run([false, true]);
    expect(exit).toHaveBeenCalledWith(0);
    for (const [, , options] of h.spawn.mock.calls) {
      expect(options.env.LUA_REAL_COVERAGE_FILE).toBe('/unused-lua-runner-test/lua-coverage.jsonl');
    }
    expect(h.checkLuaRealCoverage).toHaveBeenCalledTimes(1);
    expect(h.checkLuaRealCoverage).toHaveBeenCalledWith({
      root: process.cwd(),
      executed: ["return redis.call('GET', KEYS[1])"],
      allowlist: LUA_WITHOUT_REAL_TEST,
    });
  });

  it('実 Lua テストの無い Lua が一覧の外にあれば、再試行せずに exit 1 で id を出す', async () => {
    h.checkLuaRealCoverage.mockReturnValue({ executed: 3, missing: ['lib/new.ts#NEW_LUA'], stale: [], errors: [] });
    const { exit, error } = await run([true]);
    expect(exit).toHaveBeenCalledWith(1);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(error.mock.calls.flat().join('\n')).toContain('lib/new.ts#NEW_LUA');
  });

  it('一覧に残っているのに実行された Lua は warning で消すよう促し、成功は変えない', async () => {
    h.checkLuaRealCoverage.mockReturnValue({ executed: 3, missing: [], stale: ['lib/old.ts#COVERED_NOW'], errors: [] });
    const { exit, warn } = await run([true]);
    expect(exit).toHaveBeenCalledWith(0);
    expect(warn.mock.calls.flat()).toEqual([expect.stringMatching(/^::warning::.*lib\/old\.ts#COVERED_NOW.*LUA_WITHOUT_REAL_TEST/)]);
  });

  it('解析できない送信式があれば (網の外に Lua がある) exit 1 にする (fail-closed)', async () => {
    h.checkLuaRealCoverage.mockReturnValue({
      executed: 3, missing: [], stale: [], errors: [{ file: 'lib/x.ts', line: 3, reason: 'unresolved_script' }],
    });
    const { exit, error } = await run([true]);
    expect(exit).toHaveBeenCalledWith(1);
    expect(error.mock.calls.flat().join('\n')).toContain('lib/x.ts:3');
  });
});
