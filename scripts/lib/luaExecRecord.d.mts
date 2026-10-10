// TypeScript 型宣言 — テストとハーネスから import するとき型補完を効かせるため。
// 実装は scripts/lib/luaExecRecord.mjs (node native ESM)。tsc は declaration only として読む。

export const LUA_EXEC_RECORD_ENV: 'LUA_EXEC_RECORD_DIR';

export type LuaExecution = { sha256: string; testPath: string | null };

export function luaScriptSha256(script: string): string;

export function luaExecRecordDir(env?: Record<string, string | undefined>): string | null;

export function recordLuaExecution(dir: string, script: string, testPath?: string): string;

export function readLuaExecRecord(dir: string): { bodies: Map<string, string>; executions: LuaExecution[] };
