// repo の Lua (Upstash EVAL で外部送信するスクリプト) を、**送信式から**機械的に列挙する単一情報源。
//
// 第 7 回レビュー C5 / F10 / F17 / E11: Lua は lib/・app/・scripts/ の 40 file に散在し、
// (1) 本番 bundle の破損検査 (scripts/check-lua-bundle.mjs) は手書きの断片 11 個だけ、
// (2) 「テンプレート禁止」の網はソースにも無く、(3) 実 Lua (wasmoon) で 1 度も実行されない Lua が残っていた。
// 3 つとも「どの文字列が Lua か」を手で列挙していたのが原因なので、TypeScript の構文木で次のように拾う。
//
// - 送信式 (send site): `kvEval(script, …)`・`<x>.eval(script, …)` 等の呼び出しと、`['EVAL', script, …]` /
//   `command('EVAL', script, …)` の形。script 引数がその関数の引数をそのまま渡すだけの関数 (lib/kv.ts の kvEval・
//   facilitatorReservation の `eval:`) は「転送」とみなし、その関数の呼び出しを送信式に加える。
// - script 引数を、`+` 連結・`[…].join(sep)`・テンプレート・三項演算子・同じ file / import した定数・
//   1 文の return だけの関数 (lib/license/stock.ts の licenseLuaVariant) の呼び出しまで辿って**本文に展開**する。
//   値の分からない式 (env・実行時の値) だけが dynamic として残る。送信式の script が全部 dynamic なら解析できない
//   送信式として errors に入れる (検査をすり抜けさせない・fail-closed)。
// - 送られる Lua 1 本 (unit) = 送信式の script の 1 通りの値。三項演算子なら 2 本。id は送る定数 (`<file>#<名前>`)・
//   包む関数の呼び出し (`<file>#licenseLuaVariant(CAS)`)・その場の文字列 (`<file>#<囲む関数名>()`)。
// - 組み立てに使った式 (expr) = 定数の初期化式・包む関数の return 式・その場の文字列。bundle 検査はこの単位で、
//   式に直接書かれた文字列の連なり (runs) が chunk の文字列に欠けずに残っているかを見る。
// - Lua らしい文字列 (LUA_MARKER) なのに、どの送信式からも辿れない文字列は orphans (未知の送信経路の疑い)。
//
// 2026-09-06 の実害 (minifier が `+` 連結中のテンプレートの `${}` 以降を落とし、本番だけ EVAL が 400) は
// feedback_bundle_first_when_prod_only / scripts/check-lua-bundle.mjs 冒頭を参照。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import ts from 'typescript';

/** 送信式と Lua を探すディレクトリ (repo root からの相対)。tests/ は対象外 (ハーネス自身の Lua は外部送信しない)。 */
export const LUA_SOURCE_DIRS = ['lib', 'app', 'scripts', 'packages', 'components', 'hooks'];
/** next build に入るディレクトリ。送信式がここにある Lua だけを本番 bundle で検査する (scripts/ は node で直接動く)。 */
export const BUNDLED_DIRS = ['lib', 'app'];

/** Lua であることの目印 (orphans の検出と bundle の anchor 選び)。`[rR]edis` は lib/license/stock.ts の `realRedis.call`。 */
export const LUA_MARKER = /[rR]edis\.p?call\s*\(|\bKEYS\[|\bARGV\[|\bcjson\.(?:encode|decode)\b/;

/** 第 1 引数に script を取る送信関数の名前 (転送関数は解析中に足す)。 */
const SEND_NAMES = ['kvEval', 'eval', 'evalsha', 'evalSha', 'evalRo', 'evalRO'];
const EVAL_COMMAND = /^eval(?:_ro|sha|sha_ro)?$/i;
// Lua を送らない file (Lua の断片を検査の期待値として持つだけ・この解析器自身)。
const NOT_SENDERS = new Set(['scripts/check-lua-bundle.mjs', 'scripts/lib/luaSources.mjs']);
const SOURCE_EXT = /\.(?:ts|tsx|mts|mjs|js|cjs)$/;
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'coverage', 'tests', '__tests__']);
const MAX_VARIANTS = 64;
// 送信式が bundle に在る根拠にする文字列 (site evidence) の最短長。短い文字列は他の code にも現れる。
const EVIDENCE_MIN_LENGTH = 10;

// ---------------------------------------------------------------------------------------------
// source の読み込みと import の解決

function walk(root, dir, out) {
  let entries;
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(root, posix.join(dir, entry.name), out);
    } else if (SOURCE_EXT.test(entry.name) && !/\.d\.m?ts$/.test(entry.name)) {
      out.push(posix.join(dir, entry.name));
    }
  }
  return out;
}

