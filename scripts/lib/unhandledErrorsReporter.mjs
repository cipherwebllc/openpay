// vitest の未処理エラー (assertion の外で起きた Unhandled Rejection / Uncaught Exception) を数えて
// ファイルに書く reporter。JSON reporter の numFailedTests には載らないため、run-tests.mjs が
// 終了コードを見ずに JSON だけで合否を決めると見逃す (第 7 回レビュー #759 の指摘)。
// 書き出し先は RUN_TESTS_UNHANDLED_OUT (run-tests.mjs・run-lua-tests.mjs が渡す)。無ければ何もしない。
//
// 実行の終わりの hook は vitest の版で違う: 2.x は onFinished(files, errors)・4 以降は onFinished を呼ばず
// onTestRunEnd(testModules, unhandledErrors, reason) (2.1.9 には onTestRunEnd が無い)。両方を持たせ、最初に
// 呼ばれた方だけを書く (両方を呼ぶ版でも、後の呼び出しが先の集計を上書きして件数を減らさない)。
import { writeFileSync } from 'node:fs';

export default class UnhandledErrorsReporter {
  #written = false;

  onFinished(_files, errors = []) {
    this.#write(errors);
  }

  onTestRunEnd(_testModules, unhandledErrors = []) {
    this.#write(unhandledErrors);
  }

  #write(errors) {
    const out = process.env.RUN_TESTS_UNHANDLED_OUT;
    if (!out || this.#written) return;
    this.#written = true;
    const messages = errors.map((e) => String(e?.stack ?? e?.message ?? e).split('\n').slice(0, 3).join('\n'));
    writeFileSync(out, JSON.stringify({ count: errors.length, messages }));
  }
}

// reporter が書いた本文 (読めなければ null) から合否を決める。書かれていない・壊れている
// (= vitest が onFinished / onTestRunEnd まで進まなかった) も fail。run-tests.mjs の判定をテストで固定するための純関数。
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
