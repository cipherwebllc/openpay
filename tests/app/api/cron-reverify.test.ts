import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReverifyCursor } from '@/lib/x402/reverify';

// cron の IO (KV / probe / directory) だけを差し替え、cursor 前進の判断を検証する。
// 純関数 (selectReverifyBatch / mapWithConcurrency / utc*) は本物を使う。
const io = vi.hoisted(() => ({
  cursor: { offset: 0 } as ReverifyCursor | null,
  externalIds: ['r0'] as string[] | null,
  writes: [] as ReverifyCursor[],
  writeOk: true,
  targetStorageError: true,
}));

const logs = vi.hoisted(() => ({ warn: [] as Array<[string, unknown]> }));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: () => {},
    warn: (event: string, data: unknown) => logs.warn.push([event, data]),
    error: () => {},
  },
}));

vi.mock('@/lib/x402/firstParty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/x402/firstParty')>()),
  FIRST_PARTY_RESOURCES: [],
}));

vi.mock('@/lib/directory/verification', () => ({
  probeDirectorySource: async () => true,
  writeDirectoryVerificationSnapshot: async () => true,
}));

vi.mock('@/lib/x402/reverify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/x402/reverify')>();
  return {
    ...actual,
    acquireReverifyLock: async () => 'acquired' as const,
    releaseReverifyLock: async () => {},
    readReverifyCursor: async () => io.cursor,
    writeReverifyCursor: async (cursor: ReverifyCursor) => {
      io.writes.push(cursor);
      return io.writeOk;
    },
    listExternalReverifyIds: async () => io.externalIds,
    // storage エラー枝: record 取得が失敗し続ける 1 件を再現する。
    readExternalReverifyTarget: async () =>
      io.targetStorageError
        ? { ok: false as const, detail: 'http_error 500 ERR simulated' }
        : { ok: true as const, resource: null },
    probeForReverifyDetailed: async () => ({
      verdict: 'ok_402_openpay' as const,
      authClass: 'clear' as const,
    }),
  };
});

async function load() {
  return import('@/app/api/cron/reverify/route');
}

function request(token?: string): Request {
  return new Request('https://open-pay.jp/api/cron/reverify', {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('GET /api/cron/reverify auth', () => {
  it('CRON_SECRET 未設定は bearer の有無にかかわらず401', async () => {
    vi.stubEnv('CRON_SECRET', '');
    const route = await load();
    expect((await route.GET(request())).status).toBe(401);
    expect((await route.GET(request('guess'))).status).toBe(401);
  });

  it('CRON_SECRET 不一致は401', async () => {
    vi.stubEnv('CRON_SECRET', 'correct-secret');
    const route = await load();
    const response = await route.GET(request('wrong-secret'));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  });
});

// B12: storage エラー中は cursor を進めない設計が、同じ offset で恒常的に失敗する record が
// 1 件あると「cursor 永久凍結 = その先の record が二度と再検証されない」に化けていた。
// 3 回連続で同じ offset が失敗したら warn を出して quarantine し、巡回を再開する。
describe('GET /api/cron/reverify cursor quarantine', () => {
  beforeEach(() => {
    io.cursor = { offset: 0, storageErrorStreak: 0 };
    io.externalIds = Array.from({ length: 40 }, (_, i) => `r${i}`);
    io.writes = [];
    io.writeOk = true;
    io.targetStorageError = true;
    logs.warn = [];
    vi.stubEnv('CRON_SECRET', 'secret');
    vi.stubEnv('ALERT_WEBHOOK_URL', '');
  });

  it('storage エラー 1〜2 回目は offset を据え置き streak だけ進める', async () => {
    const route = await load();

    const first = await route.GET(request('secret'));
    expect(first.status).toBe(503);
    expect(io.writes.at(-1)).toMatchObject({
      offset: 0,
      storageErrorStreak: 1,
    });

    io.cursor = io.writes.at(-1) ?? null;
    expect((await route.GET(request('secret'))).status).toBe(503);
    expect(io.writes.at(-1)).toMatchObject({
      offset: 0,
      storageErrorStreak: 2,
    });
    // 1〜2 回目は quarantine しない (storage 失敗の内訳 warn は毎回出る)。
    expect(logs.warn.map(([event]) => event)).toEqual([
      'x402.reverify.storage_error',
      'x402.reverify.storage_error',
    ]);
  });

  it('3 回目の連続失敗で warn を出し batch を quarantine して cursor を進める', async () => {
    io.cursor = { offset: 0, storageErrorStreak: 2 };
    const route = await load();

    const response = await route.GET(request('secret'));

    // 応答は従来どおり 503 (取りこぼしを成功と偽らない)。
    expect(response.status).toBe(503);
    const quarantined = io.writes.at(-1) as ReverifyCursor;
    expect(quarantined.offset).toBe(25);
    expect(quarantined.storageErrorStreak).toBeUndefined();
    expect(logs.warn).toContainEqual([
      'x402.reverify.cursor_quarantined',
      expect.objectContaining({ offset: 0, nextOffset: 25, streak: 3 }),
    ]);
  });

  // 2026-09-06: 3 日間 503 が続いたのに「どの対象の・どの段階の KV 操作が失敗したか」が
  // 応答にもログにも無く原因を特定できなかった。503 応答 (GitHub Actions の cron ログに
  // 出る) と warn の両方に内訳を残す。
  it('503 応答と warn に storage 失敗の内訳 (対象・段階・KV の文言) を載せる', async () => {
    io.cursor = { offset: 0 };
    io.externalIds = ['r0'];
    const route = await load();

    const response = await route.GET(request('secret'));

    expect(response.status).toBe(503);
    const body = (await response.json()) as { storageFailures: unknown };
    expect(body.storageFailures).toEqual([
      { target: 'external:r0', stage: 'read', detail: 'http_error 500 ERR simulated' },
    ]);
    expect(logs.warn).toContainEqual([
      'x402.reverify.storage_error',
      expect.objectContaining({
        failures: [
          { target: 'external:r0', stage: 'read', detail: 'http_error 500 ERR simulated' },
        ],
      }),
    ]);
  });

  it('途中で成功が挟まれば streak は 0 に戻る', async () => {
    io.cursor = { offset: 0, storageErrorStreak: 2 };
    io.targetStorageError = false; // この run は storage エラー無し
    const route = await load();

    const response = await route.GET(request('secret'));

    expect(response.status).toBe(200);
    const saved = io.writes.at(-1) as ReverifyCursor;
    expect(saved.offset).toBe(25);
    expect(saved.storageErrorStreak).toBeUndefined();
    expect(logs.warn).toHaveLength(0);

    // 成功で streak が消えたので、次の失敗は 1 からやり直し (即 quarantine しない)。
    io.cursor = saved;
    io.targetStorageError = true;
    expect((await route.GET(request('secret'))).status).toBe(503);
    expect(io.writes.at(-1)).toMatchObject({ storageErrorStreak: 1 });
    // storage 失敗の内訳 warn は出るが、quarantine の warn は出ない。
    expect(logs.warn.map(([event]) => event)).toEqual(['x402.reverify.storage_error']);
  });
});
