// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { runtimeClosure, runtimeSpecifiers } from '../_helpers/runtimeImports';

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
//      たどれない書き方 (process.env[name]・spread・環境変数を読まない property など) は throw する (fail closed)。
//      落ちたら、その書き方を分類できるように classifyEnv を直す。
//   2. client の bundle に入る file = 'use client' を持つ file と instrumentation-client.ts から、実行時の import で
//      たどれる file (tests/_helpers/runtimeImports.ts)。
//   3. その file が server 専用の property を読んでいないこと (`env.x`・`env['x']`・分割代入・別名・名前を変えた import・
//      `import * as`)。env を値のまま渡す・再 export するなど、読む property を決められない使い方も通さない。
//
// 粒度は file。client が import する file に server 専用の読み取りがあれば、呼んでいなくても落ちる (その関数は
// client の bundle に入り、client から呼べば必ず OFF を返す)。server だけが呼ぶ関数なら server 専用の module へ移す。
// 見ていないもの: 'use client' の file が SOURCE_ROOTS の外にある場合・env の中の入れ子の property 単位の区別
// (入れ子に server 専用が 1 つでもあれば、最上位の property ごと server 専用として扱う)。

const ROOT = process.cwd();
const ENV_FILE = 'lib/env.ts';
const SOURCE_ROOTS = ['app', 'components', 'hooks', 'lib'];
// 'use client' は無いが、Next が browser の bundle の先頭で実行する。
const CLIENT_ENTRIES_BY_CONVENTION = ['instrumentation-client.ts'];

/**
 * client の bundle に入る file が server 専用の property を読む、今ある例外。key は `file#property`。
 * `reach` は、その読み取りの結果が client の bundle の中で届く範囲の上限: file → それを実行時に import する client の
 * file → そこが取る名前 ('*' = 名前で絞れない取り方)。実際の import がこれと 1 つでも違えば落ちる (例外を file ごと
 * 素通しにしない)。読み取りが無くなった項目もテストが落とす。
 */
const ALLOWED: Record<string, { why: string; reach: Record<string, Record<string, string[]>> }> = {
  'lib/shops/flags.ts#enableAgentOrder': {
    why: 'shopsApiEnabled() は server の AND guard。client の bundle には、AI ストアのカード (DiscoveryCatalogPanel・' +
      'DiscoveryExamples) → lib/x402/usdcCatalog.ts → lib/x402/firstParty.ts の import で入る。firstParty.ts は module の' +
      '読み込み時に shopsApiEnabled() を呼んで FIRST_PARTY_RESOURCES を作るので、client ではその配列から JPYC Shops の' +
      '行が必ず抜ける。今は usdcCatalog.ts が取るのが OPENPAY_CANONICAL_ORIGIN (flag に依らない定数) だけなので、画面には' +
      '出ない。直すなら OPENPAY_CANONICAL_ORIGIN を firstParty.ts の外へ出して、この項目を消す。',
    reach: {
      'lib/shops/flags.ts': { 'lib/x402/firstParty.ts': ['shopsApiEnabled'] },
      'lib/x402/firstParty.ts': { 'lib/x402/usdcCatalog.ts': ['OPENPAY_CANONICAL_ORIGIN'] },
    },
  },
};

const parse = (file: string, source: string) =>
  ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

const lineOf = (node: ts.Node) => node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;

const isWrapper = (node: ts.Node): node is ts.ParenthesizedExpression | ts.AsExpression | ts.SatisfiesExpression | ts.NonNullExpression =>
  ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node);

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

