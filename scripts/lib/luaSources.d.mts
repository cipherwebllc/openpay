// TypeScript 型宣言 — テストから import するとき型補完を効かせるため。
// 実装は scripts/lib/luaSources.mjs (node native ESM)。tsc は declaration only として読む。

/** 送る本文の片。text は静的な文字列 (literal = ソースの文字列リテラル由来)、dyn は値の分からない式。 */
export type LuaPart = { text: string; literal: boolean } | { dyn: string; param?: boolean };

export type LuaSite = { file: string; line: number; evidence: string[] };

/** 送られる Lua 1 本 (送信式の script の 1 通りの値)。 */
export type LuaUnit = {
  /** `<file>#<定数名>`・`<file>#<包む関数>(<引数>)`・`<file>#<囲む関数名>()`。 */
  id: string;
  parts: LuaPart[];
  /** 組み立てに使った式 (expr) の id。 */
  exprs: string[];
  /** 組み立ての中にある `${}` 付きテンプレートの式 (外部送信する Lua では禁止)。 */
  templates: string[];
  sites: LuaSite[];
  /** 送信式が lib/・app/ にある (= next build に入る)。 */
  bundled: boolean;
};

/** 組み立てに使った式 (定数の初期化式・包む関数の return 式・その場の文字列)。 */
export type LuaExpr = { id: string; file: string; line: number; runs: string[] };

export type LuaAnalysis = {
  sites: (LuaSite & { unitIds: string[] })[];
  units: LuaUnit[];
  exprs: LuaExpr[];
  errors: { file: string; line: number; reason: string; expr?: string; id?: string }[];
  orphans: { file: string; line: number; text: string }[];
};

export const LUA_SOURCE_DIRS: readonly string[];
export const BUNDLED_DIRS: readonly string[];
export const LUA_MARKER: RegExp;
export function analyzeLua(root: string, options?: { dirs?: readonly string[] }): LuaAnalysis;
export function unitSource(unit: Pick<LuaUnit, 'parts'>, placeholder?: string): string;
export function luaRealCoverage(
  units: readonly Pick<LuaUnit, 'id' | 'parts'>[],
  executed: readonly string[],
): { covered: string[]; uncovered: string[] };
export function evaluateLuaRealCoverage(args: {
  units: readonly Pick<LuaUnit, 'id' | 'parts'>[];
  executed: readonly string[];
  allowlist: readonly string[];
}): { missing: string[]; stale: string[] };
export function checkLuaAllowlist(
  allowlist: readonly string[],
  unitIds: readonly string[],
): { blocking: string[]; gone: string[] };
export function readExecutedLua(coverageFile: string): string[];
export function checkLuaRealCoverage(args: {
  root: string;
  executed: readonly string[];
  allowlist: readonly string[];
}): { executed: number; missing: string[]; stale: string[]; errors: { file: string; line: number; reason: string }[] };
export function bundleStrings(text: string, name?: string): string[];
export function checkLuaInBundle(
  analysis: Pick<LuaAnalysis, 'units' | 'exprs'>,
  bundleFiles: readonly { name: string; strings: readonly string[] }[],
): {
  checked: string[];
  broken: { id: string; file: string; missing: string[] }[];
  missing: string[];
  absent: string[];
};
