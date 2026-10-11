# x402, API and agent payments

> The detailed API reference behind the [README](../README.md). Listing rules live in [LISTING_POLICY.md](./LISTING_POLICY.md).
> README の詳しい版です（x402・AI エージェント決済・API・料金表）。掲載ルールは [LISTING_POLICY.md](./LISTING_POLICY.md) にあります。

- [Pay-per-request APIs on Arc](#pay-per-request-apis-on-arc-x402--arc-の-usdc-で買える有料-api)
- [x402 / API / agent payments](#x402--api--agent-payments)
- [Japan Web3 Directory API](#japan-web3-directory-api)
- [JPYC Shops API](#jpyc-shops-api)

## Pay-per-request APIs on Arc (x402) · Arc の USDC で買える有料 API

Every USDC-priced API on open-pay.jp answers `402` with **two ways to pay the same price: USDC on Base, or USDC on [Arc](https://www.arc.io/)** (`eip155:5042`).
The Arc option settles through the **Circle Gateway x402 facilitator** (`GatewayWalletBatched`): the buyer pays from a Gateway balance with no gas, and content is released only after the facilitator's verify + settle succeed.
Live on Arc mainnet since 2026-09-17 — see it without a wallet:

```bash
curl -si https://open-pay.jp/api/paid/hello | grep -i '^payment-required:' | cut -d' ' -f2 | base64 -d
# → accepts: [ eip155:8453 (USD Coin), eip155:5042 (GatewayWalletBatched) ] — same amount, same payee
```

Buy with Arc USDC from a browser wallet (no private key in the script): `node scripts/arc-gateway-buyer-smoke.mjs` · Catalogue: [`/openapi.json`](https://open-pay.jp/openapi.json) · [`/llms.txt`](https://open-pay.jp/llms.txt) · Runbook: [`docs/DEPLOY_CHECKLIST.md`](./DEPLOY_CHECKLIST.md) §14.8

## x402 / API / agent payments

OpenPay includes **experimental** x402 protocol support for per-request paid API endpoints (AI agent / API use cases — separate from the human checkout flow).

`GET /api/paid/hello` returns HTTP 402 (x402 v1 + v2 dual-stack); clients (e.g. `x402-fetch`) sign an EIP-3009 authorization and retry.

OpenPay verifies + settles via an external facilitator (`X402_FACILITATOR_URL`; production uses payai — x402.org cannot settle Base mainnet) before returning content.

The same vanilla path also sells `GET /api/paid/usdc/japan-web3-directory[/search]` and `GET /api/paid/usdc/stores` in USDC on Base (no OpenPay fee; listed on x402scan).

Setting `X402_VANILLA_FACILITATOR=cdp` (with `CDP_API_KEY_ID`/`CDP_API_KEY_SECRET`) routes verify/settle for these USDC endpoints through the Coinbase CDP facilitator instead, which auto-indexes discoverable endpoints into the x402 Bazaar and agentic.market; unset, behavior is unchanged.

With `ENABLE_X402_ARC_GATEWAY=1` the same endpoints also accept **USDC on Arc** (`eip155:5042`): the x402 v2 challenge lists a second `accepts` entry that is verified and settled through the Circle Gateway x402 facilitator (`GatewayWalletBatched` domain; buyers pay gaslessly from a Gateway balance, the seller is credited in its Gateway balance, no OpenPay fee).

Base remains the CDP/Bazaar rail and is unchanged.

**Client interoperability (verified with real settlements, 2026-07-29/30):** the Base USDC products are standard x402 (exact scheme) and were purchased end-to-end with the official clients `x402-fetch` 1.2 (v1 `X-PAYMENT`) and `@x402/fetch` 2.20 (v2 `PAYMENT-SIGNATURE`).

The JPYC products use OpenPay's forwarder-split and require `openpay-x402-sdk` / `openpay-x402-mcp`; standard clients reject them safely **before signing** (the v1 client stops at schema validation because `eip155:137` is not in its network enum), so no funds can move.

Note that `@x402/mcp`'s buyer side wraps MCP tool calls (`mcp://tool/…`) and does not target plain HTTP endpoints. The client only signs — the facilitator submits the on-chain tx and pays gas, so agents need **no native gas** on the target chain.

**OpenPay's distinct angle — JPYC support.** The wider x402 ecosystem is largely USDC-only (Coinbase's reference and most public servers).

OpenPay's x402 server also accepts **JPYC v3 on Polygon / Polygon Amoy**, making it usable for **JPY-denominated agent / API billing** without routing through a USD asset. USDC on Base / Base-Sepolia is also supported.

**Managed JPYC facilitator + discovery** (flag-gated `NEXT_PUBLIC_ENABLE_X402_FACILITATOR` — **live in production** with real settlements; code default off).

Beyond *using* an external facilitator, OpenPay can run its **own** JPYC x402 facilitator: `GET /api/facilitator/supported`, `POST /api/facilitator/verify`, `POST /api/facilitator/settle`, first-party paid resources (`GET /api/paid/demo`, `GET /api/paid/stores`), a discovery catalog (`GET /api/discovery` + `/discovery` page) and SIWE-gated resource management — owners register, edit, and remove their own listings (`POST /api/facilitator/resources`, `PATCH`/`DELETE /api/facilitator/resources/:id`; removal is a soft-delete that drops the listing from the catalog while retaining the record for settlement audit, and only the owning wallet — `merchant === SIWE session` — may edit or remove).

`scripts/x402-buyer-example.mjs` is a single-file buyer example using the npm packages `openpay-x402-sdk` and `viem` for the first-party demo.

It collects a **1% facilitator fee (1 JPYC minimum), added on the buyer's side** — the seller receives the listed amount in full — **non-custodially**: settlement reuses OpenPay's existing EIP-3009 forwarder (`settle()` atomically splits seller + fee in one tx; the relayer only pays gas and never touches JPYC).

Each settlement returns an OpenPay-signed **receipt** verifiable offline (`POST /api/facilitator/verify-receipt`; the signer is published in `/supported`).

Because the split needs an OpenPay-flavored authorization, **vanilla single-auth x402 clients are not yet compatible** (Phase 2).

Registration is **abuse-moderated** — a listing must actually be payment-gated, so the server best-effort probes the URL and rejects ones that return `200` to anyone, and **scheme-checked** — a URL whose 402 advertises a non-OpenPay facilitator (e.g. USDC/Base accepts) is rejected with `gate_not_openpay` plus a copy-paste self-contained JPYC gate snippet, so the catalog promise ("payable in JPYC") stays true (registrants also attest they have the right to charge and gate it); the probe is **SSRF-hardened** (private/loopback/link-local hosts blocked, including IPv4-mapped IPv6 forms, and DNS-rebinding is re-checked at connect time).

The public catalog is edge-cached and its KV reads are bounded-concurrency, so it stays responsive under agent polling. Disclosed fee numbers are pinned in `lib/legal.ts` `DISCLOSED_X402_FEE` with a divergence fence.

Plan: `plans/x402-jpyc-facilitator.md`; go-live runbook: `docs/DEPLOY_CHECKLIST.md` §14.

The catalog's “verified” signal is backed by an hourly maintenance loop, not a static label: it re-probes first-party and registered x402 URLs with the same SSRF protections, records the last successful check, and temporarily hides a listing after three confirmed contract violations.

Transient network, rate-limit, authentication, Cloudflare-challenge, and server failures do not count toward hiding; a later valid OpenPay 402 restores the listing automatically.
Listing rules (what may be listed, reverification, prohibited listings) are in [LISTING_POLICY.md](./LISTING_POLICY.md).

**Agent order** (flag-gated `ENABLE_AGENT_ORDER`, **server-only, default OFF — fully inert**, additionally requires `NEXT_PUBLIC_ENABLE_X402_FACILITATOR` + `NEXT_PUBLIC_ENABLE_ORDER_RELAY`). Turns a `@handle` mobile-order shop into something an AI agent can order from end-to-end.

`GET /api/agent-order/menu?h=<handle>` returns the shop's **public** menu (item ids, names, prices, `hasOptions`); `GET /api/agent-order/pay?h=&cart=&table=&pickupAt=` is an x402 resource where the cart (`base64url([{id,qty}])`) is **priced by the server from the menu** (never from a client-supplied amount) — items with options are rejected (`item_has_options`) in v1.

The 402 `accepts` use the same forwarder-split rail (buyer-side 1% fee, `payTo` = the shop's `config.to`), so payment goes through the unchanged `x402_pay` path.

`pickupAt` (ms) is advisory: on a preorder shop with time controls on, a value outside the shop's pickup slots (earliest-lead / last-order window, 15-minute grid) is normalized to the nearest slot when the paid order is stored, not rejected.

The settled `200` `pickupAt` is authoritative (with the agent's original value as `pickupAtRequested` when it differs); `pickupAtEstimate` in the 402 challenge is advisory and may move later if the payment lands after a slot boundary.

Before settlement, the route stores an immutable order snapshot for 24 hours, bound to the payment authorization; a reservation storage failure returns `503 storage_unavailable` without settling.

Already-consumed authorizations without an existing agent binding, and human recover claims, are rejected with the existing `402 payment_invalid` challenge.

After settlement, an internal finalizer verifies the exact forwarder `Settled` event and atomically registers the reserved order.

Public `/api/order/notify` rejects a reserved authorization with `409 reserved_order`; only pre-upgrade unreserved agent records use the legacy notify path.

If registration fails on the new path, payment remains successful (`200`, `paymentSettled: true`, `orderRegistered: false`, `txHash`), with `repair: {action: "do_not_pay_again", retryWithSameHeader, txHash}`. **Do not call `x402_pay` again:** it signs a new payment.

`retryWithSameHeader: true` means replaying the identical signed payment header can repair registration; `false` means that retry cannot repair the identified conflict and the `txHash` is needed for investigation.

Recovery is request-driven, not a background job; the 24-hour snapshot does not extend the status lookup's 10,000-block hash-discovery window. Plan: `plans/a2b-agent-order-reservation.md`.

The `openpay-x402-mcp` package (≥ 0.9.0) has two explicit profiles.

`openpay-order-mcp` is the keyless human-pays profile: it exposes four tools — free shop discovery with `find_shops`, then `order_menu`, `order_summary`, and `createOrderLink`; the customer opens the returned link and pays from their own wallet.

Run it with `npx --yes --package=openpay-x402-mcp -- openpay-order-mcp`.

The full `openpay-x402-mcp` profile exposes nine tools: the unchanged previous seven plus `find_shops` and the guarded paid-search convenience tool `search_shops` for agents that perform autonomous x402 payments.
Node.js developers can use the `openpay-x402-sdk` npm package for guarded discovery, quotes, and x402 payments without MCP.
First-party paid resources are dual-stack: v1 buyers still use the JSON 402 body + `X-PAYMENT` / `X-PAYMENT-RESPONSE`, while v2 buyers can use `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, and `PAYMENT-RESPONSE` headers.

Vanilla v2 clients still need to construct the OpenPay forwarder nonce from `extra.openpay.commitVersion`; without that OpenPay-aware payload, settle rejects the payment.
Local MCP buyers can use [`packages/x402-mcp`](../packages/x402-mcp) for guarded JPYC x402 discovery, quote, and pay tools.

| Network | Asset | Status |
|---|---|---|
| `base` | USDC (Circle native) | mainnet |
| `base-sepolia` | USDC (Circle native testnet) | testnet (default) |
| `polygon` | JPYC v3 | mainnet (verified) |
| `polygon-amoy` | JPYC v3 (testnet) | testnet |

**Scope notes (different from the human checkout flow).** A paid route is pinned to **one (network, asset)** pair — agents must hold the token on that exact chain.

The human checkout's Circle CCTP V2 / Gateway cross-chain bridging is **not** part of the x402 path (bridge overhead exceeds typical per-request micropayment value). Choose the network per route via `X402_NETWORK`.

Wrap your own paid route in two lines:

```ts
import { withX402Payment } from '@/lib/x402/middleware';
export const GET = withX402Payment(async () => NextResponse.json({ ok: true }));
```

Configure via `X402_*` env vars (see `.env.local.example`).

## Japan Web3 Directory API

The Japan Web3 Directory is a flag-gated structured dataset for discovering services connected to Japan's JPYC, USDC, Web3, and AI-agent ecosystem.

Human-readable cards are available at `/ja/directory` and `/en/directory`; agents can use the JSON APIs and the OpenAPI 3.1 document at `GET /api/openapi.json`. `NEXT_PUBLIC_ENABLE_WEB3_DIRECTORY` is off by default, and paid routes additionally require the x402 facilitator flag.

### Data policy

Facts and OpenPay-written editorial summaries are kept separate. Unknown capabilities stay `false` or empty instead of being inferred, and only `published` records are returned. The five permitted source classes are:

1. Official product or organization websites.
2. Official documentation and help centers.
3. Official announcements and press releases.
4. Official source-code repositories.
5. Operator-reviewed manual submissions from the service owner or maintainer.

Do not add data through unauthorized scraping, access-control or paywall bypasses, copied third-party descriptions, personal data, rumors, or unsupported claims.

A source URL, attribution, and verification date are required; current conditions must still be checked with the cited source.

### Endpoints and prices

| Access | Endpoint | Result | Price |
|---|---|---|---:|
| Free | `GET /api/directory?limit=5` | Published teaser list (maximum 5 records) | Free |
| Free | `GET /api/directory/categories` | Published category counts | Free |
| Free | `GET /api/directory/tags` | Published tag counts | Free |
| Schema | `GET /api/openapi.json` | OpenAPI 3.1 for free and paid routes (also served at `GET /openapi.json` for x402 indexers) | Free |
| x402 | `GET /api/paid/japan-web3-directory` | Full published list | 2 JPYC |
| x402 (USDC) | `GET /api/paid/usdc/japan-web3-directory` | Full published list — standard x402, USDC on Base mainnet, no OpenPay fee (listed price is the full charge) | 0.02 USDC |
| x402 (USDC) | `GET /api/paid/usdc/japan-web3-directory/search` | Filtered search — standard x402, USDC on Base mainnet, no OpenPay fee | 0.02 USDC |
| x402 (USDC) | `GET /api/paid/usdc/jpyc/supply` | JPYC Supply by Chain — current contract-reported totalSupply per chain (Polygon / Kaia / Avalanche / Ethereum) with the observed block number | 0.002 USDC |
| x402 (USDC) | `GET /api/paid/usdc/jpyc/balance?address=` | JPYC Wallet Balance — current balanceOf of any address across chains with the observed block number | 0.002 USDC |
| x402 (USDC) | `GET /api/paid/usdc/jpyc/transfers?chain=` | Recent JPYC Transfers — Transfer events on one chain within an ≈1-hour window ending at head - depth (64 blocks on Polygon/Ethereum; 2 blocks on Kaia/Avalanche); snapshot newest first, cursor delta oldest first; optional address filter. Wait for that depth before checking a payment | 0.005 USDC |
| x402 (USDC) | `GET /api/paid/usdc/jpyc/activity?chain=polygon&window=24h` | JPYC Network Activity — approximately 24 hours of metrics computed hourly from finalized Polygon buckets; exact range in response. Free `/api/jpyc/activity/preview?chain=polygon`; buy again when observedAt advances and before expiresAt | 0.01 USDC |
| x402 | `GET /api/paid/japan-web3-directory/search` | Filtered search | 2 JPYC |
| x402 | `GET /api/paid/japan-web3-directory/:slug` | One published record | 1 JPYC |

The managed facilitator adds its disclosed **1% fee (minimum 1 JPYC) on the buyer's side**; the listed dataset price is paid to the seller in full. Search accepts allowlisted filters such as `keyword`, `category`, `token`, `chain`, `language`, and the `supports*` capabilities.

See the OpenAPI document for the complete query schema and response envelope.

Inspect the payment challenge without paying:

```bash
curl -i https://open-pay.jp/api/paid/japan-web3-directory
```

The response is HTTP 402 and includes the payable `accepts` requirements. To sign, pay, and retry with Node.js 20+, install `openpay-x402-sdk` and `viem` in your working directory, then use the single-file [`scripts/x402-buyer-example.mjs`](../scripts/x402-buyer-example.mjs):

```bash
npm install openpay-x402-sdk viem
curl -fsSL https://raw.githubusercontent.com/cipherwebllc/openpay/main/scripts/x402-buyer-example.mjs -o x402-buyer-example.mjs
BUYER_PRIVATE_KEY=0x... RESOURCE_URL=https://open-pay.jp/api/paid/japan-web3-directory node x402-buyer-example.mjs
```

Use a dedicated buyer wallet, start on testnet, and fund it only with the amount needed for the request.

### MCP use

The existing `openpay-x402-mcp` flow needs no package-specific directory tool: call `discovery_search` to find the list or search resource, then use `x402_pay` to inspect the quote and make the guarded JPYC payment.

Dedicated names such as `search_japan_web3_directory` are a possible future convenience API, not currently exposed tools.

### Adding or updating data

Directory records live in [`lib/directory/data.ts`](../lib/directory/data.ts). Submit a code PR with the factual fields, an allowed primary source, attribution, and verification date.

New records move through `draft` → `review` → `published`; use `rejected` when review fails and `archived` when a previously published service should no longer appear. API and UI publication is always limited to `published` records.

Directory source URLs are checked once per UTC day by the same maintenance cron. API items add `sourceCheckedAt` and three-valued `sourceOk` (`null` means no current result for that exact URL).

This is only a reachability check and does not establish that the directory information is true; the editorial `verifiedAt` remains a separate human-review date.

Source names, trademarks, linked content, and third-party database rights remain with their respective owners.

OpenPay's original code is MIT-licensed, but that does not grant a blanket license to reuse third-party source content; each API response includes its own attribution and license notice.

The directory is informational, may be incomplete or stale, and is not an endorsement or financial, legal, tax, or investment advice. Verify availability, supported networks, token contracts, fees, and regulatory eligibility with the cited official source before acting.

## JPYC Shops API

The Shops API uses a “discovery is free, data is paid” model. AI agents can find a shop handle and current three-valued ordering availability without a key or payment, then continue into the existing free menu and human-pays ordering flow.

Richer discovery data and filters remain behind the paid x402 search. Listings are strictly opt-in: a shop appears only after its owner selects the AI-agent listing option and republishes.

Responses use only information the shop has already made public, exclude phone numbers, and include per-shop attribution plus a bilingual license notice.

Shops can opt out by clearing the option and republishing; the index and materialized search summary are deleted, with shared-cache removal taking up to 60 seconds.

The feature is default-off and requires all four guards: `NEXT_PUBLIC_ENABLE_SHOPS_API`, `NEXT_PUBLIC_ENABLE_X402_FACILITATOR`, `NEXT_PUBLIC_ENABLE_ORDER_RELAY`, and server-only `ENABLE_AGENT_ORDER`.

The “verified” foundation differs by dataset: Shops are built from owner opt-in materialized records and live availability snapshots, while the x402 catalog and Directory cited sources are continuously rechecked by the maintenance cron described above.

A source reachability result is never presented as proof that its factual claims are true.

| Access | Endpoint | Result | Price |
|---|---|---|---:|
| Free | `GET /api/shops` | Listing count plus the fixed first three samples (`name` / `mode` only) | Free |
| Free | `GET /api/shops/find?q=&limit=10` | Name-only discovery with `handle` / `name` / `mode` / `acceptingNow` (maximum 10) | Free |
| x402 | `GET /api/paid/jpyc-shops/search` | Filtered shop search with live ordering availability | 2 JPYC |
| Free | `GET /api/agent-order/menu?h=<handle>` | Full public menu for a returned shop | Free |
| Schema | `GET /api/openapi.json` | OpenAPI 3.1 for free and paid routes (also served at `GET /openapi.json` for x402 indexers) | Free |

The free find endpoint accepts optional `q` (case-insensitive partial shop-name match) and `limit` (default and maximum 10). Its items contain exactly four fields: `handle`, `name`, `mode`, and `acceptingNow`.

Address, opening-time fields, menu summary, `dineIn` / `mode` filtering, and live-state details are reserved for the paid search.

The paid search accepts `q`, `mode`, `dineIn`, `acceptingNow`, `limit` (maximum 20), and `offset`.

`acceptingNow` is intentionally three-valued: `true` means every required check definitely passes; `false` means a definite stop condition applies (static stop, pause, time boundary, no pickup slot, unavailable forwarder, or all menu items sold out); `null` means a live read failed or legacy summary data is insufficient to decide.

Filtering with `acceptingNow=true` returns only `true` and never includes `null`.

Inspect the 2 JPYC payment challenge without paying:

```bash
curl -i 'https://open-pay.jp/api/paid/jpyc-shops/search?q=cafe&acceptingNow=true&limit=10'
```

The managed facilitator adds its disclosed 1% fee (minimum 1 JPYC) on the buyer's side. After payment, use each result's `pageUrl` to recheck current shop details and `menuUrl` to retrieve the free public menu.

Shops API data is licensed for search and ordering assistance; resale or bulk redistribution of the dataset itself is restricted.
