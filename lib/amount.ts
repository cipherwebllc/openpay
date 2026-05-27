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
