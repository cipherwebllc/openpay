import 'server-only';

type BodySource = {
  readonly body: ReadableStream<Uint8Array> | null;
};

type BodyReadResult =
  | { ok: true; bytes: Uint8Array<ArrayBuffer> }
  | { ok: false; reason: 'too_large' | 'unreadable' };

export type CappedJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'too_large' | 'invalid_json' };

export type CappedTextResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'too_large' | 'unreadable' };

// req.text() が外す先頭の BOM (EF BB BF) は最大 2 つ = 6 byte (Node 26 の undici で確認: BOM を 1 つ外したうえで、BOM を
// 外す既定の TextDecoder に渡す)。readTextBodyCapped が生 byte で余分に読む量。1 つしか外さない runtime でも、余分に読む
// だけで結果は変わらない。
const MAX_STRIPPED_BOM_BYTES = 6;

async function consumeBodyCapped(
  source: BodySource,
  cap: number,
): Promise<BodyReadResult> {
  const reader = source.body?.getReader();
  if (!reader) return { ok: false, reason: 'unreadable' };

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > cap) {
        // 上限超過後の外部 body を読み続けてメモリ・帯域を消費しないため接続側へ中断を伝える。
        try {
          await reader.cancel();
        } catch {
          // cap 超過は既に確定済み。cancel 失敗を呼び元へ波及させて判定を変えない。
        }
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: 'unreadable' };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

// body を逐次読みし、Content-Length の欠落・詐称時も累積 cap でメモリ確保を止める。
export async function readBodyCapped(
  source: BodySource,
  cap: number,
): Promise<Uint8Array | null> {
  const result = await consumeBodyCapped(source, cap);
  return result.ok ? result.bytes : null;
}

// `const text = await req.text(); if (Buffer.byteLength(text, 'utf8') > cap) → 413` と同じ結果を、上限を大きく超える body を
// 最後まで読まずに返す (req.text() で読んでいた relay/facilitator 等の入口の、応答を変えずに読み口だけ差し替えるため)。
// - text は req.text() と同じ文字列 (先頭の BOM を外し、不正な UTF-8 は U+FFFD に置き換える)。BOM の外し方を runtime の
//   req.text() と食い違わせないよう、復号は同じ実装 (Response#text) に任せる。
// - too_large は従来どおり「復号した文字列を UTF-8 に戻した長さ > cap」。不正な UTF-8 は置換文字 (3 byte) に伸びるので、
//   生 byte が cap 以下でも too_large になりうる (fatal に復号する readJsonBodyCapped とはここが違う)。
// - 生 byte が cap + 6 を超えたらその chunk で読むのをやめて cancel する。復号で縮むのは外れる BOM (最大 6 byte) だけで
//   置換は長さを縮めないので、cap + 6 を超えた body は全体を読んでも必ず too_large になる (結果は変わらない)。違いが出るのは
//   cap + 6 を超えたあとで stream が切れる body だけで、req.text() なら投げていた (unreadable) ところを too_large で返す。
// - body が無ければ空文字列 (req.text() と同じ)。読み取り中の stream の失敗は unreadable (req.text() が投げるのと同じ扱い)。
// 前提: body はまだ誰も読んでいない (lock も消費もされていない)。lock 済みなら getReader() が投げて呼び元へ伝わり、一部を
// 読まれた後なら残りだけを受理しうる (req.text() はどちらも投げる)。使っている 8 本の route は body に先に触らないので、
// 守りは置かない。
export async function readTextBodyCapped(
  source: BodySource,
  cap: number,
): Promise<CappedTextResult> {
  if (!source.body) return { ok: true, text: '' };
  const result = await consumeBodyCapped(source, cap + MAX_STRIPPED_BOM_BYTES);
  if (!result.ok) return result;
  const text = await new Response(result.bytes).text();
  if (Buffer.byteLength(text, 'utf8') > cap) return { ok: false, reason: 'too_large' };
  return { ok: true, text };
}

// body の先頭 cap バイトだけを返す (全体は要らず、先頭に印があるかだけを見る判定用)。cap に達したら残りは読まずに
// cancel し、stream が途中で切れたらそこまでに読めた分を返す。body が無ければ空。
export async function readBodyPrefix(
  source: BodySource,
  cap: number,
): Promise<Uint8Array> {
  const reader = source.body?.getReader();
  if (!reader) return new Uint8Array(0);

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const kept = value.byteLength > cap - total ? value.subarray(0, cap - total) : value;
      chunks.push(kept);
      total += kept.byteLength;
    }
    if (total >= cap) {
      try {
        await reader.cancel();
      } catch {
        // 先頭は読み終えている。cancel の失敗を呼び元へ波及させて判定を変えない。
      }
    }
  } catch {
    // stream の途中の失敗は「そこまでの先頭」を返す (呼び元は先頭だけで判定する)。
  } finally {
    // 読み終えた body の lock を外す。read と cancel はすべて await 済みで保留中の read が無いので、releaseLock は投げない
    // (守りは置かない)。
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// Request/Response 共通の capped JSON reader。UTF-8 と JSON のどちらかを解釈できなければ
// invalid_json、stream の累積が cap を超えた場合だけ too_large として呼び元が 413 を返せる。
export async function readJsonBodyCapped(
  source: BodySource,
  cap: number,
): Promise<CappedJsonResult> {
  const result = await consumeBodyCapped(source, cap);
  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason === 'too_large' ? 'too_large' : 'invalid_json',
    };
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(result.bytes);
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
}
