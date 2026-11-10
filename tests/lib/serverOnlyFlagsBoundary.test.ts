// @vitest-environment node
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { parseSource as parse, readSource, runtimeClosure, runtimeSpecifiers } from '../_helpers/runtimeImports';

// 守るもの: client の bundle に入るコードが、lib/env.ts の「server 専用」の値を読まないこと。
//
// lib/env.ts の `env` は client からも import される共有の object で、その中に NEXT_PUBLIC_ の付かない環境変数から
// 作る flag (enableAgentOrder など) が混ざっている。Next は NEXT_PUBLIC_ の付かない `process.env.X` を client の bundle に
// 埋め込まないので、client でこれらを読むと必ず OFF に見える。SSR では ON・hydration 後は OFF になり、画面と server が
// 食い違う。typecheck も実行のテストも通る (vitest は 1 つの process で両方の値が見える) ので、構文木で確かめる。
//
// 手順:
//   1. lib/env.ts を読み、env の property (最上位) を、作るときに読む環境変数の名前で 2 つに分ける。
//      NEXT_PUBLIC_ だけ = client でも値がある / それ以外を 1 つでも読む = server 専用。
//      分類するのは、file の中の依存を全部たどれたときだけ: 名前はすべて行き先が分かる (最上位の const / function・関数の
//      中の変数・外の package の import・KNOWN_GLOBALS)・process は `process.env.NAME` の形だけ・宣言の後で値を変える
//      書き方 (代入・++・delete・NON_MUTATING_METHODS 以外の method の呼び出し) が無い。1 つでも外れたら throw する
//      (fail closed)。落ちたら、その書き方を分類できるように classifyEnv を直す。
//   2. client の bundle に入る file = 'use client' を持つ file と instrumentation-client.ts から、実行時の import で
//      たどれる file (tests/_helpers/runtimeImports.ts)。中を見るのは .ts / .tsx / .js / .mjs (runtimeImports が import を
//      たどる拡張子)、.css は飛ばす。この test がたどれないもの (ほかの拡張子・Pages Router の pages/・'use server' の
//      file・`@/*` 以外の path alias) が現れたら落とす。
//   3. その file が server 専用の property を読んでいないこと (`env.x`・`env['x']`・分割代入・別名・名前を変えた import・
//      `import * as`)。env を値のまま渡す・再 export する・env の property でない名前 (valueOf など継承した member) を
//      読むなど、読む property を決められない使い方も通さない。
//
// 粒度は file。client が import する file に server 専用の読み取りがあれば、呼んでいなくても落ちる (その関数は
// client の bundle に入り、client から呼べば必ず OFF を返す)。server だけが呼ぶ関数なら server 専用の module へ移す。
//
// 見ていないもの:
//   - env を経由しない `process.env.X` の直読み。
//   - 外の package (node_modules) の中。lib/env.ts が import した関数の中で読む環境変数や、渡した値をその中で変えること。
//   - lib/env.ts の外から env の値を書き換えること (env は `as const` で、型の上では書けない)。
//   - 'use client' の file が SOURCE_ROOTS の外にある場合 (instrumentation-client.ts だけは足してある)。
//   - next.config.mjs の webpack / turbopack の alias (tsconfig の paths だけを見る)。
//   - env の中の入れ子の property 単位の区別 (入れ子に server 専用が 1 つでもあれば、最上位の property ごと server 専用として扱う)。

const ROOT = process.cwd();
const ENV_FILE = 'lib/env.ts';
// Next は root に app/ (と pages/) があれば src/ を見ない。pages/ は下の test で「無い」ことを確かめる。
const SOURCE_ROOTS = ['app', 'components', 'hooks', 'lib'];
// 'use client' は無いが、Next が browser の bundle の先頭で実行する。
const CLIENT_ENTRIES_BY_CONVENTION = ['instrumentation-client.ts'];
// client の bundle の file のうち、中を見るもの (runtimeImports が import をたどる拡張子) と、コードでないもの。
const SCANNED = /\.(?:tsx?|m?js)$/;
const NOT_CODE = /\.css$/;

