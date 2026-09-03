# Changelog

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
