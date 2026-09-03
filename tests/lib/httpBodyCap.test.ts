// lib/httpBodyCap.ts の分岐網羅。
// 「Content-Length を一切信用せず、実バイトの累積だけで打ち切る」ことが本モジュールの存在理由なので、
// 宣言長の欠落・詐称でも上限で止まること / 上限ちょうどは通ること / too_large と invalid_json を
// 取り違えないことを固定する。

import { describe, expect, it, vi } from 'vitest';
import {
  readBodyCapped,
  readJsonBodyCapped,
  type CappedJsonResult,
} from '@/lib/httpBodyCap';

const enc = new TextEncoder();

function streamOf(
  chunks: ReadonlyArray<Uint8Array>,
): { body: ReadableStream<Uint8Array> } {
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    }),
  };
}

function textSource(text: string) {
  return streamOf([enc.encode(text)]);
}

describe('readJsonBodyCapped', () => {
  it('上限ちょうどは通る (境界は「超過」でのみ弾く)', async () => {
    const json = JSON.stringify({ a: 'x'.repeat(10) });
    const cap = enc.encode(json).byteLength;
    const r = await readJsonBodyCapped(textSource(json), cap);
    expect(r).toEqual<CappedJsonResult>({ ok: true, value: { a: 'x'.repeat(10) } });
  });

  it('上限 +1 バイトで too_large (呼び元が 413 を返せる)', async () => {
    const json = JSON.stringify({ a: 'x'.repeat(10) });
    const cap = enc.encode(json).byteLength - 1;
    const r = await readJsonBodyCapped(textSource(json), cap);
    expect(r).toEqual<CappedJsonResult>({ ok: false, reason: 'too_large' });
  });

  it('分割チャンクでも累積で判定し、超過時は上流へ cancel を伝える', async () => {
    const cancel = vi.fn();
    // 閉じない (無限に流れ続ける) stream。cap 超過で reader.cancel が呼ばれないと
    // 読み続けてメモリ・帯域を食うため、cancel の伝播そのものを固定する。
    const source = {
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(enc.encode('aaaa'));
        },
        cancel() {
          cancel();
        },
      }),
    };
    const r = await readJsonBodyCapped(source, 5);
    expect(r).toEqual<CappedJsonResult>({ ok: false, reason: 'too_large' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('Content-Length を持たない stream でも実バイトで打ち切る', async () => {
    // Request 経由 (chunked/duplex) では宣言長が無い。helper は header を一切見ない。
    const req = new Request('http://localhost/x', {
      method: 'POST',
      body: 'x'.repeat(100),
    });
    const r = await readJsonBodyCapped(req, 10);
    expect(r).toEqual<CappedJsonResult>({ ok: false, reason: 'too_large' });
  });

  it('Content-Length が実体より小さく詐称されても実バイトで打ち切る', async () => {
    const req = new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'content-length': '2' },
      body: 'x'.repeat(100),
    });
    const r = await readJsonBodyCapped(req, 10);
    expect(r).toEqual<CappedJsonResult>({ ok: false, reason: 'too_large' });
  });

  it('JSON として壊れている body は invalid_json (too_large ではない)', async () => {
    const r = await readJsonBodyCapped(textSource('{ not json'), 1024);
    expect(r).toEqual<CappedJsonResult>({ ok: false, reason: 'invalid_json' });
  });

  it('UTF-8 として不正なバイト列も invalid_json', async () => {
    const r = await readJsonBodyCapped(streamOf([new Uint8Array([0xff, 0xfe])]), 1024);
    expect(r).toEqual<CappedJsonResult>({ ok: false, reason: 'invalid_json' });
  });

  it('body が無い (null) 場合は invalid_json に畳む', async () => {
    const r = await readJsonBodyCapped({ body: null }, 1024);
    expect(r).toEqual<CappedJsonResult>({ ok: false, reason: 'invalid_json' });
  });

  it('読み取り中の stream エラーも invalid_json (呼び元へ throw しない)', async () => {
    const source = {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error('boom'));
        },
      }),
    };
    const r = await readJsonBodyCapped(source, 1024);
    expect(r).toEqual<CappedJsonResult>({ ok: false, reason: 'invalid_json' });
  });
});

describe('readBodyCapped', () => {
  it('上限内はバイト列を返す', async () => {
    const bytes = await readBodyCapped(textSource('hello'), 1024);
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes as Uint8Array)).toBe('hello');
  });

  it('上限超過と body 欠落はどちらも null (呼び元は取得失敗として扱う)', async () => {
    expect(await readBodyCapped(textSource('hello'), 2)).toBeNull();
    expect(await readBodyCapped({ body: null }, 1024)).toBeNull();
  });
});