// lib/env.ts の中で使ってよい global (今の env.ts が使うものだけ)。Object.assign・Reflect などは宣言の後で値を変えられる。
const KNOWN_GLOBALS = new Set(['undefined', 'arguments', 'console', 'Number', 'Error']);
// lib/env.ts の中で呼んでよい method (値を変えないもの・今の env.ts が使うものだけ)。push・set などは宣言の後で値を足せる。
const NON_MUTATING_METHODS = new Set(['warn', 'isFinite', 'isInteger', 'test']);

const lineOf = (node: ts.Node) => node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;

const isWrapper = (node: ts.Node): node is ts.ParenthesizedExpression | ts.AsExpression | ts.SatisfiesExpression | ts.NonNullExpression =>
  ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node);

const unwrap = (node: ts.Expression): ts.Expression => (isWrapper(node) ? unwrap(node.expression) : node);

/** 値を読む位置の identifier か (宣言の名前・`a.b` の b・`{ b: 1 }` の b は違う)。 */
function isReference(id: ts.Identifier): boolean {
  const parent = id.parent as ts.Node & { name?: ts.Node; propertyName?: ts.Node };
  if (ts.isShorthandPropertyAssignment(parent)) return true; // `{ env }` は env を読む
  if (ts.isExportSpecifier(parent)) return (parent.propertyName ?? parent.name) === id; // `export { a as b }` は a を読む
  if (parent.name === id) return false;
  if ((ts.isImportSpecifier(parent) || ts.isBindingElement(parent)) && parent.propertyName === id) return false;
  return true;
}

/** その名前の束縛を新しく作る位置か (別名と同じ名前の引数・変数を見つけるため)。 */
function isBindingName(id: ts.Identifier): boolean {
  const parent = id.parent as ts.Node & { name?: ts.Node };
  return parent.name === id && (
    ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent) ||
    ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent) ||
    ts.isClassExpression(parent) || ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)
  );
}

/** 代入・++ / --・delete なら、書き換える先の式。 */
function writeTarget(node: ts.Node): ts.Expression | undefined {
  if (ts.isBinaryExpression(node)) {
    const kind = node.operatorToken.kind;
    return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment ? node.left : undefined;
  }
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    return node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken ? node.operand : undefined;
  }
  return ts.isDeleteExpression(node) ? node.expression : undefined;
}

