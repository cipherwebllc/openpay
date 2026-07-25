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
  reserve: (
    key: string,
    amountAtomic: string,
    limitAtomic: string,
    reservation: Record<string, string>,
  ) => Promise<
    | { ok: true; totalAtomic: string }
    | { ok: false; reason: string; totalAtomic?: string }
  >;
  confirm: (id: string) => Promise<boolean>;
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
  it('atomically admits only one cross-instance reservation at the limit', async () => {
    const sdk = await loadSdk();
    const path = await temporaryPath('spend.json');
    const first = sdk.createFileSpendStore({ path });
    const second = sdk.createFileSpendStore({ path });
    const key = '0xabc:2026-07-17';
    const reservation = (id: string) => ({
      id,
      payer: '0xabc',
      network: 'eip155:80002',
      asset: '0xdef',
      validBefore: '2000000000',
    });

    const results = await Promise.all([
      first.reserve(key, '7', '10', reservation('0x01')),
      second.reserve(key, '7', '10', reservation('0x02')),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      results.find((result) => !result.ok),
    ).toMatchObject({ ok: false, reason: 'limit_exceeded' });
    await expect(first.load(key)).resolves.toBe('7');
  });

  it('keeps a reservation counted when it is only marked confirmed', async () => {
    const sdk = await loadSdk();
    const path = await temporaryPath('spend.json');
    const store = sdk.createFileSpendStore({ path });
    const key = '0xabc:2026-07-17';

    await expect(
      store.reserve(key, '7', '10', {
        id: '0xnonce',
        payer: '0xabc',
        network: 'eip155:80002',
        asset: '0xdef',
        validBefore: '2000000000',
      }),
    ).resolves.toMatchObject({ ok: true, totalAtomic: '7' });
    await expect(store.confirm('0xnonce')).resolves.toBe(true);

    await expect(store.load(key)).resolves.toBe('7');
    await expect(
      readFile(path, 'utf8').then(JSON.parse),
    ).resolves.toMatchObject({
      [key]: '7',
      __openpayReservations: {
        '0xnonce': { status: 'confirmed' },
      },
    });
  });

  it('roundtrips an atomic string', async () => {
    const sdk = await loadSdk();
    const path = await temporaryPath('spend.json');
    const store = sdk.createFileSpendStore({ path });
    const key = '0xabc:2026-07-17';

    await store.save(key, '123000000000000000000');

    await expect(store.load(key)).resolves.toBe('123000000000000000000');
  });

  it('keeps the published minimal fsImpl working for compatibility saves', async () => {
    const sdk = await loadSdk();
    let stored: string | null = null;
    const store = sdk.createFileSpendStore({
      path: '/virtual/spend.json',
      fsImpl: {
        async readFile() {
          if (stored === null) {
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          }
          return stored;
        },
        async mkdir() {},
        async writeFile(_path, data) {
          stored = data;
        },
      },
    });

    await store.save('0xabc:2026-07-17', '9');

    await expect(store.load('0xabc:2026-07-17')).resolves.toBe('9');
    await expect(
      store.reserve('0xabc:2026-07-17', '1', '10', {
        id: '0xnonce',
        payer: '0xabc',
        network: 'eip155:80002',
        asset: '0xdef',
        validBefore: '2000000000',
      }),
    ).resolves.toEqual({ ok: false, reason: 'unavailable' });
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
