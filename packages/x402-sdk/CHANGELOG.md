# Changelog

## 0.8.1

- Fix `openpay-x402-sdk/delivery` on Cloudflare Workers: the JWKS fetch called a
  detached `fetch`, which Workers reject with "Illegal invocation", so every ticket
  failed with `keys_unavailable`. Verified on a real Worker deployment (2026-09-10).
- Templates: send `Content-Disposition: attachment; filename="<object key>"` only on
  successful file responses. An error response carrying `attachment` made Chrome
  show ERR_INVALID_RESPONSE instead of the JSON body.

## 0.8.0

- Add the typed `openpay-x402-sdk/delivery` Web-API-only subpath: strict Ed25519
  delivery-ticket verification, request extraction, startup readiness and RFC 7638
  thumbprints. Preserve all root exports and dependencies.
- Bound JWKS fetches, enforce complete key-set validation, honor Age in a 300-second
  cache, share concurrent fetches, throttle unknown-kid refresh and reject stale
  trust. Supplied keys never fetch or automatically refresh.
- Add optional atomic replay consumption with fail-closed errors and final expiry
  rechecks; ship private R2/Durable Object and Node presigned-redirect templates.
- Cross-check shared fixtures and fresh server signatures, packed subpath imports,
  types, runtime capability failures, and template authorization boundaries.
- Document bearer/session-wallet semantics and the Node/Workers acceptance matrix.
  No dependencies added. Initial generation only: human review and real private R2
  deployment acceptance remain required before adoption; publication is separate.

## 0.7.1

- Add `resolveLicense({ product, origin?, fetch? })` for validated v1 product
  descriptors, HTTPS-only discovery, redirect rejection and token derivation checks.
- Let `hasLicense` and `createLicenseGate` accept a product ID in place of the
  explicit chain/contract/token tuple. Polygon/Amoy RPC remains optional.
- Discover gate identity at first challenge/verify or `await gate.ready()`, sharing
  concurrent discovery and caching the descriptor for the gate lifetime. Failed
  discovery can retry. Synchronous `check()` throws `not_ready` until initialized.
- Preserve explicit identity and synchronous session checks. Add `session.origin`
  to bind signatures to your service independently of descriptor discovery.
- Document integration with `LICENSE_PRODUCT_ID` and `LICENSE_SESSION_SECRET`.
  No new dependencies. This workspace release has not been published.

## 0.7.0

- Add `hasLicense` for standard ERC-1155 ownership with a required chain/contract/
  uint256 token identity, block-pinned reads, and typed RPC errors. Token IDs
  accept bigint or hex, never JS numbers.
- Add `verifyLicense` for the trusted HTTPS v1 status API, with schema and
  address/product identity validation. Preserve `entitled: null` as unknown and
  reject redirects; allow HTTP only on localhost/127.0.0.1.
- Add `createLicenseGate`: five-minute EIP-4361-style EOA challenges, atomic
  single-use nonces, on-chain ownership, and HMAC sessions bound to the service
  origin and full license identity. Default sessions last five minutes; support
  an injectable nonce store without adding other persistence.
- Add TypeScript declarations, mocked RPC/fetch and real-signature unit tests,
  and the entry-license + x402 pay-per-use README pattern. Keep existing exports'
  behavior and spend defaults unchanged; add no dependencies.
- Keep licenses standard ERC-1155; the ERC-8217 agent-binding format will be
  published later. This release does not implement binding metadata.

## 0.6.0

- Add `createDualGate` — a dual-rail seller gate that serves both JPYC (Polygon,
  OpenPay facilitator) and USDC (Base, standard x402 relayed via OpenPay to the
  CDP facilitator). USDC payments settle directly to the seller wallet with 0%
  OpenPay fee; if the USDC face cannot be fetched, the gate degrades to
  JPYC-only and never blocks JPYC payments.
- Add `createListingClient` — programmatic marketplace listing (register, list,
  update, deactivate) with built-in SIWE sign-in, so sellers and agents can
  publish listings without the web form. `register` requires an explicit
  `attested: true` (the SDK never attests on your behalf); set `usdc` to also
  appear on the x402 Bazaar after the first settled purchase.
- Return an explicit `settlement` field from `pay()`, because HTTP `200` only
  means the seller returned a body and is not evidence that the payment settled.
  `verified` means a receipt header was present and the facilitator signature
  bound it to this payment, `unverified` means a header was present but
  unsigned, malformed, forged, or mismatched, and `receipt_unavailable` means no
  header was returned or the facilitator signer could not be resolved. Treat
  anything but `verified` as not proven paid. `receipt` keeps its previous
  meaning and an unlocked response body is still never discarded.
