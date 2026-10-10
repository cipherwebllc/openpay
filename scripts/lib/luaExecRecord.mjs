// 実 Lua ハーネス (tests/_helpers/redisLua.ts) が実行した Lua 本文の記録 (opt-in・既定は無効)。
//
// 目的: 「どの Lua が実 Lua テストで実行されたか」を、静的解析を使わずに数えるための土台
// (第 7 回レビュー F10・plans/lua-registry-defineLua.md の PR-0)。記録するのは EVAL に実際に渡った本文
// なので、送信関数の別名・文字列の組み立て・route の中の Lua でも取りこぼさない。
// 突き合わせる側 (登録表の全本文が 1 度以上実行されたか) はこの形式を読むだけでよい。
//
// 有効化: 環境変数 LUA_EXEC_RECORD_DIR に、OS の tmpdir 配下に作った空ディレクトリの絶対パスを渡す。
//   例: LUA_EXEC_RECORD_DIR="$(mktemp -d)" node scripts/run-lua-tests.mjs
// 未設定なら何もしない (CI と通常の vitest の挙動は変わらない)。vitest の fork worker にも env はそのまま渡る。
//
// 記録の形 (dir 配下):
//   scripts/<sha256>.lua  実行した本文そのもの (内容アドレス・同じ本文は 1 file)
//   executions.jsonl      1 EVAL = 1 行 {"sha256": 本文の sha256 (hex), "testPath": 実行した test file (repo 相対) か null}
// Lua の実行が失敗した EVAL も記録する (送られた本文の記録であって、成否の記録ではない)。

import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

export const LUA_EXEC_RECORD_ENV = 'LUA_EXEC_RECORD_DIR';

const SCRIPTS_DIR = 'scripts';
const EXECUTIONS_FILE = 'executions.jsonl';

/** 本文の sha256 (hex)。記録の file 名と executions.jsonl の照合キー。 */
export function luaScriptSha256(script) {
  return createHash('sha256').update(script, 'utf8').digest('hex');
}

/**
 * 記録先 (実パス) を返す。env が未設定なら null (= 記録しない)。
 * 記録を repo の作業ツリーに書いて commit や CI に混ぜないため、OS の tmpdir 配下の既存ディレクトリだけを受け付け、
 * それ以外は黙って別の場所に書かずに例外にする。
 */
export function luaExecRecordDir(env = process.env) {
  const dir = env[LUA_EXEC_RECORD_ENV];
  if (!dir) return null;
  if (!isAbsolute(dir)) {
    throw new Error(`${LUA_EXEC_RECORD_ENV} must be an absolute path under the OS tmpdir: ${dir}`);
  }
  const real = realpathSync(dir);
  if (!real.startsWith(realpathSync(tmpdir()) + sep)) {
    throw new Error(`${LUA_EXEC_RECORD_ENV} must be under the OS tmpdir (${tmpdir()}): ${dir}`);
  }
  return real;
}

/** 1 EVAL 分を記録し、本文の sha256 を返す。testPath は絶対パス (vitest の expect.getState().testPath) か undefined。 */
export function recordLuaExecution(dir, script, testPath) {
  const sha256 = luaScriptSha256(script);
  const bodyDir = join(dir, SCRIPTS_DIR);
  mkdirSync(bodyDir, { recursive: true });
  const bodyPath = join(bodyDir, `${sha256}.lua`);
  if (!existsSync(bodyPath)) {
    // 並列の worker が同じ本文を同時に書いても、読む側が書きかけの file を見ないよう一時名から rename する。
    const temporary = `${bodyPath}.${process.pid}.tmp`;
    writeFileSync(temporary, script, 'utf8');
    renameSync(temporary, bodyPath);
  }
  const line = { sha256, testPath: testPath ? relative(process.cwd(), testPath).split(sep).join('/') : null };
  appendFileSync(join(dir, EXECUTIONS_FILE), `${JSON.stringify(line)}\n`, 'utf8');
  return sha256;
}

/** 記録を読む。1 度も EVAL が無ければ (file がまだ無ければ) 空。 */
export function readLuaExecRecord(dir) {
  const bodies = new Map();
  const bodyDir = join(dir, SCRIPTS_DIR);
  if (existsSync(bodyDir)) {
    for (const name of readdirSync(bodyDir).sort()) {
      if (name.endsWith('.lua')) bodies.set(name.slice(0, -'.lua'.length), readFileSync(join(bodyDir, name), 'utf8'));
    }
  }
  const executionsPath = join(dir, EXECUTIONS_FILE);
  const executions = existsSync(executionsPath)
    ? readFileSync(executionsPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return { bodies, executions };
}
