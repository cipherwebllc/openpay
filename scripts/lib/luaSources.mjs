// repo の Lua (Upstash EVAL で外部送信するスクリプト) をソースから機械的に列挙する単一情報源。
//
// 第 7 回レビュー C5 / F10 / F17 / E11: Lua は lib/・app/・scripts/ の 39 file に散在し、
// (1) 本番 bundle の破損検査 (scripts/check-lua-bundle.mjs) は手書きの断片 11 個だけ、
// (2) 「テンプレート禁止」の網はソースにも無く、(3) 実 Lua (wasmoon) で 1 度も実行されない Lua が残っていた。
// 3 つとも「どの文字列が Lua か」を手で列挙していたのが原因なので、ここで TypeScript の構文木から拾う。
//
// 拾い方: 文字列リテラル (と `${}` を含むテンプレート) の値に LUA_MARKER があれば、その文字列を含む
// 「文字列を組み立てる式」(`+` 連結・括弧・`as`・`[...].join(sep)`) を外側へたどった全体を 1 本の Lua とみなす。
// 組み立て式の中の識別子・関数呼び出し (`String(N)` 等) は値が分からないので dynamic として記録し、
// 静的な文字列片 (fragments) だけを検査に使う。
//
// 2026-09-06 の実害 (minifier が `+` 連結中のテンプレートの `${}` 以降を落とし、本番だけ EVAL が 400) は
// feedback_bundle_first_when_prod_only / scripts/check-lua-bundle.mjs 冒頭を参照。

import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import ts from 'typescript';

/** Lua を探すディレクトリ (repo root からの相対)。tests/ は対象外 (ハーネス自身の Lua は外部送信しない)。 */
export const LUA_SOURCE_DIRS = ['lib', 'app', 'scripts'];

/** Lua であることの目印。文字列の値にこれがあれば、その文字列を含む組み立て式全体を Lua とみなす。
 *  `[rR]edis` は lib/license/stock.ts の `realRedis.call` (redis を包み直した Lua) も拾うため。 */
export const LUA_MARKER = /[rR]edis\.p?call\s*\(|\bKEYS\[|\bARGV\[|\bcjson\.(?:encode|decode)\b/;

// Lua を外部送信しない file (Lua の断片を「検査の期待値」として持つだけ)。
const NOT_LUA_SENDERS = new Set(['scripts/check-lua-bundle.mjs']);
const SOURCE_EXT = /\.(?:ts|tsx|mts|mjs|js|cjs)$/;
const SKIP_DIRS = new Set(['node_modules', '.next', '.git']);

function walk(root, dir, out) {
  let entries;
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(root, join(dir, entry.name), out);
    } else if (SOURCE_EXT.test(entry.name) && !entry.name.endsWith('.d.ts') && !entry.name.endsWith('.d.mts')) {
      out.push(join(dir, entry.name).split(sep).join('/'));
    }
  }
  return out;
}

/** repo の全 Lua を列挙する (file の昇順・file 内は出現順)。 */
export function listLuaScripts(root, dirs = LUA_SOURCE_DIRS) {
  return dirs
    .flatMap((dir) => walk(root, dir, []))
    .filter((file) => !NOT_LUA_SENDERS.has(file))
    .sort()
    .flatMap((file) => {
      const text = readFileSync(join(root, file), 'utf8');
      // 構文木を作る前の安い絞り込み (目印の無い file に Lua は無い)。
      return LUA_MARKER.test(text) ? extractLuaScripts(file, text) : [];
    });
}

/** Lua を含む source file を repo-relative path (posix 区切り) の昇順で返す。 */
export function listLuaSourceFiles(root, dirs = LUA_SOURCE_DIRS) {
  return [...new Set(listLuaScripts(root, dirs).map((script) => script.file))];
}

function scriptKind(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.ts') || file.endsWith('.mts')) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function isPlus(node) {
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;
}

// `[...].join(sep)` の呼び出しなら、その配列を返す。
function joinedArray(node) {
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'join') return null;
  return ts.isArrayLiteralExpression(callee.expression) ? callee.expression : null;
}

function isWrapper(node) {
  return ts.isParenthesizedExpression(node)
    || ts.isAsExpression(node)
    || (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(node));
}

