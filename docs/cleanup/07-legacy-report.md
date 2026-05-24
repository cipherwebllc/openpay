# Legacy / Deprecated Code Audit (Task 7/8)

## Summary
- TODO/FIXME/HACK comments in source: **0** (zero)
- `@deprecated` JSDoc tags: **0**
- `*Legacy`/`*Old`/`*V1` named functions where newer exists: **0**
- Identified legacy code blocks: **5** (all small, scoped, well-documented)
- High-confidence removable: **0**
- Medium-confidence (deferred decisions): **3**
- Cleanup-grade tidies (cosmetic, optional): **2**

The OpenPay codebase is unusually clean of legacy markers. Repo-wide search for `TODO|FIXME|HACK|XXX|DEPRECATED|@deprecated` across `lib/ components/ app/ hooks/ scripts/ tests/ e2e/` returns **zero hits**. No `*Legacy` / `*Old` / `*V1` function-name suffixes exist. No `if (process.env.OLD_FOO)` style retired feature-flag branches.

## High-confidence findings (safe to remove)
None. Every "legacy" comment we found is either (a) live backwards-compat for already-printed merchant QR codes, (b) a documented migration scaffold for future schema versions, or (c) an explicit "remove when X" instruction tied to a still-pending product gate.

## Medium-confidence (need product decision, not code judgement)

### M1: `mode=direct` legacy alias in URL parser
- File: `/Users/masia02/openpay/lib/url.ts:295-308` and `:805-808` and header comment `:9-11`
- Status: 2 parse sites + 1 doc. Renamed `direct` → `standard` in PR `9cbafd9` (2026-05-16, 8 days old). Alias normalises old `mode=direct` (fee=0) into the new `mode=standard` (fee=0.5%) so already-printed QR posters keep working.
- Verification: `git blame` shows lines authored 2026-05-16. Only 8 days in production.
- Recommendation: **KEEP for at least 6 months** after rename (until ~2026-11). Removing now will silently break any merchant who printed a `mode=direct` poster between MVP and 2026-05-16. Reassess in Q4 2026 once history/Sentry can confirm zero `mode=direct` query strings have arrived for 90 days.

### M2: `AlphaNotice` banner component
- File: `/Users/masia02/openpay/components/AlphaNotice.tsx` (35 lines) + `messages/{ja,en}.json` `AlphaNotice` namespace (~5 keys each) + `tests/components/AlphaNotice.test.tsx`.
- Status: Header comment lines 1-5 explicitly documents the removal procedure ("本番運用が安定したら本 component ごと削除する想定"). Per memory `project_strategic_direction`, OpenPay is still in alpha / demand-validation phase, so the banner remains accurate.
- Recommendation: **KEEP until product exits alpha**. The removal instructions exist precisely because the author expects to eventually delete it; not a code-quality issue.

### M3: Phase 1 / Phase 2 phase markers in comments
- Files containing dated phase markers (informational only, code is current):
  - `/Users/masia02/openpay/lib/smartAccount/mav2.ts:14,94` ("phase 1 では sponsorship のみ、USDC ERC20 + MAv2 は未検証")
  - `/Users/masia02/openpay/lib/scan/parseScannedUrl.ts:7,76` ("EIP-681 は Phase 1 では reject、Phase 2 で in-wallet 遷移検討")
  - `/Users/masia02/openpay/lib/x402/types.ts:6-7` ("Phase 1 USDC base、Phase 2 JPYC polygon")
  - `/Users/masia02/openpay/lib/history.ts:69,118,177,190,203` (Phase 2 schemaVersion migration scaffold — heavily tested)
  - `/Users/masia02/openpay/components/{PaymentForm,CheckoutForm}.tsx:235,291,511` ("ローカル履歴 Phase 2")
  - `/Users/masia02/openpay/app/api/log/payment/{route,stats/route}.ts` ("phase 2 cross-chain bridge fields")
- Verdict: These are **labels for active code, not vestigial branches**. The MAv2 `if (paymasterMode === 'erc20') throw` is real production behaviour for HashPort users today; the EIP-681 reject is the live scanner contract. No dead branches gated on "phase 1 only".
- Recommendation: **Leave**. Optionally a future maintainer can scrub phase labels into a `CHANGELOG` reference, but it has zero runtime impact.

