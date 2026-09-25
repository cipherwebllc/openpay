# Changelog

## Unreleased

- Add `SIGNER_MODE=circle` for the separately installed Circle Agent Wallet CLI: Polygon/Amoy chain mapping, lossless EIP-712 JSON, strict 65-byte signatures and address verification on every call. Share the shell-free child runner with Kova while preserving Kova's public behavior; Circle uses a 60-second independent deadline, `SIGKILL`, closed stdin, and bounded output.
- Map the CLI 1.1.4 bundle's `AUTH_REQUIRED`/`AUTH_EXPIRED` to fixed `circle_login_required` errors and missing executables to `circle_not_found`. Do not expose raw CLI output or infer policy denial from the ambiguous `PERMISSION_DENIED` code. Exclude `BUYER_PRIVATE_KEY`, `STEWARD_*`, and `KOVA_*` from Circle's child environment.
- Default Circle's daily cap to `MAX_SESSION_JPYC` (`default_circle`) using the shared address/UTC-date `spend.json` ledger; expose Circle status, reject `wallet_init`, and support `wallet_prove` through the CLI. No signer fallback or dependency changes.
- Document human installation, login and Terms acceptance. Circle typed-data policy enforcement, non-TTY challenge completion, and Amoy/mainnet purchases remain unverified; rely on the MCP caps and have a person log in again after session expiry.

## 0.18.0 — 2026-09-25

- Add `SIGNER_MODE=kova` as a third-party CLI signer: fixed Polygon/Amoy mapping from the validated 402 network, lossless bigint JSON, strict 65-byte signatures and address verification on every signature. Use shell-free `execFile`, closed stdin, a 30-second deadline with `SIGKILL` and bounded output; expose only fixed denial/failure messages, never raw child output or errors. Report a missing executable as `kova_not_found`. No signer fallback.
- Exclude `BUYER_PRIVATE_KEY` and all `STEWARD_*` variables from the Kova child environment while forwarding Kova credentials and other environment variables.
- Default Kova's daily cap to the session cap with `default_kova`; use the existing address/UTC-date ledger at `OPENPAY_X402_HOME/spend.json` without creating a keystore. Report the public Kova mode and reject `wallet_init`.
- Support `wallet_prove` in Kova mode: the `OpenPay Agent Proof` typed-data is signed through the CLI (`--chain polygon`) so the Agent can bind its purchase history on `/agent`; a Kova policy denial returns `kova_policy_denied`, a missing executable `kova_not_found`.
- Document pinned npm setup with `openpay-x402-mcp@0.18` in the package README, Polygon/Amoy separation and the verified Amoy + Polygon mainnet purchases (2026-09-25). Kova 0.1.2 does not limit typed-data signing through `spending_limit` or `sign_allowlist` in our test, so the MCP caps are the only amount limits for this mode; EIP-7702 delegation set by `kova init` does not block JPYC v3 authorizations. Windows is unsupported.
- No additional npm dependencies or peer dependencies. Kova must be installed separately.

## 0.17.2 — 2026-09-24

- Correct `order_summary` guidance: read `customerPaysJpyc` and `feeBearer` for the exact human checkout total and fee payer. Usually the customer pays the subtotal; preorder shops may add a customer-paid 3% fee. Align the tool description and README with the server's shop-specific fee schedule.
- Payment/signing behavior, input schemas, and dependencies are unchanged.

## 0.17.1 — 2026-09-23

- Keep `wallet_prove` challenges, bind links and signed audiences on
  `https://open-pay.jp` regardless of `DISCOVERY_URL`. A separate `OPENPAY_ORIGIN`
  can explicitly select another HTTPS origin; its server must verify that same
  audience. Trim surrounding whitespace and treat blank env values as unset.
  Reject invalid or insecure origins before fetching or signing.
- Require SDK `^0.10.1`, which creates new spend directories with mode 0700.
  Before migrating an existing env-key / Steward installation to keystore mode,
  inspect the directory and run `chmod 700 ~/.openpay-x402` once if it has legacy
  0755 permissions (use `OPENPAY_X402_HOME` instead when configured). Keep existing
  spend and wallet files; existing wallet files still require mode 0600.
- Save `steward-bootstrap` credentials (MCP env and owner TOTP seed) to an exclusive `0600` file instead of printing secrets. Default to a new file under `~/.config/openpay/`; accept `--out` for an explicit path outside a repository, and preserve credentials already issued if a later step fails.
- Require `--allow-ci` when CI is enabled (`CI=false` and `CI=0` disable this check). Withhold raw errors while retaining safe error names and codes for operator diagnostics.
- No dependencies added.
- Release order: publish SDK 0.10.1 first, then MCP 0.17.1. The SDK tarball must
  match the integrity pinned in this package's lockfile. If any SDK package bytes
  change before release, repack it and update the lockfile before publishing.

## 0.17.0 — 2026-09-23

- Add x402-only `wallet_prove {}` (13 tools; order remains 4) for keystore and env-key signers. Return a five-minute, single-use link that binds the Agent to a browser's SIWE account for server-side purchase history; no payment or local purchase record.
- Fetch challenges through the SDK's DNS-pinned GET transport, limit bodies to 8 KiB, reject unexpected fields and invalid nonce/timestamps/TTL, and reconstruct all EIP-712 fields from local constants. Return the unpadded base64url proof only inside the link fragment.
- Disclose link-sharing and first-opener risks, rebinding recovery, and server-side retention of 400 days after the last record. A disabled server flag returns `feature_disabled`; Steward is unsupported. Preserve existing tool definitions, dependencies, and the local wallet threat model.

