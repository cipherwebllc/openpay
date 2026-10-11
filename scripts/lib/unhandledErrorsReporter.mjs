// vitest の未処理エラー (assertion の外で起きた Unhandled Rejection / Uncaught Exception) を数えて
// ファイルに書く reporter。JSON reporter の numFailedTests には載らないため、run-tests.mjs が
// 終了コードを見ずに JSON だけで合否を決めると見逃す (第 7 回レビュー #759 の指摘)。
// 書き出し先は RUN_TESTS_UNHANDLED_OUT (run-tests.mjs・run-lua-tests.mjs が渡す)。無ければ何もしない。
//
// 実行の終わりの hook は onTestRunEnd(testModules, unhandledErrors, reason) (vitest 4 以降)。vitest 2.x の
// onFinished(files, errors) は 4 以降では呼ばれないので持たない (vitest 5 への更新で削除)。
import { writeFileSync } from 'node:fs';

export default class UnhandledErrorsReporter {
  onTestRunEnd(_testModules, unhandledErrors = []) {
    const out = process.env.RUN_TESTS_UNHANDLED_OUT;
    if (!out) return;
    const messages = unhandledErrors.map((e) => String(e?.stack ?? e?.message ?? e).split('\n').slice(0, 3).join('\n'));
    writeFileSync(out, JSON.stringify({ count: unhandledErrors.length, messages }));
  }
}

// reporter が書いた本文 (読めなければ null) から合否を決める。書かれていない・壊れている
// (= vitest が onTestRunEnd まで進まなかった) も fail。run-tests.mjs の判定をテストで固定するための純関数。
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