function scriptKind(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.ts') || file.endsWith('.mts')) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function createProgram(root) {
  const cache = new Map();
  return {
    root,
    source(file) {
      if (!cache.has(file)) {
        const text = readFileSync(join(root, file), 'utf8');
        cache.set(file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file)));
      }
      return cache.get(file);
    },
    resolveModule(fromFile, spec) {
      let base;
      if (spec.startsWith('@/')) base = spec.slice(2);
      else if (spec.startsWith('./') || spec.startsWith('../')) base = posix.join(posix.dirname(fromFile), spec);
      else return null; // 外部 package (viem・server-only 等) の値は分からない
      const stem = base.replace(/\.(?:mjs|js)$/, '');
      const candidates = [base, ...['.ts', '.tsx', '.mts', '.mjs', '.js', '.cjs'].map((ext) => stem + ext),
        ...['index.ts', 'index.tsx', 'index.mjs', 'index.js'].map((index) => posix.join(base, index))];
      return candidates.find((candidate) => isFile(join(root, candidate))) ?? null;
    },
  };
}

const hasExport = (node) => ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export;

function unwrap(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)
    || ts.isTypeAssertionExpression(current)
    || (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(current))) {
    current = current.expression;
  }
  return current;
}

// statements の中の名前の束縛 (const/let/var・function・import)。
function bindingIn(statements, name) {
  for (const stmt of statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name) {
          return { kind: 'var', decl, isConst: (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0 };
        }
      }
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) {
      return { kind: 'function', fn: stmt };
    } else if (ts.isImportDeclaration(stmt) && stmt.importClause && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const bindings = stmt.importClause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (element.name.text === name) {
            return { kind: 'import', spec: stmt.moduleSpecifier.text, exported: (element.propertyName ?? element.name).text };
          }
        }
      }
      if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === name) {
        return { kind: 'namespace', spec: stmt.moduleSpecifier.text };
      }
    }
  }
  return null;
}

// node から外側の scope へ名前を探す。関数の引数も束縛として返す。
function findBinding(node, name) {
  for (let scope = node.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope) && scope.parameters) {
      const index = scope.parameters.findIndex((param) => ts.isIdentifier(param.name) && param.name.text === name);
      if (index >= 0) return { kind: 'param', fn: scope, index };
    }
    if (ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope)) {
      const found = bindingIn(scope.statements, name);
      if (found) return found;
    }
  }
  return null;
}

