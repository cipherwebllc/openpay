// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = resolve('packages/x402-mcp/scripts/steward-bootstrap.mjs');
const apiKey = 'FAKE_API_SECRET', signerSecret = 'FAKE_SIGNER_SECRET', totpSecret = 'JBSWY3DPEHPK3PXP';
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'steward-secrets-test-'));
  await writeFile(join(dir, 'mock.mjs'), `
const nativeTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn) => nativeTimeout(fn, 0);
let logins = 0, policy;
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url).pathname;
  if (process.env.FAIL_AT === 'transport') throw Object.assign(
    new Error('transport ${apiKey} ${signerSecret} ${totpSecret} ' + process.env.OWNER_PRIVATE_KEY),
    JSON.parse(process.env.DIAGNOSTIC_ERROR || '{}'),
  );
  if (path === '/platform/tenants') return Response.json({ ok: true, data: { apiKey: '${apiKey}' } });
  if (path === '/auth/nonce') return Response.json({ ok: true, nonce: 'abcdefgh12345678' });
  if (path === '/auth/verify') return Response.json(++logins === 3
    ? { ok: true, mfa: { challengeId: 'challenge' } }
    : { ok: true, token: 'FAKE_SESSION_SECRET', userId: 'owner-id' });
  if (path === '/agents') return Response.json({ ok: true, data: { id: 'agent-id', walletAddress: '0x' + '2'.repeat(40) } });
  if (path.endsWith('/policies')) {
    if (init.method === 'PUT') policy = JSON.parse(init.body);
    return Response.json({ ok: true, data: policy });
  }
  if (path === '/auth/mfa/totp/enroll') return Response.json({ ok: true, secret: '${totpSecret}' });
  if (path === '/auth/mfa/totp/complete') return Response.json({ ok: true, token: 'FAKE_MFA_SECRET' });
  if (path.endsWith('/signers')) return process.env.FAIL_AT === 'signer'
    ? Response.json({ ok: false, error: '${apiKey} ${signerSecret} ${totpSecret}' }, { status: 500 })
    : Response.json({ ok: true, data: { id: 'signer-id', credentialSecret: '${signerSecret}' } });
  return Response.json({ ok: true });
};
`);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
function run(args: string[] = [], env: Record<string, string> = {}) {
  return spawnSync('node', ['--import', join(dir, 'mock.mjs'), script, ...args], {
    env: { NODE_ENV: 'test', PATH: process.env.PATH, HOME: dir, OWNER_PRIVATE_KEY: '0x' + '1'.repeat(64), STEWARD_PLATFORM_KEY: 'FAKE_PLATFORM_SECRET', ...env },
    encoding: 'utf8', timeout: 15_000,
  });
}
function noSecrets(r: ReturnType<typeof run>) {
  for (const secret of [apiKey, signerSecret, totpSecret, 'FAKE_SESSION_SECRET', 'FAKE_MFA_SECRET', 'FAKE_PLATFORM_SECRET', '0x' + '1'.repeat(64)]) {
    expect(r.stdout + r.stderr).not.toContain(secret);
  }
}

