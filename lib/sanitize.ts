// C0 制御文字 (U+0000–U+001F、タブ含む) と DEL (U+007F) を削除し前後 trim する。
// URL params / LocalStorage / draft 入力など複数経路で文字列受入時に共通使用する
// セキュリティ関連 helper。許可文字集合をここ 1 箇所で管理することで、将来
// (例: U+200B zero-width space) 拡張時の同期漏れを防ぐ。
const CONTROL_CHAR_REGEX = /[\x00-\x1f\x7f]/g;

// 不対サロゲートは不正 Unicode で encodeURIComponent を throw させるため制御文字と同様に除去
// (入力経路の単一チョークポイント)。
// - high surrogate (U+D800–U+DBFF) の直後に low surrogate (U+DC00–U+DFFF) が続かない場合
// - low surrogate の直前に high surrogate がない場合
const UNPAIRED_SURROGATE_REGEX =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function stripControlChars(value: string): string {
  return value
    .replace(CONTROL_CHAR_REGEX, '')
    .replace(UNPAIRED_SURROGATE_REGEX, '')
    .trim();
}

// 文字列を UTF-16 コードユニット単位で max 以内に切詰める。
// 切詰位置 max-1 が high surrogate (ペアの前半) の場合はペアごと落として max-1 で返す。
// 孤立サロゲートは encodeURIComponent が throw し URL 生成を壊すため、境界のペアは丸ごと落とす。
export function truncateSafe(value: string, max: number): string {
  if (value.length <= max) return value;
  // max-1 が high surrogate なら、low surrogate を含めてペアごと落とす
  const boundary = value.charCodeAt(max - 1);
  if (boundary >= 0xd800 && boundary <= 0xdbff) {
    return value.slice(0, max - 1);
  }
  return value.slice(0, max);
}