## Cleanup-grade tidies (cosmetic, optional)

### C1: `lib/crossChain/types.ts:10` Solana planning comment
- The single line `// (phase 4b-2 で追加予定: solana=5)` is left over from when Solana was on the roadmap.
- Per memory `project_cross_chain_phase4_status` Solana phase 4b-2 is **shelved** (Circle Forwarding Tier B no-go).
- Recommendation: Either rewrite to "Solana=5 is reserved by Circle but shelved (see docs/research/...)" or delete. Pure documentation hygiene. **Leave the constant array alone** — it correctly omits Solana.

### C2: `MIGRATIONS` empty object in history.ts
- File: `/Users/masia02/openpay/lib/history.ts:181` (`export const MIGRATIONS: Record<number, MigrationFn> = {};`)
- Empty by design — single v1 schema currently. Comments at L168-181 explain the contract for future v2 migrations.
- Recommendation: **Keep**. This is an extension seam with full test coverage, not dead code. Removing it would force a refactor when a v2 lands.

## Rejected (looks legacy but is live)

- **`OnrampCta` component** — Live fallback CTA shown in PaymentForm / CheckoutForm / TipForm when buyer wallet has no balance. Not legacy.
- **`useBatchPayment` hook** — Present-day gasless code path used by all 3 form components.
- **Pimlico SimpleAccount path** (`lib/smartAccount/simpleAccount.ts`) — Still the default for non-MAv2 / non-MetaMask wallets (per memory `project_hashport_target`).
- **MAv2 + Kaia hard-reject in `lib/smartAccount/mav2.ts:83-92`** — Defensive guard; Sentry telemetry signal for future demand assessment.
- **`mode=standard` parser branch** — Live fallback for gasless-incompatible wallets (per task brief: do not remove).
- **All Solana mentions** — Only the single comment in `lib/crossChain/types.ts:10`. No `lib/solana/` directory, no stub files (per task brief Solana stubs were expected; none exist to revive).
- **`/experimental/cross-chain-demo` route** — Live, env-gated (`NEXT_PUBLIC_EXPERIMENTAL_CROSS_CHAIN_ENABLED`), 404s in production by default. Comments at `app/[locale]/experimental/cross-chain-demo/page.tsx:1-10` describe its isolation regime. Last touched in the current Phase 4 work.
- **`X402_TEST_MODE` bypass** in `lib/x402/middleware.ts:27` — Live dev affordance, guarded by `NODE_ENV=production` throw in config.
- **`CCTP_FINALITY_STANDARD = 2000`** — Looks like "old slow path" but Circle officially exposes it; CCTP V2 supports both Fast (1000) and Standard (2000) finality thresholds. Code defaults to Fast; Standard is selectable per-tx.
- **`history.ts` unversioned → v1 stamp** at L203 — Live data-rescue for users whose LocalStorage entries predate `schemaVersion`. Tested in `tests/lib/history.test.ts:「unversioned legacy 読込」`.
- **`storage.ts` `fallback` parameter** — Generic LocalStorage helper, not a legacy code path.
- **`pimlico.ts` / `mav2.ts` "silent fallback 禁止" comments** — Author's intent annotations on security-critical throws. Not legacy.

## TODO/FIXME inventory
**Empty.** Repo contains literally zero TODO / FIXME / HACK / XXX / DEPRECATED markers in source files (only package-lock.json has noise). This is unusually disciplined.

## Recommended implementation order
Nothing actionable beyond optional doc hygiene. The single suggestion if you want one PR:

1. **C1 (optional, 1-line cosmetic)**: Rewrite or delete the Solana comment in `lib/crossChain/types.ts:10`. Net change ≈ 1 line. No test impact, no behaviour change.

Everything else should remain. The "legacy alias" patterns in `lib/url.ts` are doing their job — protecting printed QR posters from breaking — and the comments saying "remove later" (AlphaNotice, mode=direct) are correctly waiting on still-pending business gates (exit-alpha, 6-month-no-traffic-confirmation), not on engineer attention.