/** lib/env.ts の env の property を、作るときに読む環境変数で分ける。たどれない書き方は throw する。 */
function classifyEnv(source: string) {
  const parsed = parse(ENV_FILE, source);
  const unclassifiable = (what: string, node: ts.Node) =>
    new Error(`${ENV_FILE}:${lineOf(node)} ${what} — serverOnlyFlagsBoundary.test.ts の classifyEnv が分類できる形にする`);

  // 別の module の中まではたどらない。repo の中の module を import したら、そこで読む環境変数を見落とす。
  const localImport = runtimeSpecifiers(ENV_FILE, source).find((spec) => spec.startsWith('.') || spec.startsWith('@/'));
  if (localImport) throw unclassifiable(`repo の中の module (${localImport}) を import している`, parsed);

  // 最上位の名前の行き先 (const と function。function は overload の数だけある) と、import した名前 (外の package)。
  const topLevel = new Map<string, ts.Node[]>();
  const imported = new Set<string>();
  for (const stmt of parsed.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const clause = stmt.importClause;
      if (clause?.name) imported.add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) imported.add(bindings.name.text);
      for (const element of bindings && ts.isNamedImports(bindings) ? bindings.elements : []) imported.add(element.name.text);
    } else if (ts.isVariableStatement(stmt)) {
      if (!(stmt.declarationList.flags & ts.NodeFlags.Const)) throw unclassifiable('最上位の let / var (後から代入できる)', stmt);
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) throw unclassifiable('最上位の分割代入', decl);
        topLevel.set(decl.name.text, [decl]);
      }
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      topLevel.set(stmt.name.text, [...(topLevel.get(stmt.name.text) ?? []), stmt]);
    } else if (ts.isClassDeclaration(stmt) || ts.isEnumDeclaration(stmt) || ts.isModuleDeclaration(stmt)) {
      throw unclassifiable('最上位の class / enum / namespace (中をたどらない)', stmt);
    }
  }

  let object = (topLevel.get('env')?.[0] as ts.VariableDeclaration | undefined)?.initializer;
  while (object && isWrapper(object)) object = object.expression;
  if (!object || !ts.isObjectLiteralExpression(object)) throw unclassifiable('`const env = { … }` が見つからない', parsed);

  // 最上位より内側で作る名前 (関数の引数・中の const など)。scope ごとに 1 度だけ集める。入れ子の関数の名前まで多めに
  // 集めるが、最上位の名前と同じ名前の束縛は下で throw するので、行き先を取り違えない。
  const declared = new Map<ts.Node, Set<string>>();
  const declaredIn = (scope: ts.Node) => {
    let names = declared.get(scope);
    if (!names) {
      const found = new Set<string>();
      const collect = (node: ts.Node) => {
        if (ts.isIdentifier(node) && isBindingName(node)) found.add(node.text);
        ts.forEachChild(node, collect);
      };
      collect(scope);
      declared.set(scope, (names = found));
    }
    return names;
  };
  const isScope = (node: ts.Node) =>
    ts.isFunctionLike(node) || ts.isBlock(node) || ts.isCatchClause(node) ||
    ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node);
  const isLocal = (id: ts.Identifier) => {
    for (let node = id.parent; !ts.isSourceFile(node); node = node.parent) {
      if (isScope(node) && declaredIn(node).has(id.text)) return true;
    }
    return false;
  };
  const isTopLevelName = (id: ts.Identifier) => {
    const decl = id.parent;
    if (ts.isFunctionDeclaration(decl)) return decl.parent === parsed;
    return ts.isVariableDeclaration(decl) && ts.isVariableDeclarationList(decl.parent) &&
      ts.isVariableStatement(decl.parent.parent) && decl.parent.parent.parent === parsed;
  };

  // file 全体で確かめる (env の式の外で書いても、宣言の後で値を変えられる・別の名前を指せる)。
  const check = (node: ts.Node) => {
    if (ts.isTypeNode(node) || ts.isImportDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
    const target = writeTarget(node);
    if (target) {
      const written = unwrap(target);
      if (!ts.isIdentifier(written) || !isLocal(written)) throw unclassifiable('宣言の後で値を書き換えている (通すのは関数の中の変数への代入だけ)', node);
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
        const method = ts.isPropertyAccessExpression(callee) ? callee.name.text
          : ts.isStringLiteralLike(callee.argumentExpression) ? callee.argumentExpression.text : '(名前が決まらない)';
        if (!NON_MUTATING_METHODS.has(method)) throw unclassifiable(`method ${method} を呼んでいる (値を変えないと分かっている method だけを通す)`, node);
      }
    }
    if (ts.isIdentifier(node)) {
      if (isBindingName(node)) {
        if (!isTopLevelName(node) && (topLevel.has(node.text) || imported.has(node.text))) {
          throw unclassifiable(`最上位の名前 (${node.text}) と同じ名前の束縛がある (どちらを指すか取り違える・名前を変える)`, node);
        }
      } else if (isReference(node)) {
        if (node.text === 'process') {
          const envAccess = node.parent;
          const named = ts.isPropertyAccessExpression(envAccess) && envAccess.expression === node && envAccess.name.text === 'env' && (
            (ts.isPropertyAccessExpression(envAccess.parent) && envAccess.parent.expression === envAccess) ||
            (ts.isElementAccessExpression(envAccess.parent) && envAccess.parent.expression === envAccess && ts.isStringLiteralLike(envAccess.parent.argumentExpression))
          );
          if (!named) throw unclassifiable('process.env を、名前が決まらない形で読んでいる (通すのは `process.env.NAME` だけ)', node);
        } else if (!isLocal(node) && !topLevel.has(node.text) && !imported.has(node.text) && !KNOWN_GLOBALS.has(node.text)) {
          throw unclassifiable(`行き先の分からない名前 (${node.text}) を使っている`, node);
        }
      }
    }
    ts.forEachChild(node, check);
  };
  check(parsed);

  /** node の式が (最上位の const と function をたどって) 読む環境変数の名前。 */
  const envVarsReadBy = (start: ts.Node) => {
    const names = new Set<string>();
    const seen = new Set<ts.Node>();
    const follow = (node: ts.Node) => {
      if (ts.isTypeNode(node)) return;
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'process') {
        // 形は上の check で確かめてある (`process.env.NAME` か `process.env['NAME']`)。
        const read = node.parent as ts.PropertyAccessExpression | ts.ElementAccessExpression;
        names.add(ts.isPropertyAccessExpression(read) ? read.name.text : (read.argumentExpression as ts.StringLiteralLike).text);
        return;
      }
      if (ts.isIdentifier(node) && isReference(node)) {
        for (const decl of topLevel.get(node.text) ?? []) {
          if (seen.has(decl)) continue;
          seen.add(decl);
          follow(decl);
        }
      }
      ts.forEachChild(node, follow);
    };
    follow(start);
    return [...names];
  };

  const serverOnly: Record<string, string[]> = {};
  const clientOk: string[] = [];
  for (const prop of object.properties) {
    const named = (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) && (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name));
    if (!named) throw unclassifiable('env の property が `name: 式` でも `name` でもない (spread・method・計算した名前)', prop);
    const name = (prop.name as ts.Identifier | ts.StringLiteralLike).text;
    // `name,` (shorthand) は、同じ名前の最上位の const をたどる。
    const vars = envVarsReadBy(ts.isPropertyAssignment(prop) ? prop.initializer : prop.name);
    // 環境変数を 1 つも読まない = たどり損ねの疑い。client 可と決めつけない。
    if (vars.length === 0) throw unclassifiable(`env.${name} が読む環境変数が見つからない`, prop);
    const serverVars = vars.filter((envVar) => !envVar.startsWith('NEXT_PUBLIC_'));
    if (serverVars.length > 0) serverOnly[name] = serverVars;
    else clientOk.push(name);
  }
  return { serverOnly, clientOk };
}

