# Private R2 delivery gate (SDK 0.8.0 initial generation)

This template verifies an OpenPay 60-second bearer ticket before accessing R2.
It uses `openpay-x402-sdk/delivery`, standard WebCrypto `Ed25519`, and no Node
compatibility flag. Package source/tests are not a real Workers deployment proof.

1. Use the reviewed 0.8.0 package artifact in a seller project; it is not assumed
   published. After publication, the dependency can be installed from the official
   npm registry. Copy `worker.mjs` and `wrangler.toml` together.
2. Create a **private** R2 bucket, upload each immutable revision, and replace
   `bucket_name`. Disable public r2.dev access and public bucket custom domains.
   Remove any old unsigned object URL; ordinary product content should contain
   instructions or a safe landing page, not a file bypass.
3. Configure the variables below and bind the worker's public HTTPS hostname.
   Set that stable gate URL as the OpenPay product's delivery destination.
4. For single-use admission, uncomment both `REPLAY` and its SQLite migration in
   `wrangler.toml`. Deploy through your reviewed release process. The compatibility
   date is pinned to `2026-09-09`; test that date on a real Worker before adoption.

| Setting | Meaning |
| --- | --- |
| `OPENPAY_PRODUCT_ID` | Exact `h_` + 32 lowercase hex product ID; never request-controlled. |
| `AUDIENCE` | Worker's public HTTPS origin, e.g. `https://files.example`; must equal the configured destination's origin. |
| `OBJECT_KEYS` | Optional JSON revision map, e.g. `{ "1": "file-v1.zip" }`. Default is exactly that map. Every unmapped revision is denied, with no latest-version fallback. |
| `FILES` | R2 binding to the private bucket. |
| `REPLAY` | Optional private Durable Object binding, one object per product/audience/jti. |

`ready()` runs at isolate startup on its first request (network I/O is unavailable
at module evaluation), before any file access. Failed startup denies and can
retry. All GET/HEAD/Range/conditional requests authenticate first. This deliberately
small template ignores Range and conditional headers: GET sends full content with
200, HEAD sends metadata only. Add resumable/conditional responses only behind the
same gate. No Cache API is consulted. All responses use `private, no-store`,
`no-referrer`, and `Content-Disposition: attachment`; failures are generic 403 JSON.

The Durable Object uses `blockConcurrencyWhile` around storage read/put/alarm,
so simultaneous consumes cannot both succeed; an alarm removes state at expiry.
Storage or alarm failures deny admission. **Workers KV is NOT equivalent** to
atomic consume. Omit `REPLAY` only if replay during the ticket's TTL is acceptable.
A consumed ticket stays consumed after R2 failure. HEAD consumes it too: acquire
another ticket for GET, retries, ranges or restarts. A stream admitted before
expiry may finish after expiry; the SDK does not cut it off at 60 seconds.

`sub` is the issuance session's wallet, not proof of the presenter's identity.
The token is readable and bearer-authorized, not DRM. Suppress or redact query
strings, Authorization, Location and ticket-bearing errors throughout seller/CDN
logs. `no-referrer` does not remove browser history or already stored logs.

Release acceptance must run a private R2 end-to-end download on the pinned Worker:
valid/expired/wrong-product/unmapped-revision tickets; missing/duplicate/conflicting
credentials; HEAD/Range/conditional access; simultaneous replay (exactly one
success); storage/downstream failure; and no unsigned/public/cache bypass. Run a
cold-JWKS request and staged key rotation too. These are deployment checks, not
claims established by mocked package tests. See the [SDK delivery documentation](../../README.md#保護配布-delivery-ticket)
for cache/rotation and runtime boundaries. The [Node example](../node-delivery-gate.mjs)
uses the same env names and map, but its seller presigning stub must be implemented;
the storage signature's absolute deadline must be at most the ticket's `exp`.

References: [standard WebCrypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/),
[Durable Object event isolation](https://developers.cloudflare.com/durable-objects/api/state/),
[alarms](https://developers.cloudflare.com/durable-objects/api/alarms/),
[Workers KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/).
