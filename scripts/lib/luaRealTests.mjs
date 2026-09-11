// 本物の Lua (wasmoon = Lua 5.4 WASM) を vitest 内で実行する test ファイルの一覧 (単一情報源)。
//
// wasmoon 1.16 は JS 関数 (redis.call / cjson) を Lua に橋渡しする部分の寿命管理に不具合があり、
// CI では非決定的に "memory access out of bounds" / "Aborted(native code called abort())" で落ちる
// (memory: feedback_wasmoon_oob_flaky・2026-09-09〜12 に 5 run)。ハーネス側の小手先対策
// (engine 再作成・collectgarbage) は逆に決定的な OOB を起こしたため、恒久対策 案 1 (2026-09-12 user 採用):
//   - 通常の test step / Coverage からこの一覧を除外し、
//   - 専用 job (lua-real) で **プロセスごと** 作り直して最大 3 回まで再試行する (scripts/run-lua-tests.mjs)。
// WASM の heap が壊れた後は同一プロセス内の retry では回復しないので、vitest の --retry ではなく
// プロセス再起動で再試行する。
//
// この一覧は run-tests.mjs (除外 + ファイル数フェンスの allowlist)・run-lua-tests.mjs (実行対象)・
// .github/workflows/ci.yml (Coverage の --exclude) で共有し、tests/scripts/workflow-guards.test.ts が
// ci.yml と「tests/_helpers/redisLua を import する test 全件」とのドリフトを検出する。
// wasmoon を直接 import する 1 file だけでなく、redisLua ハーネス経由で本物の Lua を実行する test も
// 全て対象 (実際に verifyBudget.test.ts も 2026-09-12 に巻き込まれた)。
export const LUA_REAL_TEST_FILES = [
  'tests/_helpers/redisLua.test.ts',
  'tests/app/api/store-delivery-metadata.test.ts',
  'tests/app/api/store-products-license-terms.test.ts',
  'tests/lib/license/minter.test.ts',
  'tests/lib/license/product.test.ts',
  'tests/lib/license/stock.test.ts',
  'tests/lib/license/verifyBudget.test.ts',
  'tests/lib/store/deliveryBudget.test.ts',
  'tests/lib/x402/purchaseIntent-lua.test.ts',
  'tests/lib/x402/registry-lua.test.ts',
  'tests/lib/x402/reverify-cas.test.ts',
];
