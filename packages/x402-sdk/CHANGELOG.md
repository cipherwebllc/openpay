# Changelog

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
