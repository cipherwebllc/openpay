// TypeScript 型宣言 — テストから import するとき型補完を効かせるため。
// 実装は scripts/lib/client-namespace-graph.mjs (node native ESM)。

/** リポジトリルートの絶対パス。 */
export const REPO_ROOT: string;

/** app/[locale]/layout.tsx の絶対パス。 */
export const LOCALE_LAYOUT: string;

/** entry から到達可能なリポ内モジュールを辿り、参照される namespace をソートして返す。 */
export function collectNamespaces(entryFile: string): string[];

/** app/[locale] 配下の page.tsx を列挙する (route = layout からの相対ディレクトリ)。 */
export function listLocalePages(): Array<{ route: string; file: string }>;

/**
 * entry から到達可能なファイルのうち useTranslations('<namespace>') を使うものについて、
 * その translator で引いているキーと、文字列リテラルでない (動的な) 呼び出しを返す。
 */
export function collectKeysForNamespace(
  entryFile: string,
  namespace: string,
): { files: string[]; keys: string[]; dynamic: string[] };