/** from の中の specifier が lib/env.ts を指すか。 */
function resolvesToEnvFile(spec: string, from: string): boolean {
  const base = spec.startsWith('@/') ? join(ROOT, spec.slice(2)) : spec.startsWith('.') ? resolve(ROOT, dirname(from), spec) : null;
  return base !== null && base.replace(/\.tsx?$/, '') === join(ROOT, ENV_FILE).replace(/\.tsx?$/, '');
}

/**
 * file が env のどの property (最上位) を読むか。`unclassified` は、読む property を決められない env の使い方
 * (値のまま渡す・再 export・`env[key]`・`...rest`・別名と同じ名前の束縛)。
 */
function envUses(file: string, source: string) {
  const parsed = parse(file, source);
  // unclassified は読み直すたびに作り直す (下の loop)。再 export は import/export の文から 1 度だけ拾う。
  let unclassified: string[] = [];
  const reexports: string[] = [];
  const giveUp = (what: string, node: ts.Node) => unclassified.push(`${file}:${lineOf(node)} ${what}`);

  // env の object を指す名前 → その名前を作った node。`import * as ns` は ns.env で読む。
  const aliases = new Map<string, ts.Node>();
  const namespaces = new Set<string>();
  for (const stmt of parsed.statements) {
    if (file === ENV_FILE && ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === 'env') aliases.set('env', decl);
      }
    }
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier) && resolvesToEnvFile(stmt.moduleSpecifier.text, file)) {
      const bindings = stmt.importClause?.isTypeOnly ? undefined : stmt.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      for (const element of bindings && ts.isNamedImports(bindings) ? bindings.elements : []) {
        if (!element.isTypeOnly && (element.propertyName ?? element.name).text === 'env') aliases.set(element.name.text, element);
      }
    }
    if (ts.isExportDeclaration(stmt) && !stmt.isTypeOnly && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier) && resolvesToEnvFile(stmt.moduleSpecifier.text, file)) {
      const clause = stmt.exportClause;
      const passesEnv = !clause || ts.isNamespaceExport(clause) || clause.elements.some((element) => !element.isTypeOnly && (element.propertyName ?? element.name).text === 'env');
      if (passesEnv) reexports.push(`${file}:${lineOf(stmt)} env を再 export している (import する側の読み取りをたどれない)`);
    }
  }

  let reads: { prop: string; line: number }[] = [];
  const read = (prop: string, node: ts.Node) => reads.push({ prop, line: lineOf(node) });

  /** env の object を指す式 (ref) が、どう使われているか。 */
  const classifyUse = (ref: ts.Expression) => {
    let node: ts.Node = ref;
    while (isWrapper(node.parent) && node.parent.expression === node) node = node.parent;
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      read(parent.name.text, parent);
    } else if (ts.isElementAccessExpression(parent) && parent.expression === node) {
      if (ts.isStringLiteralLike(parent.argumentExpression)) read(parent.argumentExpression.text, parent);
      else giveUp('env[…] の名前が決まらない', parent);
    } else if (ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name)) {
      const statement = parent.parent.parent;
      const exported = ts.isVariableStatement(statement) && statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (exported) giveUp('env を別の名前で export している (import する側の読み取りをたどれない)', parent);
      else aliases.set(parent.name.text, parent);
    } else if (ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isObjectBindingPattern(parent.name)) {
      for (const element of parent.name.elements) {
        const key = element.propertyName ?? element.name;
        if (element.dotDotDotToken || !(ts.isIdentifier(key) || ts.isStringLiteralLike(key))) giveUp('env の分割代入で、読む property の名前が決まらない', element);
        else read(key.text, element);
      }
    } else if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === node && ts.isObjectLiteralExpression(parent.left)) {
      for (const prop of parent.left.properties) {
        const named = ts.isShorthandPropertyAssignment(prop) || (ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)));
        if (named) read((prop.name as ts.Identifier).text, prop);
        else giveUp('env の分割代入で、読む property の名前が決まらない', prop);
      }
    } else {
      giveUp('env を値のまま使っている (渡した先で読む property をたどれない)', parent);
    }
  };

  const visit = (node: ts.Node) => {
    // 型は消える。import と `export … from` は上で見た (`export { 別名 }` は下で読み取りとして見る)。
    if (ts.isTypeNode(node) || ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)) return;
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const [target] = node.arguments;
      if (target && ts.isStringLiteralLike(target) && resolvesToEnvFile(target.text, file)) giveUp('lib/env を import() / require() で読んでいる', node);
    }
    if (ts.isIdentifier(node)) {
      if (aliases.has(node.text) && isBindingName(node) && aliases.get(node.text) !== node.parent) {
        giveUp(`env を指す名前 (${node.text}) と同じ名前の束縛がある (どちらを読むか構文木だけでは決められない・名前を変える)`, node);
      } else if (aliases.has(node.text) && isReference(node)) {
        classifyUse(node);
      } else if (namespaces.has(node.text) && isReference(node)) {
        const parent = node.parent;
        if (!ts.isPropertyAccessExpression(parent) || parent.expression !== node) giveUp('lib/env の namespace を値のまま使っている', parent);
        else if (parent.name.text === 'env') classifyUse(parent);
      }
    }
    ts.forEachChild(node, visit);
  };
  // `const e = env` の別名は、見つけるたびに最初から読み直す (別名が増えなくなるまで)。
  for (let known = -1; known !== aliases.size;) {
    known = aliases.size;
    reads = [];
    unclassified = [...reexports];
    visit(parsed);
  }
  return { reads, unclassified };
}

