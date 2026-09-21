// @vitest-environment node
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Wallet = {
  public: {
    address: string;
    created: boolean;
    storage: { path: string; permissionsChecked: boolean };
  };
  secret: { privateKey: string };
};
type Keystore = {
  loadWallet: (options?: { env: Record<string, string> }) => Promise<Wallet | null>;
  createWallet: (options?: { env: Record<string, string> }) => Promise<Wallet>;
  walletDirectory: (env?: Record<string, string>) => string;
};
const entry = pathToFileURL(resolve('packages/x402-mcp/src/keystore.mjs')).href;
const keystore = await import(entry) as Keystore;
let home: string;
let path: string;
const digest = (data: string) => createHash('sha256').update(data).digest('hex');

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'x402-keystore-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('OPENPAY_X402_HOME', '');
  path = join(home, '.openpay-x402', 'wallet.json');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});

describe('local keystore', () => {
  it('creates private storage, rereads the stored address, and never overwrites an existing wallet', async () => {
    expect(await keystore.loadWallet()).toBeNull();
    const first = await keystore.createWallet();
    const original = digest(await readFile(path, 'utf8'));
    const loaded = await keystore.loadWallet();
    const second = await keystore.createWallet();
    expect(first.public.created).toBe(true);
    expect(second.public.created).toBe(false);
    expect(loaded?.public.address).toBe(first.public.address);
    expect(second.public.address).toBe(first.public.address);
    expect(digest(await readFile(path, 'utf8'))).toBe(original);
    expect(first.public.storage.path).toBe(path);
    expect(first.public.storage.permissionsChecked).toBe(process.platform !== 'win32');
    if (process.platform !== 'win32') {
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
      expect((await lstat(join(home, '.openpay-x402'))).mode & 0o777).toBe(0o700);
    }
  });

  it('concurrent initializers return the same stored address with exactly one creator', async () => {
    const wallets = await Promise.all([keystore.createWallet(), keystore.createWallet()]);
    expect(wallets[0].public.address).toBe(wallets[1].public.address);
    expect(wallets.map((wallet) => wallet.public.created).sort()).toEqual([false, true]);
    expect((await keystore.loadWallet())?.public.address).toBe(wallets[0].public.address);
  });

  it('converges across two independent Node processes without exposing their keys', async () => {
    const run = () => new Promise<{ address: string; created: boolean }>((resolvePromise, reject) => {
      const code = `import { createWallet } from ${JSON.stringify(entry)};
const wallet = await createWallet();
process.stdout.write(JSON.stringify({address: wallet.public.address, created: wallet.public.created}));`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
        env: { ...process.env, HOME: home, OPENPAY_X402_HOME: '' },
      });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code !== 0) reject(new Error(`initializer exit ${code}`));
        else resolvePromise(JSON.parse(output));
      });
    });
    const wallets = await Promise.all([run(), run()]);
    expect(wallets[0].address).toBe(wallets[1].address);
    expect(wallets.map((wallet) => wallet.created).sort()).toEqual([false, true]);
  });

  it('uses OPENPAY_X402_HOME as the storage directory', async () => {
    const directory = join(home, 'custom');
    const wallet = await keystore.createWallet({ env: { OPENPAY_X402_HOME: directory } });
    expect(wallet.public.storage.path).toBe(join(directory, 'wallet.json'));
    expect((await keystore.loadWallet({ env: { OPENPAY_X402_HOME: directory } }))?.public.address).toBe(wallet.public.address);
  });

  it.skipIf(process.platform === 'win32')('rejects 0644 without chmod or rewriting and gives a manual repair command', async () => {
    await keystore.createWallet();
    const original = digest(await readFile(path, 'utf8'));
    await chmod(path, 0o644);
    await expect(keystore.loadWallet()).rejects.toMatchObject({ code: 'wallet_permissions_unsafe' });
    await expect(keystore.createWallet()).rejects.toThrow(`chmod 600 '${path}'`);
    expect((await lstat(path)).mode & 0o777).toBe(0o644);
    expect(digest(await readFile(path, 'utf8'))).toBe(original);
  });

  it.skipIf(process.platform === 'win32')('rejects an existing directory with group/other access', async () => {
    const dir = join(home, '.openpay-x402');
    await mkdir(dir);
    await chmod(dir, 0o755);
    await expect(keystore.createWallet()).rejects.toMatchObject({ code: 'wallet_permissions_unsafe' });
    expect((await lstat(dir)).mode & 0o777).toBe(0o755);
  });

  it.each(['json', 'shape', 'key', 'address'])('refuses %s corruption without overwriting or leaking input', async (kind) => {
    const wallet = await keystore.createWallet();
    const document = JSON.parse(await readFile(path, 'utf8'));
    if (kind === 'shape') document.version = 2;
    if (kind === 'key') document.privateKey = `0x${'0'.repeat(64)}`;
    if (kind === 'address') document.address = `0x${'2'.repeat(40)}`;
    const raw = kind === 'json' ? `broken ${wallet.secret.privateKey}` : JSON.stringify(document);
    await writeFile(path, raw);
    const expectedCode = kind === 'address' ? 'wallet_address_mismatch' : 'wallet_corrupt';
    for (const operation of [keystore.loadWallet, keystore.createWallet]) {
      const error = await operation().catch((error: Error & { code: string }) => error);
      expect(error instanceof Error ? (error as Error & { code: string }).code : 'no_error').toBe(expectedCode);
      expect(String(error).includes(wallet.secret.privateKey)).toBe(false);
    }
    expect(digest(await readFile(path, 'utf8'))).toBe(digest(raw));
  });

  it('rejects symlink directories, symlink files, and non-files', async () => {
    const dir = join(home, '.openpay-x402');
    const target = join(home, 'target');
    await mkdir(target, { mode: 0o700 });
    await symlink(target, dir);
    await expect(keystore.loadWallet()).rejects.toMatchObject({ code: 'wallet_dir_symlink' });
    await expect(keystore.createWallet()).rejects.toMatchObject({ code: 'wallet_dir_symlink' });
    await rm(dir);
    await mkdir(dir, { mode: 0o700 });
    await writeFile(join(target, 'wallet'), '{}', { mode: 0o600 });
    await symlink(join(target, 'wallet'), path);
    await expect(keystore.loadWallet()).rejects.toMatchObject({ code: 'wallet_file_unsafe' });
    await expect(keystore.createWallet()).rejects.toMatchObject({ code: 'wallet_file_unsafe' });
    await rm(path);
    await mkdir(path);
    await expect(keystore.loadWallet()).rejects.toMatchObject({ code: 'wallet_file_unsafe' });
  });

  it('reports unchecked permissions on Windows', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const wallet = await keystore.createWallet();
    expect(wallet.public.storage.permissionsChecked).toBe(false);
    await chmod(path, 0o644);
    expect((await keystore.loadWallet())?.public.storage.permissionsChecked).toBe(false);
  });
});
