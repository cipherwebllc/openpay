# Changelog

## 0.9.0

- Add keyless `find_shops` to both profiles. It calls the free
  `/api/shops/find` endpoint and points agents to `order_menu(handle)` and
  `createOrderLink` for the next steps.
- Add x402-only `search_shops` for the paid 2 JPYC detailed Shops search. It
  delegates to the existing `x402_pay` challenge, money-guard, signing, and
  unlock flow; `maxTotalJpyc` remains mandatory.
- Preserve each of the previous seven public tool definitions byte-for-byte and
  append the two new tools. The order profile now exposes 4 tools and the x402
  profile exposes 9.

## 0.8.0

- Add an `openpay-order-mcp` binary for the keyless, human-pays order profile. It
  exposes only `order_menu`, `order_summary`, and `createOrderLink`.
- Keep `openpay-x402-mcp` as the backward-compatible full seven-tool profile,
  with unchanged tool order, descriptions, schemas, payment guards, and signing
  behavior.
- Reject calls to known tools outside the active profile before fetching or
  signing (`tool_not_in_profile`).

## 0.7.2

- Docs: add a "Quickstart: buy a JPYC resource" section — a concrete
  `discovery_search` → `x402_quote` → `x402_pay` walkthrough for the headline
  "local MCP buyer for JPYC resources" use case, using the live catalog `demo`
  resource. No code change.

## 0.7.1

- Strengthen tool-selection steering (descriptions only; no behavior change):
  make `order_summary` the explicit DEFAULT for any "how much / quote / estimate /
  見積もり" question about a mobile order a **person** will pay (returns the subtotal
  the customer actually pays — no buyer upcharge), and make `order_quote` lead with
  a ⚠️ "do NOT use to estimate what a person pays" and clarify it is only for the
  rare agent-auto-pay (x402, buyer covers the fee, subject to guards). Fixes AI
  clients defaulting to `order_quote` (x402 buyer-upcharge + MAX_PER_CALL guards)
  when a human simply wants a quote.

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
