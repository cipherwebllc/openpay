// @vitest-environment node
// lib/handle.ts (facade) の公開 API と browser-safe 性のフェンス (R13 で lib/handle/* へ分割)。
import { readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as handle from '@/lib/handle';
import type {
  ClearableHandleTipField, HandleEmbed, HandleEmbedResolved, HandleFont,
  HandleHeading, HandleLink, HandleLinkLayout, HandleProfile, HandleReceiveMethod,
  HandleRecord, HandleRegularLink, HandleTipConfig, HandleTipConfigUpdate,
  HandleValidation, PublishableTipConfig, ValidatedConfig, ValidatedHandleConfig,
  ValidatedProfile,
} from '@/lib/handle';

const ROOT = process.cwd();
const HANDLE_SUBMODULES = ['normalize', 'tipConfig', 'embeds', 'profile', 'record', 'schema']
  .map((name) => `lib/handle/${name}.ts`);
// client bundle に入ってはいけない first-party の server モジュール (KV / SIWE session / 認証 / KV 操作)。
const SERVER_FIRST_PARTY = /^lib\/(?:kv|siwe|handleStore|adminAuth|cronAuth|orderFeedAuth)\.ts$/;
// 同じく package 側 (server-only 宣言・Node 組み込み・server 専用 API・KV クライアント・SIWE)。
const SERVER_PACKAGE = /^(?:server-only$|node:|next\/headers$|@upstash\/)|(?:^|\/)siwe(?:\/|$)/;
const SCRIPT_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// `@/*` (tsconfig paths) と相対 specifier を、TS / bundler と同じ「そのファイル → 拡張子補完 →
// ディレクトリ index」の順で解決する (`@/lib/handle` は lib/handle.ts)。package は null。
function resolveFirstParty(specifier: string, importer: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = join(ROOT, specifier.slice(2));
  else if (specifier.startsWith('.')) base = resolve(dirname(importer), specifier);
  else return null;
  const candidates = [
    base,
    ...['.ts', '.tsx', '.js', '.mjs'].map((ext) => base + ext),
    ...['index.ts', 'index.tsx'].map((file) => join(base, file)),
  ];
  const found = candidates.find(isFile);
  if (!found) throw new Error(`unresolved import ${specifier} from ${relative(ROOT, importer)}`);
  return found;
}

// 実行時に残る import だけを返す。`import type` と全要素が type の named import / export は
// bundler が消すので辿らない。それ以外 (値として使われない import を含む) は保守的に辿る。
function runtimeSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const allTypeOnly = (elements: ts.NodeArray<ts.ImportSpecifier | ts.ExportSpecifier>) =>
    elements.length > 0 && elements.every((element) => element.isTypeOnly);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const typeOnly = clause !== undefined && (clause.isTypeOnly || (
        clause.name === undefined && clause.namedBindings !== undefined &&
        ts.isNamedImports(clause.namedBindings) && allTypeOnly(clause.namedBindings.elements)
      ));
      if (!typeOnly) found.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const typeOnly = node.isTypeOnly || (
        node.exportClause !== undefined && ts.isNamedExports(node.exportClause) &&
        allTypeOnly(node.exportClause.elements)
      );
      if (!typeOnly) found.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && (
      node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require')
    )) {
      const [argument] = node.arguments;
      if (argument && ts.isStringLiteralLike(argument)) found.push(argument.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

// entry から first-party の実行時 import を推移的に辿り、server 依存への辺を列挙する。
// node_modules の中は辿らない (package 名で判定する)。
function runtimeImportGraph(entry: string) {
  const files = new Set<string>();
  const edges: Array<[from: string, to: string]> = [];
  const violations: string[] = [];
  const pending = [resolve(ROOT, entry)];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    if (!SCRIPT_FILE.test(file)) continue;
    const from = relative(ROOT, file);
    for (const specifier of runtimeSpecifiers(file)) {
      const target = resolveFirstParty(specifier, file);
      if (target === null) {
        if (SERVER_PACKAGE.test(specifier) || builtinModules.includes(specifier)) {
          violations.push(`${from} -> ${specifier}`);
        }
        continue;
      }
      const to = relative(ROOT, target);
      edges.push([from, to]);
      if (SERVER_FIRST_PARTY.test(to)) violations.push(`${from} -> ${specifier}`);
      pending.push(target);
    }
  }
  return { files: [...files].map((file) => relative(ROOT, file)), edges, violations };
}

describe('public handle facade compatibility', () => {
  it('keeps exactly the existing runtime exports', () => {
    expect(Object.keys(handle).sort()).toEqual([
      'CLEARABLE_HANDLE_TIP_FIELDS', 'DEFAULT_RECEIVE_METHODS', 'HANDLE_FONTS',
      'HANDLE_LINK_LAYOUTS', 'HANDLE_PATTERN', 'MAX_AVATAR_URL_LEN', 'MAX_BIO_LEN',
      'MAX_COVER_URL_LEN', 'MAX_HANDLES_PER_WALLET', 'MAX_LINK_IMAGE_URL_LEN',
      'MAX_LINK_LABEL_LEN', 'MAX_LINK_URL_LEN', 'MAX_PROFILE_EMBEDS',
      'MAX_PROFILE_LINKS', 'MAX_RECEIVE_METHODS', 'MAX_SOCIAL_LINKS', 'RESERVED_HANDLES',
      'configToSearchParams', 'configToTipParams', 'decodeHandleSegment',
      'extractHandleEmbed', 'handleStorefrontConfig', 'isAudiusHandleEmbedUrl',
      'isHandleEmbedUrl', 'isHandleFont', 'isHandleLinkLayout', 'isReserved',
      'isValidHandleFormat', 'methodToPublishableConfig', 'normalizeHandle',
      'parseHandleRecord', 'serializeHandleRecord', 'tipParamsToConfig',
      'validateHandle', 'validateHandleTipConfig', 'validateProfile', 'validateTipConfig',
    ]);
  });

  it('keeps all public type exports and update nullability available at the original path', () => {
    expectTypeOf<ReturnType<typeof handle.validateHandle>>().toEqualTypeOf<HandleValidation>();
    expectTypeOf<ReturnType<typeof handle.validateTipConfig>>().toEqualTypeOf<ValidatedConfig>();
    expectTypeOf<ReturnType<typeof handle.validateHandleTipConfig>>().toEqualTypeOf<ValidatedHandleConfig>();
    expectTypeOf<ReturnType<typeof handle.validateProfile>>().toEqualTypeOf<ValidatedProfile>();
    expectTypeOf<ReturnType<typeof handle.parseHandleRecord>>().toEqualTypeOf<HandleRecord | null>();
    expectTypeOf<ReturnType<typeof handle.extractHandleEmbed>>().toEqualTypeOf<HandleEmbed | null>();
    expectTypeOf<ReturnType<typeof handle.methodToPublishableConfig>>().toEqualTypeOf<PublishableTipConfig>();
    expectTypeOf<HandleRecord['config']>().toEqualTypeOf<HandleTipConfig>();
    expectTypeOf<HandleRecord['profile']>().toEqualTypeOf<HandleProfile | undefined>();
    expectTypeOf<HandleTipConfig['methods']>().toEqualTypeOf<HandleReceiveMethod[]>();
    expectTypeOf<HandleProfile['links']>().toEqualTypeOf<HandleLink[] | undefined>();
    expectTypeOf<HandleLink>().toEqualTypeOf<HandleRegularLink | HandleHeading>();
    expectTypeOf<HandleRegularLink['embedResolved']>().toEqualTypeOf<HandleEmbedResolved | undefined>();
    expectTypeOf<HandleProfile['font']>().toEqualTypeOf<HandleFont | undefined>();
    expectTypeOf<HandleProfile['linkLayout']>().toEqualTypeOf<HandleLinkLayout | undefined>();
    expectTypeOf<ClearableHandleTipField>().toEqualTypeOf<'message' | 'thanks' | 'thanksUrl' | 'webhook'>();
    expectTypeOf<HandleTipConfigUpdate[ClearableHandleTipField]>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<HandleTipConfig[ClearableHandleTipField]>().toEqualTypeOf<string | undefined>();
    expect(handle.CLEARABLE_HANDLE_TIP_FIELDS).toEqual(['message', 'thanks', 'thanksUrl', 'webhook']);
  });

  it('keeps the facade runtime import graph free of KV, SIWE/auth, server-only and Node dependencies', () => {
    const graph = runtimeImportGraph('lib/handle.ts');
    expect(graph.violations).toEqual([]);
    // 空振りの pass を防ぐ: facade → 全 submodule → `@/` 経由の依存まで実際に辿れていること。
    expect(graph.files).toEqual(expect.arrayContaining([
      'lib/handle.ts', ...HANDLE_SUBMODULES, 'lib/url.ts', 'lib/mobileOrder.ts', 'lib/handleThemeKey.ts',
    ]));
    // lib/handle/* は facade を import しない (循環防止)。
    expect(graph.edges.filter(([from, to]) => from.startsWith('lib/handle/') && to === 'lib/handle.ts')).toEqual([]);
    // `@/lib/handle` を常に lib/handle.ts へ解決させるため、ディレクトリ index は置かない。
    expect(isFile(join(ROOT, 'lib/handle/index.ts'))).toBe(false);
  });

  it('reports direct and transitive server dependencies with the same walk', () => {
    // 検査器自体の自己検査: server 側の既知モジュールから辿ると直接・推移の両方を検出する。
    const { violations } = runtimeImportGraph('lib/handleStore.ts');
    expect(violations).toContain('lib/handleStore.ts -> @/lib/kv');
    expect(violations).toContain('lib/kv.ts -> server-only');
  });
});
