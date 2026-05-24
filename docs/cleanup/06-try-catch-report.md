# Defensive Programming Audit (Task 6/8)

## Summary
- Total `try {` blocks (app/lib/hooks/components): **19**
- Total `catch` occurrences (incl. inline `.catch()`): **25**
- Legitimately defensive (keep): **19**
- Bad defensive pattern (remove/fix): **0 high-confidence**, **0 medium-confidence**

Conclusion: OpenPay's defensive code surface is **disciplined and small**. Every single try-catch I inspected has a clear, documented purpose tied to an actual failure mode (RPC flake, untrusted JSON, browser API, network fetch, dynamic import, SSR window absence). Several blocks even carry inline comments explaining *why* the swallow is intentional. There is nothing in the high-confidence "remove this" bucket.

## High-confidence findings (safe to remove)

**None.**

## Medium-confidence (need human review)

**None.**

Two patterns were close to being flagged but on inspection are correct:

- `hooks/useCrossChainPayment.ts:278-299` — `safeExecute` / `safeExecuteOption` catch-and-rethrow. Looks pointless at first, but the comment (l.276-277) explains it: ensures `setError()` + `setIsExecuting(false)` run before rethrow so UI state is consistent regardless of where caller's own catch lives. Keep.
- `components/CrossChainHint.tsx:172-176` — bare `catch { return; }` around `hook.executeOption(selectedOption)`. Looks like a swallow, but the upstream `safeExecuteOption` (above) has already set `error` state + logged. The UI just needs to bail out of the success branch without re-handling. Keep — but a one-line comment `// (error already surfaced via hook.error state)` would be a nice future addition (not a cleanup blocker).

## Categorically kept (don't suggest removing)

All of the following are correctly defensive and out of scope for removal:

| File:Line | Purpose |
|---|---|
| `app/api/log/payment/route.ts:106-110` | `req.json()` of untrusted body — must return 400, not 500 |
| `app/api/log/payment/export/route.ts:51-55` | JSON.parse of historical KV entries; bad rows tagged `_parseError` (observable, not swallowed) |
| `app/api/log/payment/stats/route.ts:389-394` | JSON.parse of KV entries during aggregation; parse-error count surfaced separately (commented rationale l.383-385) |
| `lib/paymentLog.ts:124-140` | client-side fetch to `/api/log/payment` with `keepalive`; fires `PAYMENT_LOG_FAILURE_EVENT` CustomEvent so failure is *observable*, not swallowed |
| `lib/accountDetection.ts:58-62` | `getAddress()` parse of bytecode-derived hex; malformed delegate → `unknown` (correct product semantics for 7702 detection) |
| `lib/storage.ts:5-24` | localStorage in Safari ITP / private mode throws — documented at top of file |
| `lib/url.ts:681-685` | `decodeURIComponent` of untrusted query — must return `null` for caller's "invalid checkout link" path |
| `lib/kv.ts:29-45, 49-61` | Upstash REST fetch + JSON parse; returns typed `KvErr` (no silent fallback) |
| `lib/x402/middleware.ts:53-68` | x402 facilitator unreachable → 503; matches HTTP error contract for paid routes |
| `hooks/useCrossChainPayment.ts:278-299` | wrapper that guarantees `setError + setIsExecuting(false)` before rethrow (see above) |
| `hooks/useQrScanner.ts:96-101` | dynamic import of `qr-scanner` chunk — must classify into UI state, otherwise infinite spinner (commented l.93-94) |
| `hooks/useQrScanner.ts:105-110` | `QrScanner.hasCamera()` MediaDevices API — classify into UI state |
| `components/CrossChainHint.tsx:172-176` | bail out of success branch; error already surfaced via hook state (see above) |
| `components/TipForm.tsx:190-195` | webhook POST `.catch` → `logger.warn`; webhook is best-effort post-payment side effect |
| `components/CheckoutForm.tsx:260-265` | same pattern for checkout webhook |
| `components/QrScannerSurface.tsx:43` | `navigator.clipboard.readText()` denied in non-HTTPS / no-permission → empty input (correct, documented l.40-41) |

Also worth highlighting (positive observation):
- `lib/crossChain/execute.ts:2` has a top-of-file comment `// fail-fast (try/catch なし)、caller (useCrossChainPayment) が error state に` — the team is *deliberately* not adding defensive code at boundaries where fail-fast is correct. This is the hallmark of a healthy defensive-code culture.
- `lib/url.ts:420` comment `URL.canParse を使うので try/catch 不要。` — same discipline.
- `lib/history.ts` uses pure type-guard validation (`isValidEntry`) instead of try-catching, which is the right pattern.

## Recommended implementation order

**No code changes recommended for this task.**

The audit's value is the *negative result*: confirming that OpenPay's 19 try-catch blocks are all justified. Future contributors can use the table above as the canonical list of expected defensive boundaries; anything new beyond this set should require a comment explaining why.

Optional cosmetic improvement (low priority, not for this cleanup pass):
- Add a one-line `// (error already surfaced via hook.error)` to `components/CrossChainHint.tsx:174` so the bare `catch { return; }` is self-documenting like the rest of the codebase.
