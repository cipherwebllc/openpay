import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

// bundle に残る import を TS の構文木で辿る (境界のテスト用)。辿るのは `import … from`・`export … from`
// (再 export の中継)・副作用 import・`import()`・`require()`。`import type` / `export type … from` は bundle に入らないので
// 辿らない。`import { type A } from` は 1 つずつ type でも辿る (書き方しだいで副作用 import が残るので、
// 型だけなら `import type` に書かせる)。行頭の正規表現で見ると、複数行の import・二重引用符・相対 path・
// 再 export を 1 段挟むだけですり抜けられた。

const ROOT = process.cwd();

export function runtimeSpecifiers(file: string, source: string): string[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const specs: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      // importClause 無し = 副作用 import (`import '…'`) も辿る。
      if (!node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
        specs.push(node.moduleSpecifier.text);
      }
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specs.push(node.moduleSpecifier.text);
      }
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      // require() も bundle に入る (2026-11-08 時点でアプリのコードに require は無いが、書けば通ってしまうので辿る)。
      const [target] = node.arguments;
      // 行き先を静的に決められない import() / require() は境界を検査できない → 通さない。
      if (!target || !ts.isStringLiteralLike(target)) throw new Error(`non-literal import()/require() in ${file}`);
      specs.push(target.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return specs;
}

function resolveLocal(spec: string, from: string): string | null {
  const base = spec.startsWith('@/')
    ? join(ROOT, spec.slice(2))
    : spec.startsWith('.') ? resolve(dirname(from), spec) : null;
  if (base === null) return null;
  for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
    if (existsSync(base + ext) && statSync(base + ext).isFile()) return base + ext;
  }
  throw new Error(`unresolved import ${spec} from ${from}`);
}

/** entries (repo 相対) から runtime import を辿り、出てきた specifier と、届いた repo 内の file (repo 相対) を返す。 */
export function runtimeClosure(entries: string[]) {
  const specifiers = new Set<string>();
  const files = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    if (!/\.(?:tsx?|m?js)$/.test(file)) return; // json 等は import を持たない
    for (const spec of runtimeSpecifiers(file, readFileSync(file, 'utf8'))) {
      specifiers.add(spec);
      const next = resolveLocal(spec, file);
      if (next) visit(next);
    }
  };
  for (const entry of entries) visit(join(ROOT, entry));
  return { specifiers, files: [...files].map((file) => relative(ROOT, file)) };
}
