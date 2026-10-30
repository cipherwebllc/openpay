import 'server-only';

type BodySource = {
  readonly body: ReadableStream<Uint8Array> | null;
};

type BodyReadResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: 'too_large' | 'unreadable' };

export type CappedJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'too_large' | 'invalid_json' };

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
