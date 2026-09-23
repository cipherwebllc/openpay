# PR 10 / C3 implementation and review follow-up

Status: uncommitted worktree edits; no commit, push, branch creation, or build.

## PR description draft

IPv6 address rotation within one /64 previously bypassed each full-address HMAC limiter. Add `hashIpBucket` for IPv4 /32 and IPv6 /64, normalizing IPv4-mapped IPv6 before masking and supporting compressed forms and direct callers with zone IDs. Reuse the existing HMAC, domain separator, secret policy, and client-IP trust logic.

Migrate non-money full-address limiters: SIWE nonce/verify, tip messages, agent purchases/activity, payment logging, discovery/resource management, free directory/shops, creator-store management, and read-only license APIs. Keep existing limiter prefixes, windows, and rejection behavior. IPv4 HMAC keys remain identical; affected IPv6 counters reset once at deployment, harmlessly.

Handle availability and push subscribe/test retain their existing `anonymizeIp` keys (IPv4 /24, IPv6 /64), independently of `IP_HASH_SECRET`. These routes were already protected against within-/64 rotation. Their counters do not reset in this PR. Admin/billing has no existing IP limiter in this checkout; adding one is separate C5 work.

## Independent review disposition

1. **Fixed (should-fix):** restore handle availability and push subscribe/test exactly to their pre-change source; remove their four route-table entries and four fallback cases, plus unused test setup.
2. **Fixed locally (nit):** this report supplies PR description text and the explicit PR 10b checklist below. No PR was published and no report or plan outside the writable worktree was edited. The deferred list is also included in the final reply for the orchestrator.
3. **Fixed (nit):** document that zone-ID support is for direct `hashIpBucket` callers; `clientIp` continues to reject scoped addresses.
4. **Fixed (nit):** document that legitimate users in the same /64 share the payment-log limit of 60/minute, analogous to IPv4 NAT.

## PR 10b tracking: money limiters still using native IPv6 /128

All items remain pending and intentionally unchanged. Migration requires a separate money-route change and explicit human review under rule 15; preserve payment control flow under rule 12.

- [ ] `relay-admission`: `app/api/relay/jpyc/route.ts`.
- [ ] `relay-status`: `app/api/relay/jpyc/status/route.ts`.
- [ ] `relay-admission`: `app/api/csv-pass/relay/route.ts`.
- [ ] `relay-admission`: `app/api/facilitator/settle/route.ts`.
- [ ] `x402-dual-rail`: `lib/x402/dualRailRelay.ts`, serving `app/api/x402/relay/requirements/route.ts`, `app/api/x402/relay/verify/route.ts`, and `app/api/x402/relay/settle/route.ts`.
- [ ] `shops-paid`: `guardPaidShopsApi` in `app/api/shops/_shared.ts`, used by `app/api/paid/jpyc-shops/search/route.ts`.
- [ ] Hosted JPYC purchase/quote IP key: `app/api/paid/hosted/[id]/route.ts`, passed into `checkPurchaseQuoteRateLimit`.
- [ ] Hosted USDC purchase/quote IP key: `lib/x402/hostedUsdcPaidRoute.ts`, used by the hosted paid route and passed into `checkPurchaseQuoteRateLimit`.
- [ ] `x402-status`: `lib/x402/facilitatorStatusRateLimit.ts`, used by `app/api/facilitator/status/route.ts`, `app/api/store/purchase/status/route.ts`, `app/api/agent-order/pay/route.ts`, and `app/api/paid/_shared.ts`.
- [ ] `order-call`: `app/api/order/call/route.ts`.
- [ ] `register-claim`: `app/api/register/claim/route.ts`.

Order notify/admission/status and facilitator verify/verify-receipt already use `anonymizeIp` with IPv6 /64. They remain unchanged and are not unresolved /128 cases.

## Regression coverage

- `tests/lib/ipHash.test.ts`: /32 and /64 table cases, compressed and mapped forms, zone IDs, invalid input, missing/short secrets, and retained `hashIp` /128 behavior.
- `tests/app/api/ip-bucket-keys.test.ts`: exact real-HMAC keys through trusted Cloudflare client-IP selection for the remaining migrated route families and store scopes, including agent daily windows and the unchanged paid-shops /128 guard.
- `tests/app/api/log-payment.test.ts`: same-/64 sharing, different-/64 separation, and unchanged missing-secret fallback.
- Existing handle and push suites retain their original prefix-key checks.

## Validation

- `npm run typecheck`: passed, exit 0, no errors.
- `npx eslint --no-warn-ignored <files>`: passed, exit 0, no errors or warnings. Covers all 29 changed TypeScript files and the three restored routes. The Markdown report is also submitted but has no ESLint configuration.
- `npx vitest run --no-cache` (full suite): **587 files passed, 0 failed; 12,520 tests passed, 0 failed**. First follow-up run passed; no retries or worker overrides were needed.
- The bucket-key test file now has 33 passing cases. The full-suite count decreased by eight solely because the four handle/push bucket cases and their four fallback cases were removed as directed.
- `git diff --check`: passed.
- Audited all 11 retained /128 caller sites against this checklist and against HEAD; their limiter code is unchanged. The three reverted routes match HEAD exactly. Original `hashIp` and `clientIp` code is unchanged.
- No new dependencies, build, commits, pushes, or real-wallet/keystore access.

## Changed files (30)

```text
app/api/auth/siwe/nonce/route.ts
app/api/auth/siwe/verify/route.ts
app/api/directory/_shared.ts
app/api/discovery/[id]/route.ts
app/api/facilitator/resources/[id]/route.ts
app/api/facilitator/resources/route.ts
app/api/license/products/[id]/route.ts
app/api/license/verify/route.ts
app/api/log/payment/route.ts
app/api/shops/_shared.ts
app/api/store/_shared.ts
app/api/tip-messages/route.ts
lib/agent/activityRateLimit.ts
lib/agent/purchasesRateLimit.ts
lib/net/ipHash.ts
r6-c3-ipv6-bucket-result.md
tests/app/api/directory.test.ts
tests/app/api/ip-bucket-keys.test.ts
tests/app/api/license/products.test.ts
tests/app/api/license/verify.test.ts
tests/app/api/log-payment.test.ts
tests/app/api/shops.test.ts
tests/app/api/store-content-characterization.test.ts
tests/app/api/store-delivery-metadata.test.ts
tests/app/api/store-delivery.test.ts
tests/app/api/store-entitlements.test.ts
tests/app/api/store-products-license-terms.test.ts
tests/app/api/store-products.test.ts
tests/app/api/tip-messages.test.ts
tests/lib/ipHash.test.ts
```
