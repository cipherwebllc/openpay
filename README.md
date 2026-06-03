# OpenPay

OpenPay is a **non-custodial QR payment tool** that turns JPYC / USDC wallet transfers into a simple checkout for stores, events, creators, and AI agents.

OpenPay は、JPYC / USDC のウォレット送金を、店舗・イベント向け QR 決済体験に変えるノンカストディ型 OSS 決済ツールです。

**Demo**: <https://open-pay.jp> · **Status**: Alpha · **License**: MIT

![OpenPay screenshot](./public/og-image.png)

---

## Key features

- **Non-custodial** — payments go directly to the merchant wallet; OpenPay never holds funds.
- **No wallet lock-in** — any wallet that signs standard ERC20 / ERC-4337 / EIP-7702 transactions can pay; no app install required.
- **JPYC / USDC** support (Japan's electronic payment instrument + Circle's USD stablecoin).
- **QR-locked conditions** — amount, token, chain, and recipient are pinned per QR; customers cannot mistype them.
- **Two payment modes** — Standard (customer pays gas) or Gasless (OpenPay sponsors gas via Pimlico).
- **Portal UX** — a single app with separate surfaces for paying (`/scan`), receiving (`/create`), browsing history (`/history`), and discovering on-chain services (`/explore`), all behind a shared header / bottom-nav and wallet-state badge.
- **Block explorer link** on every receipt — merchants verify on-chain truth, not just a UI screen.
- **Local transaction history** — per-browser LocalStorage history at `/history`, with filters (period / status / search), a JPY-converted GMV summary, CSV export, and a "latest 3" strip on the QR builder.
- **Accounting integration** — `/history` exports income CSV in **freee**, **Money Forward**, and **Yayoi** formats (Yayoi-native in Shift_JIS), and — opt-in via `NEXT_PUBLIC_ENABLE_FREEE_SYNC` — connects to **freee over OAuth** to push income transactions in one click. Gated behind **SIWE wallet login** (no password/account) with an idempotent "sync to freee" batch (re-clicking never double-books).
- **Reference market rate** — a lightweight strip on `/` and `/create` shows `1 USDC = ¥X.XX` via a 5-min server-cached CoinGecko proxy; `1 JPYC = ¥1.00 (peg)` is fixed.
- **Experimental x402 / agent payment** support for per-request paid APIs — with both USDC and **JPYC** assets (most x402 servers are USDC-only).
- **OSS, self-hostable** under MIT.

## Why OpenPay?

Wallet-to-wallet transfers work, but a customer-typed transfer at a checkout counter is error-prone — the wrong token, wrong chain, or off-by-one amount sends money that can't be recovered.

OpenPay generates a **QR with the amount, token, chain, and recipient fixed by the merchant**. The customer scans, reviews, signs — and funds land in the merchant's wallet directly. No new account to create, no merchant onboarding, no balance held by OpenPay.

## Payment modes

| Mode | Gas | Best for |
|---|---|---|
| **Standard payment (with gas)** | Customer pays in their own wallet (POL / ETH) | Web3 users who already hold native gas |
| **Gasless payment** | OpenPay sponsors gas via Pimlico (and Circle Paymaster for USDC on Base / Arbitrum / Optimism) | Customers who only hold the payment token |

- Gasless for **JPYC** uses OpenPay's self-hosted **EIP-3009 relayer**: the customer signs a `receiveWithAuthorization` (a plain EIP-712 signature — **no EIP-7702 delegation required**, so it works in MetaMask and other injected wallets), and the relayer forwards it to an on-chain forwarder contract that atomically pays the merchant and recovers a fixed gas-equivalent in JPYC. Live on **Polygon and Kaia** mainnet. Pimlico / EIP-7702 sponsorship remains as an automatic fallback.
- Gasless for **USDC** uses ERC-4337 + ERC-7702 — the customer's existing EOA is reused; no smart-wallet creation step. Gas is sponsored via **Pimlico** (ERC20 paymaster) or, for USDC on Base / Arbitrum / Optimism, **Circle Paymaster v0.8** (gas paid directly in USDC; OpenPay collects 0 fee). These require EIP-7702, so USDC gasless needs a chain that supports it (see the Avalanche note below).
- Standard mode is a plain ERC20 `transfer` (single transfer to the merchant).
- In gasless mode, the network-fee bearer is selectable: `gas=customer` (default) or `gas=merchant`.

