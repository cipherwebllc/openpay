# Dead Code Audit (Task 3/8)

## Summary
- knip ran: yes — v6.14.2, JSON reporter, no `knip.config` present (defaults)
- ts-prune ran: yes — fallback corroboration
- Raw knip findings: 27 issue entries → 7 unused files, 15 unused exports, 12 unused types, 1 unused dep, 1 unused devDep, 9 "unlisted"
- After manual cross-reference: **2 high-confidence**, **5 medium-confidence**, ~38 rejected (false positives)

## Tool output reference
Snippet of raw knip output (JSON reporter):

```
{"file":"scripts/generate-icons.mjs", "files":[{"name":"scripts/generate-icons.mjs"}], ...}
{"file":"lib/chains.ts", "exports":[{"name":"isBuyerOnlyChainSlug","line":224}], ...}
{"file":"package.json", "dependencies":[{"name":"@vercel/speed-insights"}], ...}
```

Full output: `/tmp/knip.json` (9 422 B), `/tmp/tsprune.txt` (88 lines).

## High-confidence dead code (safe to delete)

### Item 1: `@vercel/speed-insights` (npm dep)
- Defined at: `/Users/masia02/openpay/package.json:36` (`"@vercel/speed-insights": "^2.0.0"`)
- Grep result: `grep -rn "speed-insights\|SpeedInsights"` matches only `package.json` and `package-lock.json` — zero source imports.
- Why safe: Package is declared but no module ever imports `<SpeedInsights />` or any export. `@vercel/analytics` is the only Vercel observability lib actually wired up. Drop the dep + lockfile entry.

### Item 2: `isBuyerOnlyChainSlug` (function export)
- Defined at: `/Users/masia02/openpay/lib/chains.ts:224`
- Grep result: `grep -rn "\bisBuyerOnlyChainSlug\b"` → only the definition line. The sibling `buyerOnlyChainForSlug` (line 220) and the type `BuyerOnlyChainSlug` are heavily used; this type-guard helper has zero callers.
- Why safe: Pure helper, no dynamic-name lookup risk (the function name is not a string key anywhere). Either delete or keep behind a comment if planned for QR validation work.

## Medium-confidence (need human eyeball — may be reached dynamically)

### M1: CCTP V2 address/URL exports in `lib/crossChain/cctp.ts` (7 symbols)
- `CCTP_V2_TOKEN_MESSENGER_MAINNET` (L21), `…_TESTNET` (L25), `CCTP_V2_MESSAGE_TRANSMITTER_MAINNET` (L23), `…_TESTNET` (L27), `CCTP_IRIS_API_MAINNET` (L38), `CCTP_IRIS_API_TESTNET` (L39), `CCTP_IRIS_API_BASE_URL` (L51)
- Used **internally** by the same file (composed into `CCTP_TOKEN_MESSENGER` / `CCTP_MESSAGE_TRANSMITTER` / `baseUrl` at lines 31–56, 189). The `export` keyword is what's unused.
- Verdict: downgrade `export const X =` → `const X =`. Do NOT delete the constants themselves. Cross-chain code (phase 4) is live per memory `project_cross_chain_phase4_status`.

### M2: `defaultBlockHeightOffset` in `lib/crossChain/gateway.ts:106`
- Used internally at L210 (`maxBlockHeightOffset ?? defaultBlockHeightOffset(sourceChainId)`). No external caller.
- Verdict: downgrade `export` → internal `function`. Symbol stays; safe.

### M3: `chainIdForDomain` / `domainForChainId` re-export at `CrossChainDemoClient.tsx:572`
- Lines 41–42 already import them locally; line 572 re-exports them via `export { … }`. No external module reads from `CrossChainDemoClient` for these.
- The originals in `lib/crossChain/config.ts:128, 132` are heavily used (tests, gateway.ts, router.ts, hooks, pathEnumerator). Comment on L571 says "Re-export for completeness".
- Verdict: delete L571–L572 only; keep the originals.

### M4: `COPIED_FEEDBACK_MS` in `hooks/useCopyToClipboard.ts:5`
- Used as default arg `feedbackMs: number = COPIED_FEEDBACK_MS` on L12. No external caller imports the constant.
- Verdict: downgrade `export const` → `const`.