// file が export する名前の束縛 (re-export・`export *` を辿る)。
function findExport(program, file, name, seen = new Set()) {
  const key = `${file}#${name}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const source = program.source(file);
  for (const stmt of source.statements) {
    if (ts.isVariableStatement(stmt) && hasExport(stmt)) {
      const found = bindingIn([stmt], name);
      if (found) return { file, binding: found };
    } else if (ts.isFunctionDeclaration(stmt) && hasExport(stmt) && stmt.name?.text === name) {
      return { file, binding: { kind: 'function', fn: stmt } };
    } else if (ts.isExportDeclaration(stmt)) {
      const target = stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)
        ? program.resolveModule(file, stmt.moduleSpecifier.text) : null;
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const element of stmt.exportClause.elements) {
          if (element.name.text !== name) continue;
          const local = (element.propertyName ?? element.name).text;
          if (stmt.moduleSpecifier) return target ? findExport(program, target, local, seen) : null;
          const found = bindingIn(source.statements, local);
          return found ? { file, binding: found } : null;
        }
      } else if (!stmt.exportClause && target) {
        const found = findExport(program, target, name, seen);
        if (found) return found;
      }
    }
  }
  return null;
}

// 関数宣言・関数式の名前 (転送関数の検出と包む関数の id に使う)。
function functionName(fn) {
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  const parent = fn.parent;
  if (parent && (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent))
    && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  return null;
}

// 1 文の return だけの関数なら、その return 式 (包む関数の本体)。
function returnExpression(fn) {
  if (!fn.body) return null;
  if (!ts.isBlock(fn.body)) return fn.body;
  const [only] = fn.body.statements;
  return fn.body.statements.length === 1 && ts.isReturnStatement(only) && only.expression ? only.expression : null;
}

function nameOf(node) {
  for (let current = node.parent; current; current = current.parent) {
    if ((ts.isVariableDeclaration(current) || ts.isPropertyAssignment(current) || ts.isPropertyDeclaration(current))
      && current.name && ts.isIdentifier(current.name)) {
      return current.name.text;
    }
    if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name) {
      return `${current.name.getText()}()`;
    }
  }
  return '(top-level)';
}

const lineOf = (node) => node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;
const isStringLike = (node) => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
const isPlus = (node) => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;

// `[...].join(sep)` の呼び出しなら、その配列を返す。
function joinedArray(node) {
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'join') return null;
  const array = unwrap(callee.expression);
  return ts.isArrayLiteralExpression(array) ? array : null;
}

// 式に直接書かれた文字列の連なり (runs)。識別子・呼び出し・テンプレートの `${}`・join の区切りで切る
// (minifier は隣り合う文字列の `+` は畳むが、識別子の位置や join をどう出すかは保証されない)。
function ownRuns(node) {
  const runs = [];
  let current = null;
  const flush = () => {
    if (current) runs.push(current);
    current = null;
  };
  const visit = (raw) => {
    const n = unwrap(raw);
    if (isStringLike(n)) {
      current = (current ?? '') + n.text;
    } else if (isPlus(n)) {
      visit(n.left);
      visit(n.right);
    } else if (ts.isTemplateExpression(n)) {
      current = (current ?? '') + n.head.text;
      for (const span of n.templateSpans) {
        flush();
        current = span.literal.text;
      }
    } else if (joinedArray(n)) {
      flush();
      for (const element of joinedArray(n).elements) {
        visit(element);
        flush();
      }
    } else {
      flush();
    }
  };
  visit(node);
  flush();
  return runs;
}

// ---------------------------------------------------------------------------------------------
// script の値を本文に展開する

function product(left, right, ctx, where) {
  if (left.length * right.length > MAX_VARIANTS) {
    ctx.errors.push({ file: where.getSourceFile().fileName, line: lineOf(where), reason: 'too_many_variants' });
    return left;
  }
  return left.flatMap((a) => right.map((b) => ({
    parts: [...a.parts, ...b.parts],
    exprs: [...a.exprs, ...b.exprs],
    templates: [...a.templates, ...b.templates],
  })));
}

const textVariant = (text, literal) => [{ parts: [{ text, literal }], exprs: [], templates: [] }];
const dynVariant = (node) => [{ parts: [{ dyn: node.getText().replace(/\s+/g, ' ').slice(0, 80) }], exprs: [], templates: [] }];
const withExpr = (variants, id) => variants.map((variant) => ({ ...variant, exprs: [id, ...variant.exprs] }));

function registerExpr(ctx, id, node) {
  if (!ctx.exprs.has(id)) {
    ctx.exprs.set(id, {
      id,
      file: node.getSourceFile().fileName,
      line: lineOf(node),
      pos: node.getStart(),
      end: node.getEnd(),
      runs: ownRuns(node),
    });
  }
}

// const の初期化式を展開する (env を持たないので file 単位で cache できる)。
function resolveConst(ctx, file, decl, name) {
  if (ctx.constCache.has(decl)) return ctx.constCache.get(decl);
  if (ctx.resolving.has(decl) || !decl.initializer) return null;
  ctx.resolving.add(decl);
  const id = `${file}#${name}`;
  registerExpr(ctx, id, decl.initializer);
  const variants = withExpr(resolveExpr(ctx, decl.initializer, null), id);
  ctx.resolving.delete(decl);
  ctx.constCache.set(decl, variants);
  return variants;
}

// 識別子 (または namespace import の `ns.X`) が指す束縛を、宣言のある file と一緒に返す。
function bindingOf(ctx, node) {
  const file = node.getSourceFile().fileName;
  if (ts.isIdentifier(node)) {
    const binding = findBinding(node, node.text);
    if (binding?.kind === 'import') {
      const target = ctx.program.resolveModule(file, binding.spec);
      return target ? findExport(ctx.program, target, binding.exported) : null;
    }
    return binding ? { file, binding } : null;
  }
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    const namespace = findBinding(node.expression, node.expression.text);
    if (namespace?.kind !== 'namespace') return null;
    const target = ctx.program.resolveModule(file, namespace.spec);
    return target ? findExport(ctx.program, target, node.name.text) : null;
  }
  return null;
}