// 文字列を組み立てる式を外側へたどり、Lua 1 本分の根を返す。
function climb(node) {
  let cur = node;
  for (;;) {
    const parent = cur.parent;
    if (!parent) return cur;
    if (isWrapper(parent) || isPlus(parent)) {
      cur = parent;
      continue;
    }
    // `${LUA_CONST}` で Lua を差し込むテンプレートも組み立て式 (E11 の禁止対象) として拾う。
    if (ts.isTemplateSpan(parent) && parent.expression === cur) {
      cur = parent.parent;
      continue;
    }
    if (ts.isArrayLiteralExpression(parent)) {
      const call = parent.parent?.parent;
      if (call && joinedArray(call) === parent) {
        cur = call;
        continue;
      }
    }
    return cur;
  }
}

function staticTextOf(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => span.literal.text).join('');
  }
  return null;
}

// 組み立て式を、値の順に「静的な文字列片 ({text})」と「値の分からない式 ({expr})」の列にする。
function collect(node, out) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    out.parts.push({ text: node.text });
    return;
  }
  if (ts.isTemplateExpression(node)) {
    out.templateSubstitutions.push(node.templateSpans.map((span) => span.expression.getText()).join(', '));
    out.parts.push({ text: node.head.text });
    for (const span of node.templateSpans) {
      out.parts.push({ expr: span.expression.getText() });
      out.parts.push({ text: span.literal.text });
    }
    return;
  }
  if (isWrapper(node)) {
    collect(node.expression, out);
    return;
  }
  if (isPlus(node)) {
    collect(node.left, out);
    collect(node.right, out);
    return;
  }
  const array = joinedArray(node);
  if (array) {
    const separator = node.arguments[0];
    array.elements.forEach((element, index) => {
      if (index > 0) {
        if (!separator) out.parts.push({ text: ',' });
        else if (ts.isStringLiteral(separator)) out.parts.push({ text: separator.text });
        else out.parts.push({ expr: separator.getText() });
      }
      collect(element, out);
    });
    return;
  }
  out.parts.push({ expr: node.getText() });
}

function nameOf(root) {
  for (let node = root.parent; node; node = node.parent) {
    if ((ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node))
      && node.name && ts.isIdentifier(node.name)) {
      return node.name.text;
    }
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) {
      return `${node.name.getText()}()`;
    }
  }
  return '(top-level)';
}

/**
 * 1 file 分の Lua を列挙する。
 * parts = 値の順の片 ({text} = 静的な文字列・{expr} = 値の分からない式)、fragments / dynamic はその text / expr だけ、
 * templateSubstitutions = 組み立て式の中にある `${}` 付きテンプレート (外部送信する Lua では禁止・E11)。
 * @returns {{ id: string, file: string, name: string, line: number,
 *   parts: ({ text: string } | { expr: string })[], fragments: string[], dynamic: string[],
 *   templateSubstitutions: string[] }[]}
 */