### M5: `enumeratorDomainForChainId` at `lib/crossChain/pathEnumerator.ts:217`
- Re-export with comment "上流 (router.ts の selectPath) と整合性を保つための helper export…将来 router.ts と enumerator を統合する余地" (kept intentionally for future refactor). Zero current callers.
- Verdict: deletable, but author explicitly flagged as forward-looking. Leave a decision to maintainer.

### Unused types (12 entries) — all FALSE POSITIVES of `export type`
- `SimpleAccountClient`, `PayMode`, `SplitEntry`, `PaymentResult`, `PaymentFlow`, `BalanceQueryResponseEntry`, `CrossChainRole`, `ProgressCallback`, `SwitchChainFn`, `PaymentPath`, `ExecuteResult`, `LegalEntity` are all consumed **inside the same module** (function signatures, interface fields, `as Type[]` casts). knip treats "used only in defining module" as unused export.
- Verdict: optionally drop the `export` keyword (cosmetic). No symbol deletion. **`LegalEntity` is the one true exception** — `lib/legal.ts:29` defines `export type LegalEntity = typeof LEGAL_ENTITY;` and the type name appears nowhere else; demote or delete safely.

## Rejected (knip flagged, but actually live)

- **`eslint-config-next` (devDep)** — Used via `FlatCompat('next/core-web-vitals')` in `eslint.config.mjs:17`. knip can't resolve the implicit `next/core-web-vitals` package.
- **`@eslint/eslintrc` (unlisted)** — Direct import in `eslint.config.mjs:5`. Should be moved from peer/transitive into devDeps, but not deletable.
- **`@wagmi/core` (unlisted) — 4 hits** — Type-only imports (`GetWalletClientReturnType`, `ConnectErrorType`) in `lib/smartAccount/{mav2,metamask,simpleAccount}.ts` and `tests/components/ConnectButton.test.tsx`. Available transitively via `wagmi`; could be promoted to direct devDep but the imports are live.
- **`axios`, `@coinbase/cdp-sdk`, `@base-org/account`, `axios-retry` in `tests/lib/axios-override.test.ts`** — Intentional transitive-compat test (file comment lines 1-8). Override-pin guard for HIGH CVEs in axios <1.15.2.
- **`scripts/check-pimlico-balance.d.mts` / `scripts/setup-sentry-alerts.d.mts`** — `.d.ts` companions for the `.mjs` runtimes that vitest imports (`tests/scripts/check-pimlico-balance.test.ts:53`, `tests/scripts/setup-sentry-alerts.test.ts:1-216`). Provide type completion.
- **`scripts/verify-kaia-jpyc.mjs` / `verify-kaia-pimlico.mjs`** — Have vitest coverage (`tests/scripts/verify-kaia.test.ts:15-16`) AND are documented in `docs/DEPLOY_CHECKLIST.md` as deploy-gate runs.
- **`scripts/verify-ens-resolver.mjs`** — Documented in `CHANGELOG.md:18` as "deploy gate runnable smoke" for Basenames/ENS regression.
- **`scripts/verify-pimlico-usdc.mjs`** — Documented in `CHANGELOG.md:30` for multi-chain USDC paymaster quote audit.
- **`scripts/generate-icons.mjs`** — One-shot brand-asset regen tool (resizes `~/Desktop/openpay.png` → favicon/apple-touch/maskable). Operator tool; safer to keep.

## Recommended implementation order

1. **Drop `@vercel/speed-insights` from `package.json`** (and `package-lock.json` via `npm i`). Lowest-risk, removes one transitive tree.
2. **Delete `isBuyerOnlyChainSlug` (`lib/chains.ts:224-226`).** Single function, no callers; safe.
3. **Delete `LegalEntity` type (`lib/legal.ts:29`).** Zero references outside definition.
4. **Delete the cosmetic re-exports** (`CrossChainDemoClient.tsx:571-572`, `pathEnumerator.ts:214-217`). Optional but tidies the public surface.
5. **Optional**: demote `export` → local on the M1/M2/M4 constants and the 11 "used-internal-only" `export type` aliases — purely a public-API tightening, zero runtime impact. Do this in one PR scoped to "tighten module boundaries".
6. **Do NOT touch** anything in `scripts/` and do NOT touch transitive-compat tests (`axios-override.test.ts`) or anything related to `@wagmi/core` type imports.
