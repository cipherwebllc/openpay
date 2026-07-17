import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

type SpendStore = {
  load: (key: string) => Promise<string | null>;
  save: (key: string, atomicString: string) => Promise<void>;
};

type SdkModule = {
  createFileSpendStore: (options?: {
    path?: string;
    fsImpl?: {
      readFile: (path: string, encoding: string) => Promise<string>;
      mkdir: (path: string, options: { recursive: boolean }) => Promise<unknown>;
      writeFile: (
        path: string,
        data: string,
        encoding: string,
      ) => Promise<unknown>;
    };
  }) => SpendStore;
};

const SDK_ENTRY = resolve(process.cwd(), 'packages/x402-sdk/src/index.mjs');
const temporaryDirectories: string[] = [];

async function loadSdk(): Promise<SdkModule> {
  return (await import(pathToFileURL(SDK_ENTRY).href)) as SdkModule;
}

async function temporaryPath(...parts: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'openpay-x402-spend-'));
  temporaryDirectories.push(root);
  return join(root, ...parts);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe('openpay-x402-sdk file spend store', () => {
  it('roundtrips an atomic string', async () => {
    const sdk = await loadSdk();
    const path = await temporaryPath('spend.json');
    const store = sdk.createFileSpendStore({ path });
    const key = '0xabc:2026-07-17';

    await store.save(key, '123000000000000000000');

    await expect(store.load(key)).resolves.toBe('123000000000000000000');
  });

  it('prunes keys outside the date being saved', async () => {
    const sdk = await loadSdk();
    const path = await temporaryPath('spend.json');
    await writeFile(
      path,
      JSON.stringify({
        '0xold:2026-07-16': '1',
        '0xkept:2026-07-17': '2',
      }),
      'utf8',
    );
    const store = sdk.createFileSpendStore({ path });

    await store.save('0xnew:2026-07-17', '3');

    await expect(readFile(path, 'utf8').then(JSON.parse)).resolves.toEqual({
      '0xkept:2026-07-17': '2',
      '0xnew:2026-07-17': '3',
    });
  });

  it('returns null for corrupt JSON so guards can fail closed', async () => {
    const sdk = await loadSdk();
    const path = await temporaryPath('spend.json');
    await writeFile(path, '{broken', 'utf8');
    const store = sdk.createFileSpendStore({ path });

    await expect(store.load('0xabc:2026-07-17')).resolves.toBeNull();
  });

  it('returns null for a read failure so guards can fail closed', async () => {
    const sdk = await loadSdk();
    const store = sdk.createFileSpendStore({
      path: '/virtual/spend.json',
      fsImpl: {
        async readFile() {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        },
        async mkdir() {},
        async writeFile() {},
      },
    });

    await expect(store.load('0xabc:2026-07-17')).resolves.toBeNull();
  });

  it('creates the parent directory automatically', async () => {
    const sdk = await loadSdk();
    const path = await temporaryPath('nested', 'state', 'spend.json');
    const store = sdk.createFileSpendStore({ path });

    await store.save('0xabc:2026-07-17', '9');

    await expect(readFile(path, 'utf8').then(JSON.parse)).resolves.toEqual({
      '0xabc:2026-07-17': '9',
    });
  });

  it('treats a missing file or key as zero', async () => {
    const sdk = await loadSdk();
    const path = await temporaryPath('nested', 'spend.json');
    const store = sdk.createFileSpendStore({ path });

    await expect(store.load('0xabc:2026-07-17')).resolves.toBe('0');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{}', 'utf8');
    await expect(store.load('0xabc:2026-07-17')).resolves.toBe('0');
  });

  it('does not throw when writing fails after a completed payment', async () => {
    const sdk = await loadSdk();
    const store = sdk.createFileSpendStore({
      path: '/virtual/spend.json',
      fsImpl: {
        async readFile() {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        },
        async mkdir() {},
        async writeFile() {
          throw new Error('disk full');
        },
      },
    });

    await expect(
      store.save('0xabc:2026-07-17', '9'),
    ).resolves.toBeUndefined();
  });
});
