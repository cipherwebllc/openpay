// Lua (Upstash EVAL に送るスクリプト) を組む式に JS のテンプレート補間 `${}` を持ち込ませないフェンス。
//
// 2026-09-06 の実害: Next.js の minifier が `+` 連結の中のテンプレートリテラルの `${}` 以降と後続の文字列片を
// 落とし、本番だけ Lua が構文エラーになった (scripts/check-lua-bundle.mjs の冒頭)。ソースの文字列を使う
// vitest・dev・本番 DB 直叩きは全部通るので、書いた時点で止める網がこれ (第 8 回レビュー F-1 / Q10)。
// 補間の無いバッククォート (複数行の Lua 本文) は壊れないので対象外。数値は String(n) の普通の連結で組む。
//
// 「Lua の定義」は AST で次のように見つける (コメントと Lua でない文字列は見ない):
//   1. 文字列片に Lua の印 (redis.call / ARGV[ / KEYS[ / cjson.encode|decode) がある式を、`+` 連結・括弧・
//      三項・配列の要素と `[...].join()`・テンプレートの `${}` の中までさかのぼった最上位を 1 本の定義とする。
//      その中にテンプレート補間があれば違反。定義の中の識別子は、同じファイルの変数と import 先の変数の
//      初期化式までたどって同じく調べる (`const COND = \`...${N}\`` を Lua に連結する形)。
//   2. Lua の定義を値に持つ変数をテンプレートの `${}` に入れる式も違反 (`\`${PRELUDE} ...\``)。
//   3. EVAL の口 (kvEval(x) / store.eval(x) / ['EVAL', x]) に渡す式は、印が無くても Lua とみなして 1 と同じく調べる。
import { readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const LUA_MARKER = /\bredis\.p?call\s*\(|\bARGV\[|\bKEYS\[|\bcjson\.(?:encode|decode)\b/;
const SCAN_DIRS = ['app', 'lib', 'components', 'hooks', 'scripts', 'packages'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'tests', 'test', 'fixtures', '.next']);
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.mts', '.mjs', '.js', '/index.ts', '/index.tsx', '/index.mjs', '/index.js'];

type Analysis = {
  violations: string[];
  /** Lua の定義 (1 の最上位) の数とその場所。網が実際に何かを見ていることの確認用。 */
  definitions: string[];
  /** EVAL の口の数と、そのうち引数が Lua の定義にたどり着けた数。 */
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

function hasLuaMarker(node: ts.Node): boolean {
  const text = literalText(node);
  if (text !== undefined && LUA_MARKER.test(text)) return true;
  return ts.forEachChild(node, hasLuaMarker) ?? false;
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

function line(file: ts.SourceFile, node: ts.Node): string {
  return `${file.fileName}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
}

function analyze(sources: Record<string, string>): Analysis {
  const files = new Map<string, ts.SourceFile>();
  for (const [name, text] of Object.entries(sources)) {
    files.set(name, ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true));
  }

  // 変数名 → そのファイルの変数宣言 (初期化式あり)。同名の宣言が複数あれば全部 (shadowing は保守的に両方見る)。
  const declarations = new Map<string, Map<string, ts.VariableDeclaration[]>>();
  for (const [name, file] of files) {
    const byName = new Map<string, ts.VariableDeclaration[]>();
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        byName.set(node.name.text, [...(byName.get(node.name.text) ?? []), node]);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    declarations.set(name, byName);
  }

  function resolveModule(from: string, specifier: string): string | undefined {
    let base: string;
    if (specifier.startsWith('@/')) base = specifier.slice(2);
    else if (specifier.startsWith('.')) base = posix.normalize(posix.join(posix.dirname(from), specifier));
    else return undefined;
    return RESOLVE_SUFFIXES.map((suffix) => base + suffix).find((candidate) => files.has(candidate));
  }

  // 識別子 → 値の初期化式 (同じファイルの変数か、import した変数)。関数・引数などは undefined。
  function resolveIdentifier(fileName: string, identifier: ts.Identifier): ts.VariableDeclaration[] {
    const local = declarations.get(fileName)?.get(identifier.text);
    if (local) return local;
    const file = files.get(fileName)!;
    for (const statement of file.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      const element = bindings.elements.find((e) => e.name.text === identifier.text);
      if (!element) continue;
      const target = resolveModule(fileName, statement.moduleSpecifier.text);
      const exported = (element.propertyName ?? element.name).text;
      return target ? declarations.get(target)?.get(exported) ?? [] : [];
    }
    return [];
  }

  // 値として読まれる識別子だけ (プロパティ名・宣言名・import 名は除く)。
  function referencedIdentifiers(node: ts.Node, out: ts.Identifier[] = []): ts.Identifier[] {
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const isName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isVariableDeclaration(parent) && parent.name === node);
      if (!isName) out.push(node);
      return out;
    }
    ts.forEachChild(node, (child) => { referencedIdentifiers(child, out); });
    return out;
  }

  // 式 (とその中の識別子がたどり着く初期化式) にあるテンプレート補間を返す。
  function templatesIn(fileName: string, root: ts.Node, seen: Set<ts.Node>): { file: ts.SourceFile; node: ts.Node }[] {
    if (seen.has(root)) return [];
    seen.add(root);
    const file = root.getSourceFile();
    const found: { file: ts.SourceFile; node: ts.Node }[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isTemplateExpression(node)) found.push({ file, node });
      ts.forEachChild(node, visit);
    };
    visit(root);
    for (const identifier of referencedIdentifiers(root)) {
      for (const declaration of resolveIdentifier(fileName, identifier)) {
        const owner = declaration.getSourceFile().fileName;
        found.push(...templatesIn(owner, definitionRoot(declaration.initializer!), seen));
      }
    }
    return found;
  }

  const violations = new Set<string>();
  const definitions: string[] = [];
  const luaDeclarations = new Set<ts.VariableDeclaration>();
  let sinks = 0;
  let resolvedSinks = 0;

  const report = (where: string, hits: { file: ts.SourceFile; node: ts.Node }[]): void => {
    for (const hit of hits) {
      const via = line(hit.file, hit.node) === where ? '' : ` (${where} の Lua からたどった)`;
      violations.add(`${line(hit.file, hit.node)}: Lua を組む式にテンプレート補間 \`\${}\` がある${via}`);
    }
  };

  // 1. 印のある Lua の定義。
  for (const [fileName, file] of files) {
    const roots = new Set<ts.Node>();
    const visit = (node: ts.Node): void => {
      const text = literalText(node);
      if (text !== undefined && LUA_MARKER.test(text)) roots.add(definitionRoot(node));
      ts.forEachChild(node, visit);
    };
    visit(file);
    for (const root of roots) {
      definitions.push(line(file, root));
      if (ts.isVariableDeclaration(root.parent) && root.parent.initializer === root) luaDeclarations.add(root.parent);
      report(line(file, root), templatesIn(fileName, root, new Set()));
    }
  }

  for (const [fileName, file] of files) {
    const visit = (node: ts.Node): void => {
      // 2. Lua の定義を値に持つ変数をテンプレートに埋め込む式。
      if (ts.isTemplateExpression(node)) {
        const embedsLua = node.templateSpans.some((span) =>
          referencedIdentifiers(span.expression).some((identifier) =>
            resolveIdentifier(fileName, identifier).some((declaration) => luaDeclarations.has(declaration)),
          ),
        );
        if (embedsLua) violations.add(`${line(file, node)}: Lua の定義をテンプレート補間 \`\${}\` で組み立てている`);
      }
      // 3. EVAL の口に渡す式。
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
        const reachesLua =
          hasLuaMarker(script) ||
          referencedIdentifiers(script).some((identifier) =>
            resolveIdentifier(fileName, identifier).some(
              (declaration) => luaDeclarations.has(declaration) || hasLuaMarker(declaration.initializer!),
            ),
          );
        if (reachesLua) resolvedSinks += 1;
        report(line(file, script), templatesIn(fileName, script, new Set()));
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
  ])('違反を見つける: %s', (_name, sources) => {
    expect(analyze(sources as Record<string, string>).violations.length).toBeGreaterThan(0);
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
  ])('違反にしない: %s', (_name, sources) => {
    expect(analyze(sources as Record<string, string>).violations).toEqual([]);
  });
});

describe('Lua の定義にテンプレート補間 ${} を持ち込まないフェンス (リポジトリ全体)', () => {
  const sources = Object.fromEntries(SCAN_DIRS.flatMap(sourceFiles).map((file) => [file, readFileSync(file, 'utf8')]));
  const result = analyze(sources);

  it('Lua を組む式 (定義・EVAL の口) にテンプレート補間が無い', () => {
    expect(result.violations).toEqual([]);
  });

  it('網が実際に Lua の定義と EVAL の口を見ている (検出の印や探す範囲が壊れていない)', () => {
    const definitionFiles = new Set(result.definitions.map((where) => where.replace(/:\d+$/, '')));
    // 2026-09 の実害の場所・複数行のバッククォート・配列 + join・連結で包む形の代表。
    for (const file of ['lib/x402/reverify.ts', 'lib/x402/purchase/lua.ts', 'lib/order/agentOrderReservation.ts', 'lib/license/stock.ts']) {
      expect(definitionFiles).toContain(file);
    }
    // 2026-10-30 時点で定義 92・EVAL の口 88 (うち 86 が定義にたどり着く)。下限は検出器が壊れて 0 近くに
    // 落ちたことを捕まえるためのもので、Lua を減らすリファクタで落ちないよう余裕を取っている。
    expect(result.definitions.length).toBeGreaterThanOrEqual(50);
    expect(result.sinks).toBeGreaterThanOrEqual(50);
    // EVAL の口のほとんどは、引数が Lua の定義にたどり着く (kv.ts の汎用の口などの引数は関数の引数なのでたどれない)。
    expect(result.resolvedSinks).toBeGreaterThanOrEqual(Math.floor(result.sinks * 0.8));
  });
});
