// 弥生会計 (インストール版) ネイティブ取込用の Shift_JIS エンコード。
//
// encoding-japanese (~50KB) は「弥生ネイティブ CSV を書き出す瞬間」しか使わないため、
// 動的 import で遅延ロードし初期バンドル (とりわけ /pay の 420kB 予算) に載せない。
// UTF-8 出力は TextEncoder で同期に済むので、ここは Shift_JIS 専用。

/**
 * Shift_JIS で表現できない文字 (絵文字・𠮷 等の JIS 外字) を列挙する。
 *
 * encodeShiftJis は変換不能文字を無言で `?` に落とすため、書き出し前に「何文字が置換されるか」を
 * 呼出側が利用者へ提示できるようにする。判定は往復変換 (Unicode → SJIS → Unicode) の一致比較。
 * 重複文字は 1 度だけ判定し、初出順のユニークな配列を返す (CSV 全文でも変換回数が抑えられる)。
 * 元から `?` の文字は往復しても `?` なので判定不能 → 除外する。
 */
export async function sjisLossyChars(text: string): Promise<string[]> {
  const { convert, stringToCode, codeToString } = await import(
    'encoding-japanese'
  );
  const seen = new Set<string>();
  const lossy: string[] = [];
  for (const ch of text) {
    if (ch === '?' || seen.has(ch)) continue;
    seen.add(ch);
    const sjis = convert(stringToCode(ch), 'SJIS', 'UNICODE');
    if (codeToString(convert(sjis, 'UNICODE', 'SJIS')) !== ch) lossy.push(ch);
  }
  return lossy;
}

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
