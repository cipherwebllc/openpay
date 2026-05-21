# OpenPay

<div align="center">
  <img src="overview.png" alt="OpenPay" width="100%" />
</div>

**OpenPay is a non-custodial QR payment tool that turns JPYC / USDC wallet transfers into a simple checkout experience for stores, events, creators, and agents.**

**OpenPay は、JPYC / USDC のウォレット送金を、店舗・イベント向けの QR 決済体験に変えるノンカストディ型 OSS 決済ツールです。**

OpenPay does not hold merchant funds. Customer payments are sent **directly to the merchant wallet**; OpenPay service fees are sent **separately** to the fee receiver wallet.

- 🌐 **Site**: <https://open-pay.jp>
- 💻 **Repo**: <https://github.com/cipherwebllc/openpay>
- 📜 **License**: MIT
- 🚧 **Status**: Alpha — test with small amounts first.

---

## What OpenPay does

- Create payment **QR codes** with amount, token, chain, and recipient fixed
- Accept **JPYC / USDC** payments **directly to the merchant wallet**
- Reduce mistyped amounts, wrong tokens, wrong chains, and wrong recipients vs. manual wallet transfers
- Support **standard payments** (customer pays gas) and **gasless payments** (OpenPay sponsors gas)
- Cover **stores, events, creator tip widgets, API endpoints, and AI agents (x402)**

## Why OpenPay

- Wallet transfers work, but they are not a good store experience: customers mistype the amount, pick the wrong token, choose the wrong chain, or send to the wrong address.
- OpenPay turns a wallet transfer into a clearer checkout flow with the merchant-fixed parameters embedded in the QR.
- **No custody.** OpenPay never holds, settles, or routes merchant funds.
- **Bring your own wallet.** WalletConnect v2, EIP-6963, Coinbase Wallet, MetaMask etc. all work — no wallet lock-in.

## Payment modes

| Mode | OpenPay fee | Gas | Best for |
| --- | --- | --- | --- |
| **Standard** (`mode=standard`) | **0.5%** | Customer pays in their own wallet (POL / ETH) | Web3 users with native gas |
| **Gasless** (`mode=gasless`) | **1.0%** + estimated network fee | OpenPay sponsors gas. Network fee billed to customer (default) or merchant via `gas=customer` / `gas=merchant` | Cleaner checkout, customers without native gas |

- OpenPay fee is **always paid by the merchant** (invisible to the customer).
- Gasless uses ERC-4337 (Account Abstraction) + Pimlico Paymaster + ERC-7702 — the customer's existing EOA balance is reused; no smart-wallet creation step.
- Standard mode is a plain ERC20 `transfer` × 2 (merchant + fee), no smart account / paymaster.

## Fees

- **Standard**: 0.5%
- **Gasless**: 1.0% + estimated network fee
- **No monthly fee, no minimum fee**
- Merchant funds → merchant wallet (direct)
- OpenPay fees → fee receiver wallet (separate transfer in the same UserOperation for gasless, second tx for standard)

## Supported tokens / chains

