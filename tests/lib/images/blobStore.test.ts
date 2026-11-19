// @vitest-environment node
// lib/images/blobStore の締切を、本物の @vercel/blob 2.8.2 で確かめる (Blob の API は undici の MockAgent が受け、外へは出ない)。
// SDK は 5xx を既定 10 回まで間を空けて送り直し、送り直しを止めるのは AbortError のときだけ。締切で
// - 呼び元へ BlobDeadlineError で返る (関数の上限より先に route が 503 を返せる)
// - その後 SDK が送り直しを続けない (次の送信が abort 済みの signal で止まり、残る timer が無い)
// ことを、偽の timer で時を進めて確かめる。締切は「各操作の上限」と「route の絶対の期限 (AbortSignal)」の早い方。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import {
  BLOB_LIST_DEADLINE_MS,
  BLOB_PUT_DEADLINE_MS,
  BlobDeadlineError,
  countImagesUnder,
  putPublicImage,
} from '@/lib/images/blobStore';

let original: Dispatcher;
let agent: MockAgent;
let requests: { method: string; path: string }[];

function fakeOidcToken(): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
}

/** Blob の API がずっと 503 (service_unavailable) を返す = SDK が送り直し続ける形。 */
function blobApiAlwaysUnavailable() {
  agent
    .get('https://vercel.com')
    .intercept({ path: (path) => path.startsWith('/api/blob'), method: () => true })
    .reply(503, (options) => {
      requests.push({ method: String(options.method), path: String(options.path) });
      return { error: { code: 'service_unavailable', message: 'try again' } };
    })
    .persist();
}

/** 本物の時は進めずに、偽の timer と undici の内側の待ち (setImmediate) を交互に進める。 */
async function advance(ms: number, step = 100) {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(step);
  }
}

beforeEach(() => {
  requests = [];
  original = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  vi.stubEnv('VERCEL_OIDC_TOKEN', fakeOidcToken());
  vi.stubEnv('BLOB_STORE_ID', 'store_test');
  vi.stubEnv('BLOB_READ_WRITE_TOKEN', undefined);
  vi.stubEnv('DEBUG', undefined);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  setGlobalDispatcher(original);
  await agent.close();
});

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const operations = [
  ['list (cursor を追う全体)', (route: AbortSignal) => countImagesUnder('v1/owner/', 200, route), BLOB_LIST_DEADLINE_MS],
  ['put', (route: AbortSignal) => putPublicImage('v1/owner/product/id.jpg', JPEG, 'image/jpeg', route), BLOB_PUT_DEADLINE_MS],
] as const;

describe('Blob の締切 (本物の SDK)', () => {
  it.each(operations)('%s: 上限で BlobDeadlineError を返し、その後 SDK は送り直さない', async (_label, run, deadlineMs) => {
    blobApiAlwaysUnavailable();
    let settled: unknown = 'pending';
    // route の絶対の期限はまだ先 (abort しない signal)。
    void run(new AbortController().signal).then(
      () => { settled = 'resolved'; },
      (error: unknown) => { settled = error; },
    );
    await advance(deadlineMs - 200);
    expect(settled).toBe('pending');
    expect(requests.length).toBeGreaterThanOrEqual(1);

    await advance(400);
    expect(settled).toBeInstanceOf(BlobDeadlineError);
    const attemptsAtDeadline = requests.length;

    // SDK の送り直しの間隔 (最大で数十秒) を十分に越えて進めても、Blob へ送らない・待ちの timer も残らない。
    await advance(120_000, 1_000);
    expect(requests.length).toBe(attemptsAtDeadline);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(operations)('%s: 上限より前でも、route の絶対の期限 (signal の abort) で BlobDeadlineError を返し、その後 SDK は送り直さない', async (_label, run) => {
    blobApiAlwaysUnavailable();
    const route = new AbortController();
    let settled: unknown = 'pending';
    void run(route.signal).then(
      () => { settled = 'resolved'; },
      (error: unknown) => { settled = error; },
    );
    // 上限 (5 秒・10 秒) よりずっと前の 2 秒で、route の期限が来る。
    await advance(2_000);
    expect(settled).toBe('pending');
    expect(requests.length).toBeGreaterThanOrEqual(1);
    route.abort();
    await advance(100);
    expect(settled).toBeInstanceOf(BlobDeadlineError);
    const attemptsAtDeadline = requests.length;

    await advance(120_000, 1_000);
    expect(requests.length).toBe(attemptsAtDeadline);
    // 上限の timer も残らない。
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(operations)('%s: route の絶対の期限を過ぎてから呼ぶと、Blob に送らずに BlobDeadlineError', async (_label, run) => {
    blobApiAlwaysUnavailable();
    const route = new AbortController();
    route.abort();
    await expect(run(route.signal)).rejects.toBeInstanceOf(BlobDeadlineError);
    await advance(120_000, 1_000);
    expect(requests).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
