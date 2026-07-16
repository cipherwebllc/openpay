# Changelog

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