export function extractLuaScripts(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  const roots = new Map();
  const visit = (node) => {
    const value = staticTextOf(node);
    if (value !== null && LUA_MARKER.test(value)) {
      const root = climb(node);
      roots.set(root.getStart(source), root);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  // 2 周目: 同じ file の Lua 定数を部品にして組み立てる式 (lib/license/stock.ts の licenseLuaVariant の
  // `PRELUDE + '...' + digitalScript + '...' + COMMIT`) も 1 本の Lua とみなす。部品側の文字列片には
  // 目印が無いことがあるため。
  const luaNames = new Set([...roots.values()].map((root) => nameOf(root)));
  const visitComposed = (node) => {
    if (ts.isIdentifier(node) && luaNames.has(node.text) && !ts.isVariableDeclaration(node.parent)) {
      const root = climb(node);
      if (root !== node) roots.set(root.getStart(source), root);
    }
    ts.forEachChild(node, visitComposed);
  };
  visitComposed(source);
  // 外側の根に内側の根が含まれる場合 (`${}` の中の Lua 等) は外側だけを残す。
  const sorted = [...roots.values()].sort((a, b) => a.getStart(source) - b.getStart(source));
  const kept = sorted.filter((node) => !sorted.some((other) => other !== node
    && other.getStart(source) <= node.getStart(source) && node.getEnd() <= other.getEnd()));
  const seen = new Map();
  return kept.map((root) => {
    const out = { parts: [], templateSubstitutions: [] };
    collect(root, out);
    const base = nameOf(root);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const name = count === 1 ? base : `${base}#${count}`;
    return {
      id: `${file}#${name}`,
      file,
      name,
      line: source.getLineAndCharacterOfPosition(root.getStart(source)).line + 1,
      parts: out.parts,
      fragments: out.parts.filter((part) => 'text' in part).map((part) => part.text),
      dynamic: out.parts.filter((part) => 'expr' in part).map((part) => part.expr),
      templateSubstitutions: out.templateSubstitutions,
    };
  });
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// parts から「実行された本文」に当てる正規表現を作る。値の分からない式は任意の文字列に当てる。
function partsPattern(parts, anchored) {
  const body = parts.map((part) => ('text' in part ? escapeRegExp(part.text) : '[\\s\\S]*?')).join('');
  return new RegExp(anchored ? `^${body}$` : body);
}

/**
 * 実 Lua テスト (tests/_helpers/redisLua) が実行した script 本文 (executed) と照合し、
 * 各 Lua が 1 度でも実 Lua で実行されたかを返す。
 * - 単独で送る Lua は本文全体の一致 (前後を固定する。短い Lua が別の Lua の一部に偶然含まれても数えない)。
 * - 他の Lua の部品 (registry の CAS_OWNER_GUARD 等・組み立て式の中で名前が使われるもの) と、
 *   関数で包んで送る Lua (lib/license/stock.ts の licenseLuaVariant(CAS) 等) は、組み立てた本文の
 *   一部として実行されれば足りる。包む側は「値の分からない片を持つ Lua」(= 組み立て式) として本文全体で照合する。
 * @param {{ id: string, name: string, parts: ({ text: string } | { expr: string })[], dynamic: string[] }[]} scripts
 * @param {string[]} executed
 */
export function luaRealCoverage(scripts, executed) {
  const partNames = new Set(scripts.flatMap((script) =>
    script.dynamic.flatMap((expr) => expr.match(/[A-Za-z_$][\w$]*/g) ?? [])));
  const composers = scripts.filter((script) => script.dynamic.length > 0)
    .map((script) => partsPattern(script.parts, true));
  const composed = executed.filter((body) => composers.some((pattern) => pattern.test(body)));
  const covered = [];
  const uncovered = [];
  for (const script of scripts) {
    const whole = partsPattern(script.parts, !partNames.has(script.name));
    const inside = partsPattern(script.parts, false);
    const hit = executed.some((body) => whole.test(body)) || composed.some((body) => inside.test(body));
    (hit ? covered : uncovered).push(script.id);
  }
  return { covered, uncovered };
}

/**
 * 実 Lua テストの網の判定 (scripts/run-lua-tests.mjs)。
 * missing = 実 Lua で 1 度も実行されず、allowlist (luaRealTests.mjs の LUA_WITHOUT_REAL_TEST) にも無い Lua → fail。
 * stale = allowlist にあるのに実行された・もう存在しない Lua → 行の削除を促す (warning)。
 */
export function evaluateLuaRealCoverage({ scripts, executed, allowlist }) {
  const { uncovered } = luaRealCoverage(scripts, executed);
  const allowed = new Set(allowlist);
  const ids = new Set(scripts.map((script) => script.id));
  const notRun = new Set(uncovered);
  return {
    missing: uncovered.filter((id) => !allowed.has(id)),
    stale: allowlist.filter((id) => !ids.has(id) || !notRun.has(id)),
  };
}

/** tests/_helpers/redisLua が書いた記録 (env LUA_REAL_COVERAGE_FILE・1 行 1 本の JSON 文字列) を読む。 */
export function readExecutedLua(coverageFile) {
  try {
    return readFileSync(coverageFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    // どの test も Lua を実行しなければ記録 file 自体ができない。空として扱い、全 Lua を未実行と報告する。
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

/** run-lua-tests.mjs 用: 実行された本文を repo の Lua と突き合わせる。 */
export function checkLuaRealCoverage({ root, executed, allowlist }) {
  return {
    executed: executed.length,
    ...evaluateLuaRealCoverage({ scripts: listLuaScripts(root), executed, allowlist }),
  };
}

/**
 * 送る本文を復元する (構文検査用)。組み立て式の部品のうち、同じ一覧の Lua の名前 (同じ file を優先・
 * 他 file は名前が一意のときだけ) は再帰的に埋め、値の分からない部品 (`String(N)`・キー名・関数の引数) は
 * placeholder で埋める。placeholder は文脈で通る形が違う (式・文字列の中なら '0'、文の位置なら '')。
 */
export function resolveLuaSource(script, scripts, placeholder = '0', seen = new Set()) {
  return script.parts.map((part) => {
    if ('text' in part) return part.text;
    const sameFile = scripts.find((other) => other.file === script.file && other.name === part.expr);
    const named = scripts.filter((other) => other.name === part.expr);
    const target = sameFile ?? (named.length === 1 ? named[0] : null);
    if (!target || seen.has(target.id)) return placeholder;
    return resolveLuaSource(target, scripts, placeholder, new Set([...seen, script.id]));
  }).join('');
}

// minifier が出力で書き換えうる文字 (改行・引用符・バックスラッシュ・テンプレートの区切り・非 ASCII) で
// 切った残りは、どの引用符・エスケープ方式で出力されても bundle にそのまま残る。
const ESCAPE_SENSITIVE = /[\n\r\t\v\f\0'"`\\$]|[^\x20-\x7e]/;

/** 静的な文字列片を、bundle にそのまま残るはずの部分文字列 (probe) に切る。短すぎる片は捨てる。 */
export function luaProbes(fragments, minLength = 12) {
  const probes = new Set();
  for (const fragment of fragments) {
    for (const piece of fragment.split(new RegExp(ESCAPE_SENSITIVE.source, 'g'))) {
      const trimmed = piece.trim();
      if (trimmed.length >= minLength) probes.add(trimmed);
    }
  }
  return [...probes];
}

// 値の分からない部品で区切った、静的な片の連なり (それぞれ bundle では 1 本の文字列になる)。
function staticRuns(script) {
  const parts = script.parts ?? script.fragments.map((text) => ({ text }));
  const runs = [''];
  for (const part of parts) {
    if ('text' in part) runs[runs.length - 1] += part.text;
    else runs.push('');
  }
  return runs.filter((run) => run.length > 0);
}

// anchor (その Lua が bundle の file に在ると判断する目印) は、Lua の語を含む長めの probe に限る。
// 短い・Lua でない片 (`registration:` 等) は JS 側のキー文字列にも現れ、無関係な file を「在る」と誤認する。
const ANCHOR_LUAISH = /[rR]edis\.p?call|KEYS\[|ARGV\[|cjson\.|\blocal\b|\bthen\b|\bend\b|\breturn\b|tonumber\(|ipairs\(/;
const ANCHOR_MIN_LENGTH = 16;

/**
 * build 成果物 (server の .js) に、各 Lua の probe が「欠けずに」残っているかを調べる。
 *
 * - その Lua だけが持つ probe (anchor) が 1 つでもある bundle file では、全 probe が同じ file に在ること。
 *   一部だけ在る = minifier が文字列片を落とした (2026-09-06 型) → broken。
 * - anchor がどの file にも無い Lua は absent (flag OFF の build で tree-shake された等。壊れようがないので情報だけ)。
 * - 他の Lua に丸ごと含まれる Lua (部品) は、含む側の検査に任せる (shared)。
 * 同じ本文の Lua (複数 file の lock 解放等) は 1 つにまとめて数える。
 *
 * @param {{ id: string, fragments: string[] }[]} scripts
 * @param {{ name: string, text: string }[]} bundleFiles
 */
export function checkLuaInBundle(scripts, bundleFiles, minLength = 12) {
  const groups = new Map();
  for (const script of scripts) {
    // 隣り合う静的な片は minifier が 1 本の文字列に畳む (`'a' + 'b'` → "ab")。片の境界をまたぐ probe で、
    // 「境界の前後の片だけが落ちて文が連結される」2026-09-06 型の破損も拾う。値の分からない部品の位置では畳まれない。
    const runs = staticRuns(script);
    const probes = luaProbes(runs, minLength);
    if (probes.length === 0) continue;
    const key = [...probes].sort().join('\u0000');
    const group = groups.get(key) ?? { ids: [], probes, text: runs.join('\u0000') };
    group.ids.push(script.id);
    groups.set(key, group);
  }
  const list = [...groups.values()];
  // Lua を 1 本も持たない chunk (UI 等) は読み飛ばす。
  const luaFiles = bundleFiles.filter((file) => LUA_MARKER.test(file.text));
  const result = { present: [], absent: [], shared: [], broken: [] };
  for (const group of list) {
    const anchors = group.probes.filter((probe) =>
      probe.length >= ANCHOR_MIN_LENGTH && ANCHOR_LUAISH.test(probe)
      && list.every((other) => other === group || !other.text.includes(probe)));
    if (anchors.length === 0) {
      result.shared.push(group.ids);
      continue;
    }
    let seen = false;
    for (const file of luaFiles) {
      if (!anchors.some((anchor) => file.text.includes(anchor))) continue;
      seen = true;
      const missing = group.probes.filter((probe) => !file.text.includes(probe));
      if (missing.length > 0) result.broken.push({ ids: group.ids, file: file.name, missing });
    }
    (seen ? result.present : result.absent).push(group.ids);
  }
  return result;
}