| Token | Chains |
| --- | --- |
| **JPYC** (v3, electronic payment instrument under Japan's revised Payment Services Act) | Polygon |
| **USDC** (Circle native — bridged USDC.e is **not** supported) | Base, Arbitrum, Optimism, Polygon |

`NEXT_PUBLIC_NETWORK_ENV=testnet` swaps mainnets for Base / Arbitrum / Optimism Sepolia + Polygon Amoy. Same chain slug, same QR shape.

### Kaia network — under evaluation (not enabled)

JPYC officially launched on the Kaia network (chainId 8217) in May 2026, with JPYC EX supporting Kaia deposits / redemptions, and JPYC has since extended JPYC Faucet to Kairos testnet (2026-05-18) — making developer iteration on Kaia free. We are tracking inflow signals (Unifi / LINE NEXT light-user adoption) before enabling Kaia in OpenPay. A code-level PoC (chain config / multi-chain JPYC scaffolding / unit tests / live-network verification scripts) lives on the `kaia-poc` branch — `scripts/verify-kaia-jpyc.mjs` and `scripts/verify-kaia-pimlico.mjs` already validate the JPYC v3 deployment on Kaia mainnet and Pimlico Kaia bundler capability, but **no live Kaia UserOp has been submitted yet**, so the final smoke + production cutover are gated to demand materialization. If you want OpenPay to accept JPYC on Kaia, please open a GitHub issue — concrete requests count as demand signal.

## Non-custodial design

- OpenPay **never holds** merchant funds.
- Customer payments are sent **directly to the merchant wallet**.
- OpenPay service fees are sent **separately** to the fee receiver wallet.
- OpenPay does **not** issue, redeem, custody, or exchange JPYC / USDC.
- Source is MIT-licensed and self-hostable.

## Alpha notice

- OpenPay is **alpha software**.
- **Test with small amounts first.**
- Blockchain transactions are **irreversible** — there is no chargeback.
- Always verify merchant wallet address, token, chain, amount, and final receipt.
- After the completion screen, merchants should verify actual receipt in their wallet or on the block explorer.
- The optional `/history` page shows recent payments **per browser** (LocalStorage). The blockchain is always the source of truth.

## Quick start (merchants)

1. Open <https://open-pay.jp/> (or your self-hosted instance)
2. Enter your **merchant wallet address**
3. Enter the **amount**
4. Select **token** and **chain**
5. Select **payment mode** (gasless or standard)
6. Show or share the **QR code or payment link**
7. Customer pays from their wallet
8. Verify receipt in your wallet or on the block explorer

A "store-mode" QR (no fixed amount, customer types) and a "fixed-amount" QR (one QR per product) are both supported. Creators can also embed the `/tip` widget as a one-line `<iframe>`.

## Quick start (developers)

```bash
git clone https://github.com/cipherwebllc/openpay
cd openpay
npm install
cp .env.local.example .env.local      # fill in values
npm run dev                            # http://localhost:3000
```

Useful scripts:

```bash
npm run typecheck
npm run lint
npm run test:run
npm run build
npm run e2e:local                      # build with stub env + run Playwright
```

Tech: Next.js 15 App Router · TypeScript · viem / wagmi · ERC-4337 + Pimlico · next-intl (ja / en) · Tailwind · Vitest + Playwright.

Available routes (locale-prefixed, `ja` / `en`): `/`, `/pay`, `/tip`, `/history`, `/scan` (experimental, pre-connect PWA), `/checkout` (experimental), `/terms`, `/privacy`, `/disclaimer`, `/tokutei`, and `/api/paid/*` (x402).

## Pre-connect PWA / Scan mode (experimental — alpha)

**Hypothesis** (Phase 1): if a customer connects a wallet ahead of time, the time spent at the register is reduced from ~15 s ("open wallet app → open camera → scan QR → approve connect → sign") to ~3 s ("tap PWA icon → scan QR → sign").

To validate this:

- Open `/scan` (e.g. <https://open-pay.jp/ja/scan>) and connect a wallet via WalletConnect / Coinbase Wallet / injected
- "Add to Home Screen" (iOS Safari share menu, or Android Chrome `Install app`)
- At the register: tap the PWA icon, scan the merchant QR with the in-browser camera (`qr-scanner`, no app switching), and the URL is validated + you land on `/pay` with your wallet still connected

Security:

- Only same-origin URLs to `/pay`, `/tip`, `/checkout` deep-link automatically; external origins show a confirmation banner with `target="_blank"` + `noopener noreferrer`.
- `ethereum:` (EIP-681) URIs are rejected in Phase 1 (use a wallet such as MetaMask Mobile directly for those).
- `javascript:` / `data:` / unknown payloads are surfaced as "unrecognized" with the raw text shown — they never trigger navigation.
- Camera permission is requested only on the explicit "Start camera" gesture (no auto-prompt). The fallback "Paste URL" field works without camera permission on kiosk / keyboard-only devices.

Limitations:

- iOS Safari evicts `localStorage` after ~7 days of inactivity; the WalletConnect session may need re-approving after a long pause.
- `display-mode: standalone` shortcuts in the manifest are honored by Android Chrome but ignored by iOS Safari.
- This is **demand-gated experimental UX**. If usage signal does not validate the hypothesis within ~4 weeks, the `/scan` route and `qr-scanner` dependency are easy to roll back (single revert).

## Environment variables

Minimum to run dev:

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_NETWORK_ENV` | `testnet` (default) or `mainnet` |
| `NEXT_PUBLIC_PIMLICO_API_KEY` | Required for gasless. <https://dashboard.pimlico.io> |
| `NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID` | Pimlico sponsorship policy ID (gasless JPYC) |
| `NEXT_PUBLIC_FEE_RECEIVER_ADDRESS` | OpenPay fee receiver wallet (**required on mainnet**) |
| `NEXT_PUBLIC_WC_PROJECT_ID` | WalletConnect projectId from <https://cloud.reown.com> |

Optional (operations / observability):

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_*_RPC_URL` | Custom RPC per chain (recommended for production) |
| `NEXT_PUBLIC_SENTRY_DSN` | Sentry client DSN |
| `SENTRY_AUTH_TOKEN` | **Sensitive.** Sentry source-map upload token — always set as Sensitive in Vercel |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Vercel KV (Upstash Redis) for alpha payment log |
| `PAYMENT_LOG_ADMIN_TOKEN` | Bearer token for `/api/log/payment/export` |
| `X402_*` | x402 paid-API config (see next section) |

**Never commit `.env.local`.** Never commit private keys. `NEXT_PUBLIC_*` values are bundled into the client — treat them as public.

See `.env.local.example` for the full list with notes.

## x402 / API / agent payments

OpenPay also includes experimental x402 protocol support for **per-request paid API endpoints** (AI agent / API use cases — not a human checkout).

`GET /api/paid/hello` returns **HTTP 402 Payment Required** with x402 payment requirements. A client (e.g. an AI agent using `x402-fetch`) signs an EIP-3009 USDC authorization, retries with the `X-PAYMENT` header, and OpenPay verifies + settles via the Coinbase facilitator before returning content.

Wrap your own paid route:

```ts
// app/api/paid/hello/route.ts
import { NextResponse, type NextRequest } from 'next/server';
import { withX402Payment } from '@/lib/x402/middleware';

export const runtime = 'nodejs';

async function handler(_req: NextRequest) {
  return NextResponse.json({ message: 'paid content' });
}

export const GET = withX402Payment(handler, { description: 'My paid endpoint' });
```

Local check:

```bash
# unpaid → 402 + accepts
curl -i http://localhost:3000/api/paid/hello

# dev bypass (blocked in production by startup guard)
X402_TEST_MODE=true npm run dev
curl http://localhost:3000/api/paid/hello   # → 200 + JSON
```

Configure via `X402_*` env vars (see `.env.local.example`). On facilitator outage, OpenPay returns **HTTP 503** rather than 500 so standard x402 clients do not infinite-retry.

## Security / limitations

- Always verify recipient address, token, chain, and amount.
- Blockchain transactions are **irreversible**. There is **no chargeback**.
- Gasless payments depend on third-party infrastructure (Pimlico, x402 facilitator). Outages can affect availability.
- Network fee estimates may differ from actual on-chain cost.
- OpenPay is **not** a wallet, exchange, custodian, or redemption provider.
- x402 replay protection relies on the EIP-3009 token-contract nonce + facilitator. No nonce DB is kept server-side.
- Rate limiting / bot mitigation is **not** included — use Vercel BotID or a similar layer in front of paid endpoints.

## Legal / disclaimer

- OpenPay is provided **as-is** as alpha software.
- Users are responsible for compliance in their own jurisdiction.

- [Terms of Service / 利用規約](https://open-pay.jp/ja/terms)
- [Privacy Policy / プライバシーポリシー](https://open-pay.jp/ja/privacy)
- [Disclaimer / 免責事項](https://open-pay.jp/ja/disclaimer)
- [特定商取引法に基づく表記](https://open-pay.jp/ja/tokutei)

## License

MIT.

Self-hosting and forking are fully permitted under MIT. The OpenPay brand and the `open-pay.jp` domain belong to the operator and are not part of the license grant.

---

Changelog: [CHANGELOG.md](./CHANGELOG.md)
