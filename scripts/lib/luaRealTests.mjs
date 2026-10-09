// 本物の Lua (wasmoon = Lua 5.4 WASM) を vitest 内で実行する test ファイルの一覧 (単一情報源)。
//
// Wasmoon 1.16 の doString は返り値を global の Lua stack に残す。旧ハーネスは同じ engine を
// 使い続け、stack の蓄積で WASM heap が壊れて後続 test も OOB / abort / hang になった。
// 2026-09-24: redisLua は EVAL ごとに factory (WASM heap) と engine を作り、finally で close する。
// 通常の test step / Coverage からの除外と専用 lua-real job は従来どおり。
// 2026-09-24 の手動検証では、ローカル 3 回とも全 test が初回 attempt で pass することを確認した。
//
// この一覧は run-tests.mjs (除外 + ファイル数フェンスの allowlist)・run-lua-tests.mjs (実行対象)・
// .github/workflows/ci.yml (Coverage の --exclude) で共有し、tests/scripts/workflow-guards.test.ts が
// ci.yml と「tests/_helpers/redisLua を import する test 全件」とのドリフトを検出する。
// wasmoon を直接 import する 1 file だけでなく、redisLua ハーネス経由で本物の Lua を実行する test も
// 全て対象 (実際に verifyBudget.test.ts も 2026-09-12 に巻き込まれた)。
export const LUA_REAL_TEST_FILES = [
  'tests/_helpers/redisLua.test.ts',
  'tests/lib/order/agentOrderReservation-lua.test.ts',
  'tests/lib/order/agentOrderPending-lua.test.ts',
  'tests/lib/order/agentOrderRecovery-lua.test.ts',
  'tests/lib/order/agentOrderFinalize-lua.test.ts',
  'tests/lib/order/agentOrderLifecycle-lua.test.ts',
  'tests/lib/order/agentOrderPersistence-lua.test.ts',
  'tests/lib/order/agentOrderReview-lua.test.ts',
  'tests/lib/order/agentOrderOrigin-lua.test.ts',
  'tests/app/api/agentPurchases.test.ts',
  'tests/app/api/freee-routes-integration.test.ts',
  'tests/app/api/store-delivery-metadata.test.ts',
  'tests/app/api/store-products-license-terms.test.ts',
  'tests/lib/license/minter.test.ts',
  'tests/lib/license/product.test.ts',
  'tests/lib/license/stock.test.ts',
  'tests/lib/agent/bindings.test.ts',
  'tests/lib/license/verifyBudget.test.ts',
  'tests/lib/store/deliveryBudget.test.ts',
  'tests/lib/x402/purchaseIntent-lua.test.ts',
  'tests/lib/x402/purchaseIntent-lua-machine.test.ts',
  'tests/lib/x402/storeUsdcIntent-lua-machine.test.ts',
  'tests/lib/x402/purchaseIntent-expiry-lua.test.ts',
  'tests/lib/x402/hostedTakedown-lua.test.ts',
  'tests/lib/x402/purchaseQuoteRateLimit-lua.test.ts',
  'tests/lib/x402/registry-lua.test.ts',
  'tests/lib/x402/registry-moderation-lua.test.ts',
  'tests/lib/x402/registry-legacy-claims-lua.test.ts',
  'tests/lib/x402/registry-url-claims-lua.test.ts',
  'tests/lib/x402/registry-url-claims-lifecycle-lua.test.ts',
  'tests/lib/x402/reverify-cas.test.ts',
  'tests/lib/x402/reverify-url-claims-lua.test.ts',
  'tests/lib/x402/storeIndex-lua.test.ts',
  'tests/lib/x402/storeUsdcReconcile-lua.test.ts',
  'tests/scripts/kv-restore-lua.test.ts',
  'tests/lib/x402/facilitatorReservation-lua.test.ts',
  'tests/lib/paymentClaim-lua.test.ts',
  'tests/lib/x402/vanillaResourceClaim-lua.test.ts',
  'tests/lib/timedGrant-lua.test.ts',
  'tests/lib/x402/storeEntitlement-lua.test.ts',
  'tests/lib/x402/storeUsdcRateProvider-lua.test.ts',
  'tests/app/api/order-notify-lua.test.ts',
  'tests/scripts/lua-compile-lua.test.ts',
  'tests/lib/kvLpushAtomic-lua.test.ts',
];

// 実 Lua テストがまだ 1 本も無い Lua (id = scripts/lib/luaSources.mjs の `<file>#<定数名>`)。
// run-lua-tests.mjs は上の test を実行したときに実 Lua で実行された本文を集め、ここに無い Lua が
// 1 度も実行されていなければ fail する (新しい Lua には実 Lua テストを足す・第 7 回レビュー C5 / F10)。
// テストを足して実行されるようになったら行を消す (残っていれば warning で知らせる)。
// money-path の Lua はここに置かない (2026-10-10 時点で全部に実 Lua テストがある)。
export const LUA_WITHOUT_REAL_TEST = [
  // 面 C (money-path 外) の受注ボードの状態更新・スタッフ呼び出し・handle・push 購読・営業中表示・チップの質問箱・
  // x402 の funnel 計測。第 7 回レビュー C5 の残り (構文は tests/scripts/lua-compile-lua.test.ts が全 Lua で検査する)。
  'app/api/order/call/route.ts#COMMIT_CALL',
  'app/api/order/calls/route.ts#REMOVE_CALL',
  'app/api/order/feed/route.ts#REPLACE_ELEM',
  'lib/handleStore.ts#AGENT_LISTING_LUA',
  'lib/handleStore.ts#CAS_UPDATE',
  'lib/handleStore.ts#CLAIM_HANDLE',
  'lib/handleStore.ts#RELEASE_HANDLE',
  'lib/push/store.ts#UPSERT_SCRIPT',
  'lib/push/store.ts#REMOVE_SCRIPT',
  'lib/shopLiveStore.ts#CAS_SET',
  'lib/tipMessages.ts#STORE_TIP_MESSAGE',
  'lib/x402/funnel.ts#FUNNEL_HINCR',
  // 利用ライセンス NFT の保有一覧 (読むだけ) と登録確認 (商品 record の CAS・在庫と決済は持たない)。
  'lib/license/holders.ts#PAGE',
  'lib/license/registration.ts#CONFIRM',
];