/** file の先頭の directive ('use client' / 'use server' など)。コメントや関数の中の文字列は境界ではない。 */
function directives(file: string, source: string): Set<string> {
  const found = new Set<string>();
  for (const stmt of parse(file, source).statements) {
    if (!ts.isExpressionStatement(stmt) || !ts.isStringLiteral(stmt.expression)) break;
    found.add(stmt.expression.text);
  }
  return found;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.[cm]?[jt]sx?$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name) ? [path] : [];
  });
}

describe('server-only env flags stay out of the client bundle', () => {
  const { serverOnly, clientOk } = classifyEnv(readSource(ENV_FILE));
  const allSources = SOURCE_ROOTS.flatMap(sourceFiles);
  // 重い走査はここで 1 度だけ (source と構文木は runtimeImports が file ごとに 1 度だけ作って使い回す)。
  // directive を持てるのは、その文字を含む file だけなので、ほかは parse しない (escape で書いた 'use client' は見ない)。
  const clientEntries = [
    ...allSources.filter((file) => readSource(file).includes('use client') && directives(file, readSource(file)).has('use client')),
    ...CLIENT_ENTRIES_BY_CONVENTION,
  ];
  const clientFiles = runtimeClosure(clientEntries).files;
  const clientCode = clientFiles.filter((file) => SCANNED.test(file));

  const usesCache = new Map<string, ReturnType<typeof envUses>>();
  const usesOf = (file: string) => {
    let uses = usesCache.get(file);
    if (!uses) usesCache.set(file, (uses = envUses(file, readSource(file))));
    return uses;
  };

  /** file の env の使い方のうち、server 専用の property の読み取りと、読む property を決められない使い方。 */
  const check = (file: string, uses = usesOf(file)) => {
    const serverReads: string[] = [];
    const unclassified = [...uses.unclassified];
    for (const { prop, line } of uses.reads) {
      if (Object.hasOwn(serverOnly, prop)) serverReads.push(`${file}#${prop} (line ${line})`);
      // valueOf など継承した member は env を丸ごと返せる (その先で読む property をたどれない)。
      else if (!clientOk.includes(prop)) unclassified.push(`${file}:${line} env の property でない名前 (${prop}) を読んでいる`);
    }
    return { serverReads, unclassified };
  };

  it('splits every env property by the env vars it is built from (neither side is empty)', () => {
    expect(Object.keys(serverOnly).length).toBeGreaterThan(0);
    expect(clientOk.length).toBeGreaterThan(0);
    // 対になる 2 つを取り違えていないこと (server の認可用と、画面を出すだけの Ui)。
    expect(serverOnly.enableCreatorStore).toEqual(['ENABLE_CREATOR_STORE']);
    expect(clientOk).toContain('enableCreatorStoreUi');
    // 最上位の const を経由する shorthand (`enableOrderRelay,`) もたどれている。
    expect(clientOk).toContain('enableOrderRelay');
  });

  it('the classifier follows consts and helpers, and fails closed on what it cannot follow', () => {
    const classify = (body: string, before = '') => classifyEnv(`${before}\nexport const env = { ${body} } as const;`);
    expect(classify(
      "a: flag(process.env.NEXT_PUBLIC_A), b: flag(process.env.B), c: process.env['C'] === '1', mixed: pub && flag(process.env.D), pub, nested: { x: process.env.NEXT_PUBLIC_X, y: process.env.Y }",
      "const flag = (raw?: string) => raw === '1';\nconst pub = flag(process.env.NEXT_PUBLIC_P);",
    )).toEqual({
      serverOnly: { b: ['B'], c: ['C'], mixed: ['D'], nested: ['Y'] },
      clientOk: ['a', 'pub'],
    });
    // helper の中で読む環境変数も、その helper を使う property のものとして数える。
    expect(classify('a: secret()', 'function secret() { return process.env.SECRET; }').serverOnly).toEqual({ a: ['SECRET'] });
    // 関数の中の変数への代入・決めた global・値を変えない method は通す。
    expect(classify(
      'a: count(process.env.NEXT_PUBLIC_A)',
      "function count(raw?: string) { let n = 0; for (let i = 0; i < 3; i++) n += 1; if (!/^1$/.test(raw ?? '')) console.warn('x'); return raw === undefined ? n : Number(raw); }",
    )).toEqual({ serverOnly: {}, clientOk: ['a'] });

    // 理解できた NEXT_PUBLIC_ が 1 つあっても、ほかの依存を理解できなければ分類しない。
    expect(() => classify("a: process['env'].SECRET ?? process.env.NEXT_PUBLIC_A")).toThrow(/名前が決まらない/);
    expect(() => classify('a: read("A")', 'const read = (name: string) => process.env[name];')).toThrow(/名前が決まらない/);
    expect(() => classify('a: source.A', 'const source = process.env;')).toThrow(/名前が決まらない/);
    expect(() => classify('a: unknown ?? process.env.NEXT_PUBLIC_A')).toThrow(/行き先の分からない名前 \(unknown\)/);
    // 宣言の後で値を変える書き方 (代入・method・Object.assign)。env の式の外に書いても落とす。
    expect(() => classify('a: config.a', 'const config = { a: process.env.NEXT_PUBLIC_A };\nconfig.a = process.env.SECRET;')).toThrow(/書き換えている/);
    expect(() => classify('a: list', 'const list = [process.env.NEXT_PUBLIC_A];\nfunction add() { list.push(process.env.SECRET); }')).toThrow(/method push/);
    expect(() => classify('a: config', 'const config = { a: process.env.NEXT_PUBLIC_A };\nObject.assign(config, { a: process.env.SECRET });')).toThrow(/method assign/);
    expect(() => classify('a: pub', 'const pub = process.env.NEXT_PUBLIC_A;\nconst f = (pub?: string) => pub;')).toThrow(/同じ名前の束縛/);
    expect(() => classify('...rest', 'const rest = { a: process.env.A };')).toThrow(/spread/);
    expect(() => classify('get a() { return process.env.A; }')).toThrow(/spread/);
    expect(() => classify('a: 1')).toThrow(/環境変数が見つからない/);
    expect(() => classify('a', 'const [a] = [process.env.A];')).toThrow(/分割代入/);
    expect(() => classify('a', 'let a = process.env.NEXT_PUBLIC_A;')).toThrow(/let/);
    expect(() => classify('a: other.a', "import { other } from './other';")).toThrow(/import している/);
    expect(() => classifyEnv('export const env = make();')).toThrow(/見つからない/);
  });

  it('the scanner sees every way of reading a property, and gives up on uses it cannot follow', () => {
    const uses = (source: string, file = 'components/Fixture.tsx') => {
      const { reads, unclassified } = envUses(file, source);
      return { reads: reads.map((entry) => entry.prop), unclassified: unclassified.length };
    };
    const imported = "import { env } from '@/lib/env';\n";
    expect(uses(`${imported}const a = env.one; const b = env?.two; const c = env['three']; const d = (env as { four: boolean }).four;`))
      .toEqual({ reads: ['one', 'two', 'three', 'four'], unclassified: 0 });
    expect(uses(`${imported}const { one, two: renamed } = env; let three; ({ three } = env);`))
      .toEqual({ reads: ['one', 'two', 'three'], unclassified: 0 });
    // 別名 (使う場所より後で作る別名も)・名前を変えた import・namespace import・相対 path。
    expect(uses(`${imported}const read = () => second.one; const first = env; const second = first;`))
      .toEqual({ reads: ['one'], unclassified: 0 });
    expect(uses("import { env as config } from '@/lib/env';\nconst a = config.one;")).toEqual({ reads: ['one'], unclassified: 0 });
    expect(uses("import * as shared from '@/lib/env';\nconst a = shared.env.one; const b = shared.isMainnet;")).toEqual({ reads: ['one'], unclassified: 0 });
    expect(uses("import { env } from '../lib/env';\nconst a = env.one;")).toEqual({ reads: ['one'], unclassified: 0 });
    expect(uses("import { env } from './env';\nconst a = env.one;", 'lib/fixture.ts')).toEqual({ reads: ['one'], unclassified: 0 });
    // .mjs も同じように読む (client の bundle の .js / .mjs も中を見る)。
    expect(uses(`${imported}export const on = () => env.one;`, 'lib/fixture.mjs')).toEqual({ reads: ['one'], unclassified: 0 });

    // 読まないもの: 型だけの参照・別の module の env・process.env・property の名前としての env。
    expect(uses("import type { env } from '@/lib/env';\ntype One = (typeof env)['one'];")).toEqual({ reads: [], unclassified: 0 });
    expect(uses(`${imported}type One = typeof env.one; const a = process.env.NODE_ENV; const b = { env: 1 }; const c = b.env;`))
      .toEqual({ reads: [], unclassified: 0 });
    expect(uses("import { env } from '@/lib/other';\nconst a = env.one;")).toEqual({ reads: [], unclassified: 0 });

    // 読む property を決められない使い方。
    for (const source of [
      `${imported}use(env);`,
      `${imported}const copy = { ...env };`,
      `${imported}const a = env[key];`,
      `${imported}const { one, ...rest } = env;`,
      `${imported}export const config = env;`,
      `${imported}const config = env; export { config };`,
      `${imported}function read(env: { one: boolean }) { return env.one; }`,
      "export { env } from '@/lib/env';",
      "export * from '@/lib/env';",
      "import * as shared from '@/lib/env';\nuse(shared);",
      "const load = async () => (await import('@/lib/env')).env.one;",
    ]) {
      expect(uses(source).unclassified, source).toBeGreaterThan(0);
    }
    // env 以外の再 export は通す。
    expect(uses("export { isMainnet } from '@/lib/env';")).toEqual({ reads: [], unclassified: 0 });

    // env の property でない名前 (継承した member) は、env を丸ごと持ち出せるので通さない。
    const valueOf = `${imported}const copy = env.valueOf() as typeof env; console.log(copy.enableAgentOrder);`;
    expect(check('components/Fixture.tsx', envUses('components/Fixture.tsx', valueOf)))
      .toEqual({ serverReads: [], unclassified: ['components/Fixture.tsx:2 env の property でない名前 (valueOf) を読んでいる'] });
  });

  it('the client bundle holds nothing this test does not follow', () => {
    // Pages Router の file は 'use client' が無くても client の bundle に入る (SOURCE_ROOTS の入口が足りなくなる)。
    expect(existsSync(join(ROOT, 'pages')), 'pages/ ができた — 入口の数え方を決める').toBe(false);
    // runtimeImports が repo の中としてたどるのは `@/` と相対 path だけ。ほかの alias は外の package に見えて、その先を見落とす。
    const { config, error } = ts.readConfigFile(join(ROOT, 'tsconfig.json'), ts.sys.readFile);
    expect(error).toBeUndefined();
    expect({ baseUrl: config.compilerOptions.baseUrl, paths: config.compilerOptions.paths }).toEqual({ baseUrl: undefined, paths: { '@/*': ['./*'] } });
    // 'use server' の file は client から import しても server で動く (client に入るのは呼び出しの stub)。中の読み取りを
    // client のものとして数えると誤り、数えないとその先の import を見落とす。現れたら扱いを決める。
    expect(clientCode.filter((file) => directives(file, readSource(file)).has('use server'))).toEqual([]);
    // 中を見ない拡張子 (.jsx・.cjs・.json など)。import もたどっていないので、現れたら SCANNED か NOT_CODE を決める。
    expect(clientFiles.filter((file) => !SCANNED.test(file) && !NOT_CODE.test(file))).toEqual([]);
  });

  it('no file in the client bundle reads a server-only property', () => {
    // 空振りの防止: client の bundle は lib/env.ts まで届いていて、env を読む file がある。
    expect(clientCode).toContain(ENV_FILE);
    expect(clientCode.filter((file) => file !== ENV_FILE && usesOf(file).reads.length > 0).length).toBeGreaterThan(0);

    const results = clientCode.map((file) => check(file));
    expect(results.flatMap((result) => result.unclassified)).toEqual([]);
    expect(results.flatMap((result) => result.serverReads)).toEqual([]);
  });

  it('the scanner is not blind to the repo: it finds the server-side reads of server-only properties', () => {
    const client = new Set(clientFiles);
    expect(allSources.filter((file) => !client.has(file)).some((file) => check(file).serverReads.length > 0)).toBe(true);
  });
});
