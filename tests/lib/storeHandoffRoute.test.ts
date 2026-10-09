import { describe, it, expect } from 'vitest';
import { MAX_BODY_BYTES } from '@/lib/relay/relayRoute';
import { readHandoffBody } from '@/lib/storeHandoffRoute';

// 本文を小分けに流し、何回読まれたか・途中で打ち切られたかを数える Request。
function streamed(totalBytes: number, chunkBytes: number) {
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled * chunkBytes >= totalBytes) {
        controller.close();
        return;
      }
      pulled += 1;
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x20));
    },
    cancel() {
      cancelled = true;
    },
  });
  const req = new Request('https://open-pay.jp/api/register/handoff', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: stream,
    duplex: 'half',
  } as RequestInit);
  return { req, pulled: () => pulled, cancelled: () => cancelled };
}

const post = (body: string) =>
  new Request('https://open-pay.jp/api/register/handoff', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });

describe('readHandoffBody (受け渡し API の本文)', () => {
  // A14/G10/C4: 4 KB の上限は「全部読んでから測る」のではなく、読みながら超えた時点で打ち切る (メモリ確保を止める)。
  it('上限を超えたら読み込みを打ち切って 413 (1 MiB の本文を全部は読まない)', async () => {
    const s = streamed(1024 * 1024, 1024);
    const r = await readHandoffBody(s.req);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.res.status).toBe(413);
    expect(await r.res.json()).toEqual({ ok: false, error: 'payload_too_large' });
    expect(r.res.headers.get('cache-control')).toBe('no-store');
    expect(s.pulled()).toBeLessThan(32);
    expect(s.cancelled()).toBe(true);
  });

  it('上限ちょうどの本文は読む (正規の本文を 413 にしない)', async () => {
    const pad = 'x'.repeat(MAX_BODY_BYTES - JSON.stringify({ pad: '' }).length);
    const body = JSON.stringify({ pad });
    expect(Buffer.byteLength(body)).toBe(MAX_BODY_BYTES);
    const r = await readHandoffBody(post(body));
    expect(r).toEqual({ ok: true, body: { pad } });
    const over = await readHandoffBody(post(JSON.stringify({ pad: `${pad}x` })));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.res.status).toBe(413);
  });

  it('応答の形は従来どおり: 壊れた JSON・本文なしは 400 invalid_json、オブジェクト以外は 400 invalid_body', async () => {
    for (const [req, error] of [
      [post('{not json'), 'invalid_json'],
      [new Request('https://open-pay.jp/api/register/handoff', { method: 'POST' }), 'invalid_json'],
      [post('[1,2]'), 'invalid_body'],
      [post('null'), 'invalid_body'],
      [post('"x"'), 'invalid_body'],
    ] as const) {
      const r = await readHandoffBody(req);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.res.status).toBe(400);
      expect(await r.res.json()).toEqual({ ok: false, error });
    }
  });

  it('オブジェクトの本文はそのまま返す', async () => {
    expect(await readHandoffBody(post(JSON.stringify({ chainId: 137, merchant: '0xabc' })))).toEqual({
      ok: true,
      body: { chainId: 137, merchant: '0xabc' },
    });
  });
});
