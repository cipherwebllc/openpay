// @vitest-environment node
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Wallet = { public: { address: string; created?: boolean }; secret: { privateKey: string } };
const { createWallet, loadWallet } = await import(
  pathToFileURL(resolve('packages/x402-mcp/src/keystore.mjs')).href
) as { createWallet: () => Promise<Wallet>; loadWallet: () => Promise<Wallet | null> };
let home: string;
let directory: string;
let path: string;

beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), 'x402-atomic-'));
  directory = join(home, '.openpay-x402');
  path = join(directory, 'wallet.json');
  vi.stubEnv('HOME', home);
  vi.stubEnv('OPENPAY_X402_HOME', '');
});
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});

describe('atomic wallet publication', () => {
  it('keeps secrets out of object spreads and serializable wallet metadata', async () => {
    const wallet = await createWallet();
    expect(Object.keys(wallet)).toEqual(['public']);
    expect(typeof wallet.secret?.privateKey).toBe('string');
    expect(JSON.stringify({ ...wallet }).includes(wallet.secret.privateKey)).toBe(false);
    const loaded = await loadWallet();
    expect(Object.keys(loaded!)).toEqual(['public']);
    expect(loaded?.public.address).toBe(wallet.public.address);
  });

  it('publishes only a fully synced private temp file, unlinks it, then syncs the directory', async () => {
    const events: string[] = [];
    const open = fs.open.bind(fs);
    const link = fs.link.bind(fs);
    const unlink = fs.unlink.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[1] === 'wx') {
        expect(String(args[0])).toMatch(/wallet\.json\.[\w-]+\.tmp$/);
        expect(args[2]).toBe(0o600);
        const write = handle.writeFile.bind(handle);
        vi.spyOn(handle, 'writeFile').mockImplementation(async (...input) => {
          await expect(fs.lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
          await write(...input);
          events.push('write');
        });
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, 'sync').mockImplementation(async () => { await sync(); events.push('file sync'); });
      } else if (String(args[0]) === directory) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, 'sync').mockImplementation(async () => { await sync(); events.push('directory sync'); });
      }
      return handle;
    });
    vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
      expect(events).toEqual(['write', 'file sync']);
      expect(JSON.parse(await fs.readFile(from, 'utf8')).version).toBe(1);
      await link(from, to);
      events.push('link');
    });
    vi.spyOn(fs, 'unlink').mockImplementation(async (target) => { await unlink(target); events.push('unlink'); });
    syncBuiltinESMExports();
    const wallet = await createWallet();
    expect(events).toEqual(['write', 'file sync', 'link', 'unlink', 'directory sync']);
    expect(wallet.public.created).toBe(true);
    expect(await fs.readdir(directory)).toEqual(['wallet.json']);
  });

  it.each(['open', 'write', 'file sync', 'close', 'EPERM', 'ENOTSUP', 'EIO', 'unlink', 'directory sync', 'reread'])(
    'cleans secret temp files and fails closed on %s failure', async (stage) => {
      const open = fs.open.bind(fs);
      const unlink = fs.unlink.bind(fs);
      const error = () => Object.assign(new Error('injected filesystem failure'), { code: stage.startsWith('E') ? stage : 'EIO' });
      vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        if (stage === 'open' && args[1] === 'wx') throw error();
        const handle = await open(...args);
        if (args[1] === 'wx') {
          if (stage === 'write') vi.spyOn(handle, 'writeFile').mockImplementation(async () => {
            await handle.write('partial');
            throw error();
          });
          if (stage === 'file sync') vi.spyOn(handle, 'sync').mockRejectedValue(error());
          if (stage === 'close') {
            const close = handle.close.bind(handle);
            vi.spyOn(handle, 'close').mockImplementation(async () => { await close(); throw error(); });
          }
        } else if (String(args[0]) === directory && stage === 'directory sync') {
          vi.spyOn(handle, 'sync').mockRejectedValue(error());
        } else if (String(args[0]) === path && stage === 'reread') {
          vi.spyOn(handle, 'readFile').mockRejectedValue(error());
        }
        return handle;
      });
      if (stage.startsWith('E')) vi.spyOn(fs, 'link').mockRejectedValue(error());
      if (stage === 'unlink') vi.spyOn(fs, 'unlink').mockImplementationOnce(async () => { throw error(); }).mockImplementation(unlink);
      syncBuiltinESMExports();
      const failure = await createWallet().then(() => null, (error: { code: string; reason: string }) => ({ code: error.code, reason: error.reason }));
      expect(failure).toMatchObject({ code: 'wallet_unavailable', reason: stage.startsWith('E') ? stage : 'EIO' });
      const names = await fs.readdir(directory);
      expect(names.filter((name) => name.endsWith('.tmp'))).toEqual([]);
      if (['directory sync', 'reread', 'unlink'].includes(stage)) {
        expect(names).toEqual(['wallet.json']);
        expect(JSON.parse(await fs.readFile(path, 'utf8')).version).toBe(1);
      } else {
        expect(names).toEqual([]);
      }
    },
  );

  it('concurrent init converges without corrupt-file retries and removes the losing temp file', async () => {
    const link = fs.link.bind(fs);
    let release!: () => void;
    const both = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    let writers = 0;
    vi.spyOn(fs, 'link').mockImplementation(async (...args) => {
      if (++writers === 2) release();
      await both;
      await link(...args);
    });
    const timer = vi.spyOn(globalThis, 'setTimeout');
    syncBuiltinESMExports();
    const wallets = await Promise.all([createWallet(), createWallet()]);
    expect(writers).toBe(2);
    expect(wallets[0].public.address).toBe(wallets[1].public.address);
    expect(wallets.map((wallet) => wallet.public.created).sort()).toEqual([false, true]);
    expect(timer).not.toHaveBeenCalled();
    expect(await fs.readdir(directory)).toEqual(['wallet.json']);
  });
});
