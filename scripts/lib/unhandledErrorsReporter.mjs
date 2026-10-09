// vitest の未処理エラー (assertion の外で起きた Unhandled Rejection / Uncaught Exception) を数えて
// ファイルに書く reporter。JSON reporter の numFailedTests には載らないため、run-tests.mjs が
// 終了コードを見ずに JSON だけで合否を決めると見逃す (第 7 回レビュー #759 の指摘)。
// 書き出し先は RUN_TESTS_UNHANDLED_OUT (run-tests.mjs が渡す)。無ければ何もしない。
import { writeFileSync } from 'node:fs';

export default class UnhandledErrorsReporter {
  onFinished(_files, errors = []) {
    const out = process.env.RUN_TESTS_UNHANDLED_OUT;
    if (!out) return;
    const messages = errors.map((e) => String(e?.stack ?? e?.message ?? e).split('\n').slice(0, 3).join('\n'));
    writeFileSync(out, JSON.stringify({ count: errors.length, messages }));
  }
}

// reporter が書いた本文 (読めなければ null) から合否を決める。書かれていない・壊れている
// (= vitest が onFinished まで進まなかった) も fail。run-tests.mjs の判定をテストで固定するための純関数。
export function evaluateUnhandled(text) {
  let parsed;
  try {
    parsed = typeof text === 'string' ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!parsed || !Number.isInteger(parsed.count) || parsed.count < 0) {
    return { ok: false, readable: false, count: 0, messages: [] };
  }
  const messages = Array.isArray(parsed.messages) ? parsed.messages.map(String) : [];
  return { ok: parsed.count === 0, readable: true, count: parsed.count, messages };
}
