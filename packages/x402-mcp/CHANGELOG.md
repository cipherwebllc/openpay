# Changelog

## 0.7.0

- Add `order_summary` tool: for the **human-pays** flow (the customer pays from
  their own wallet), return the amount the customer actually pays — the subtotal,
  with the shop covering the ~1% service fee (store-borne). No key needed.
  - Pair it with `createOrderLink` for the "my AI plans the order, I pay by hand"
    (BYOW) handoff: `order_menu` → pick items → `order_summary` (tell the customer
    the exact amount) → `createOrderLink` (the link they open and pay).
  - Reads a new read-only server endpoint `GET /api/agent-order/summary`. **No
    payment is ever made.** Unlike `order_quote` (x402, buyer covers the fee on top
    of the subtotal, with a 1 JPYC floor), `order_summary` reports the store-borne
    checkout amount (no floor) so the human-pays and auto-pays models are no longer
    conflated.
- Clarify tool descriptions: `order_quote` / `x402_pay` are **only** for when the
  agent itself holds a funded key and auto-pays (x402); for human-pays, use
  `order_summary` + `createOrderLink`. `order_menu` / `order_summary` /
  `createOrderLink` need no key.

## 0.6.0

- Add `createOrderLink` tool: build a human-facing checkout link
  (`${origin}/@<handle>?cart=<base64url>[&table][&pickupAt]`) for an OpenPay
  `@handle` shop's mobile order. Wallet-optional (no key needed) — the traveler
  opens the link and pays from their own wallet. This is the "my AI plans the
  order, I pay by hand" (BYOW) handoff for inbound/travel use.
  - The link only carries `{id, qty, options}`; the shop's receiving address and
    prices are re-resolved server-side from the `@handle` record, so menu text can
    never change the destination or amount, and no self-contained receiver token is
    ever emitted (no `/order?s=` handoff).
  - Cart serialization uses the same `base64url(JSON [{id,qty,options}])` format as
    `order_quote` and the server's `lib/agentOrder.encodeAgentCart` (single source of
    truth; a repo fence test guards against drift).
- Internal: extract the shared `normalizeCartItems` validator used by both
  `order_quote` and `createOrderLink` (no behavior change to `order_quote`).

## 0.5.3

- Prior release (order_menu / order_quote agent-order tools, x402 discovery / quote / pay,
  Steward and env-key signer modes).
