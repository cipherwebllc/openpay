// C0 制御文字 (U+0000–U+001F、タブ含む) と DEL (U+007F) を削除し前後 trim する。
// URL params / LocalStorage / draft 入力など複数経路で文字列受入時に共通使用する
// セキュリティ関連 helper。許可文字集合をここ 1 箇所で管理することで、将来
// (例: U+200B zero-width space) 拡張時の同期漏れを防ぐ。
const CONTROL_CHAR_REGEX = /[\x00-\x1f\x7f]/g;

export function stripControlChars(value: string): string {
  return value.replace(CONTROL_CHAR_REGEX, '').trim();
}