// 呼び出された関数が「1 文の return だけ」なら、その関数と宣言 file を返す (包む関数)。
function composerOf(ctx, call) {
  const found = bindingOf(ctx, unwrap(call.expression));
  if (!found) return null;
  const { binding } = found;
  let fn = null;
  if (binding.kind === 'function') fn = binding.fn;
  else if (binding.kind === 'var' && binding.isConst && binding.decl.initializer) {
    const init = unwrap(binding.decl.initializer);
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) fn = init;
  }
  const body = fn ? returnExpression(fn) : null;
  return body ? { file: found.file, fn, body, name: functionName(fn) ?? '(anonymous)' } : null;
}

function resolveExpr(ctx, raw, env) {
  const node = unwrap(raw);
  if (isStringLike(node)) return textVariant(node.text, true);
  if (ts.isNumericLiteral(node)) return textVariant(String(Number(node.text.replace(/_/g, ''))), false);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) {
    return textVariant(String(-Number(node.operand.text.replace(/_/g, ''))), false);
  }
  if (ts.isTemplateExpression(node)) {
    let variants = textVariant(node.head.text, true);
    for (const span of node.templateSpans) {
      variants = product(variants, resolveExpr(ctx, span.expression, env), ctx, node);
      variants = product(variants, textVariant(span.literal.text, true), ctx, node);
    }
    const substitutions = node.templateSpans.map((span) => span.expression.getText());
    return variants.map((variant) => ({ ...variant, templates: [...variant.templates, ...substitutions] }));
  }
  if (isPlus(node)) return product(resolveExpr(ctx, node.left, env), resolveExpr(ctx, node.right, env), ctx, node);
  if (ts.isConditionalExpression(node)) {
    return [...resolveExpr(ctx, node.whenTrue, env), ...resolveExpr(ctx, node.whenFalse, env)];
  }
  const array = joinedArray(node);
  if (array) {
    const [separatorNode] = node.arguments;
    const separator = !separatorNode ? textVariant(',', false)
      : isStringLike(unwrap(separatorNode)) ? textVariant(unwrap(separatorNode).text, true) : dynVariant(separatorNode);
    let variants = textVariant('', true);
    array.elements.forEach((element, index) => {
      if (index > 0) variants = product(variants, separator, ctx, node);
      variants = product(variants, resolveExpr(ctx, element, env), ctx, node);
    });
    return variants;
  }
  if (ts.isCallExpression(node)) {
    const callee = unwrap(node.expression);
    // String(N): 引数が定数なら文字列 (reverify の閾値)。
    if (ts.isIdentifier(callee) && callee.text === 'String' && node.arguments.length === 1
      && !findBinding(callee, 'String')) {
      return resolveExpr(ctx, node.arguments[0], env).map((variant) => (variant.parts.every((part) => 'text' in part)
        ? { ...variant, parts: [{ text: variant.parts.map((part) => part.text).join(''), literal: false }] }
        : { ...variant, parts: [{ dyn: node.getText() }] }));
    }
    const composer = composerOf(ctx, node);
    if (composer) return resolveComposerCall(ctx, composer, node, env).flatMap((entry) => entry.variants);
    return dynVariant(node);
  }
  if (ts.isIdentifier(node) && env?.has(node.text) && findBinding(node, node.text)?.kind === 'param') {
    return env.get(node.text);
  }
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
    const found = bindingOf(ctx, node);
    if (found?.binding.kind === 'var' && found.binding.isConst) {
      const name = ts.isIdentifier(node) ? node.text : node.name.text;
      const resolved = resolveConst(ctx, found.file, found.binding.decl, found.binding.decl.name.text ?? name);
      if (resolved) return resolved;
    }
    if (found?.binding.kind === 'param') return [{ parts: [{ dyn: node.getText(), param: true }], exprs: [], templates: [] }];
  }
  return dynVariant(node);
}