/** lib/env.ts の env の property を、作るときに読む環境変数で分ける。たどれない書き方は throw する。 */
function classifyEnv(source: string) {
  const parsed = parse(ENV_FILE, source);
  const unclassifiable = (what: string, node: ts.Node) =>
    new Error(`${ENV_FILE}:${lineOf(node)} ${what} — serverOnlyFlagsBoundary.test.ts の classifyEnv が分類できる形にする`);

  // 別の module の中まではたどらない。repo の中の module を import したら、そこで読む環境変数を見落とす。
  const localImport = runtimeSpecifiers(ENV_FILE, source).find((spec) => spec.startsWith('.') || spec.startsWith('@/'));
  if (localImport) throw unclassifiable(`repo の中の module (${localImport}) を import している`, parsed);

  // property の式に出てくる名前の行き先 (最上位の const と function。function は overload の数だけある)。
  const topLevel = new Map<string, ts.Node[]>();
  for (const stmt of parsed.statements) {
    if (ts.isVariableStatement(stmt)) {
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

  /** node の式が (最上位の const と function をたどって) 読む環境変数の名前。 */
  const envVarsReadBy = (start: ts.Node) => {
    const names = new Set<string>();
    const seen = new Set<ts.Node>();
    const follow = (node: ts.Node) => {
      if (ts.isTypeNode(node)) return;
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'process' && node.name.text === 'env') {
        const parent = node.parent;
        if (ts.isPropertyAccessExpression(parent) && parent.expression === node) names.add(parent.name.text);
        else if (ts.isElementAccessExpression(parent) && parent.expression === node && ts.isStringLiteralLike(parent.argumentExpression)) names.add(parent.argumentExpression.text);
        else throw unclassifiable('process.env を、名前が決まらない形で読んでいる', node);
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

  let object = (topLevel.get('env')?.[0] as ts.VariableDeclaration | undefined)?.initializer;
  while (object && isWrapper(object)) object = object.expression;
  if (!object || !ts.isObjectLiteralExpression(object)) throw unclassifiable('`const env = { … }` が見つからない', parsed);

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

/** from の中の specifier が target (repo 相対の .ts / .tsx) を指すか。 */
function resolvesTo(spec: string, from: string, target: string): boolean {
  const base = spec.startsWith('@/') ? join(ROOT, spec.slice(2)) : spec.startsWith('.') ? resolve(ROOT, dirname(from), spec) : null;
  return base !== null && base.replace(/\.tsx?$/, '') === join(ROOT, target).replace(/\.tsx?$/, '');
}
const resolvesToEnvFile = (spec: string, from: string) => resolvesTo(spec, from, ENV_FILE);

/** file が target から実行時に取る名前。'*' = 名前で絞れない取り方。import していなければ null。 */
function namesTakenFrom(file: string, source: string, target: string): string[] | null {
  const runtimeImports = runtimeSpecifiers(file, source).filter((spec) => resolvesTo(spec, file, target)).length;
  if (runtimeImports === 0) return null;
  const named = parse(file, source).statements.flatMap((stmt) => {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier) || !resolvesTo(stmt.moduleSpecifier.text, file, target)) return [];
    const clause = stmt.importClause;
    if (!clause || clause.isTypeOnly || clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return [];
    return [clause.namedBindings.elements.filter((element) => !element.isTypeOnly).map((element) => (element.propertyName ?? element.name).text)];
  });
  // 名前を並べた import 以外 (import * as・default・副作用・再 export・import()) は、何を取るか決められない。
  return [...named.flat(), ...(named.length < runtimeImports ? ['*'] : [])];
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

function hasUseClient(file: string, source: string): boolean {
  // directive prologue だけを見る (コメントや関数の中の文字列は境界ではない)。
  for (const stmt of parse(file, source).statements) {
    if (!ts.isExpressionStatement(stmt) || !ts.isStringLiteral(stmt.expression)) return false;
    if (stmt.expression.text === 'use client') return true;
  }
  return false;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

const readSource = (file: string) => readFileSync(join(ROOT, file), 'utf8');

describe('server-only env flags stay out of the client bundle', () => {
  const { serverOnly, clientOk } = classifyEnv(readSource(ENV_FILE));
  const allSources = SOURCE_ROOTS.flatMap(sourceFiles);
  const clientEntries = [...allSources.filter((file) => hasUseClient(file, readSource(file))), ...CLIENT_ENTRIES_BY_CONVENTION];
  const clientFiles = runtimeClosure(clientEntries).files.filter((file) => /\.tsx?$/.test(file));

  /** files のうち server 専用の property を読む箇所 (`file#property` → 行) と、読む property を決められない箇所。 */
  const serverOnlyReads = (files: string[]) => {
    const found = new Map<string, number[]>();
    const unclassified: string[] = [];
    for (const file of files) {
      const uses = envUses(file, readSource(file));
      unclassified.push(...uses.unclassified);
      for (const { prop, line } of uses.reads) {
        if (prop in serverOnly) found.set(`${file}#${prop}`, [...(found.get(`${file}#${prop}`) ?? []), line]);
      }
    }
    return { found, unclassified };
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

    expect(() => classify('a: read("A")', 'const read = (name: string) => process.env[name];')).toThrow(/名前が決まらない/);
    expect(() => classify('a: source.A', 'const source = process.env;')).toThrow(/名前が決まらない/);
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
  });

  it('no file in the client bundle reads a server-only property', () => {
    // 空振りの防止: client の bundle は lib/env.ts まで届いていて、env を読む file がある。
    expect(clientFiles).toContain(ENV_FILE);
    expect(clientFiles.filter((file) => file !== ENV_FILE && envUses(file, readSource(file)).reads.length > 0).length).toBeGreaterThan(0);

    const { found, unclassified } = serverOnlyReads(clientFiles);
    expect(unclassified).toEqual([]);
    const violations = [...found].filter(([key]) => !(key in ALLOWED)).map(([key, lines]) => `${key} (line ${lines.join(', ')})`);
    expect(violations).toEqual([]);
    // 読み取りが無くなった例外は消す (残すと、同じ file の次の読み取りが素通りする)。
    expect(Object.keys(ALLOWED).filter((key) => !found.has(key))).toEqual([]);
  });

  it('a recorded exception reaches no further into the client bundle than its record says', () => {
    // 取る名前の読み方: 名前を並べた import だけが名前になり、ほかの取り方は '*'。型だけの import は数えない。
    const taken = (source: string) => namesTakenFrom('components/Fixture.tsx', source, 'lib/x402/firstParty.ts');
    expect(taken("import { a, type B, c as d } from '@/lib/x402/firstParty';")).toEqual(['a', 'c']);
    expect(taken("import { a } from '../lib/x402/firstParty';\nconst later = () => import('@/lib/x402/firstParty');")).toEqual(['a', '*']);
    expect(taken("import * as all from '@/lib/x402/firstParty';")).toEqual(['*']);
    expect(taken("export { a } from '@/lib/x402/firstParty';")).toEqual(['*']);
    expect(taken("import type { B } from '@/lib/x402/firstParty';\nimport { a } from '@/lib/x402/other';")).toBeNull();

    for (const [key, { reach }] of Object.entries(ALLOWED)) {
      // 記録は、読み取りのある file から始める (空の記録で file ごと素通しにしない)。
      expect(Object.keys(reach)).toContain(key.split('#')[0]);
      for (const [target, recorded] of Object.entries(reach)) {
        const actual: Record<string, string[]> = {};
        for (const file of clientFiles) {
          const names = namesTakenFrom(file, readSource(file), target);
          if (names) actual[file] = names;
        }
        expect(actual, `${key}: client の bundle の中で ${target} を import する file と、取る名前`).toEqual(recorded);
      }
    }
  });

  it('the scanner is not blind to the repo: it finds the server-side reads of server-only properties', () => {
    const client = new Set(clientFiles);
    expect(serverOnlyReads(allSources.filter((file) => !client.has(file))).found.size).toBeGreaterThan(0);
  });
});
