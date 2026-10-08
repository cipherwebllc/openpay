import { DECIMAL_PATTERN } from './url';

// 金額文字列ユーティリティ。digit / 小数のみ許容し token decimals に丸める。
// QrGenerator (レジ用クイック金額) と TipEmbedGenerator (チップ金額プリセット) で共用。

// 入力値を decimals に丸める: digit と '.' 以外を除去し、小数桁が decimals を超えたら
// 切り詰める。digit を含まない入力は '' を返す (呼び出し側で空/不正として除外する)。
export function truncateAmount(raw: string, decimals: number): string {
  const cleaned = raw.replace(/[^\d.]/g, '');
  const dotIdx = cleaned.indexOf('.');
  if (dotIdx === -1) return cleaned;
  const fracDigits = cleaned.length - dotIdx - 1;
  if (fracDigits <= decimals) return cleaned;
  return cleaned.slice(0, dotIdx + 1 + decimals);
}

// 金額リストを decimals に丸め、0 / 不正 / (丸め後の) 重複を除いた有効値だけを返す。
// クイック金額ボタン・プリセットチップの表示および URL 生成で使う。
export function normalizeAmountList(
  list: readonly string[],
  decimals: number,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    if (!DECIMAL_PATTERN.test(raw) || Number(raw) <= 0) continue;
    const truncated = truncateAmount(raw, decimals);
    if (!DECIMAL_PATTERN.test(truncated) || Number(truncated) <= 0) continue;
    if (seen.has(truncated)) continue;
    seen.add(truncated);
    out.push(truncated);
  }
  return out;
}

// 表示用に整数部へ 3 桁区切りを入れる ("3000" → "3,000"・"1000.5" → "1,000.5")。
// 文字列のまま区切る (Number に通さない = 18 桁の小数でも丸めない)。URL・保存値には使わない (表示専用)。
// 最初の小数点より後ろはそのまま残す (入力途中の文字を表示から落とさない)。
export function groupAmountDigits(raw: string): string {
  const dot = raw.indexOf('.');
  const int = dot === -1 ? raw : raw.slice(0, dot);
  const rest = dot === -1 ? '' : raw.slice(dot);
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + rest;
}

// 桁区切りつきで見せている金額欄の編集を、区切りなしの値と caret の位置に直す (caretLeft = caret より左にある
// 文字の数・区切りは数えない)。左から数えるので、区切りの増減や末尾の切り捨てがあっても caret はずれない。
// - 区切りだけを消した (値が変わらない) ときは、その隣の数字を消す (Backspace は左・Delete は右)。
// - 小数点は 1 つだけ。2 つ目は受け付けず、caret は打つ前の位置に戻す。
export function editGroupedAmount(input: {
  /** 編集後の入力欄の文字列 (区切りを含む)。 */
  value: string;
  /** 編集後の caret 位置 (value の中の位置)。 */
  caret: number;
  /** InputEvent.inputType (無ければ空文字)。 */
  inputType: string;
  /** 編集前の値 (区切りなし)。 */
  prev: string;
  decimals: number;
}): { amount: string; caretLeft: number } {
  const { value, caret, inputType, prev, decimals } = input;
  let digits = value.replace(/,/g, '');
  let left = value.slice(0, caret).replace(/,/g, '').length;
  if (inputType.startsWith('delete') && digits === prev) {
    if (inputType === 'deleteContentForward') {
      digits = digits.slice(0, left) + digits.slice(left + 1);
    } else if (left > 0) {
      digits = digits.slice(0, left - 1) + digits.slice(left);
      left -= 1;
    }
  }
  const next = truncateAmount(digits, decimals);
  if (next.indexOf('.') !== next.lastIndexOf('.')) {
    const inserted = Math.max(0, value.length - groupAmountDigits(prev).length);
    return { amount: prev, caretLeft: Math.min(Math.max(0, left - inserted), prev.length) };
  }
  return {
    amount: next,
    caretLeft: Math.min(truncateAmount(digits.slice(0, left), decimals).length, next.length),
  };
}
