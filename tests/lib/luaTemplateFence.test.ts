// Lua (Upstash EVAL に送るスクリプト) を組む式に JS のテンプレート補間 `${}` を持ち込ませないフェンス。
//
// 2026-09-06 の実害: Next.js の minifier が `+` 連結の中のテンプレートリテラルの `${}` 以降と後続の文字列片を
// 落とし、本番だけ Lua が構文エラーになった (scripts/check-lua-bundle.mjs の冒頭)。ソースの文字列を使う
// vitest・dev・本番 DB 直叩きは全部通るので、書いた時点で止める網がこれ (第 8 回レビュー F-1 / Q10)。
// 補間の無いバッククォート (複数行の Lua 本文) は壊れないので対象外。数値は String(n) の普通の連結で組む。
//
// 「Lua の値」は AST で次のように見つける (コメントと Lua でない文字列は見ない):
//   1. 文字列片に Lua の印 (redis.call / ARGV[ / KEYS[ / cjson.encode|decode) がある式を、`+` 連結・括弧・
//      三項の枝・配列の要素と `[...].join()`・テンプレートの `${}` の中までさかのぼった最上位を 1 本の Lua の定義とする。
//   2. Lua の定義を値に持つ変数・Lua を return する関数 (helper) を、連結・テンプレート・三項の枝で使う式も
//      Lua の定義とする (`PRELUDE + ... + COMMIT`・`` `${PRELUDE} ...` ``)。これを Lua が増えなくなるまで繰り返す。
//   3. EVAL の口 (kvEval(x) / store.eval(x) / ['EVAL', x]) に渡す式は、印が無くても Lua とみなす。
// 1〜3 の式の中にテンプレート補間があれば違反。式の中の識別子はレキシカルスコープで宣言を引き (関数の引数・
// ループ変数は値をたどれないので止まる)、変数は初期化式、関数 (helper) は return する式までたどって同じく調べる。
// 三項の条件は Lua の値にならないので見ない。
import { readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const LUA_MARKER = /\bredis\.p?call\s*\(|\bARGV\[|\bKEYS\[|\bcjson\.(?:encode|decode)\b/;
const SCAN_DIRS = ['app', 'lib', 'components', 'hooks', 'scripts', 'packages'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'tests', 'test', 'fixtures', '.next']);
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.mts', '.mjs', '.js', '/index.ts', '/index.tsx', '/index.mjs', '/index.js'];

/** 値をたどれる宣言: 初期化式のある変数か、本文のある関数。 */
type Binding = ts.VariableDeclaration | ts.FunctionDeclaration;

type Analysis = {
  violations: string[];
  /** Lua の定義 (1 と 2 の最上位) の場所。網が実際に何かを見ていることの確認用。 */
  definitions: string[];
  /** EVAL の口の数と、そのうち引数が Lua の値にたどり着けた数。 */
  sinks: number;
  resolvedSinks: number;
};

function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => span.literal.text).join('');
  }
  return undefined;
}

// 1 本の Lua を組む式の最上位までさかのぼる。
function definitionRoot(node: ts.Node): ts.Node {
  let current = node;
  for (;;) {
    const parent = current.parent;
    if (!parent) return current;
    if (
      ts.isParenthesizedExpression(parent) ||
      (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken) ||
      (ts.isConditionalExpression(parent) && parent.condition !== current) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isTemplateSpan(parent) ||
      ts.isTemplateExpression(parent)
    ) {
      current = parent;
      continue;
    }
    // [...].join('...')
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === current &&
      parent.name.text === 'join' &&
      ts.isCallExpression(parent.parent) &&
      parent.parent.expression === parent
    ) {
      current = parent.parent;
      continue;
    }
    return current;
  }
}

