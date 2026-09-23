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