// 包む関数の呼び出し: 引数を呼び出し側で展開し、return 式に束縛して展開する。
function resolveComposerCall(ctx, composer, call, env) {
  const id = `${composer.file}#${composer.name}()`;
  registerExpr(ctx, id, composer.body);
  const params = composer.fn.parameters.map((param) => (ts.isIdentifier(param.name) ? param.name.text : null));
  let combos = [new Map()];
  params.forEach((name, index) => {
    if (!name) return;
    const arg = call.arguments[index];
    const variants = arg ? resolveExpr(ctx, arg, env) : [{ parts: [{ dyn: 'undefined' }], exprs: [], templates: [] }];
    combos = combos.flatMap((combo) => variants.map((variant) => new Map([...combo, [name, [variant]]])));
  });
  if (combos.length > MAX_VARIANTS) {
    ctx.errors.push({ file: call.getSourceFile().fileName, line: lineOf(call), reason: 'too_many_variants' });
    combos = combos.slice(0, MAX_VARIANTS);
  }
  return combos.map((combo) => ({ variants: withExpr(resolveExpr(ctx, composer.body, combo), id) }));
}

// ---------------------------------------------------------------------------------------------
// 送信式

// call / 配列が送信式なら script の式を返す。names = 送信関数の名前 → script を受ける引数の位置。
function sendScript(node, names) {
  if (ts.isCallExpression(node)) {
    const callee = unwrap(node.expression);
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
    if (name && names.has(name) && node.arguments.length > names.get(name)) return node.arguments[names.get(name)];
    const [command, script] = node.arguments;
    if (command && script && ts.isStringLiteral(unwrap(command)) && EVAL_COMMAND.test(unwrap(command).text)) return script;
  }
  if (ts.isArrayLiteralExpression(node)) {
    const [command, script] = node.elements;
    if (command && script && ts.isStringLiteral(unwrap(command)) && EVAL_COMMAND.test(unwrap(command).text)) return script;
  }
  return null;
}

// script がそれを囲む関数の引数そのままなら、その関数と引数の位置 (転送関数)。
function forwarderOf(script) {
  const node = unwrap(script);
  if (!ts.isIdentifier(node)) return null;
  const binding = findBinding(node, node.text);
  return binding?.kind === 'param' ? { fn: binding.fn, index: binding.index } : null;
}

// 送信式が bundle に在る根拠 (site evidence): 送信式を含む文とその後ろの文 (同じ block) の文字列リテラルのうち、
// repo の他の場所に現れないもの。後ろの文が bundle に在れば、到達できる送信式も在る (前の文は早期 return で
// 送信式だけが消えても残りうるので使わない)。
function evidenceRegion(call) {
  let statement = call;
  while (statement.parent && !ts.isBlock(statement.parent) && !ts.isSourceFile(statement.parent)
    && !ts.isModuleBlock(statement.parent) && !ts.isCaseClause(statement.parent)) {
    statement = statement.parent;
  }
  const siblings = statement.parent?.statements ?? [statement];
  const index = siblings.indexOf(statement);
  return index >= 0 ? siblings.slice(index) : [statement];
}

function literalsIn(nodes, skip) {
  const out = [];
  const visit = (node) => {
    if (node === skip) return;
    if (isStringLike(node)) out.push(node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) out.push(node.text);
    ts.forEachChild(node, visit);
  };
  nodes.forEach(visit);
  return out;
}

/**
 * repo の送信式と、そこから送られる Lua を解析する。
 * @returns {{ sites: object[], units: object[], exprs: object[], errors: object[], orphans: object[] }}
 */
