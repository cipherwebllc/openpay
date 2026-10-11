# OpenPay features, fees and supported chains

> The detailed reference behind the [README](../README.md). The README keeps a short summary; this page keeps the full text.
> README の詳しい版です。README には要約だけを置き、全文はこのページにあります。

- [Key features](#key-features)
- [Why OpenPay?](#why-openpay)
- [Payment modes](#payment-modes)
- [Fees](#fees)
- [Supported tokens and chains](#supported-tokens-and-chains)
- [Non-custodial design](#non-custodial-design)
- [How it works](#how-it-works)
- [Limitations](#limitations)
- [Roadmap](#roadmap)

## Key features

- **Non-custodial** — payments go directly to the merchant wallet; OpenPay never holds funds.
- **No wallet lock-in** — any wallet that signs standard ERC20 / ERC-4337 / EIP-7702 transactions can pay; no app install required.
- **JPYC / USDC** support (Japan's electronic payment instrument + Circle's USD stablecoin).
- **QR-locked conditions** — amount, token, chain, and recipient are pinned per QR; customers cannot mistype them.
- **Two payment modes** — Standard (customer pays gas in the native token) or Gasless (customer pays with just the token; for JPYC OpenPay sponsors the gas and charges a small per-transaction usage fee — **works in any wallet**, for USDC gas is paid in USDC via the paymaster **but only for EIP-7702 smart-account wallets — ordinary wallets fall back to standard**).
- **Portal UX** — a single app with separate surfaces for paying (`/scan`), receiving (`/create`), browsing history (`/history`), and discovering on-chain services (`/explore`), all behind a shared header / bottom-nav and wallet-state badge.
- **Block explorer link** on every receipt — merchants verify on-chain truth, not just a UI screen.
- **Local transaction history** — per-browser LocalStorage history at `/history`, with filters (period / status / search), a JPY-converted GMV summary, CSV export, and a "latest 3" strip on the QR builder.
- **Accounting integration** — `/history` exports income CSV in **freee**, **Money Forward**, and **Yayoi** formats (Yayoi-native in Shift_JIS), and — opt-in via `NEXT_PUBLIC_ENABLE_FREEE_SYNC` — connects to **freee over OAuth** to push income transactions in one click.

  Gated behind **SIWE wallet login** (no password/account) with an idempotent "sync to freee" batch (re-clicking never double-books).
- **Sales line items & simple register** — the QR builder has an optional **accounting fields** section (product/purpose name, memo, tax rate & category, receipt no.), and `/create` adds a mobile-friendly **simple register**: add **multiple products to a cart** (from presets or typed), set per-line quantity / unit price / tax rate, and generate an itemized `/checkout` QR for the cart total.

  The line items travel with the payment and are recorded in `/history` as a **sales detail** (per-line product, quantity, unit price, tax rate, in-tax amount, total, receipt no.).

  They flow into the accounting CSVs (tax category + an item summary like “Coffee x2 / T-shirt x1” in the description), a dedicated **line-item CSV** (one row per product), and freee’s memo (one deal per transaction, items summarised — idempotent, never double-booked).

  One cart is a single currency. Register mode and product presets are stored locally (LocalStorage; no server DB).

  These are **bookkeeping aids for CSV import** — OpenPay is not a POS or accounting product, and final accounting (tax treatment, mixed-rate carts, etc.) should be confirmed in your accounting software / by a tax advisor.

  JPYC is treated as ¥1; tax is computed in the token’s own units (no forced JPY conversion for USDC).
- **Mobile order & `@handle` storefronts** *(live in production)* — a store can publish a menu at `open-pay.jp/@handle` (or share a `/order` link); customers browse, add to a cart, and pay by QR, with the receiving wallet shared with the profile/tip page.

  Flag-gated layers add order relay to the merchant, kitchen / hall fulfillment boards (overdue orders tint amber/red, the kitchen aggregates uncooked item totals and can sort by pickup time), live sold-out toggles, open-from / last-order auto-stop and pre-order time slots, a pickup-ready customer notification, an optional customer **order memo** (allergies / requests), and a **dine-in staff-call button** bound to the customer's own paid order (see the env table).
- **Payment push notifications** *(live in production)* — merchants get a Web Push when a payment (or mobile order) lands: SIWE-bound per-device subscriptions, server-authoritative triggers only (the relay/order paths — never client-reported logs), 60-second coalescing ("n new payments"), amount shown only per-device **opt-in**, a **"send test notification"** button, and notification tap lands on `/history` with the newest payment highlighted.

  On iOS, push requires the home-screen (A2HS) PWA — the panel guides users there.
- **Installable PWA + offline receive QR** *(live in production)* — installable web app (manifest screenshots, add-to-home-screen hints at peak moments), a "today's sales" card on `/` for connected merchants, and an **offline mode for the receive screen**: once `/create` has been opened online, the page and the **last generated QR** keep working with no signal (QR is generated on-device) — for stalls, events, and basements.

  Payment routes are never served from cache.
- **Printable store kit** — `/kit` prints an A4 sheet of four A6 "Cash & OpenPay accepted" counter POPs plus a door sticker; with the customer-facing payment-QR poster (token / chain logos + 3-step how-to) from `/create`, a store can be fully signposted with two sheets of paper.
- **Reference market rate** — a lightweight strip on `/` and `/create` shows `1 USDC = ¥X.XX` via a 5-min server-cached Coinbase proxy; `1 JPYC = ¥1.00 (peg)` is fixed.
- **Creator digital goods store** *(live in production)* — creators sell digital items on their `@handle` profile for JPYC: **URL products** (share links to PDFs / ZIPs / videos on free hosting) and **text products** (prompts, templates, up to 20k chars, stored by OpenPay for delivery).

  No seller fee — the buyer pays price + the x402 facilitator fee (1%, min 1 JPYC); sales settle **directly to the seller wallet** (non-custodial).

  Ships with a Specified-Commercial-Transactions-compliant purchase confirmation, seller-info registration, a **permanent purchase library** (re-download anytime, per-revision), purchase-provenance display (wallet / purchase ID / tx shown with the content as a resale deterrent), product images + gallery (up to 4), and **per-product share links** whose OG cards open the purchase dialog directly (`/@handle?product=…`).

  See `/guide/store` for a hands-on selling guide.
- **License NFTs** *(flags default OFF)* — seller-defined access licenses with ERC-1155 proof on Polygon (Amoy for testing), paid directly to the seller in JPYC.

  Policy: 1–10,000 units, integer price at least 1,000 JPYC, non-transferable by default; transferable NFTs transfer the license. No usage counts or balances; purchase rights survive mint delay or failure. Seller-funded refunds are separate transfers.

  Sellers may pick the OpenPay standard terms template (standard-v1) or their own terms URL. `GET /api/license/verify?address=&product=` is a read-only HTTPS status API: unknown is `entitled: null`, not authentication or a signed attestation.

  SIWE holders can use `/api/store/content/<product>` and discover incoming licenses via `/api/store/library?source=holders` (follow `nextCursor` as `cursor`; the ordinary library remains purchase history). Ledger and Verify data are public. Third-party gating is not guaranteed.

  Public listing is available when `ENABLE_LICENSE_NFT_PUBLIC=1`; existing creator profile and SIWE prerequisites still apply. `GET /api/license/products/<id>` returns a public v1 product descriptor; SDK 0.7.1 accepts the product ID directly for license gates.

  See Terms Article 13 and deployment checklist §16.4–16.8.
- **Protected delivery (flags default OFF)** — OpenPay checks entitlement and redirects to the seller’s host with a 60-second EdDSA ticket; it does not host the external file bytes. Public verification keys are served at `/.well-known/openpay-delivery-keys.json`, and SDK 0.8.0 provides `openpay-x402-sdk/delivery` and a private R2 Worker example. Sellers operate the destination and are responsible for its availability; tickets control access, not copying or sharing during their lifetime.
- **x402 / AI-agent payments** *(live in production)* — a managed **JPYC x402 facilitator** with a public **AI store** (`/discovery`: searchable catalog + self-service seller registration), first-party demo resources, and the `openpay-x402-mcp` MCP package (two profiles: keyless human-pays ordering, and guarded autonomous x402 payments).

  Most x402 servers are USDC-only; OpenPay adds **JPYC**, and its USDC APIs accept **Base and Arc** (Arc via the Circle Gateway x402 facilitator).
- **OSS, self-hostable** under MIT.

## Why OpenPay?

Wallet-to-wallet transfers work, but a customer-typed transfer at a checkout counter is error-prone — the wrong token, wrong chain, or off-by-one amount sends money that can't be recovered.

OpenPay generates a **QR with the amount, token, chain, and recipient fixed by the merchant**. The customer scans, reviews, signs — and funds land in the merchant's wallet directly. No new account to create, no merchant onboarding, no balance held by OpenPay.

## Payment modes

| Mode | Gas | Best for |
|---|---|---|
| **Standard payment (with gas)** | Customer pays in their own wallet (POL / ETH) | Web3 users who already hold native gas |
| **Gasless payment** | For JPYC, OpenPay sponsors the gas and charges a per-transaction OpenPay usage fee (see Fees) — works in any wallet. For USDC, the customer pays gas in USDC via the Pimlico / Circle paymaster (OpenPay collects 0) — **requires an EIP-7702 smart-account wallet; ordinary wallets fall back to standard** | JPYC: any wallet. USDC: customers whose wallet is an EIP-7702 smart account |

- Gasless for **JPYC** uses OpenPay's self-hosted **EIP-3009 relayer**: the customer signs a `receiveWithAuthorization` to a forwarder (or, where no forwarder is configured, a plain `transferWithAuthorization` directly to the merchant — a plain EIP-712 signature, **no EIP-7702 delegation required**, so it works in MetaMask and other injected wallets), and the relayer submits it on-chain.

  In the **recover** configuration (forwarder set), OpenPay sponsors the gas (POL / KAIA / AVAX) and a per-transaction **OpenPay usage fee** is split to the OpenPay fee-receiver atomically in the same transaction (see Fees); for payments the **merchant always absorbs the fee** (the customer pays the displayed price) — the per-QR gas-bearer toggle is removed for JPYC recover.

  Live on **Polygon, Kaia, and Avalanche C-Chain** mainnet. Pimlico / EIP-7702 sponsorship remains as an automatic fallback on Polygon / Kaia (on Avalanche, whose EIP-7702 is non-canonical, the fallback is standard mode).

  If the relay's HTTP response is lost mid-flight, the client **latches the signed payload** (no re-signing, no silent fallback to standard mode) and auto-resolves the outcome via a read-only status endpoint — a settled payment completes normally (receipt, order relay, history), and **double payment is structurally prevented**.
- Gasless for **USDC** uses ERC-4337 + ERC-7702.

  Gas is sponsored via **Pimlico** (ERC20 paymaster) or, for USDC on Base / Arbitrum / Optimism, **Circle Paymaster v0.8** (gas paid directly in USDC; OpenPay collects 0 fee). ⚠️ **USDC gasless requires the customer's EOA to already be EIP-7702-delegated to a smart account** — an ordinary, never-delegated injected wallet cannot bootstrap the delegation (viem cannot sign the 7702 authorization over JSON-RPC), and MetaMask's own Stateless7702 smart account is currently disabled pending a viem / delegation-toolkit fix; both **fall back to standard payment** (the customer pays their own gas).

  It also requires a chain whose EIP-7702 is active (see the Avalanche note below). **JPYC gasless has no such requirement** — it is a signature-only EIP-3009 relay that works in any injected wallet.
- Standard mode is a plain ERC20 `transfer` (single transfer to the merchant).
- The gasless network-fee bearer can be set with `gas=customer` (default) or `gas=merchant`. For **JPYC gasless in recover mode** it decides who bears the per-transaction OpenPay usage fee: `customer` adds it on top of the payment, `merchant` absorbs it from the amount received.

  For the **USDC** paymaster paths it has no effect on what OpenPay collects (OpenPay collects 0).

## Fees

In **gasless** mode for **JPYC** (recover configuration), each payment carries a **per-transaction OpenPay usage fee** — **1% of the payment with a 2 JPYC minimum** (`max(2 JPYC, 1%)`).

The fee is deducted at settlement and split to the OpenPay fee-receiver atomically in the same transaction.

The fee-bearer is **fixed, not a per-QR choice**: for **payments** (`/pay`, `/checkout`, the register) the **merchant always absorbs the fee** and the **customer pays exactly the displayed price** (the merchant's net = price − fee).

OpenPay never takes custody: the principal price of goods still moves customer→merchant directly on-chain, and only the usage-fee portion is split out.

For **tips** (`/tip`, `@handle` tip pages) the **tipper pays a flat gas-equivalent floor (about 2 JPYC)** on top of the tip — the **1% does not apply to tips** (tips stay at the flat floor).

There are **no OpenPay usage fees** on receiving a payment itself, on **standard** (with-gas) mode outside mobile orders — including the register's standard JPYC path since 2026-10-07 (see below; the customer pays their own gas, OpenPay does not touch it), or on the **USDC** paths outside mobile orders (gas is paid by the customer in USDC via the Pimlico / Circle paymaster, or directly on Arc; OpenPay collects 0).

The usage fee applies to JPYC gasless (recover) payments and tips, plus mobile orders described below.

“The shop pays the gas” (register or a fixed-amount payment QR shown on screen, JPYC on Polygon, Kaia or Avalanche; flag-gated) carries no OpenPay usage fee — the shop’s device pays the gas and, by design, 1 wei is added to the customer’s payment and sent to OpenPay.

**Mobile-order system fee (flag-gated; live in production).**

When `NEXT_PUBLIC_ENABLE_MOBILE_ORDER_FEE` is on (production sets `1`; code default off), payments made through a mobile-order storefront (`@handle` / `/order`) carry the OpenPay usage fee at a **mobile-order rate** (the **mobile-order system fee**) — consideration for the mobile-order *system* (shop page, menu, order management, order relay).

It is **not charged in addition to** the gasless per-tx usage fee: on a mobile order only this rate applies, and the gas OpenPay sponsors is included in it (no separate gasless fee on top).

It is **path-independent**: it applies whether the payment goes through the gasless relay **or** standard (with-gas) mode, so a gasless-by-other-means or standard payment does not escape it.

The rate is **1%** for in-store / kiosk (`storefront`) and **3%** for pre-order mobile ordering (`preorder`) — a flat percent (no floor).

For pre-order a per-store toggle picks **store-borne** (deducted from the merchant's receipt; customer sees the price only) or **customer-added** (the customer pays price + 3%).

On the relay path it is enforced server-side — the relay route recomputes the rate from a code constant keyed by the order kind, so the client cannot lower it — and split to the same fee-receiver in the same transaction.

It is booked as a **system fee** (not a network/gas cost) in history / CSV. `/pay`, tips, and ordinary checkout links are unaffected. Rates live in `lib/mobileOrderFee.ts`, fenced against the disclosed numbers in `lib/legal.ts` (`DISCLOSED_MOBILE_ORDER_FEE`).

**Digital goods store (live in production).**

Selling digital items on `@handle` profiles carries **no seller fee**; the buyer pays the listed price plus the **x402 facilitator fee** (1% of price, min 1 JPYC) added on the buyer side — the same fee schedule as other x402 payments, applied because store purchases settle over the x402 rail.

Disclosed in Terms Article 13 and the Tokutei notice.

**Register (POS) standard-payment fee — abolished on 2026-10-07.** The register's standard (with-gas) JPYC path no longer carries an OpenPay usage fee (production set `NEXT_PUBLIC_ENABLE_REGISTER_FEE` to `0`; the Terms/Tokutei disclosures state it).

The flag and its fee-claim endpoint (`/api/register/claim`) have since been removed from the code, so bringing a register fee back would take new code and updated fee disclosures first.

A register sale paid on the gasless **relay** path carries the regular recover fee, like any other JPYC gasless payment.

This pricing is **not a percentage skim of arbitrary size**: it is a small, capped, per-transaction service fee for the gas-sponsored JPYC relay.

OpenPay remains a non-custodial software / infrastructure provider rather than a payment intermediary under the Japanese Payment Services Act framework.

Arc is **standard-mode only** when enabled: customers pay network fees directly in USDC, with no separate gas token needed and no OpenPay collection. Arc is always excluded from cross-chain sources.

Destination forwarding is separately gated by `NEXT_PUBLIC_ENABLE_USDC_ARC_CROSSCHAIN` (default **off**); it uses CCTP V2 and Circle Forwarding Service, with the forwarding fee added to the buyer’s payment and no OpenPay collection. `NEXT_PUBLIC_ENABLE_USDC_ARC` defaults **off**.

## Supported tokens and chains

| Token | Merchant receiving chains | Buyer-pay-from chains (cross-chain ON) | Notes |
|---|---|---|---|
| **JPYC** (v3, Japan's electronic payment instrument under the revised Payment Services Act) | Polygon, Kaia, Avalanche C-Chain | same (no cross-chain) | Gasless via OpenPay's self-hosted **EIP-3009 relayer** (signature-based, no EIP-7702 needed) — live on Polygon, Kaia, and Avalanche; Pimlico / 7702 sponsorship as fallback on Polygon / Kaia. On **Avalanche** gasless is **recover-mode only** (a forwarder is required; ~2 JPYC gas floor, same as Polygon / Kaia). **Ethereum L1** JPYC receiving is also supported but **standard-mode only** — the customer pays ETH gas (L1 gas is too volatile for a sponsored relay, so there is no gasless path) — gated behind a default-off flag (`NEXT_PUBLIC_ENABLE_JPYC_ETHEREUM`, mainnet only). |
| **USDC** (Circle native — bridged USDC.e is **not** supported) | Base, Arbitrum, Optimism, Polygon, **Ethereum L1**, **Avalanche C-Chain**, **Arc** (7 with Arc enabled) | the original 6 + **Unichain, World Chain, Sonic, Sei, HyperEVM** (11 total, via Circle Gateway / CCTP V2) | Gasless via Pimlico ERC20 Paymaster on Base / Arbitrum / Optimism / Polygon / Ethereum L1; **Circle Paymaster v0.8** runs in parallel for USDC on Base / Arbitrum / Optimism (USDC-native gas, OpenPay 0 fee). **USDC gasless additionally requires the buyer's EOA to be an EIP-7702 smart account (already delegated); ordinary / undelegated wallets fall back to standard payment** (JPYC gasless has no such requirement). **Avalanche C-Chain is standard-mode only for now** — its EIP-7702 (ACP-209) is not yet activated on mainnet, so gasless (which relies on 7702) gracefully falls back to standard payment; it re-enables automatically once ACP-209 ships. The 5 buyer-only chains are cross-chain **sources only** (they do not appear in the merchant chain chooser). Cross-chain payments require the buyer to hold native gas (ETH/POL) on the source chain — see the cross-chain notes below. |

`NEXT_PUBLIC_NETWORK_ENV=testnet` swaps mainnets for Base / Arbitrum / Optimism Sepolia + Polygon Amoy + Kairos Testnet + Sepolia + Avalanche Fuji + Unichain Sepolia + World Chain Sepolia + Sonic Blaze Testnet + Sei Testnet + HyperEVM Testnet + Arc Testnet.

> **USDC balances are chain-specific.** The same wallet address can receive USDC on all seven merchant chains (with Arc enabled), but each chain holds a separate balance.

Optional chain-abstraction via Circle Gateway / CCTP V2 is available as an augmentation when the buyer's USDC is on a different chain than the merchant's selected chain (see [docs/DEPLOY_CHECKLIST.md §10](./DEPLOY_CHECKLIST.md) for status and operator verification).

> **Cross-chain reach:** When the merchant enables cross-chain in the QR (default ON for USDC; Arc requires both Arc flags), customers can pay from any of **11 chains** — the 6 cross-chain receiving chains plus Unichain, World Chain, Sonic, Sei, and HyperEVM.

Arc can be paid *into* from those chains via Circle forwarding (buyer-paid Circle fee), but is never a source. The print poster lists all 11 so customers know up-front which wallet works.

Circle Gateway / CCTP V2 forwards the value to the merchant's selected receiving chain (~5–30 seconds end-to-end depending on path; Arc forwarding can take longer and has a separately quoted buyer-paid Circle forwarding fee).

> **Cross-chain is "gas-on" for the buyer.** Eligible same-chain payments are gasless (the buyer pays gas in USDC via the paymaster).

A cross-chain payment bridges from the buyer's wallet via their own EOA, so the buyer needs the **source chain's native gas (ETH/POL etc.)** — it cannot be completed with USDC alone.

> **Ethereum L1 caveat:** USDC payments on Ethereum L1 support both gasless (Pimlico ERC20 Paymaster, customer pays gas in USDC) and standard modes.

L1 gas is still 1–3 orders of magnitude higher than L2 — pick Base / Arbitrum / Optimism / Polygon for routine small-ticket flows; reserve Ethereum L1 for the cases where the buyer or merchant has a hard requirement (e.g. SBI VC Trade USDC withdrawals are L1-only).

### Payment-page UX (cross-chain chain chooser)

When a customer scans a USDC QR and has USDC on multiple chains, the payment page shows a **source-chain chooser** with the per-chain trade-offs side-by-side:

- Chain name + the customer's USDC balance on that chain
- Path badge: **Direct** (same chain as merchant, no bridge fee) · **Fast (Gateway)** (Circle Gateway, ~5s) · **Standard (CCTP V2)** (~30s)
- Fee breakdown (cross-chain paths only): Circle bridge fee + network gas token (e.g. `ブリッジ手数料 0.005 USDC + ガス代 (ETH)`) + ETA. The Direct (same-chain) option shows no extra fee line.
- A note that cross-chain paths need the source chain's native gas (ETH/POL) — USDC alone is not enough
- Pre-selected default = the auto-picked best path (direct preferred, else gateway, else CCTP V2), but the customer can override

The chooser is hidden when the customer has USDC on **only** the merchant's chain — in that case the regular Pay button handles it as a plain direct transfer.

The chain abstraction layer is `lib/crossChain/*` (Circle Gateway + CCTP V2), see [`docs/DEPLOY_CHECKLIST.md §10`](./DEPLOY_CHECKLIST.md) for the operator-verification status and [`docs/research/circle-12chain-addresses.md`](./research/circle-12chain-addresses.md) for contract addresses + audit trail.

### Tip widget (creator surface)

Creators can **share a tip link** (`/tip/[address]`) or **embed a Tip widget** on their blog, portfolio, or GitHub README. Same chain reach as the payment page:

- **JPYC** — receive tips on **Polygon, Kaia, or Avalanche C-Chain**. Default is Polygon; switch to Kaia or Avalanche in the creator dashboard chain chooser when generating the embed snippet.
- **USDC** — receive on any of **6 receiving chains** (Base / Arbitrum / Optimism / Polygon / Ethereum L1 / Avalanche C-Chain). Fans on different chains can still tip you via **cross-chain receive** (default ON) — Circle Gateway / CCTP V2 forwards the value to your selected chain.

  The same cross-chain path covers fans on the 5 buyer-only chains (Unichain, World Chain, Sonic, Sei, HyperEVM). Toggle cross-chain off in the dashboard if you want same-chain transfers only.

The widget is gasless-only — fans only need the tip token, no native gas (for JPYC OpenPay sponsors the gas and the tipper adds a flat gas-equivalent amount — see Fees; for USDC the fan pays gas in USDC via the Pimlico / Circle paymaster, OpenPay collects 0).

Creator-defined presets, custom thank-you message and an optional thank-you link.

**Link images & media embeds** — profile links can show a small **image instead of an emoji** (any https image URL, emoji fallback on error), and links to **nine supported services** — YouTube, Spotify, Audius, Niconico, Vimeo, Apple Music, TikTok, Suno, SoundCloud — can render as **embedded players** (opt-in per link, max 3 per profile).

Embed iframes are built only from strictly validated IDs (never from raw user URLs) and are sandboxed. **Private tip messages (question box)** — tippers can attach a private question/message; only the recipient can read it (SIWE-unlocked inbox, kept 180 days).

**Theming & branded presets** — tip pages share the six `@handle` profile themes (**Clean / Gradient / Bold / Outline / Night / Soft**) plus a free accent color, so a creator's profile and tip page can match.

The theme rides the link (`theme=`; links without it render exactly as before), and the shared **OG card reflects it** too. Amount presets can carry short **emoji labels** (`preset=300|☕ コーヒー1杯` → a two-line "☕ コーヒー1杯 / 300 JPYC" button).

The builder (`/create` → tip) previews the **real tip form in a phone frame** — what you see is what fans get.

(**USDC** gasless relies on EIP-7702, so USDC tips on **Avalanche C-Chain** are unavailable until ACP-209 activates — fans are guided to another chain; see the Avalanche note above. **JPYC** tips on Avalanche are unaffected: JPYC gasless uses the signature-based EIP-3009 relay, not 7702.)

**Sharing & social preview** — the tip builder (`/create` → tip) outputs the link with one-tap copy, a **link QR** (for print / in-person; omitted automatically if the URL is too long for a scannable code), and a **“Share on X”** button, plus two embeds: the full **`<iframe>`** widget and a paste-anywhere **“Tip” button** snippet (note / Linktree / blog).

Tip links shared on X / Discord / LINE unfurl into a **dynamic OG card** (`/og/tip`, 1200×630) with the creator’s name + token + brand (Japanese names rendered via a bundled Noto Sans JP).

The card stays accurate per mode — gasless JPYC/USDC say “no gas”, native POL/KAIA tips don’t (the sender pays their own gas). The OG endpoint only honours the creator name for a valid tip link (`to` + token/native); arbitrary direct hits fall back to a generic branded card.

**Permanent links (`@handle`)** — a creator can reserve a memorable handle (`open-pay.jp/@alice`) that serves a **link-in-bio profile** (avatar, bio, links with emoji + one featured link, the same six switchable themes) with a tip button, and keeps resolving no matter how often they change receiver or amounts.

Reservation is self-service: sign in with **SIWE** (proves wallet ownership), pick a handle (lowercase `[a-z0-9_]`, 3–30 chars; reserved/brand words blocked), and publish the current tip settings; owners can update or release their handles (up to 3 per wallet).

Records live in KV — name uniqueness is an atomic `SET NX` claim and owner-scoped update/delete use a compare-and-set. Gated behind `NEXT_PUBLIC_ENABLE_HANDLES` — **live on mainnet** (production sets `1`); code default off.

## Non-custodial design

OpenPay **never holds** merchant funds. Customer payments are sent **directly to the merchant wallet**. OpenPay does **not** issue, redeem, custody, or exchange JPYC / USDC.

## How it works

**Routes** (i18n-prefixed under `/ja` or `/en`, e.g. `/ja/create`):

| Route | Purpose |
|---|---|
| `/` | Landing page — hero with two CTAs (📱 pay / 🏪 receive), benefits, how-it-works, FAQ |
| `/create` | Merchant QR builder + Tip widget builder + offramp links + latest-3 history strip |
| `/scan` | Customer scan-to-pay surface (QR scanner + connected-wallet balances + saved payment receipts); accepts payment / tip / `@handle` storefront / `/order` QRs |
| `/history` | Local-only transaction history with CSV export |
| `/explore` | Curated directory of external stablecoin services (exchanges / DEX / dApps / bridges / explorers) |
| `/discovery` | **AI store** — public x402 catalog (search + category filter) with self-service seller registration (SIWE) |
| `/pay`, `/checkout`, `/tip/[address]` | Transactional leaf surfaces — kept focused (no app-shell chrome) |

Pages above the leaf surfaces share an `AppShell` with a sticky header (logo + wallet badge + locale + network pill) and a mobile bottom-nav. The leaf surfaces stay distraction-free intentionally.

**Merchant**:
1. Open <https://open-pay.jp> and click **🏪 受け取る (決済 QR を作る)** — or go directly to `/create`.
2. Enter the merchant wallet address.
3. Enter the amount, select token + chain + payment mode.
4. Show or share the QR code or payment link. The latest 3 received payments appear under the form once any exist.

**Customer**:
1. Open <https://open-pay.jp> and click **📱 支払う (スキャン)** — or go directly to `/scan`.
2. Scan the merchant QR (or land on `/pay` from an external link).
3. Review amount, token, chain, recipient in the wallet.
4. Sign the transaction.
5. See the completion screen with the on-chain tx hash + explorer link, plus an **electronic receipt / payment record** (`電子レシート / 支払い控え`) of the payment.

**Merchant verifies receipt** in their own wallet or on the block explorer — the completion screen alone is **not** proof of payment.

### Customer-side payment receipts (`電子レシート / 支払い控え`)

When a payment completes (`/pay`, `/checkout`, `/tip`), OpenPay saves an **electronic receipt / payment record** to the **payer's own browser** (LocalStorage key `openpay:payerReceipts:v1`, capped at 200, newest-first).

View them on `/scan` and on the completion screen, with copy / print / JSON / CSV export.

- **Stored locally only — never sent to a server.** No customer wallet address or payment history is persisted on OpenPay servers. The record holds only what is needed to confirm a payment: txHash, wallet addresses, amount, item names, tax, totals. JSON export contains no secrets.
- **Separate from the merchant-side store** (`/history` / `openpay:history:v1`) and from freee sync — different key, different framing (`direction: 'paid'`). On a device that both pays and receives, both will appear; that is by design.
- If the QR carried line items (`/checkout`), the receipt shows the **itemized breakdown, per-item tax, and totals**; otherwise a single virtual line is synthesized. The txHash links to the block explorer for final confirmation.
- It **cannot be recovered** after changing devices, clearing browser data, or in private/incognito mode — print or save it to keep a copy. On `/scan` each receipt can be **deleted** individually and all receipts **cleared** at once (useful on a shared device).
- This is **not a formal receipt, tax document, or invoice.** Final treatment should be confirmed with your organization, accounting rules, or tax advisor.

## Limitations

- **Beta software** — test with small amounts first.
- **Not all wallets are guaranteed** to display every chain / token correctly.
- **Gasless depends on third-party infrastructure** (Pimlico, x402 facilitator). Outages can affect availability.
- **Network-fee estimates may differ from actual gas costs.**
- **Blockchain transactions are irreversible** — there is no chargeback.
- **USDC balances are chain-specific.**

  The payment page chain chooser (Circle Gateway / CCTP V2) bridges them when the customer's source chain differs from the merchant's, but the chain abstraction itself has Circle as a dependency — outages on Circle's attestation API will disable cross-chain paths while same-chain direct transfers keep working.

  See `docs/DEPLOY_CHECKLIST.md §10` for the operator-verification status and kill-switch.
- **Best-effort application rate limits are built in**, but they do not mitigate volumetric DoS — production deployments still need Vercel Firewall/WAF or an equivalent edge control.
- OpenPay is **not** a wallet, exchange, custodian, or redemption provider.

## Roadmap

- More tested wallets + better wallet compatibility surface
- Improved merchant receipt verification UX
- Per-chain native-gas → USDC/JPY approximate conversion in the chain chooser (currently shows gas units + token symbol only)
- More x402 / agent payment examples
- Demand-driven additional chains and tokens
- Solana cross-chain (shelved 2026-05-24 pending Circle official confirmation that Solana is a supported **source** chain for the Forwarding Service — see [`docs/research/circle-forwarding-service.md`](./research/circle-forwarding-service.md))
