# Type Consolidation Audit (Task 2/8)

## Summary

Audit covered ~724 TS/TSX files in `lib/`, `hooks/`, `components/`, `app/`, `tests/`. Six high-confidence duplicate/redundant type declarations were found, all clustered around the payment/history domain (`HistoryAsset`/`TokenSymbol`, `HistoryStatus`/`PaymentResult`, `HistoryFlow`/`PaymentFlow`, `HistoryPayMode`/`PayMode`, `HistoryGasMode`/`GasMode`, `IncompatibleSmartAccountError.i18nKey` double-declaration). One medium-confidence finding around scattered string literal unions in api/log/payment validation. Three candidates were rejected after field-by-field comparison (settings shapes, parsed-result discriminated unions, the `LegacyXxx` rollback fixture).

## High-confidence findings (safe to consolidate)

### Finding 1: `HistoryAsset` == `TokenSymbol`
- Currently defined at: `lib/history.ts:44` (as `HistoryAsset = 'jpyc' | 'usdc'`), `lib/tokens.ts:31-32` (as `TokenSymbol`, derived from `TOKEN_SYMBOLS` const tuple).
- Proposed central location: keep `TokenSymbol` in `lib/tokens.ts`. Delete `HistoryAsset` and re-type its usages (`HistoryEntry.asset`, `BuildHistoryBase.asset`, `HISTORY_ASSET_DECIMALS`, `HISTORY_ASSET_DISPLAY`) to `TokenSymbol`.
- Why safe: identical union members. `usePaymentHistory.ts` already imports both `HistoryGasMode`/`HistoryPayMode` from `lib/history` and `TokenSymbol` from `lib/tokens` for adjacent fields, so cross-module dependency already exists. `HISTORY_ASSET_DECIMALS` would simply become `Record<TokenSymbol, number>` (matches the runtime `TOKEN_SYMBOLS` enumeration in tokens.ts already used as canonical).

### Finding 2: `HistoryStatus` == `PaymentResult`
- Currently defined at: `lib/history.ts:42` (`HistoryStatus`), `lib/paymentLog.ts:7` (`PaymentResult`). Also re-inlined at `app/api/log/payment/route.ts:18` and cast at `app/api/log/payment/stats/route.ts:162`.
- Proposed central location: `lib/paymentLog.ts` as the SoT (it is upstream of history append — paymentLog.ts emits the result; history.ts consumes it). Re-export `PaymentResult` from `lib/history.ts` as alias-deprecated, or replace `HistoryEntry.status: HistoryStatus` with `PaymentResult`.
- Why safe: both are exactly `'success' | 'reverted' | 'error'`. Inline cast at stats route would import the shared type instead of duplicating the literal union.

### Finding 3: `HistoryFlow` == `PaymentFlow`
- Currently defined at: `lib/history.ts:36-40` (`HistoryFlow`), `lib/paymentLog.ts:12-16` (`PaymentFlow`). Both = `'batch' | 'direct' | 'standard-merchant' | 'standard-fee'`.
- Proposed central location: `lib/paymentLog.ts` (same upstream rationale). `history.ts` re-exports or simply uses `PaymentFlow`.
- Why safe: literal members and ordering match. `isValidEntry` in `history.ts:133-137` repeats the 4-string check inline; switching to the shared type lets a `satisfies` table replace that handwritten validator.

### Finding 4: `HistoryPayMode` == `PayMode`
- Currently defined at: `lib/history.ts:59` (`HistoryPayMode = 'gasless' | 'standard'`), `lib/fee.ts:25` (`PayMode = 'gasless' | 'standard'`).
- Proposed central location: keep `PayMode` in `lib/fee.ts` (already SoT — `lib/url.ts:52` re-exports it explicitly with a comment "lib/fee.ts で定義…SoT に").
- Why safe: identical. `usePaymentHistory.ts:23` already imports `HistoryPayMode` purely as a relabel; switching to `PayMode` is mechanical.

### Finding 5: `HistoryGasMode` == `GasMode`
- Currently defined at: `lib/history.ts:61` (`HistoryGasMode = 'customer' | 'merchant'`), `lib/fee.ts:22` (`GasMode = 'customer' | 'merchant'`).
- Proposed central location: `lib/fee.ts` (SoT, same rationale as Finding 4).
- Why safe: identical. The pair-rename in `history.ts` and `usePaymentHistory.ts` is purely cosmetic divergence.

### Finding 6: `IncompatibleSmartAccountError.i18nKey` union duplicated within the same class
- Currently defined at: `lib/accountDetection.ts:77-81` (readonly field type) and `lib/accountDetection.ts:84-88` (constructor arg type) — same 4-string union written twice in the same file 5 lines apart.
- Proposed central location: extract `type IncompatibleSmartAccountI18nKey = 'errorIncompatibleSmartAccount' | 'errorMav2Disabled' | 'errorMav2KaiaPolygon' | 'errorMetaMaskKaia'` at top of `lib/accountDetection.ts` and use in both spots.
- Why safe: same file, same 4 literals, intent identical. Drift risk if a future i18n key is added in only one place.

## Medium-confidence findings

