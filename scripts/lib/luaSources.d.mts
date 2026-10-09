// TypeScript 型宣言 — テストから import するとき型補完を効かせるため。
// 実装は scripts/lib/luaSources.mjs (node native ESM)。tsc は declaration only として読む。

export type LuaPart = { text: string } | { expr: string };

export type LuaScript = {
  /** `<repo-relative file>#<定数名>` (関数の中で組み立てる Lua は `<関数名>()`)。 */
  id: string;
  file: string;
  name: string;
  line: number;
  parts: LuaPart[];
  fragments: string[];
  dynamic: string[];
  /** 組み立て式の中にある `${}` 付きテンプレートの式 (外部送信する Lua では禁止)。 */
  templateSubstitutions: string[];
};

export const LUA_SOURCE_DIRS: readonly string[];
export const LUA_MARKER: RegExp;
export function listLuaScripts(root: string, dirs?: readonly string[]): LuaScript[];
export function listLuaSourceFiles(root: string, dirs?: readonly string[]): string[];
export function extractLuaScripts(file: string, text: string): LuaScript[];
export function luaRealCoverage(
  scripts: readonly LuaScript[],
  executed: readonly string[],
): { covered: string[]; uncovered: string[] };
export function evaluateLuaRealCoverage(args: {
  scripts: readonly LuaScript[];
  executed: readonly string[];
  allowlist: readonly string[];
}): { missing: string[]; stale: string[] };
export function readExecutedLua(coverageFile: string): string[];
export function checkLuaRealCoverage(args: {
  root: string;
  executed: readonly string[];
  allowlist: readonly string[];
}): { executed: number; missing: string[]; stale: string[] };
export function resolveLuaSource(
  script: LuaScript,
  scripts: readonly LuaScript[],
  placeholder?: string,
): string;
export function luaProbes(fragments: readonly string[], minLength?: number): string[];
export function checkLuaInBundle(
  scripts: readonly Pick<LuaScript, 'id' | 'fragments'>[],
  bundleFiles: readonly { name: string; text: string }[],
  minLength?: number,
): {
  present: string[][];
  absent: string[][];
  shared: string[][];
  broken: { ids: string[]; file: string; missing: string[] }[];
};