function line(node: ts.Node): string {
  const file = node.getSourceFile();
  return `${file.fileName}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
}

// 値として読まれる識別子か (プロパティ名・宣言名・import/export の名前・型の位置は除く)。
function isValueReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent)) return parent.expression === node;
  if (ts.isQualifiedName(parent) || ts.isTypeReferenceNode(parent) || ts.isExpressionWithTypeArguments(parent)) return false;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  return !(
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isLabeledStatement(parent) ||
    ts.isBreakOrContinueStatement(parent)
  );
}

function bindsName(name: ts.BindingName, text: string): boolean {
  if (ts.isIdentifier(name)) return name.text === text;
  return name.elements.some((element) => !ts.isOmittedExpression(element) && bindsName(element.name, text));
}

function statementsOf(scope: ts.Node): readonly ts.Statement[] | undefined {
  if (ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope)) {
    return scope.statements;
  }
  return undefined;
}

// その文の並びで宣言された、値をたどれる同名の宣言。
function declaredIn(statements: readonly ts.Statement[], text: string): Binding[] {
  const found: Binding[] = [];
  for (const statement of statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === text && declaration.initializer) found.push(declaration);
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name?.text === text && statement.body) {
      found.push(statement);
    }
  }
  return found;
}

// 名前を宣言しているが値をたどれないもの (関数の引数・ループ変数・catch の変数・分割代入)。外側の同名を見に行かない。
function shadowsWithoutValue(scope: ts.Node, text: string): boolean {
  if (ts.isFunctionLike(scope)) return scope.parameters.some((parameter) => bindsName(parameter.name, text));
  if (
    (ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) &&
    scope.initializer &&
    ts.isVariableDeclarationList(scope.initializer)
  ) {
    return scope.initializer.declarations.some((declaration) => bindsName(declaration.name, text));
  }
  if (ts.isCatchClause(scope)) return !!scope.variableDeclaration && bindsName(scope.variableDeclaration.name, text);
  const statements = statementsOf(scope);
  return !!statements?.some((statement) =>
    ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some((declaration) => !ts.isIdentifier(declaration.name) && bindsName(declaration.name, text)),
  );
}

// 関数が return する式 (中の関数の return は外の関数の値ではないので入らない)。
function returnedExpressions(fn: ts.FunctionLikeDeclaration): ts.Expression[] {
  const body = fn.body;
  if (!body) return [];
  if (!ts.isBlock(body)) return [body];
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) found.push(node.expression);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return found;
}

// 宣言の値: 変数は初期化式 (関数を入れた変数は return する式)、関数は return する式。
function valueExpressions(binding: Binding): ts.Expression[] {
  if (ts.isFunctionDeclaration(binding)) return returnedExpressions(binding);
  const initializer = binding.initializer!;
  if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return returnedExpressions(initializer);
  return [initializer];
}

// この式がどの宣言の値か (変数の初期化式・関数が return する式)。どれでもなければ undefined。
function bindingOfValue(value: ts.Node): Binding | undefined {
  const parent = value.parent;
  if (ts.isVariableDeclaration(parent) && parent.initializer === value) {
    return ts.isIdentifier(parent.name) ? parent : undefined;
  }
  let fn: ts.Node | undefined;
  if (ts.isReturnStatement(parent)) {
    fn = parent.parent;
    while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
  } else if (ts.isArrowFunction(parent) && parent.body === value) {
    fn = parent;
  }
  if (!fn) return undefined;
  if (ts.isFunctionDeclaration(fn)) return fn.name && fn.body ? fn : undefined;
  if (
    (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
    ts.isVariableDeclaration(fn.parent) &&
    fn.parent.initializer === fn &&
    ts.isIdentifier(fn.parent.name)
  ) {
    return fn.parent;
  }
  return undefined;
}

function analyze(sources: Record<string, string>): Analysis {
  const files = new Map<string, ts.SourceFile>();
  for (const [name, text] of Object.entries(sources)) {
    files.set(name, ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true));
  }

  function resolveModule(from: string, specifier: string): ts.SourceFile | undefined {
    let base: string;
    if (specifier.startsWith('@/')) base = specifier.slice(2);
    else if (specifier.startsWith('.')) base = posix.normalize(posix.join(posix.dirname(from), specifier));
    else return undefined;
    const name = RESOLVE_SUFFIXES.map((suffix) => base + suffix).find((candidate) => files.has(candidate));
    return name ? files.get(name) : undefined;
  }

  function importedBindings(file: ts.SourceFile, text: string): Binding[] {
    for (const statement of file.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      const element = bindings.elements.find((e) => e.name.text === text);
      if (!element) continue;
      const target = resolveModule(file.fileName, statement.moduleSpecifier.text);
      return target ? declaredIn(target.statements, (element.propertyName ?? element.name).text) : [];
    }
    return [];
  }

  // 識別子 → 宣言 (内側のスコープから外へ。ファイルの最上位で見つからなければ import 先の最上位)。
  function resolveIdentifier(identifier: ts.Identifier): Binding[] {
    const text = identifier.text;
    for (let scope: ts.Node | undefined = identifier.parent; scope; scope = scope.parent) {
      if (shadowsWithoutValue(scope, text)) return [];
      const statements = statementsOf(scope);
      if (!statements) continue;
      const found = declaredIn(statements, text);
      if (found.length > 0) return found;
      if (ts.isSourceFile(scope)) return importedBindings(scope, text);
    }
    return [];
  }

  // Lua の値として流れ込む部分だけを歩く。識別子は宣言の値 (初期化式・return する式) までたどる。
  function walkValue(root: ts.Node, visit: (node: ts.Node) => void): void {
    const seen = new Set<ts.Node>();
    const step = (node: ts.Node): void => {
      if (seen.has(node)) return;
      seen.add(node);
      visit(node);
      if (ts.isIdentifier(node)) {
        if (!isValueReference(node)) return;
        for (const binding of resolveIdentifier(node)) valueExpressions(binding).forEach(step);
        return;
      }
      // 三項の条件は Lua の値にならない。
      if (ts.isConditionalExpression(node)) {
        step(node.whenTrue);
        step(node.whenFalse);
        return;
      }
      ts.forEachChild(node, step);
    };
    step(root);
  }

  function templatesIn(root: ts.Node): ts.TemplateExpression[] {
    const found: ts.TemplateExpression[] = [];
    walkValue(root, (node) => {
      if (ts.isTemplateExpression(node)) found.push(node);
    });
    return found;
  }

  // 値として読まれる識別子を名前で引けるようにしておく (Lua の値を使う場所を探すため)。
  const referencesByName = new Map<string, ts.Identifier[]>();
  for (const file of files.values()) {
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && isValueReference(node)) {
        const list = referencesByName.get(node.text);
        if (list) list.push(node);
        else referencesByName.set(node.text, [node]);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }

  // Lua の値 (式) → Lua の定義として数えるか。Lua を値に持つ宣言。
  const luaRoots = new Map<ts.Node, boolean>();
  const luaBindings = new Set<Binding>();
  const queue: ts.Node[] = [];
  const addRoot = (root: ts.Node, counted: boolean): void => {
    const known = luaRoots.get(root);
    if (known === undefined) queue.push(root);
    luaRoots.set(root, known === true || counted);
  };

  // 1. 印のある式。
  for (const file of files.values()) {
    const visit = (node: ts.Node): void => {
      const text = literalText(node);
      if (text !== undefined && LUA_MARKER.test(text)) addRoot(definitionRoot(node), true);
      ts.forEachChild(node, visit);
    };
    visit(file);
  }

  // 2. Lua を値に持つ変数・Lua を return する関数を使う式へ広げる (Lua が増えなくなるまで)。
  while (queue.length > 0) {
    const binding = bindingOfValue(queue.shift()!);
    if (!binding || luaBindings.has(binding)) continue;
    luaBindings.add(binding);
    // bindingOfValue は名前が識別子の宣言だけを返す。
    const name = binding.name && ts.isIdentifier(binding.name) ? binding.name.text : '';
    for (const reference of referencesByName.get(name) ?? []) {
      if (!resolveIdentifier(reference).includes(binding)) continue;
      const call = reference.parent;
      const value = ts.isCallExpression(call) && call.expression === reference ? call : reference;
      const root = definitionRoot(value);
      // 連結・テンプレート・三項の枝で使えば新しい Lua の定義。そのまま渡す・代入するだけなら定義は増やさない。
      addRoot(root, root !== value);
    }
  }

  const violations = new Set<string>();
  const definitions: string[] = [];
  const report = (where: ts.Node, hits: ts.TemplateExpression[]): void => {
    for (const hit of hits) {
      const via = line(hit) === line(where) ? '' : ` (${line(where)} の Lua からたどった)`;
      violations.add(`${line(hit)}: Lua を組む式にテンプレート補間 \`\${}\` がある${via}`);
    }
  };

  for (const [root, counted] of luaRoots) {
    if (counted) definitions.push(line(root));
    report(root, templatesIn(root));
  }

  // 3. EVAL の口に渡す式。
  let sinks = 0;
  let resolvedSinks = 0;
  for (const file of files.values()) {
    const visit = (node: ts.Node): void => {
      let script: ts.Expression | undefined;
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
        if (name === 'kvEval' || name === 'eval') script = node.arguments[0];
      } else if (ts.isArrayLiteralExpression(node)) {
        const [first, second] = node.elements;
        if (first && ts.isStringLiteral(first) && first.text === 'EVAL') script = second;
      }
      if (script) {
        sinks += 1;
        let reachesLua = false;
        walkValue(script, (part) => {
          const text = literalText(part);
          if (text !== undefined && LUA_MARKER.test(text)) reachesLua = true;
          if (ts.isIdentifier(part) && resolveIdentifier(part).some((binding) => luaBindings.has(binding))) reachesLua = true;
        });
        if (reachesLua) resolvedSinks += 1;
        report(script, templatesIn(script));
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }

  return { violations: [...violations].sort(), definitions, sinks, resolvedSinks };
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : sourceFiles(path);
    return SOURCE_FILE.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name) ? [path.split('\\').join('/')] : [];
  });
}

