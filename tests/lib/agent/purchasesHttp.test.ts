// @vitest-environment node
// purchasesSession: SIWE セッションの読み取り結果を Agent 購入履歴 API の private な応答へ写す。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ readSession: vi.fn() }));
vi.mock('@/app/api/auth/siwe/_session', () => ({ readSession: h.readSession }));

import { purchasesSession } from '@/lib/agent/purchasesHttp';

const OWNER = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

beforeEach(() => {
  h.readSession.mockReset();
});

async function failure(result: Awaited<ReturnType<typeof purchasesSession>>) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected failure');
  return {
    status: result.response.status,
    body: await result.response.json(),
    cacheControl: result.response.headers.get('Cache-Control'),
  };
}

describe('purchasesSession', () => {
  it('サインイン済みは address を返す', async () => {
    h.readSession.mockResolvedValue({ status: 'authenticated', address: OWNER });
    expect(await purchasesSession()).toEqual({ ok: true, address: OWNER });
  });

  it('未サインインは private な 401', async () => {
    h.readSession.mockResolvedValue({ status: 'missing' });
    expect(await failure(await purchasesSession())).toEqual({
      status: 401, body: { reason: 'not_signed_in' }, cacheControl: 'private, no-store',
    });
  });

  it('セッションの KV 障害 (storage-error) は private な 503 (未サインイン扱いにしない)', async () => {
    h.readSession.mockResolvedValue({ status: 'storage-error' });
    expect(await failure(await purchasesSession())).toEqual({
      status: 503, body: { reason: 'storage_error' }, cacheControl: 'private, no-store',
    });
  });

  // C3: readSession は KV 障害を storage-error で返し reject しない (lib/kv の no-throw 契約)。残る throw は
  // cookies() を request の外で呼んだ誤用だけで、呼び出し元はすべて force-dynamic の route。その例外を 503 に
  // 化かす保険は持たない (Next が cookies() で投げる dynamic の合図も握りつぶさない)。
  it('readSession の reject は 503 に化かさない', async () => {
    h.readSession.mockRejectedValue(new Error('cookies was called outside a request scope'));
    await expect(purchasesSession()).rejects.toThrow('outside a request scope');
  });
});
