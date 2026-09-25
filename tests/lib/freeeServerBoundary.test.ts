import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Vitest は 'use client' を無視するため、関数の実行テストでは RSC の client reference 化を
// 検出できない。route handler が使うコアから、ローカルの runtime import / re-export を
// ソースで辿る。型だけの参照は消去されるので許容し、leaf 経由の再流入も検出する。
const ROOT = resolve(__dirname, '../..');
const OPTIONS: ts.CompilerOptions = {
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  baseUrl: ROOT,
  paths: { '@/*': ['./*'] },
};
const readSource = (file: string) => readFileSync(resolve(ROOT, file), 'utf8');

function runtimeImports(file: ts.SourceFile): string[] {
  const imports: string[] = [];
  for (const stmt of file.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const clause = stmt.importClause;
      if (clause?.isTypeOnly) continue;
      const named = clause?.namedBindings;
      if (!clause?.name && named && ts.isNamedImports(named) && named.elements.every((e) => e.isTypeOnly)) continue;
      imports.push(stmt.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
      if (stmt.isTypeOnly) continue;
      const clause = stmt.exportClause;
      if (clause && ts.isNamedExports(clause) && clause.elements.every((e) => e.isTypeOnly)) continue;
      imports.push(stmt.moduleSpecifier.text);
    }
  }
  return imports;
}

function clientBoundaries(entry: string, read = readSource): string[] {
  const visited = new Set<string>();
  const boundaries: string[] = [];
  function visit(file: string, path: string[]): void {
    if (visited.has(file)) return;
    visited.add(file);
    const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
    // directive prologue のみを見る (コメントや関数内の文字列は境界ではない)。
    for (const stmt of source.statements) {
      if (!ts.isExpressionStatement(stmt) || !ts.isStringLiteral(stmt.expression)) break;
      if (stmt.expression.text === 'use client') {
        boundaries.push([...path, file].join(' -> '));
        return;
      }
    }
    for (const specifier of runtimeImports(source)) {
      if (!specifier.startsWith('.') && !specifier.startsWith('@/')) continue;
      const target = ts.resolveModuleName(specifier, resolve(ROOT, file), OPTIONS, ts.sys).resolvedModule;
      if (!target) throw new Error(`Unresolved local import: ${file} -> ${specifier}`);
      visit(relative(ROOT, target.resolvedFileName), [...path, file]);
    }
  }
  visit(entry, []);
  return boundaries;
}

describe('freee server runtime import fence', () => {
  it.each(['lib/freeeSync.ts', 'lib/historyYen.ts'])(
    '%s never crosses a use client boundary, including through shared leaves',
    (entry) => expect(clientBoundaries(entry)).toEqual([]),
  );

  it.each([
    "import { entryLineItems } from '../history';",
    "import * as history from '@/lib/history';",
    "export { entryLineItems } from '../history';",
    "export * from '../history';",
  ])('detects a shared leaf routing runtime values back through the client facade: %s', (source) => {
    const leaf = 'lib/history/model.ts';
    expect(clientBoundaries(leaf, (file) => file === leaf ? source : readSource(file))).toEqual([
      `${leaf} -> lib/history.ts`,
    ]);
  });

  it('allows erased type-only imports and exports from the client facade', () => {
    const leaf = 'lib/history/model.ts';
    const source = `
      import type { HistoryEntry } from '../history';
      import { type HistoryLineItem } from '../history';
      export type { HistoryEntry } from '../history';
      export { type HistoryLineItem } from '../history';
    `;
    expect(clientBoundaries(leaf, (file) => file === leaf ? source : readSource(file))).toEqual([]);
  });
});
