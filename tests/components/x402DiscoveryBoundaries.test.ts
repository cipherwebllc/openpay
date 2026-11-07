// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { runtimeClosure, runtimeSpecifiers } from '../_helpers/runtimeImports';

// R10a の境界: 公開カタログ側の leaf (誰でも見る面) は、runtime import を辿っても wagmi / SIWE /
// 接続ボタン / 出品者専用の panel・controller に届かない。R10b で出品者 panel を遅延読み込みにする前提。
// 辿るのは bundle に残る参照すべて: `import … from`・`export … from` (再 export の中継)・副作用 import・
// `import()`。`import type` / `export type … from` は bundle に入らないので辿らない。判定は TS の構文木で行う
// (行頭の `import … from` だけを見る正規表現だと、再 export を 1 段挟むだけですり抜けられた)。辿り方は
// tests/_helpers/runtimeImports.ts (NewsList の境界のテストと共有)。

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