## Fees

OpenPay service fee is **0% during the alpha period**, and OpenPay never charges a fee tied to the transaction amount. There are no monthly fees, minimum fees, or setup fees. Merchant funds flow directly to the merchant wallet.

In **gasless** mode, OpenPay advances the native gas (POL / KAIA / ETH) — via the **EIP-3009 relayer** for JPYC or the **Pimlico paymaster** for USDC — and recovers it as a **network-fee reimbursement collected in the payment token** (JPYC / USDC). For JPYC this reimbursement is a **fixed amount** (independent of the transaction amount; any surplus over the actual gas is not refunded) — see [docs/DEPLOY_CHECKLIST.md §9.5](./docs/DEPLOY_CHECKLIST.md). In **standard** mode the customer pays gas directly from their own wallet and OpenPay does not touch it.

A future pricing model that is **not tied to transaction volume** (e.g. a monthly subscription or a prepaid usage license such as an NFT pass / time-limited rights) is under consideration. This direction is chosen so OpenPay remains a non-custodial software / infrastructure provider rather than a payment intermediary under the Japanese Payment Services Act framework.

## Supported tokens and chains

| Token | Merchant receiving chains | Buyer-pay-from chains (cross-chain ON) | Notes |
|---|---|---|---|
| **JPYC** (v3, Japan's electronic payment instrument under the revised Payment Services Act) | Polygon, Kaia | same (no cross-chain) | Gasless via OpenPay's self-hosted **EIP-3009 relayer** (signature-based, no EIP-7702 needed) — live on Polygon + Kaia; Pimlico / 7702 sponsorship as fallback |
| **USDC** (Circle native — bridged USDC.e is **not** supported) | Base, Arbitrum, Optimism, Polygon, **Ethereum L1**, **Avalanche C-Chain** (6) | merchant 6 + **Unichain, World Chain, Sonic, Sei, HyperEVM** (11 total, via Circle Gateway / CCTP V2) | Gasless via Pimlico ERC20 Paymaster on Base / Arbitrum / Optimism / Polygon / Ethereum L1; **Circle Paymaster v0.8** runs in parallel for USDC on Base / Arbitrum / Optimism (USDC-native gas, OpenPay 0 fee). **Avalanche C-Chain is standard-mode only for now** — its EIP-7702 (ACP-209) is not yet activated on mainnet, so gasless (which relies on 7702) gracefully falls back to standard payment; it re-enables automatically once ACP-209 ships. The 5 buyer-only chains are cross-chain **sources only** (they do not appear in the merchant chain chooser). Cross-chain payments require the buyer to hold native gas (ETH/POL) on the source chain — see the cross-chain notes below. |

`NEXT_PUBLIC_NETWORK_ENV=testnet` swaps mainnets for Base / Arbitrum / Optimism Sepolia + Polygon Amoy + Kairos Testnet + Sepolia + Avalanche Fuji + Unichain Sepolia + World Chain Sepolia + Sonic Blaze Testnet + Sei Testnet + HyperEVM Testnet.

> **USDC balances are chain-specific.** The same wallet address can receive USDC on all six merchant chains, but each chain holds a separate balance. Optional chain-abstraction via Circle Gateway / CCTP V2 is available as an augmentation when the buyer's USDC is on a different chain than the merchant's selected chain (see [docs/DEPLOY_CHECKLIST.md §10](./docs/DEPLOY_CHECKLIST.md) for status and operator verification).

> **Cross-chain reach:** When the merchant enables cross-chain in the QR (default ON for USDC), customers can pay from any of **11 chains** — the 6 receiving chains plus Unichain, World Chain, Sonic, Sei, and HyperEVM. The print poster lists all 11 so customers know up-front which wallet works. Circle Gateway / CCTP V2 forwards the value to the merchant's selected receiving chain (~5–30 seconds end-to-end depending on path).

> **Cross-chain is "gas-on" for the buyer.** Same-chain payments are gasless (the buyer pays gas in USDC via the paymaster). A cross-chain payment bridges from the buyer's wallet via their own EOA, so the buyer needs the **source chain's native gas (ETH/POL etc.)** — it cannot be completed with USDC alone.

> **Ethereum L1 caveat:** USDC payments on Ethereum L1 support both gasless (Pimlico ERC20 Paymaster, customer pays gas in USDC) and standard modes. L1 gas is still 1–3 orders of magnitude higher than L2 — pick Base / Arbitrum / Optimism / Polygon for routine small-ticket flows; reserve Ethereum L1 for the cases where the buyer or merchant has a hard requirement (e.g. SBI VC Trade USDC withdrawals are L1-only).

### Payment-page UX (cross-chain chain chooser)

When a customer scans a USDC QR and has USDC on multiple chains, the payment page shows a **source-chain chooser** with the per-chain trade-offs side-by-side:

- Chain name + the customer's USDC balance on that chain
- Path badge: **Direct** (same chain as merchant, no bridge fee) · **Fast (Gateway)** (Circle Gateway, ~5s) · **Standard (CCTP V2)** (~30s)
- Fee breakdown (cross-chain paths only): Circle bridge fee + network gas token (e.g. `ブリッジ手数料 0.005 USDC + ガス代 (ETH)`) + ETA. The Direct (same-chain) option shows no extra fee line.
- A note that cross-chain paths need the source chain's native gas (ETH/POL) — USDC alone is not enough
- Pre-selected default = the auto-picked best path (direct preferred, else gateway, else CCTP V2), but the customer can override

The chooser is hidden when the customer has USDC on **only** the merchant's chain — in that case the regular Pay button handles it as a plain direct transfer. The chain abstraction layer is `lib/crossChain/*` (Circle Gateway + CCTP V2), see [`docs/DEPLOY_CHECKLIST.md §10`](./docs/DEPLOY_CHECKLIST.md) for the operator-verification status and [`docs/research/circle-12chain-addresses.md`](./docs/research/circle-12chain-addresses.md) for contract addresses + audit trail.

### Tip widget (creator surface)

Creators can embed a **Tip widget** (`/tip/[address]`) on their blog, portfolio, or GitHub README via a single `<iframe>` snippet. Same chain reach as the payment page:

- **JPYC** — receive tips on **Polygon or Kaia**. Default is Polygon; switch to Kaia in the creator dashboard chain chooser when generating the embed snippet.
- **USDC** — receive on any of **6 receiving chains** (Base / Arbitrum / Optimism / Polygon / Ethereum L1 / Avalanche C-Chain). Fans on different chains can still tip you via **cross-chain receive** (default ON) — Circle Gateway / CCTP V2 forwards the value to your selected chain. The same cross-chain path covers fans on the 5 buyer-only chains (Unichain, World Chain, Sonic, Sei, HyperEVM). Toggle cross-chain off in the dashboard if you want same-chain transfers only.

The widget is gasless-only (Pimlico sponsorship — OpenPay absorbs network gas, fans only spend the tip token). Creator-defined presets, custom thank-you message, optional webhook on success. (Because tips are gasless-only and gasless relies on EIP-7702, USDC tips on **Avalanche C-Chain** are unavailable until ACP-209 activates — fans are guided to another chain; see the Avalanche note above.)

## Non-custodial design

OpenPay **never holds** merchant funds. Customer payments are sent **directly to the merchant wallet**. OpenPay does **not** issue, redeem, custody, or exchange JPYC / USDC.

## How it works

**Routes** (i18n-prefixed under `/ja` or `/en`, e.g. `/ja/create`):

| Route | Purpose |
|---|---|
| `/` | Landing page — hero with two CTAs (📱 pay / 🏪 receive), benefits, how-it-works, FAQ |
| `/create` | Merchant QR builder + Tip widget builder + offramp links + latest-3 history strip |
| `/scan` | Customer scan-to-pay surface (QR scanner + connected-wallet balances) |
| `/history` | Local-only transaction history with CSV export |
| `/explore` | Curated directory of external stablecoin services (exchanges / DEX / dApps / bridges / explorers) |
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
5. See the completion screen with the on-chain tx hash + explorer link.

**Merchant verifies receipt** in their own wallet or on the block explorer — the completion screen alone is **not** proof of payment.

## Alpha notice

OpenPay is **alpha software**. Test with small amounts first. Blockchain transactions are **irreversible** — there is no chargeback. Always verify recipient address, token, chain, amount, and final receipt. Merchants should verify actual receipt in their wallet or on a block explorer, even after the completion screen is shown.

## Quick start

### For merchants

Just visit <https://open-pay.jp>, enter your wallet, and generate a QR. No signup.

### For developers (self-host)

```bash
git clone https://github.com/cipherwebllc/openpay
cd openpay
npm install
cp .env.local.example .env.local       # fill in values
npm run dev                            # http://localhost:3000
```

Useful scripts:

```bash
npm run typecheck
npm run lint
npm run test:run
npm run build
npm run e2e:local                      # Playwright with stub env
npm run load-test -- --url <base-url>  # zero-dep load test (p50/p90/p99, RPS, error rate)
```

## Environment variables

Minimum to run dev (more in [`.env.local.example`](./.env.local.example)):

| Variable | Purpose | Required |
|---|---|---|
| `NEXT_PUBLIC_NETWORK_ENV` | `testnet` (default) or `mainnet` | yes |
| `NEXT_PUBLIC_PIMLICO_API_KEY` | Gasless mode (<https://dashboard.pimlico.io>) | gasless only |
| `NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID` | Pimlico sponsorship policy (gasless JPYC) | gasless only |
| `NEXT_PUBLIC_FEE_RECEIVER_ADDRESS` | Operator receiver wallet — collects the JPYC gas-reimbursement for sponsored payments (unset → funds burn at 0x...dEaD) | **mainnet** |
| `NEXT_PUBLIC_WC_PROJECT_ID` | WalletConnect projectId (<https://cloud.reown.com>) | optional |
| `NEXT_PUBLIC_*_RPC_URL` | Custom RPC per chain | recommended on prod |
| `NEXT_PUBLIC_SENTRY_DSN` / `SENTRY_AUTH_TOKEN` | Sentry client + source-map upload | recommended on prod |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Vercel KV — payment log **and** SIWE sessions / freee tokens / entitlements | optional (required for SIWE + freee sync) |
| `PAYMENT_LOG_ADMIN_TOKEN` | Bearer for `/api/log/payment/export` + `/stats` + `/api/entitlement/grant` | optional |
| `NEXT_PUBLIC_ENABLE_FREEE_SYNC` | Show the freee sync panel on `/history` (default **off** — dark ship) | freee only |
| `FREEE_CLIENT_ID` / `FREEE_CLIENT_SECRET` / `FREEE_REDIRECT_URI` | freee OAuth app (server-only secret; callback `…/api/freee/callback`) | freee only |
| `SIWE_ALLOWED_DOMAINS` | Extra SIWE-login domains beyond the canonical host (localhost auto-allowed in dev) | optional |
| `ALPHA_ENTITLEMENT_BYPASS` | Open all paid features during alpha (default on; `0`/`false` to require an entitlement) | optional |
| `X402_*` | x402 paid-API config | x402 only |

**Never commit `.env.local` or private keys.** `NEXT_PUBLIC_*` values are bundled into the client — treat them as public. Production and development should use **separate** Pimlico API keys and fee receiver wallets.

## x402 / API / agent payments

OpenPay includes **experimental** x402 protocol support for per-request paid API endpoints (AI agent / API use cases — separate from the human checkout flow). `GET /api/paid/hello` returns HTTP 402; clients (e.g. `x402-fetch`) sign an EIP-3009 authorization and retry. OpenPay verifies + settles via the Coinbase facilitator before returning content. The client only signs — the facilitator submits the on-chain tx and pays gas, so agents need **no native gas** on the target chain.

**OpenPay's distinct angle — JPYC support.** The wider x402 ecosystem is largely USDC-only (Coinbase's reference and most public servers). OpenPay's x402 server also accepts **JPYC v3 on Polygon / Polygon Amoy**, making it usable for **JPY-denominated agent / API billing** without routing through a USD asset. USDC on Base / Base-Sepolia is also supported.

| Network | Asset | Status |
|---|---|---|
| `base` | USDC (Circle native) | mainnet |
| `base-sepolia` | USDC (Circle native testnet) | testnet (default) |
| `polygon` | JPYC v3 | mainnet (alpha-verified) |
| `polygon-amoy` | JPYC v3 (testnet) | testnet |

**Scope notes (different from the human checkout flow).** A paid route is pinned to **one (network, asset)** pair — agents must hold the token on that exact chain. The human checkout's Circle CCTP V2 / Gateway cross-chain bridging is **not** part of the x402 path (bridge overhead exceeds typical per-request micropayment value). Choose the network per route via `X402_NETWORK`.

Wrap your own paid route in two lines:

```ts
import { withX402Payment } from '@/lib/x402/middleware';
export const GET = withX402Payment(async () => NextResponse.json({ ok: true }));
```

Configure via `X402_*` env vars (see `.env.local.example`).

## Pimlico balance alerts

Gasless payments depend on a funded Pimlico Paymaster deposit. A GitHub Actions cron (`scripts/check-pimlico-balance.mjs`, runs every 6h) posts to a Slack/Discord webhook if Polygon, Base, or Kaia paymaster balances drop below configurable thresholds. See [`scripts/check-pimlico-balance.mjs`](./scripts/check-pimlico-balance.mjs) for setup.

## Limitations

- **Alpha software** — test with small amounts first.
- **Not all wallets are guaranteed** to display every chain / token correctly.
- **Gasless depends on third-party infrastructure** (Pimlico, x402 facilitator). Outages can affect availability.
- **Network-fee estimates may differ from actual gas costs.**
- **Blockchain transactions are irreversible** — there is no chargeback.
- **USDC balances are chain-specific.** The payment page chain chooser (Circle Gateway / CCTP V2) bridges them when the customer's source chain differs from the merchant's, but the chain abstraction itself has Circle as a dependency — outages on Circle's attestation API will disable cross-chain paths while same-chain direct transfers keep working. See `docs/DEPLOY_CHECKLIST.md §10` for the operator-verification status and kill-switch.
- **No rate limiting / bot mitigation** — front paid endpoints with Vercel BotID or similar.
- OpenPay is **not** a wallet, exchange, custodian, or redemption provider.

## Legal / disclaimer

OpenPay is **not** a wallet, exchange, custodian, or redemption provider. Users are responsible for complying with applicable laws and regulations in their jurisdiction.

- [Terms of Service / 利用規約](https://open-pay.jp/ja/terms)
- [Privacy Policy / プライバシーポリシー](https://open-pay.jp/ja/privacy)
- [Disclaimer / 免責事項](https://open-pay.jp/ja/disclaimer)
- [特定商取引法に基づく表記](https://open-pay.jp/ja/tokutei)

## Roadmap

- More tested wallets + better wallet compatibility surface
- Improved merchant receipt verification UX
- Per-chain native-gas → USDC/JPY approximate conversion in the chain chooser (currently shows gas units + token symbol only)
- More x402 / agent payment examples
- Demand-driven additional chains and tokens
- Solana cross-chain (shelved 2026-05-24 pending Circle official confirmation that Solana is a supported **source** chain for the Forwarding Service — see [`docs/research/circle-forwarding-service.md`](./docs/research/circle-forwarding-service.md))

## License

MIT. Self-hosting and forking are fully permitted under MIT. The OpenPay brand and the `open-pay.jp` domain belong to the operator and are not part of the license grant.

---

Changelog: [CHANGELOG.md](./CHANGELOG.md) · Operator deploy guide: [docs/DEPLOY_CHECKLIST.md](./docs/DEPLOY_CHECKLIST.md)