## 0.16.0 — 2026-09-22

- Add x402-only `wallet_history` (12 tools; order remains 4). Join local start/end records, disclose coverage and incomplete history, and show only verified receipt amounts with integer unit conversion. No totals or on-chain proof claims.
- Record purchase attempts in every signer mode without creating a wallet. Add `history: recorded | failed` to payment results; recording failures never change payment behavior or exceptions, and history I/O gives up after 2 seconds so a hung filesystem cannot hold back a paid result. Existing tool definitions and SDK dependency are unchanged.
- Limit logs to allowed metadata, remove queries/fragments and third-party paths, and exclude bodies, signatures, nonces, authorizations, and keys. Use checked 0600 single-write appends in a checked 0700 directory, reject unsafe files, and rotate above 512 KiB without truncation.

## 0.15.0 — 2026-09-21

- Add x402-only `wallet_init` and `wallet_status` (11 tools; order remains 4), with pinned tool wire hashes. Explicit keystore mode publishes a fully written, fsynced 0600 temporary file via an atomic hard link, removes the temporary file on success/failure, fsyncs the directory, and rereads the stored record. Existing wallets are never overwritten or regenerated; unsupported links fail closed with a filesystem reason code.
- Both wallet tools report the path and do-not-delete recovery guidance for corrupt, mismatched, or unsafe wallet files, including empty/partial records. Require an absolute `OPENPAY_X402_HOME`; invalid homes disable wallet operations without preventing startup or discovery.
- Activate initialization without restarting the host, retaining one payment executor and serializing payments with reinitialization. Uninitialized payments send no requests. Default keystore daily cap to the session cap. Separate public wallet metadata from non-enumerable secrets; retain every activated key and stray env key in redaction, never signing with an env key in keystore mode or writing keys to env.
- Report optional read-only Polygon JPYC balances using SDK outbound validation, private/link-local/internal-host rejection and DNS pinning, with an explicit localhost HTTP exception. Bound DNS/transport/body reads to five seconds (tested with fake timers); unavailable balances remain null.
- Require SDK `^0.9.0`; pin setup examples and document the plaintext-file threat model. OpenPay does not receive, store, or recover local keys.

## 0.14.0

- Attach a `settlementNote` to every `x402_pay` result that carries the SDK's new
  `settlement` field (`openpay-x402-sdk` 0.6.x). An LLM reading `status: 200`
  assumes the call was paid; the note states in one sentence that `verified` only
  means the receipt signature is valid for the signer published by the discovery
  origin — not on-chain proof — and that `unverified` and `receipt_unavailable`
  are not proof of payment. Guard rejections carry no `settlement` and are
  returned unchanged.
- Inherit the SDK 0.6.x buyer changes: pre-connection DNS checks for an injected
  custom transport, `https`-only `DISCOVERY_URL` (plaintext `http` only for
  localhost), and takeover of a spend lock left behind by a killed process, which
  removes the case where `MAX_DAILY_JPYC` blocked every payment until the lock
  file was deleted by hand.
- Fix `steward-bootstrap` success detection: a `&&` accepted both `HTTP 200` with
  `ok: false` and `HTTP 5xx` with `ok: true`, letting a failed owner promotion,
  MFA step, or signer issuance pass silently and break a later step. It now
  requires `res.ok` *and* `ok: true`, matching `setAndVerifyJpycPolicy`.
- Fence the `Eip3009Forwarder` address across the three places it is written —
  the SDK allowlist, this package's `steward-bootstrap` default, and the server's
  env-resolved value — against the deployed-address table in `contracts/README.md`.
  A drift used to let a buyer sign a `to` for the wrong contract, or make a valid
  listing unpayable with `invalid_openpay_forwarder`.
- Tool wire (names, descriptions, input schemas) is unchanged.

## 0.13.1

- Adopt `@modelcontextprotocol/sdk` 1.30.0 (DNS-rebinding protection on by
  default, shared-transport leak fix). No functional change.

## 0.13.0

- Inherit SDK pre-send authorization reservations, cross-process atomic daily
  caps, pre-fetch SSRF checks, canonical JPYC validation, and authorization TTL
  limits.
- Require exact catalog URL admission and bind signature destinations to a
  deployed or catalog-reviewed OpenPay forwarder.
- Require Steward typed-data policy PUT responses to be valid success JSON and
  verify every effective policy field with a read-back before issuing signer
  credentials.
- Return facilitator receipts only after SDK signature and payment-binding
  verification; forged seller headers no longer replace successful content.

## 0.12.0

- Add optional `MAX_DAILY_JPYC`: a per-UTC-day cumulative spend cap that
  survives restarts, persisted via `openpay-x402-sdk` 0.4.x's file spend store
  (`~/.openpay-x402/spend.json`, keyed by signer address and UTC date).
  Unreadable store fails closed; a write failure after a successful unlock
  never alters the payment response. Unset keeps previous behavior.
- Tool wire (names, schemas, descriptions) is unchanged.

## 0.11.0

- Trust query-string variants of a query-free catalog URL after the same live
  money-field verification, via `openpay-x402-sdk` 0.2.x.
- Preserve all MCP tool names, descriptions, and input schemas byte-for-byte.

## 0.10.0

- Delegate payment execution, catalog resolution, guards, payment wire handling,
  and signing to `openpay-x402-sdk` 0.1.x.
- Preserve both profiles' tool names, descriptions, schemas, result shapes,
  guard reasons, signer timing, and serialized payment behavior unchanged.

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