describe('Steward private credential handoff', () => {
  it('writes secrets to an exclusive 0600 file and logs only the path and identifiers', async () => {
    const path = join(dir, 'credentials.json');
    const r = run(['--out', path]);
    noSecrets(r);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(path);
    expect(r.stdout).toContain('agent-id');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      env: { STEWARD_API_KEY: apiKey, STEWARD_SIGNER_SECRET: signerSecret }, ownerTotpSecret: totpSecret,
    });
    await writeFile(path, 'previous');
    const again = run(['--out', path]);
    expect(again.status).toBe(1);
    expect(await readFile(path, 'utf8')).toBe('previous');
    noSecrets(again);
  });
  it('defaults under the isolated home config directory', async () => {
    const r = run();
    noSecrets(r);
    expect(r.status).toBe(0);
    const folder = join(dir, '.config', 'openpay');
    const files = await readdir(folder);
    expect(files).toHaveLength(1);
    expect((await stat(join(folder, files[0]))).mode & 0o777).toBe(0o600);
  });
  it('refuses repository paths and symlinked repository parents before provisioning', async () => {
    const repo = join(dir, 'repo');
    await mkdir(repo);
    await writeFile(join(repo, '.git'), 'gitdir: /unused');
    await symlink(repo, join(dir, 'alias'));
    for (const parent of [repo, join(dir, 'alias')]) {
      const r = run(['--out', join(parent, 'nested', 'credentials.json')]);
      expect(r.status).toBe(1);
      expect(r.stdout).not.toContain('created');
      noSecrets(r);
    }
    expect(await readdir(repo)).toEqual(['.git']);
  });
  it('refuses existing symlinks without overwriting their target', async () => {
    const existing = join(dir, 'existing');
    await writeFile(existing, 'keep');
    await symlink(existing, join(dir, 'credentials.json'));
    const r = run(['--out', join(dir, 'credentials.json')]);
    expect(r.status).toBe(1);
    expect(await readFile(existing, 'utf8')).toBe('keep');
  });
  it.each(['transport', 'signer'])('redacts %s failures and retains credentials already issued', async (failure) => {
    const path = join(dir, 'credentials.json');
    const r = run(['--out', path], { FAIL_AT: failure });
    noSecrets(r);
    expect(r.status).toBe(1);
    if (failure === 'signer') expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ env: { STEWARD_API_KEY: apiKey }, ownerTotpSecret: totpSecret });
  });
  it('requires explicit CI opt-in', () => {
    const r = run([], { CI: 'true' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--allow-ci');
    expect(r.stdout).not.toContain('created');
    const allowed = run(['--allow-ci'], { CI: 'true' });
    expect(allowed.status).toBe(0);
    noSecrets(allowed);
  });
  it.each(['false', 'FALSE', '0'])('allows explicitly disabled CI=%s without opt-in', (CI) => {
    const r = run([], { CI });
    expect(r.status).toBe(0);
    noSecrets(r);
  });
  it.each([
    { name: 'Error', code: 'EACCES' },
    { name: 'TypeError', cause: { code: 'ECONNREFUSED' } },
    { name: 'TypeError', cause: { code: 'ENOTFOUND' } },
    { name: 'Error', code: 'ERR_TLS_1_3', cause: { code: 'EIO' } },
  ])('prints safe diagnostics for $name/$code/$cause.code without the raw message', (diagnostic) => {
    const r = run([], { FAIL_AT: 'transport', DIAGNOSTIC_ERROR: JSON.stringify(diagnostic) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`"name":"${diagnostic.name}"`);
    if (diagnostic.code) expect(r.stderr).toContain(`"code":"${diagnostic.code}"`);
    if (diagnostic.cause) expect(r.stderr).toContain(`"causeCode":"${diagnostic.cause.code}"`);
    noSecrets(r);
  });
  it.each([
    { name: apiKey, code: `EACCES ${signerSecret}`, cause: { code: `ENOTFOUND:${totpSecret}` } },
    { name: 'Error\nPRIVATE_DETAIL', code: 'EACCES\n', cause: { code: 'ENOTFOUND\nPRIVATE_DETAIL' } },
    { name: 'UnreviewedError', code: 123, cause: { code: { secret: signerSecret } } },
  ])('withholds unrecognized names and malformed diagnostic codes %#', (diagnostic) => {
    const r = run([], { FAIL_AT: 'transport', DIAGNOSTIC_ERROR: JSON.stringify(diagnostic) });
    expect(r.status).toBe(1);
    expect(r.stderr).not.toMatch(/"(?:name|code|causeCode)":|PRIVATE_DETAIL|UnreviewedError/);
    noSecrets(r);
  });
});
