// lib/httpBodyCap.ts の分岐網羅。
// 「Content-Length を一切信用せず、実バイトの累積だけで打ち切る」ことが本モジュールの存在理由なので、
// 宣言長の欠落・詐称でも上限で止まること / 上限ちょうどは通ること / too_large と invalid_json を
// 取り違えないことを固定する。

import { describe, expect, it, vi } from 'vitest';
import {
  readBodyCapped,
  readBodyPrefix,
  readJsonBodyCapped,
  readTextBodyCapped,
  type CappedJsonResult,
  type CappedTextResult,
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

describe('readTextBodyCapped', () => {
  const BOM = [0xef, 0xbb, 0xbf];
  const CAP = 64;

  // 置き換え前の読み口 (`req.text()` → `Buffer.byteLength(text) > cap` で 413) をこの runtime でそのまま動かした結果。
  async function viaReqText(bytes: Uint8Array<ArrayBuffer>, cap: number): Promise<CappedTextResult> {
    const text = await new Request('http://localhost/x', { method: 'POST', body: bytes }).text();
    return Buffer.byteLength(text, 'utf8') > cap ? { ok: false, reason: 'too_large' } : { ok: true, text };
  }

  // BOM の数 0〜3・不正な UTF-8 (0xFF / 途中で切れた 3 byte 文字 E3 81 / surrogate の ED A0 80)・生 byte が cap の前後 (+6/+7 を含む)。
  const inputs: Array<{ name: string; bytes: Uint8Array<ArrayBuffer> }> = [];
  for (const boms of [0, 1, 2, 3]) {
    for (const [badName, bad] of [['なし', []], ['FF', [0xff]], ['E3 81', [0xe3, 0x81]], ['ED A0 80', [0xed, 0xa0, 0x80]]] as const) {
      for (const size of [CAP - 2, CAP, CAP + 1, CAP + 3, CAP + 5, CAP + 6, CAP + 7, CAP + 9]) {
        const head = [...new Array<number[]>(boms).fill(BOM).flat(), ...enc.encode('{"a":"'), ...bad];
        const tail = [...enc.encode('"}')];
        const fill = size - head.length - tail.length;
        if (fill < 0) continue;
        inputs.push({
          name: `BOM ${boms} つ・不正 ${badName}・生 ${size} byte`,
          bytes: Uint8Array.from([...head, ...enc.encode('x'.repeat(fill)), ...tail]),
        });
      }
    }
  }

  it.each(inputs)('$name は req.text() と同じ結果', async ({ bytes }) => {
    expect(await readTextBodyCapped(streamOf([bytes]), CAP)).toEqual(await viaReqText(bytes, CAP));
    // 1 byte ずつの chunk でも同じ (多 byte 文字と BOM が chunk 境界で割れても復号は全体で行う)。
    const oneByOne = streamOf([...bytes].map((b) => Uint8Array.of(b)));
    expect(await readTextBodyCapped(oneByOne, CAP)).toEqual(await viaReqText(bytes, CAP));
  });

  it('入力の表は ok と too_large の両方を含み、不正な UTF-8 が上限以下の生 byte でも too_large になる例がある', async () => {
    const results = await Promise.all(inputs.map(async ({ bytes }) => ({ bytes, r: await viaReqText(bytes, CAP) })));
    expect(results.some(({ r }) => r.ok)).toBe(true);
    expect(results.some(({ r }) => !r.ok)).toBe(true);
    expect(results.some(({ bytes, r }) => !r.ok && bytes.byteLength <= CAP)).toBe(true);
  });

  it('body が無ければ空文字列 (req.text() と同じ)', async () => {
    expect(await readTextBodyCapped({ body: null }, CAP)).toEqual<CappedTextResult>({ ok: true, text: '' });
    expect(await readTextBodyCapped(new Request('http://localhost/x', { method: 'POST' }), CAP)).toEqual<CappedTextResult>(
      { ok: true, text: '' },
    );
  });

  it('生 byte が cap + 6 を超えた chunk で読むのをやめて上流へ cancel を伝える', async () => {
    const cancel = vi.fn();
    let pulls = 0;
    // 閉じない stream。cap + 6 を超えた時点で止まらないと読み続ける。
    const source = {
      body: new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls += 1;
            controller.enqueue(enc.encode('aaaa'));
          },
          cancel() {
            cancel();
          },
        },
        { highWaterMark: 0 },
      ),
    };
    expect(await readTextBodyCapped(source, 10)).toEqual<CappedTextResult>({ ok: false, reason: 'too_large' });
    expect(cancel).toHaveBeenCalledOnce();
    // 4 byte ずつ: 16 byte (cap + 6) までは読み、20 byte になった chunk で止める。
    expect(pulls).toBe(5);
  });

  it('読み取り中の stream エラーは unreadable (呼び元へ throw しない)', async () => {
    const source = {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error('boom'));
        },
      }),
    };
    expect(await readTextBodyCapped(source, CAP)).toEqual<CappedTextResult>({ ok: false, reason: 'unreadable' });
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

describe('readBodyPrefix', () => {
  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

  it('上限内は全体、上限超過は先頭 cap バイトだけを返す (チャンクの途中で切る)', async () => {
    expect(text(await readBodyPrefix(textSource('hello'), 1024))).toBe('hello');
    expect(text(await readBodyPrefix(streamOf([enc.encode('abc'), enc.encode('defgh')]), 5))).toBe('abcde');
  });

  it('上限に達したら残りを読まずに上流へ cancel を伝える', async () => {
    const cancel = vi.fn();
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
    expect(text(await readBodyPrefix(source, 6))).toBe('aaaaaa');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('stream が途中で切れたらそこまでの先頭を返し、body が無ければ空 (throw しない)', async () => {
    // start で enqueue → error すると queue ごと捨てられるので、1 回目の pull で渡し 2 回目で切る。
    let sent = false;
    const source = {
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) {
            controller.error(new Error('boom'));
            return;
          }
          sent = true;
          controller.enqueue(enc.encode('head'));
        },
      }),
    };
    expect(text(await readBodyPrefix(source, 1024))).toBe('head');
    expect((await readBodyPrefix({ body: null }, 1024)).byteLength).toBe(0);
  });

  it('読み終えたら body の lock を外す (末尾まで読んだ場合・cap で cancel した場合・途中で切れた場合)', async () => {
    const eof = textSource('hello');
    await readBodyPrefix(eof, 1024);
    expect(eof.body.locked).toBe(false);

    const endless = {
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(enc.encode('aaaa'));
        },
      }),
    };
    await readBodyPrefix(endless, 6);
    expect(endless.body.locked).toBe(false);

    const broken = {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error('boom'));
        },
      }),
    };
    await readBodyPrefix(broken, 1024);
    expect(broken.body.locked).toBe(false);
  });
});