### Finding 7: `PaymentBridge` (`'gateway' | 'cctp-v2'`) re-inlined
- Defined at: `lib/paymentLog.ts:21` (`PaymentBridge`).
- Re-inlined at: `app/api/log/payment/route.ts:32` (`bridge?: 'gateway' | 'cctp-v2'`), `components/CrossChainHint.tsx:269` (`bridge: 'gateway' | 'cctp-v2'` in `SuccessPanel` props), and validation at `app/api/log/payment/route.ts:67-71`.
- Proposed: import `PaymentBridge` from `lib/paymentLog.ts` in both call sites. `PaymentBridgeKey` at `app/api/log/payment/stats/route.ts:83` (= `'direct' | PaymentBridge | 'unknown'`) is intentionally a superset (server-side normalization) and should stay distinct, but could be expressed as `'direct' | PaymentBridge | 'unknown'` once `PaymentBridge` is imported there.
- Uncertainty: route.ts validator depends on string-literal narrowing in `validate()` — refactor must keep the runtime check (cannot reduce to a type-only import alone).

### Finding 8: `ConnectedWalletClient = NonNullable<GetWalletClientReturnType>` declared 3×
- Defined at: `lib/smartAccount/simpleAccount.ts:36`, `lib/smartAccount/mav2.ts:49`, `lib/smartAccount/metamask.ts:48` — character-for-character identical.
- Proposed: add `export type ConnectedWalletClient = NonNullable<GetWalletClientReturnType>` to either `lib/smartAccount/simpleAccount.ts` (currently the SoT for `SmartAccountBundle` which mav2/metamask already import from) or a new `lib/smartAccount/types.ts`.
- Uncertainty: trivial change, but each adapter file already imports `GetWalletClientReturnType` from `@wagmi/core` directly; consolidation removes that duplicated import too.

### Finding 9: Mock `Listener = (e: { matches: boolean }) => void` and `CtorArgs` duplicated across test files
- `Listener` at `tests/components/PwaInstallHint.test.tsx:8` and `tests/hooks/usePwaDisplayMode.test.tsx:5` — identical, both for matchMedia stubbing.
- `CtorArgs` at `tests/components/QrScannerSurface.test.tsx:7-11` and `tests/hooks/useQrScanner.test.tsx:9-13` — identical, both for qr-scanner mock. Comment in `QrScannerSurface.test.tsx:6` explicitly says "useQrScanner test と同じ shape を再利用".
- Proposed: extract to `tests/_helpers/matchMediaMock.ts` and `tests/_helpers/qrScannerMock.ts` (the helpers directory already exists for `wagmiMock.ts` and `i18n.ts`).
- Uncertainty: test code only; consolidation is value-add but lower-impact than production-code consolidation.

## Rejected candidates (similar but conceptually distinct)

- **`QrSettings` vs `CheckoutSettings` vs `TipSettings`** (`hooks/use{Qr,Checkout,Tip}Settings.ts`): share `receiver / token / chain` prefix but each surface owns distinct mutable fields (`splits / posterNote / quickAmounts / crossChain` vs `items / orderId / successUrl / webhook` vs `name / message / color / presets / thanksUrl`). Extracting a common base would force optional flags everywhere and obscure per-surface storage-key versioning. **Leave separate.**

- **`ParsedPayParams` / `ParsedTipParams` / `ParsedCheckoutParams`** (`lib/url.ts:225, 507, 745`): all are `{ ok: true; params: ... } | { ok: false; error: ... }`. However, `ParsedPayParams` adds `errorKind: 'empty' | 'invalid'` which Tip/Checkout deliberately do not have (bare-`/pay` landing distinction is pay-specific). A generic `Result<T, E>` could be introduced but the marginal `error` field shape varies and current explicit shapes self-document well. **Leave separate.**

- **`LegacyToken / LegacyMode / LegacyGasMode / LegacyParsedParams / LegacyParseResult`** (`tests/lib/url-rollback.test.ts:19-37`): structurally close to live types but intentionally **frozen fixtures** of the pre-multi-chain v1 parser. File-level comment ("実装は…現リポジトリの parsePayParams を import せず、独立した関数として固定する") explicitly forbids consolidation. **Do not touch.**

## Recommended implementation order

1. Finding 6 (single-file dedupe of `IncompatibleSmartAccountI18nKey`) — smallest change, zero cross-file impact, eliminates internal drift risk.
2. Findings 4 + 5 (`HistoryPayMode`→`PayMode`, `HistoryGasMode`→`GasMode`) — pure type renames, no runtime change; tests should pass unchanged.
3. Finding 1 (`HistoryAsset`→`TokenSymbol`) — same shape, adjust two `Record<>` consts.
4. Findings 2 + 3 (`HistoryStatus`→`PaymentResult`, `HistoryFlow`→`PaymentFlow`) — paired migration; also lets `isValidEntry` reduce its handwritten literal check via `satisfies`.
5. Finding 8 (`ConnectedWalletClient` shared) — cleanup, prepares for any future 4th adapter.
6. Finding 7 (`PaymentBridge` import propagation to route.ts / CrossChainHint.tsx) — touches API route validator, run integration tests after.
7. Finding 9 (test helpers) — optional/low priority polish.