- Take over a spend lock left behind by a killed process instead of failing
  budgeted payments forever. A lock whose last modification is older than
  `SPEND_LOCK_STALE_MS` (60s, now exported) is moved aside with an atomic
  `rename` — never `unlink` — and the mover re-inspects the moved file to prove
  it took the very lock it measured, so two processes that observe the same
  stale lock cannot both enter the critical section. A lock younger than the
  window is left alone, so a live holder is never displaced.
- Record the owning `pid` and `createdAt` in the lock file, name the lock path in
  a new `detail` on `{ ok: false, reason: 'unavailable' }`, and treat an
  already-absent lock at release time as a completed release. A custom `fsImpl`
  without `stat`/`rename` keeps the previous fail-closed behavior and now warns
  once instead of disabling the takeover silently.
- Resolve the target hostname before calling an injected custom `fetchImpl`, so a
  public name pointing at a private or link-local address is rejected before the
  custom transport runs. Connection-time rebinding protection still requires
  supplying `lookup`; a resolver failure does not block, since only the transport
  that opens the socket can re-validate the address it connects to.
- Require `DISCOVERY_URL` to be `https`, with plaintext `http` allowed only for
  `localhost` / `127.0.0.1`. The discovery origin is the authority for catalog
  trust — URLs it lists are payable without an `ALLOWED_HOSTS` entry — so a
  substitutable plaintext catalog could pass an attacker's resource off as
  reviewed. Both `readRuntimeConfig` and `parseClientOptions` enforce it.
- Declare the new surface in `index.d.ts` (`SETTLEMENT`, `SettlementStatus`,
  `PaymentResult.settlement`, `SPEND_LOCK_STALE_MS`, `SpendReservationResult.detail`,
  `fsImpl.stat`, `createDualGate`, `createListingClient` and their inputs) and
  document dual-rail selling, code-side listing, settlement truth, stale-lock
  takeover, and the custom-transport boundary in the README.

## 0.5.0

- Reserve session and daily capacity immediately before exposing a signed
  authorization. Non-2xx responses, timeouts, and connection failures retain
  the reservation; successful 2xx responses keep the existing confirmed-spend
  accounting.
- Make the file daily store cross-process atomic with an exclusive lock, reject
  UTC-crossing authorizations, and fail closed when a configured store is
  unavailable.
- Enforce host/catalog admission before target I/O, block private and rebinding
  destinations, require exact catalog URLs, stop redirects, and bound buyer
  requests with a timeout.
- Bind supported networks to the canonical JPYC v3 contract/domain, cap
  seller-declared authorization lifetimes, bind signature destinations to a
  known or catalog-reviewed forwarder, and locally reserve seller-gate
  authorizations across verify and settle without requiring facilitator tokens.
- Verify facilitator-signed payment receipts against the advertised signer and
  bind every money field and authorization nonce before returning them.

## 0.4.0

- Add an opt-in persistent daily buyer limit with UTC signer/date keys, file and
  injectable spend stores, quote-time visibility, and fail-closed reads.
- Record daily spend only after successful 2xx unlocks while isolating store
  write failures from already completed payment responses.

## 0.3.0

- Add `createJpycGate` for seller-side x402 gates backed by the OpenPay catalog,
  including five-minute `accepts` caching and request-specific resource URLs.
- Support both one-shot verify-to-settle handling and split verification followed
  by settlement after an expensive upstream operation succeeds.
- Use Edge-compatible UTF-8 base64 handling for payment and settlement headers.

## 0.2.1

- Compare `accept.resource` against the requested URL using decoded query
  canonicalization (ordered `URLSearchParams` pairs) instead of byte equality.
  Hosts such as Vercel/Next.js normalize `%20` to `+` before the app sees the
  request, which made honest sellers fail `resource_mismatch`. Distinct decoded
  values (`%2B`, double encoding, reordered or extra params) still mismatch.

## 0.2.0

- Trust query-string variants of a query-free catalog URL after the live
  challenge passes the same catalog money-field verification.
- Keep exact catalog URL matches, explicit host allowlisting, resource matching,
  and public API declarations unchanged.

## 0.1.0

- Add the ESM `createOpenPayClient` API for discovery, free shop lookup, quotes,
  guarded x402 payment, and immutable session snapshots.
- Add local private-key, seven-field Steward, and custom signer options with an
  exclusive startup contract.
- Export the payment, guard, signer, catalog, and serialized executor primitives
  with TypeScript declarations.
