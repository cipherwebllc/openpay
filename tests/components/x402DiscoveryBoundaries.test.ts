// @vitest-environment node
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// R10a の境界: 公開カタログ側の leaf (誰でも見る面) は、runtime import を辿っても wagmi / SIWE /
// 接続ボタン / 出品者専用の panel・controller に届かない。R10b で出品者 panel を遅延読み込みにする前提。
// 辿るのは bundle に残る参照すべて: `import … from`・`export … from` (再 export の中継)・副作用 import・
// `import()`。`import type` / `export type … from` は bundle に入らないので辿らない。判定は TS の構文木で行う
// (行頭の `import … from` だけを見る正規表現だと、再 export を 1 段挟むだけですり抜けられた)。

const ROOT = process.cwd();
const PUBLIC_LEAVES = [
  'components/x402/DiscoveryCatalogPanel.tsx',
  'components/x402/DiscoveryExamples.tsx',
  'components/x402/discoveryDisplay.tsx',
  'components/x402/discoveryTypes.ts',
];
const FORBIDDEN = [
  'wagmi',
  '@/hooks/useSiweSession',
  // 相対 path での import も捕まえる (specifier ではなく解決後の file で見る)。
  'hooks/useSiweSession.ts',
  'components/ConnectButton.tsx',
  'components/x402/useDiscoveryOwner.ts',
  'components/x402/DiscoveryRegistrationSection.tsx',
  'components/x402/DiscoveryRegistrationForm.tsx',
  'components/x402/DiscoveryOwnedResources.tsx',
  'components/x402/PaywallSnippet.tsx',
];

function runtimeSpecifiers(file: string, source: string): string[] {
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
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [target] = node.arguments;
      // 行き先を静的に決められない import() は境界を検査できない → 通さない。
      if (!target || !ts.isStringLiteralLike(target)) throw new Error(`non-literal import() in ${file}`);
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

function runtimeClosure(entries: string[]) {
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

describe('R10a: public catalog leaves stay free of owner-only code', () => {
  it('follows re-exports, side-effect and dynamic imports but not type-only ones', () => {
    const source = [
      "import type { A } from 'type-import';",
      "export type { B } from 'type-reexport';",
      "import { type C, d } from 'inline-type-import';",
      "import e from 'default-import';",
      "export { f } from 'named-reexport';",
      "export * from 'star-reexport';",
      "export * as g from 'namespace-reexport';",
      "import 'side-effect';",
      "const h = () => import('dynamic-import');",
      '// import { x } from \'commented-out\';',
    ].join('\n');
    expect(runtimeSpecifiers('fixture.ts', source)).toEqual([
      'inline-type-import', 'default-import', 'named-reexport', 'star-reexport',
      'namespace-reexport', 'side-effect', 'dynamic-import',
    ]);
    expect(() => runtimeSpecifiers('fixture.ts', 'const m = (p: string) => import(p);')).toThrow(/non-literal/);
  });

  it('never reaches wagmi / SIWE / connect button / owner panels at runtime', () => {
    const { specifiers, files } = runtimeClosure(PUBLIC_LEAVES);
    expect(files).toEqual(expect.arrayContaining(PUBLIC_LEAVES));
    for (const forbidden of FORBIDDEN) {
      expect(specifiers).not.toContain(forbidden);
      expect(files).not.toContain(forbidden);
    }
    expect([...specifiers].filter((spec) => spec.startsWith('wagmi') || spec.includes('rainbow'))).toEqual([]);
  });

  it('the forbidden list is real: every entry is reachable from the facade (the fence is not vacuous)', () => {
    const { specifiers, files } = runtimeClosure(['components/X402DiscoveryView.tsx']);
    for (const forbidden of FORBIDDEN) {
      expect([...specifiers, ...files]).toContain(forbidden);
    }
  });
});