export function analyzeLua(root, { dirs = LUA_SOURCE_DIRS } = {}) {
  const program = createProgram(root);
  const files = dirs.flatMap((dir) => walk(root, dir, [])).filter((file) => !NOT_SENDERS.has(file)).sort();
  const texts = new Map(files.map((file) => [file, readFileSync(join(root, file), 'utf8')]));
  const ctx = { program, exprs: new Map(), errors: [], constCache: new Map(), resolving: new Set() };

  // 転送関数の名前を送信関数に足しながら、送信式を集める (不動点まで)。
  const names = new Map(SEND_NAMES.map((name) => [name, 0]));
  let rawSites = [];
  for (let round = 0; round < 6; round += 1) {
    rawSites = [];
    const prefilter = new RegExp([...names.keys(), 'eval'].map((name) => name.replace(/[$]/g, '\\$')).join('|'), 'i');
    for (const file of files) {
      if (!prefilter.test(texts.get(file))) continue;
      const source = program.source(file);
      const visit = (node) => {
        const script = sendScript(node, names);
        if (script) rawSites.push({ file, node, script });
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    let added = false;
    for (const site of rawSites) {
      const forwarder = forwarderOf(site.script);
      const name = forwarder ? functionName(forwarder.fn) : null;
      if (name && !names.has(name)) {
        names.set(name, forwarder.index);
        added = true;
      }
    }
    if (!added) break;
  }

  const sites = [];
  const units = new Map();
  for (const raw of rawSites) {
    const forwarder = forwarderOf(raw.script);
    if (forwarder) {
      // 転送関数の中の送信式 (script はその関数の引数)。呼び出し側が送信式として拾われている。
      // 名前の無い関数は呼び出しを辿れないので、検査をすり抜けさせない (fail-closed)。
      if (!functionName(forwarder.fn)) ctx.errors.push({ file: raw.file, line: lineOf(raw.node), reason: 'anonymous_forwarder' });
      continue;
    }
    const site = { file: raw.file, line: lineOf(raw.node), node: raw.node, script: raw.script, unitIds: [] };
    sites.push(site);
    // 三項演算子の枝ごとに送る Lua の名前 (unit id) を付ける。
    const branches = [];
    const split = (expr) => {
      const node = unwrap(expr);
      if (ts.isConditionalExpression(node)) {
        split(node.whenTrue);
        split(node.whenFalse);
      } else branches.push(node);
    };
    split(raw.script);
    for (const branch of branches) {
      let label = null;
      let variants;
      const found = ts.isIdentifier(branch) || ts.isPropertyAccessExpression(branch) ? bindingOf(ctx, branch) : null;
      const composer = ts.isCallExpression(branch) ? composerOf(ctx, branch) : null;
      if (found?.binding.kind === 'var' && found.binding.isConst) {
        label = `${found.file}#${found.binding.decl.name.text}`;
        variants = resolveExpr(ctx, branch, null);
      } else if (composer) {
        const args = branch.arguments.map((arg) => (ts.isIdentifier(unwrap(arg)) ? unwrap(arg).text : '…')).join(', ');
        label = `${composer.file}#${composer.name}(${args})`;
        variants = resolveExpr(ctx, branch, null);
      } else {
        // その場で組み立てる script (と、値の分からない式 — 後で unresolved_script になる)。
        label = `${raw.file}#${nameOf(branch)}`;
        registerExpr(ctx, label, branch);
        variants = withExpr(resolveExpr(ctx, branch, null), label);
      }
      variants.forEach((variant, index) => {
        if (!variant.parts.some((part) => 'text' in part && part.text.length > 0)) {
          ctx.errors.push({ file: raw.file, line: site.line, reason: 'unresolved_script', expr: branch.getText().slice(0, 80) });
          return;
        }
        const id = variants.length === 1 ? label : `${label}[${index + 1}]`;
        const existing = units.get(id);
        if (existing && JSON.stringify(existing.parts) !== JSON.stringify(variant.parts)) {
          ctx.errors.push({ file: raw.file, line: site.line, reason: 'unit_id_collision', id });
          return;
        }
        const unit = existing ?? { id, parts: variant.parts, exprs: [...new Set(variant.exprs)], templates: variant.templates, sites: [] };
        unit.sites.push(site);
        units.set(id, unit);
        site.unitIds.push(id);
      });
    }
  }

  // 送信式の証拠になる文字列 (repo 全体で 1 か所にしか無いもの)。
  const literalCount = new Map();
  for (const file of files) {
    const text = texts.get(file);
    if (!/['"`]/.test(text)) continue;
    for (const literal of literalsIn([program.source(file)], null)) {
      if (literal.length >= EVIDENCE_MIN_LENGTH) literalCount.set(literal, (literalCount.get(literal) ?? 0) + 1);
    }
  }
  for (const site of sites) {
    const region = literalsIn(evidenceRegion(site.node), site.script)
      .filter((literal) => literal.length >= EVIDENCE_MIN_LENGTH && !LUA_MARKER.test(literal));
    const counts = new Map();
    region.forEach((literal) => counts.set(literal, (counts.get(literal) ?? 0) + 1));
    site.evidence = [...counts].filter(([literal, count]) => literalCount.get(literal) === count).map(([literal]) => literal);
  }

  // どの送信式からも辿れない Lua らしい文字列 (未知の送信経路・使われていない Lua)。
  const orphans = [];
  const ranges = [...ctx.exprs.values()];
  for (const file of files) {
    if (!LUA_MARKER.test(texts.get(file))) continue;
    const source = program.source(file);
    const visit = (node) => {
      const text = isStringLike(node) ? node.text
        : ts.isTemplateExpression(node) ? node.head.text + node.templateSpans.map((span) => span.literal.text).join('') : null;
      if (text !== null && LUA_MARKER.test(text)) {
        const start = node.getStart();
        const inside = ranges.some((expr) => expr.file === file && expr.pos <= start && node.getEnd() <= expr.end);
        if (!inside) orphans.push({ file, line: lineOf(node), text: text.slice(0, 80) });
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return {
    sites: sites.map(({ file, line, unitIds, evidence }) => ({ file, line, unitIds, evidence })),
    units: [...units.values()].map((unit) => ({
      ...unit,
      sites: unit.sites.map(({ file, line, evidence }) => ({ file, line, evidence })),
      bundled: unit.sites.some((site) => BUNDLED_DIRS.some((dir) => site.file.startsWith(`${dir}/`))),
    })),
    exprs: [...ctx.exprs.values()].map(({ pos, end, ...expr }) => expr),
    errors: ctx.errors,
    orphans,
  };
}

/** 送る本文 (値の分からない部品は placeholder)。構文検査に使う。文脈で通る形が違うので placeholder を選べる。 */
export function unitSource(unit, placeholder = '0') {
  return unit.parts.map((part) => ('text' in part ? part.text : placeholder)).join('');
}

// ---------------------------------------------------------------------------------------------
// 実 Lua テストの網

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 展開した本文に当てる正規表現 (前後を固定する)。値の分からない部品だけを任意の文字列に当てる。
function unitPattern(unit) {
  return new RegExp(`^${unit.parts.map((part) => ('text' in part ? escapeRegExp(part.text) : '[\\s\\S]*?')).join('')}$`);
}

/**
 * 実 Lua テスト (tests/_helpers/redisLua) が実行した script 本文 (executed) と照合し、送られる Lua (unit) が
 * 1 度でも実 Lua で実行されたかを返す。部品 (registry の guard・licenseLuaVariant の PRELUDE / COMMIT 等) は
 * 本文に展開済みなので、部品の欠けた本文では数えない。
 */
export function luaRealCoverage(units, executed) {
  const covered = [];
  const uncovered = [];
  for (const unit of units) {
    const pattern = unitPattern(unit);
    (executed.some((body) => pattern.test(body)) ? covered : uncovered).push(unit.id);
  }
  return { covered, uncovered };
}

/**
 * 実 Lua テストの網の判定 (scripts/run-lua-tests.mjs)。
 * missing = 実 Lua で 1 度も実行されず、allowlist (luaRealTests.mjs の LUA_WITHOUT_REAL_TEST) にも無い Lua → fail。
 * stale = allowlist にあるのに実行された・もう存在しない Lua → 行の削除を促す (warning)。
 */
export function evaluateLuaRealCoverage({ units, executed, allowlist }) {
  const { uncovered } = luaRealCoverage(units, executed);
  const allowed = new Set(allowlist);
  const ids = new Set(units.map((unit) => unit.id));
  const notRun = new Set(uncovered);
  return {
    missing: uncovered.filter((id) => !allowed.has(id)),
    stale: allowlist.filter((id) => !ids.has(id) || !notRun.has(id)),
  };
}

/**
 * LUA_WITHOUT_REAL_TEST の形の検査 (通常の test job)。重複だけを止め (blocking)、もう無い Lua (gone) は
 * runner (stale の warning) と同じく止めない — 一覧にある Lua を消す PR を不当に赤くしないため。
 */
export function checkLuaAllowlist(allowlist, unitIds) {
  const ids = new Set(unitIds);
  const seen = new Set();
  const duplicates = [];
  for (const id of allowlist) {
    if (seen.has(id)) duplicates.push(id);
    seen.add(id);
  }
  return { blocking: duplicates, gone: [...seen].filter((id) => !ids.has(id)) };
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

/** run-lua-tests.mjs 用: 実行された本文を repo の Lua と突き合わせる。解析できない送信式も返す (fail-closed)。 */
export function checkLuaRealCoverage({ root, executed, allowlist }) {
  const analysis = analyzeLua(root);
  return {
    executed: executed.length,
    errors: [...analysis.errors, ...analysis.orphans.map((orphan) => ({ ...orphan, reason: 'orphan_lua' }))],
    ...evaluateLuaRealCoverage({ units: analysis.units, executed, allowlist }),
  };
}

// ---------------------------------------------------------------------------------------------
// 本番 bundle の検査

/** bundle (JS) の文字列リテラルの値をデコードして返す (引用符の種類・エスケープに左右されずに照合するため)。 */
export function bundleStrings(text, name = 'bundle.js') {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  return literalsIn([source], null);
}

// minifier が出力で書き換えうる文字で切った片 (anchor 候補)。引用符・改行・エスケープ・非 ASCII で切る。
const ESCAPE_SENSITIVE = /[\n\r\t\v\f\0'"`\\$]|[^\x20-\x7e]/g;
const ANCHOR_LUAISH = /[rR]edis\.p?call|KEYS\[|ARGV\[|cjson\.|\blocal\b|\bthen\b|\bend\b|\breturn\b|tonumber\(|ipairs\(/;
const ANCHOR_MIN_LENGTH = 16;

/**
 * build 成果物 (server の .js) に、lib/・app/ から送る Lua が欠けずに残っているかを調べる。
 * 単位は組み立てに使った式 (expr)。式に直接書かれた文字列の連なり (runs) を、chunk の文字列の値 (デコード後) と
 * そのまま照合する (短い定数・引用符も含む)。
 * - broken: その式だけが持つ片 (anchor) がある chunk に、runs の一部が無い (minifier が片を落とした・書き換えた)。
 * - missing: その式を使う送信式が bundle に在るのに、式がどの chunk にも欠けずに残っていない。送信式が在る根拠は
 *   site evidence (送信式の後ろの文にしか無い文字列) の存在。根拠になる文字列が無い送信式は在るとみなす (fail-closed)。
 * - absent: 送信式が bundle に無い (根拠の文字列がどの chunk にも無い) ので式も無い (tree-shake・情報だけ)。
 * @param {{ units: object[], exprs: object[] }} analysis
 * @param {{ name: string, strings: string[] }[]} bundleFiles
 */
export function checkLuaInBundle(analysis, bundleFiles) {
  const blobs = bundleFiles.map((file) => ({ name: file.name, blob: `\u0000${file.strings.join('\u0000')}\u0000` }));
  const units = analysis.units.filter((unit) => unit.bundled);
  const exprIds = new Set(units.flatMap((unit) => unit.exprs));
  const exprs = analysis.exprs.filter((expr) => exprIds.has(expr.id) && expr.runs.length > 0);
  const siteFound = (site) => site.evidence.length === 0
    || blobs.some(({ blob }) => site.evidence.every((evidence) => blob.includes(evidence)));
  const reachable = new Set(units.filter((unit) => unit.sites.some(siteFound)).flatMap((unit) => unit.exprs));
  const texts = exprs.map((expr) => expr.runs.join('\u0000'));
  const result = { checked: [], broken: [], missing: [], absent: [] };
  exprs.forEach((expr, index) => {
    const anchors = expr.runs.flatMap((run) => run.split(ESCAPE_SENSITIVE)).map((piece) => piece.trim())
      .filter((piece) => piece.length >= ANCHOR_MIN_LENGTH && ANCHOR_LUAISH.test(piece)
        && texts.every((other, otherIndex) => otherIndex === index || !other.includes(piece)));
    let intactSomewhere = false;
    for (const { name, blob } of blobs) {
      const missingRuns = expr.runs.filter((run) => !blob.includes(run));
      if (missingRuns.length === 0) {
        intactSomewhere = true;
      } else if (anchors.some((anchor) => blob.includes(anchor))) {
        result.broken.push({ id: expr.id, file: name, missing: missingRuns });
      }
    }
    if (intactSomewhere) result.checked.push(expr.id);
    else if (reachable.has(expr.id)) result.missing.push(expr.id);
    else result.absent.push(expr.id);
  });
  return result;
}