// lib/license/stock.ts の licenseLuaVariant の形 (PRELUDE + 本体 + COMMIT を連結して返す helper) と、
// それを kvEval に渡す呼び出し側 (lib/license/reconcile.ts)。body は helper の return に入れる式。
function licenseVariantSources(body: string): Record<string, string> {
  return {
    'lib/license/stock.ts': [
      "const PRELUDE = \"local stock = cjson.decode(redis.call('GET', KEYS[3])); \";",
      "const COMMIT = ' for _,w in ipairs(writes) do redis.call(unpack(w)) end; return result;';",
      'export function licenseLuaVariant(digitalScript: string): string {',
      `  return PRELUDE + 'local function transition() ' + ${body} + ' end; local result=transition(); ' + COMMIT;`,
      '}',
    ].join('\n'),
    'lib/license/reconcile.ts': [
      "import { licenseLuaVariant } from '@/lib/license/stock';",
      "const CAS = \"if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end; return 1\";",
      "await kvEval<number>(licenseLuaVariant(CAS), ['store:intent:x', 'store:intent:pending'], ['v']);",
    ].join('\n'),
  };
}

describe('Lua の定義にテンプレート補間 ${} を持ち込まないフェンス (検出器)', () => {
  it.each([
    ['テンプレート自体が Lua', { 'lib/a.ts': "const S = `local v = redis.call('GET', KEYS[1]); return ${N}`;" }],
    [
      '2026-09 の実害の形 (印の無いテンプレート片を Lua に + 連結)',
      { 'lib/a.ts': "const N = 3;\nconst S = \"if ARGV[4]=='violation' and failures>=\" + `${N} then hidden=true end; ` + 'return 1';" },
    ],
    ['[...].join() で組む Lua の 1 行', { 'lib/a.ts': "const S = [\"redis.call('DEL', KEYS[1])\", `return ${n}`].join(' ');" }],
    ['三項の片側', { 'lib/a.ts': "const S = 'return ARGV[1] ' + (x ? `${a}` : 'b');" }],
    ['同じファイルの変数を経由', { 'lib/a.ts': "const COND = `a>=${N}`;\nconst S = 'if ARGV[1] then ' + COND + ' end';" }],
    [
      'import した変数を経由',
      {
        'lib/cond.ts': "export const COND = `a>=${N}`;",
        'lib/a.ts': "import { COND as C } from './cond';\nconst S = 'if ARGV[1] then ' + C + ' end';",
      },
    ],
    [
      'Lua の定義をテンプレートに埋め込む (別ファイル)',
      {
        'lib/prelude.ts': "export const PRELUDE = \"local t = redis.call('TYPE', KEYS[1]);\";",
        'lib/a.ts': "import { PRELUDE } from '@/lib/prelude';\nconst S = `${PRELUDE} return 1`;",
      },
    ],
    ['印の無い Lua を kvEval に直接', { 'lib/a.ts': "await kvEval(`return ${n}`, [], []);" }],
    ['印の無い Lua を変数経由で store.eval に', { 'lib/a.ts': "const S = 'return ' + `${n}`;\nawait store.eval(S, [], []);" }],
    ["['EVAL', script, ...] の形", { 'scripts/a.mjs': "const cmd = ['EVAL', `return ${n}`, 0];" }],
    [
      'Lua の変数と連結する helper (EVAL の口から呼ばれていなくても、定義の側で止める)',
      {
        'lib/a.ts': "const PRELUDE = \"local t = redis.call('TYPE', KEYS[1]); \";\nexport function variant(s: string): string {\n  return PRELUDE + `${s}`;\n}",
      },
    ],
    [
      'helper の return だけがテンプレート (印も Lua の変数も無い・EVAL の口から helper をたどる)',
      {
        'lib/a.ts': "const CAS = \"return redis.call('GET', KEYS[1])\";\nfunction wrap(s: string): string {\n  return 'local function t() ' + `${s}` + ' end; return t()';\n}\nawait kvEval(wrap(CAS), [], []);",
      },
    ],
    [
      'arrow の helper を三項の枝で EVAL の口へ',
      {
        'lib/a.ts': "const CAS = \"return redis.call('GET', KEYS[1])\";\nconst wrap = (s: string) => 'local function t() ' + `${s}` + ' end';\nawait kvEval(license ? wrap(CAS) : CAS, [], []);",
      },
    ],
    [
      'import した helper の結果を変数に入れてから EVAL の口へ',
      {
        'lib/wrap.ts': "export function wrap(s: string): string {\n  if (!s) return 'return 0';\n  return 'return ' + `${s}`;\n}",
        'lib/a.ts': "import { wrap } from './wrap';\nconst S = wrap('1');\nawait store.eval(S, [], []);",
      },
    ],
  ])('違反を見つける: %s', (_name, sources) => {
    expect(analyze(sources as Record<string, string>).violations.length).toBeGreaterThan(0);
  });

  it('第 8 回レビューの指摘: licenseLuaVariant の連結の中の引数をテンプレートにすると落ちる', () => {
    // lib/license/stock.ts:131 の `digitalScript` を `${digitalScript}` (テンプレート) に変えた形。
    const mutated = analyze(licenseVariantSources('`${digitalScript}`'));
    expect(mutated.violations).toContain(
      'lib/license/stock.ts:4: Lua を組む式にテンプレート補間 `${}` がある (lib/license/reconcile.ts:3 の Lua からたどった)',
    );
    // 今の形 (普通の連結) は違反にしない。
    expect(analyze(licenseVariantSources('digitalScript')).violations).toEqual([]);
  });

  it.each([
    ['補間の無いバッククォートの Lua 本文', { 'lib/a.ts': "const S = `\nlocal v = redis.call('GET', KEYS[1])\nreturn v\n`;" }],
    ['String(n) の普通の連結', { 'lib/a.ts': "const S = 'if ARGV[1]>=' + String(N) + ' then return 1 end';" }],
    [
      '同じファイルの Lua でないテンプレート (キー名・ログ)',
      { 'lib/a.ts': "const S = \"return redis.call('GET', KEYS[1])\";\nconst key = `meter:${p}`;\nlogger.warn(`failed ${key}`);\nawait kvEval(S, [key], []);" },
    ],
    ['コメントの中の ${} と ARGV', { 'lib/a.ts': "// `if ARGV[1] then ${x}`\nconst S = 'return 1';" }],
    ['EVAL 以外の配列', { 'lib/a.ts': "const cmd = ['GET', `k:${id}`];" }],
    [
      'helper の本文のログ (return しないテンプレート)',
      {
        'lib/a.ts': "const PRELUDE = \"local t = redis.call('TYPE', KEYS[1]); \";\nfunction variant(s: string): string {\n  logger.info(`building ${s}`);\n  return PRELUDE + s;\n}\nawait kvEval(variant('return 1'), [], []);",
      },
    ],
    [
      '関数の引数が外側の同名の変数を隠す (レキシカルスコープ)',
      {
        'lib/a.ts': "const key = `meter:${p}`;\nfunction lua(key: string): string {\n  return \"return redis.call('GET', KEYS[1]) .. \" + key;\n}\nawait kvEval(lua('x'), [key], []);",
      },
    ],
    [
      '三項の条件にあるテンプレート (Lua の値にならない)',
      { 'lib/a.ts': "const S = \"return redis.call('GET', KEYS[1])\";\nconst label = `mode:${m}`;\nawait kvEval(label === 'a' ? S : S, [], []);" },
    ],
  ])('違反にしない: %s', (_name, sources) => {
    expect(analyze(sources as Record<string, string>).violations).toEqual([]);
  });
});

