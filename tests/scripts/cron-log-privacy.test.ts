// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'cron-log-test-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('authenticated cron log privacy', () => {
  it.each(['reverify-cron', 'jpyc-activity-cron'])('%s never logs response bodies, including errors and malformed JSON', async (workflow) => {
    const yaml = await readFile(`.github/workflows/${workflow}.yml`, 'utf8');
    const script = yaml.split('        run: |\n')[1].split('\n').map((line) => line.replace(/^          /, '')).join('\n');
    // Execute the actual workflow shell with a local curl stub; no authenticated request is made.
    await writeFile(join(dir, 'curl'), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-o' ]; then shift; output="$1"; fi
  shift
done
printf '%s' "$RESPONSE_BODY" > "$output"
printf '%s' "$RESPONSE_CODE"
`, { mode: 0o700 });
    for (const code of ['200', '401', '503']) {
      for (const body of ['{"kv":{"host":"SECRET_HOST"},"storageFailures":[{"detail":"SECRET_DETAIL"}]}', '<html>SECRET_HOST SECRET_DETAIL</html>']) {
        // Redirect the old response file into the fixture directory during the pre-fix regression run.
        const r = spawnSync('bash', ['-e', '-c', script.replaceAll('/tmp/out.json', join(dir, 'out.json'))], {
          env: { NODE_ENV: 'test', PATH: `${dir}:${process.env.PATH}`, CRON_SECRET: 'FAKE_TOKEN', RESPONSE_CODE: code, RESPONSE_BODY: body }, encoding: 'utf8',
        });
        expect(r.status).toBe(code === '200' ? 0 : 1);
        expect(r.stdout).toContain(`HTTP ${code}`);
        expect(r.stdout).toContain(code === '200' ? 'Cron trigger: accepted' : 'Cron trigger: failed');
        expect(r.stdout + r.stderr).not.toMatch(/SECRET_HOST|SECRET_DETAIL|FAKE_TOKEN/);
      }
    }
  });
});

it('ignores legacy restore reports and local backup artifacts', () => {
  for (const name of ['restore-report-drill-20260923T000000Z.json', '20260923T000000Z-r0-a12345678-full.jsonl.gz.enc', '20260923T000000Z-r0-a12345678.meta.json']) {
    expect(spawnSync('git', ['check-ignore', '--no-index', name], { encoding: 'utf8' }).status).toBe(0);
  }
});
