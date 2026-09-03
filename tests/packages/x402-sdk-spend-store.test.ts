import {
  access,
  mkdtemp,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

type SpendStore = {
  load: (key: string) => Promise<string | null>;
  reserve: (
    key: string,
    amountAtomic: string,
    limitAtomic: string,
    reservation: Record<string, string>,
  ) => Promise<
    | { ok: true; totalAtomic: string }
    | { ok: false; reason: string; totalAtomic?: string; detail?: string }
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
      [method: string]: unknown;
    };
  }) => SpendStore;
  SPEND_LOCK_STALE_MS: number;
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

  // B10: SIGKILL で残った spend.json.lock が「予算つき支払いを永久に止める」のを防ぐ。
  // ロック取得の待ちは 40×25ms=1s しかなく、臨界区間は小さな read+atomic replace なので、
  // 60s 以上更新の無いロックに生きた保持者はいない。
  describe('stale lock recovery', () => {
    const RESERVATION = {
      id: '0xnonce',
      payer: '0xabc',
      network: 'eip155:80002',
      asset: '0xdef',
      validBefore: '2000000000',
    };

    async function storeWithLock(age: number) {
      const sdk = await loadSdk();
      const path = await temporaryPath('spend.json');
      await mkdir(dirname(path), { recursive: true });
      const lockPath = `${path}.lock`;
      await writeFile(
        lockPath,
        JSON.stringify({ pid: 999_999, createdAt: '2026-09-01T00:00:00.000Z' }),
        'utf8',
      );
      const when = new Date(Date.now() - age);
      await utimes(lockPath, when, when);
      return { store: sdk.createFileSpendStore({ path }), path, lockPath };
    }

    it('takes over a lock left behind by a killed process', async () => {
      const { store, lockPath } = await storeWithLock(120_000);

      await expect(
        store.reserve('0xabc:2026-07-17', '7', '10', RESERVATION),
      ).resolves.toMatchObject({ ok: true, totalAtomic: '7' });
      // 取得したロックは通常どおり解放される。
      await expect(access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('leaves a fresh lock alone and names it in the rejection detail', async () => {
      const { store, lockPath } = await storeWithLock(0);

      const result = await store.reserve(
        '0xabc:2026-07-17',
        '7',
        '10',
        RESERVATION,
      );

      expect(result).toMatchObject({ ok: false, reason: 'unavailable' });
      expect(result.ok === false && result.detail).toContain(lockPath);
      // 生きた保持者のロックを奪わない。
      await expect(access(lockPath)).resolves.toBeUndefined();
    });

    // N-1: unlink → open('wx') の takeover は、同じ stale を見た 2 プロセスが
    // 「A が作り直したロックを B の unlink が消す」形で交錯し、**両者が臨界区間に入る**
    // (PoC 再現済み)。rename は 1 プロセスしか成功しないので奪取の所有権が証明される。
    // 両者の stale 判定 (stat) をバリアで揃えてから rename に進ませ、交錯を必ず作る。
    it('admits exactly one of two racing stale takeovers', async () => {
      const sdk = await loadSdk();
      const path = await temporaryPath('spend.json');
      await mkdir(dirname(path), { recursive: true });
      const lockPath = `${path}.lock`;
      await writeFile(lockPath, '{}', 'utf8');
      const when = new Date(Date.now() - 120_000);
      await utimes(lockPath, when, when);

      // ① 両者が「stale だ」と判定し終えるまで次に進ませない。
      let seenStale = 0;
      let releaseBarrier = () => {};
      const bothSawStale = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });
      // ② 2 番目の unlink を「1 人目がロックを作り終える」まで遅らせる = PoC の交錯そのもの。
      //    unlink → open('wx') 実装ならここで 2 人目が 1 人目のロックを消して両者が入る。
      //    rename 実装は takeover で lockPath を unlink しないので、この遅延に当たらない。
      let unlinkCalls = 0;
      let markOpened = () => {};
      const someoneHoldsLock = new Promise<void>((resolve) => {
        markOpened = resolve;
      });
      // 臨界区間に入った回数 = lockPath の 'wx' open に成功した回数。
      const acquisitions: string[] = [];
      const fsImpl = {
        access,
        mkdir,
        readFile,
        rename,
        writeFile,
        async open(target: string, flags: string) {
          const handle = await open(target, flags);
          acquisitions.push(target);
          markOpened();
          return handle;
        },
        async unlink(target: string) {
          unlinkCalls += 1;
          if (unlinkCalls === 2) await someoneHoldsLock;
          return unlink(target);
        },
        async stat(target: string) {
          const stats = await stat(target);
          seenStale += 1;
          if (seenStale >= 2) releaseBarrier();
          await bothSawStale;
          return stats;
        },
      } as unknown as NonNullable<
        Parameters<SdkModule['createFileSpendStore']>[0]
      >['fsImpl'];
      const first = sdk.createFileSpendStore({ path, fsImpl });
      const second = sdk.createFileSpendStore({ path, fsImpl });

      const results = await Promise.all([
        first.reserve('0xabc:2026-07-17', '7', '10', RESERVATION),
        second.reserve('0xabc:2026-07-17', '7', '10', {
          ...RESERVATION,
          id: '0xnonce2',
        }),
      ]);

      // ロックを握れたのはちょうど 1 人 (unlink 実装だと 2 人が握って交錯する)。
      expect(acquisitions).toEqual([lockPath]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      const loser = results.find((result) => !result.ok);
      expect(loser).toMatchObject({ ok: false, reason: 'unavailable' });
      expect(loser?.ok === false && loser.detail).toContain(lockPath);
      // 勝者が 1 人だけ書いた = 予算は 1 件ぶんしか進んでいない。
      await expect(first.load('0xabc:2026-07-17')).resolves.toBe('7');
      await expect(access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
      // 奪取に使った退避ファイルを残さない。
      await expect(
        readdir(dirname(path)).then((names) =>
          names.filter((name) => name.includes('.stale-')),
        ),
      ).resolves.toEqual([]);
    });

    // 掟13: takeover できない fsImpl を黙って素通りさせない (stale ロックで支払いが永久に止まる
    // 状態に戻るため)。ロックは奪わず、警告を一度だけ出す。
    it('disables takeover with a single warning when fsImpl cannot stat', async () => {
      const sdk = await loadSdk();
      const path = await temporaryPath('spend.json');
      await mkdir(dirname(path), { recursive: true });
      const lockPath = `${path}.lock`;
      await writeFile(lockPath, '{}', 'utf8');
      const when = new Date(Date.now() - 120_000);
      await utimes(lockPath, when, when);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const store = sdk.createFileSpendStore({
        path,
        // stat 無し = 古さを判定できない。
        fsImpl: { access, mkdir, open, readFile, rename, unlink, writeFile } as unknown as
          NonNullable<Parameters<SdkModule['createFileSpendStore']>[0]>['fsImpl'],
      });

      const blocked = await store.reserve('0xabc:2026-07-17', '7', '10', RESERVATION);
      await store.reserve('0xabc:2026-07-17', '7', '10', RESERVATION);

      expect(blocked).toMatchObject({ ok: false, reason: 'unavailable' });
      expect(blocked.ok === false && blocked.detail).toContain(
        'stale takeover unavailable',
      );
      await expect(access(lockPath)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    it('records the owning pid in the lock file', async () => {
      const sdk = await loadSdk();
      const path = await temporaryPath('spend.json');
      const lockWrites: string[] = [];
      // ロックファイルへの書き込みだけを覗くため、handle を薄く包んだ fs を渡す。
      const fsImpl = {
        access,
        mkdir,
        readFile,
        rename,
        stat,
        unlink,
        writeFile,
        async open(target: string, flags: string) {
          const handle = await open(target, flags);
          return {
            async writeFile(data: string, encoding: BufferEncoding) {
              lockWrites.push(String(data));
              return handle.writeFile(data, encoding);
            },
            close: () => handle.close(),
          };
        },
      };
      const store = sdk.createFileSpendStore({
        path,
        fsImpl: fsImpl as unknown as NonNullable<
          Parameters<SdkModule['createFileSpendStore']>[0]
        >['fsImpl'],
      });

      await expect(
        store.reserve('0xabc:2026-07-17', '7', '10', RESERVATION),
      ).resolves.toMatchObject({ ok: true });

      expect(lockWrites).toHaveLength(1);
      expect(JSON.parse(lockWrites[0])).toMatchObject({
        pid: process.pid,
        createdAt: expect.any(String),
      });
    });
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
