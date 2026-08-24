# Changelog

## Unreleased (0.6.0 予定 — publish 時に version bump + x402-mcp の依存追従を同一 PR で行う)

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
