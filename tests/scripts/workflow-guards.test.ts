import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LUA_REAL_TEST_FILES } from '../../scripts/lib/luaRealTests.mjs';
import { listTestFiles } from '../../scripts/lib/testFileFence.mjs';

function workflow(name: string): string {
  return readFileSync(resolve(process.cwd(), '.github/workflows', name), 'utf8');
}

describe('GitHub Actions operation guards', () => {
  it('CI は typecheck 直後に full ESLint を実行する', () => {
    const source = workflow('ci.yml');
    const typecheck = source.indexOf('- run: npm run typecheck');
    const lint = source.indexOf('- run: npm run lint');
    const tests = source.indexOf('- run: node scripts/run-tests.mjs');

    expect(typecheck).toBeGreaterThan(-1);
    expect(lint).toBeGreaterThan(typecheck);
    expect(tests).toBeGreaterThan(lint);
  });

  // wasmoon (本物の Lua) を使う test は非決定的に落ちるので専用 job で再試行する (2026-09-12 案 1)。
  // 一覧 (scripts/lib/luaRealTests.mjs) と ci.yml・実ファイルのドリフトをここで止める。
  it('CI は Lua 実行系 test を test job から外し lua-real job で再試行する', () => {
    const source = workflow('ci.yml');
    const testsStep = source.indexOf('- run: node scripts/run-tests.mjs');
    expect(source.slice(testsStep, testsStep + 200)).toContain("SKIP_LUA_REAL: '1'");
    expect(source).toContain('lua-real:');
    expect(source).toContain('- run: node scripts/run-lua-tests.mjs');
    // Coverage step の --exclude は一覧と過不足なく一致する
    const excluded = [...source.matchAll(/--exclude (tests\/\S+)/g)].map((m) => m[1]).sort();
    expect(excluded).toEqual([...LUA_REAL_TEST_FILES].sort());
  });

  it('Lua 実行系 test の一覧は wasmoon / redisLua ハーネスを import する test ファイルと一致する', () => {
    const root = process.cwd();
    const usingWasmoon = listTestFiles(root).filter((file) =>
      /from ['"]wasmoon['"]|\/redisLua['"]/.test(readFileSync(resolve(root, file), 'utf8')),
    );
    for (const file of LUA_REAL_TEST_FILES) expect(existsSync(resolve(root, file))).toBe(true);
    expect([...usingWasmoon].sort()).toEqual([...LUA_REAL_TEST_FILES].sort());
  });

  it('reverify cron は CRON_SECRET 欠落を error annotation + failure にする', () => {
    const source = workflow('reverify-cron.yml');
    const missingSecretBranch = source.match(
      /if \[ -z "\$CRON_SECRET" \]; then([\s\S]*?)fi/,
    )?.[1];

    expect(missingSecretBranch).toContain('::error::');
    expect(missingSecretBranch).toContain('exit 1');
    expect(missingSecretBranch).not.toContain('exit 0');
  });
});
