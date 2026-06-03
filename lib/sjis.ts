// 弥生会計 (インストール版) ネイティブ取込用の Shift_JIS エンコード。
//
// encoding-japanese (~50KB) は「弥生ネイティブ CSV を書き出す瞬間」しか使わないため、
// 動的 import で遅延ロードし初期バンドル (とりわけ /pay の 420kB 予算) に載せない。
// UTF-8 出力は TextEncoder で同期に済むので、ここは Shift_JIS 専用。

export async function encodeShiftJis(
  text: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const { convert, stringToCode } = await import('encoding-japanese');
  // string → Unicode コードポイント配列 → Shift_JIS バイト配列。
  const codes = convert(stringToCode(text), 'SJIS', 'UNICODE');
  // ArrayBuffer 裏付けを明示 (Blob/BlobPart が SharedArrayBuffer 裏付けを受け付けないため)。
  const bytes = new Uint8Array(codes.length);
  bytes.set(codes);
  return bytes;
}