describe('Lua の定義にテンプレート補間 ${} を持ち込まないフェンス (リポジトリ全体)', () => {
  const sources = Object.fromEntries(SCAN_DIRS.flatMap(sourceFiles).map((file) => [file, readFileSync(file, 'utf8')]));
  const result = analyze(sources);

  it('Lua を組む式 (定義・helper・EVAL の口) にテンプレート補間が無い', () => {
    expect(result.violations).toEqual([]);
  });

  it('網が実際に Lua の定義と EVAL の口を見ている (検出の印や探す範囲が壊れていない)', () => {
    const definitionFiles = new Set(result.definitions.map((where) => where.replace(/:\d+$/, '')));
    // 2026-09 の実害の場所・複数行のバッククォート・配列 + join・helper で包む形 (licenseLuaVariant) と、その呼び出し側。
    for (const file of [
      'lib/x402/reverify.ts',
      'lib/x402/purchase/lua.ts',
      'lib/order/agentOrderReservation.ts',
      'lib/license/stock.ts',
      'lib/x402/purchase/claim.ts',
    ]) {
      expect(definitionFiles).toContain(file);
    }
    // 2026-10-30 時点で定義 99 (印 92 + helper・連結 7)・EVAL の口 88 (うち 86 が Lua の値にたどり着く)。下限は
    // 検出器が壊れて 0 近くに落ちたことを捕まえるためのもので、Lua を減らすリファクタで落ちないよう余裕を取っている。
    expect(result.definitions.length).toBeGreaterThanOrEqual(50);
    expect(result.sinks).toBeGreaterThanOrEqual(50);
    // EVAL の口のほとんどは、引数が Lua の値にたどり着く (kv.ts の汎用の口などの引数は関数の引数なのでたどれない)。
    expect(result.resolvedSinks).toBeGreaterThanOrEqual(Math.floor(result.sinks * 0.8));
  });
});
