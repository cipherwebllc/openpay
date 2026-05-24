# Comments / AI Slop Audit (Task 8/8)

## Summary
- TS/TSX files scanned: 108 (app, lib, hooks, components)
- Single-line `//` comments: 1,716
- JSDoc blocks (`/**`): 94 across all files (top: `lib/history.ts`=16, `lib/crossChain/gateway.ts`=15)
- Comments flagged for removal: **0**
- Comments flagged for rewrite: **2** (minor — see below)
- Stubs / LARP / dead `console.log`: **0**

**Headline finding:** This codebase is unusually clean. Searches for `TODO`, `FIXME`, `XXX`, `HACK`, `not implemented`, `// generated`, `// auto-`, `for now`, `temporarily`, `quick fix`, `kludge`, `mock`, `stub`, `fake`, `dummy`, `// changed from`, `// previously`, `// removed`, `// was `, `// (fix|update|add)\(#`, commented-out code, commented-out console/debugger — **all returned zero results** in `app/`, `lib/`, `hooks/`, `components/`. Stratified sampling of 50 random `//` comments confirms every comment carries explanatory WHY content (constraints, business rules, security reasoning, external bug references, schema-migration policy, gas-fee math). The codebase looks deliberately curated — likely human-authored or reviewed and not LLM slop.

## High-confidence removals
None. No candidates found across all four pattern categories.

### Group 1: replacement-narration comments
None.

### Group 2: WHAT-restating comments
None. Every sampled comment explains constraints, invariants, or external context (e.g. `lib/paymentLog.ts:96-99` "二段構えで audit dropout を観測… production console を汚さず開発者が観測"; `app/api/log/payment/route.ts:48` "許可リスト方式 — raw cast で未知 field が後段の spread 経由で KV に流入するのを防ぐ").

### Group 3: stale TODO/FIXME (6+ mo with no movement)
None. Zero `TODO`/`FIXME`/`XXX`/`HACK` occurrences in scanned dirs.

### Group 4: stubs / dead console.log
None. Only `console.*` calls outside tests:
- `/Users/masia02/openpay/lib/logger.ts:67-71` — `console.error / console.warn / console.log` are the logger's own sinks (legitimate, this **is** the logger).
- `/Users/masia02/openpay/lib/env.ts:28, 42` — `console.warn` for env-validation fallbacks; legitimate boot-time signal before logger is configured.

No `throw new Error("not implemented")`, no empty placeholder branches, no mock data in production code (only inside `e2e/`, `__tests__/`, `tests/` — outside scope).

## Rewrites (keep but tighten)

### Item 1: `/Users/masia02/openpay/components/CheckoutForm.tsx:334`
- Current: `// eslint-disable-next-line react-hooks/exhaustive-deps`
- Proposed: `// eslint-disable-next-line react-hooks/exhaustive-deps -- timer effect intentionally re-runs only on countdown tick, not on setRedirectIn identity`
- Why: Audit rule keeps `eslint-disable` directives but asks for a reason. This is the **only** `eslint-disable` in the entire scanned tree and currently has no inline rationale.

### Item 2: `/Users/masia02/openpay/components/StepCard.tsx:5,10` and `/Users/masia02/openpay/components/SiteFooter.tsx:65`
- Current: Lines reference `review (2026-05-23) §2`, `§後追い`, `#15 対応` as the rationale for design choices.
- Proposed: Keep the design rationale, drop the review-ref suffix once changes are settled (e.g. `// Step 3 (QR 表示) を他より目立たせる brand border。` without the `review (2026-05-23) §2「…」対応` tail).
- Why: Borderline — these are essentially "fix for #X" replacement-narration, but the prose preceding them does state the WHY. Recommend trimming after one or two more weeks of stability. Same applies to the two `(Codex audit 2026-05-23)` parenthetical refs in `/Users/masia02/openpay/app/api/log/payment/stats/route.ts:5` and `:429` — the rationale is fully explained; the audit attribution can be dropped once the change is no longer load-bearing context.

These are **soft suggestions**, not slop. Leaving them in place is also defensible.

## Categorically kept

- **Section banners** in `/Users/masia02/openpay/lib/url.ts:393-395` (`// /tip helpers`) and `:581-583` (`// /checkout helpers`) — load-bearing in a 900-line file with multiple URL grammars.
- **Banners** in `/Users/masia02/openpay/app/[locale]/experimental/cross-chain-demo/CrossChainDemoClient.tsx:90,198,323,523` (`// ----- BalancesPanel -----` etc.) — file is 570 lines with four sibling sub-components; banners materially aid navigation.
- **Empty `//` lines (89 occurrences)** — all are paragraph separators inside multi-line block comments (e.g. `lib/history.ts:64`, `app/api/log/payment/stats/route.ts:13`). Removing them would collapse readable paragraphs into walls of text.
- **All JSDoc** (`/**` blocks) is on exported API or load-bearing types (`MigrationFn`, `MIGRATIONS`, `migrateToLatest`, `TipParams`, chain registries). None is over-documented on trivial internal helpers.
- **`@`-marker comments** at `/Users/masia02/openpay/lib/logger.ts:6` and `/Users/masia02/openpay/hooks/useSmartAccount.ts:115` are package-name references inside prose (`@sentry/nextjs`, `@metamask/delegation-toolkit`), not directives — keep.
- **Date-stamped comments** (`2026-05-XX`) explain why a fee constant, gas ceiling, or token-rate snapshot is what it is. They are evidence-anchored business-rule comments, not in-flight progress notes.
- **`legacy` / `phase 2` references** in `lib/history.ts:203`, `lib/url.ts:295,805`, `app/api/log/payment/route.ts:30` etc. all explain backward-compat invariants for already-shipped QR/LocalStorage entries — keep.
- **The audit disclosure header** at `/Users/masia02/openpay/app/api/log/payment/stats/route.ts:5-12` (`⚠️ 重要なデータ信頼性 disclosure`) — high-value security/data-integrity comment at a trust boundary; explicitly the kind of comment the audit rules say to preserve.

## Recommended implementation order
1. **Item 1** (add reason to `CheckoutForm.tsx:334` eslint-disable) — 2-line trivial, raises lint quality and matches the project's convention used everywhere else (zero other disables exist). Do this first.
2. **Item 2** — optional cleanup of `(2026-05-23)` review-attribution suffixes once the referenced changes have been stable for ~30 days. No urgency.
3. **No bulk cleanup pass required.** Recommend instead adding a CI guard (e.g. a lightweight `grep` in `scripts/`) that fails the build if new `TODO`/`FIXME`/`console.log` appear outside tests, to preserve the current excellent state going forward.

## Files referenced
- `/Users/masia02/openpay/components/CheckoutForm.tsx`
- `/Users/masia02/openpay/components/StepCard.tsx`
- `/Users/masia02/openpay/components/SiteFooter.tsx`
- `/Users/masia02/openpay/app/api/log/payment/stats/route.ts`
- `/Users/masia02/openpay/lib/logger.ts`
- `/Users/masia02/openpay/lib/env.ts`
- `/Users/masia02/openpay/lib/url.ts`
- `/Users/masia02/openpay/lib/history.ts`
- `/Users/masia02/openpay/lib/paymentLog.ts`
- `/Users/masia02/openpay/app/[locale]/experimental/cross-chain-demo/CrossChainDemoClient.tsx`
