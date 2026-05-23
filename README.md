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
- **Block explorer link** on every receipt — merchants verify on-chain truth, not just a UI screen.
- **Experimental x402 / agent payment** support for per-request paid APIs.
- **OSS, self-hostable** under MIT.

## Why OpenPay?

Wallet-to-wallet transfers work, but a customer-typed transfer at a checkout counter is error-prone — the wrong token, wrong chain, or off-by-one amount sends money that can't be recovered.

OpenPay generates a **QR with the amount, token, chain, and recipient fixed by the merchant**. The customer scans, reviews, signs — and funds land in the merchant's wallet directly. No new account to create, no merchant onboarding, no balance held by OpenPay.

## Payment modes

| Mode | OpenPay fee | Gas | Best for |
|---|---:|---|---|
| **Standard payment (with gas)** | **0.5%** | Customer pays in their own wallet (POL / ETH) | Web3 users who already hold native gas |
| **Gasless payment** | **1.0%** + estimated network fee | OpenPay sponsors gas via Pimlico Paymaster | Customers who only hold the payment token |

- OpenPay fee is **always paid by the merchant** (invisible to the customer).
- Gasless uses ERC-4337 + Pimlico + ERC-7702 — the customer's existing EOA is reused; no smart-wallet creation step.
- Standard mode is a plain ERC20 `transfer` (one for merchant, one for the OpenPay fee).
- In gasless mode, the network-fee bearer is selectable: `gas=customer` (default) or `gas=merchant`.

## Fees

- **Standard payment**: 0.5%
- **Gasless payment**: 1.0% + estimated network fee
- **No monthly fee, no minimum fee, no setup fee.**
- Merchant funds → merchant wallet directly.
- OpenPay fees → fee receiver wallet (separate transfer in the same UserOperation for gasless, second tx for standard).

## Supported tokens and chains

| Token | Supported chains |
|---|---|
| **JPYC** (v3, Japan's electronic payment instrument under the revised Payment Services Act) | Polygon, Kaia |
| **USDC** (Circle native — bridged USDC.e is **not** supported) | Base, Arbitrum, Optimism, Polygon |

`NEXT_PUBLIC_NETWORK_ENV=testnet` swaps mainnets for Base / Arbitrum / Optimism Sepolia + Polygon Amoy + Kairos Testnet.

> **USDC balances are chain-specific.** The same wallet address can receive USDC on all four chains, but each chain holds a separate balance. Optional chain-abstraction via Circle Gateway / CCTP V2 is available as an augmentation when the buyer's USDC is on a different chain than the merchant's selected chain (see [docs/DEPLOY_CHECKLIST.md §10](./docs/DEPLOY_CHECKLIST.md) for status and operator verification).

## Non-custodial design

OpenPay **never holds** merchant funds. Customer payments are sent **directly to the merchant wallet**. OpenPay service fees are sent **separately** to the fee receiver wallet. OpenPay does **not** issue, redeem, custody, or exchange JPYC / USDC.

## How it works

**Merchant**:
1. Open <https://open-pay.jp> (or self-host).
2. Enter the merchant wallet address.
3. Enter the amount, select token + chain + payment mode.
4. Show or share the QR code or payment link.

**Customer**:
1. Scan the QR.
2. Review amount, token, chain, recipient in their wallet.
3. Sign the transaction.
4. See the completion screen with the on-chain tx hash + explorer link.

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
```

## Environment variables

Minimum to run dev (more in [`.env.local.example`](./.env.local.example)):

| Variable | Purpose | Required |
|---|---|---|
| `NEXT_PUBLIC_NETWORK_ENV` | `testnet` (default) or `mainnet` | yes |
| `NEXT_PUBLIC_PIMLICO_API_KEY` | Gasless mode (<https://dashboard.pimlico.io>) | gasless only |
| `NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID` | Pimlico sponsorship policy (gasless JPYC) | gasless only |
| `NEXT_PUBLIC_FEE_RECEIVER_ADDRESS` | OpenPay fee receiver wallet | **mainnet** |
| `NEXT_PUBLIC_WC_PROJECT_ID` | WalletConnect projectId (<https://cloud.reown.com>) | optional |
| `NEXT_PUBLIC_*_RPC_URL` | Custom RPC per chain | recommended on prod |
| `NEXT_PUBLIC_SENTRY_DSN` / `SENTRY_AUTH_TOKEN` | Sentry client + source-map upload | recommended on prod |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Vercel KV for the alpha payment log | optional |
| `PAYMENT_LOG_ADMIN_TOKEN` | Bearer for `/api/log/payment/export` + `/stats` | optional |
| `X402_*` | x402 paid-API config | x402 only |

**Never commit `.env.local` or private keys.** `NEXT_PUBLIC_*` values are bundled into the client — treat them as public. Production and development should use **separate** Pimlico API keys and fee receiver wallets.

## x402 / API / agent payments

OpenPay includes **experimental** x402 protocol support for per-request paid API endpoints (AI agent / API use cases — separate from the human checkout flow). `GET /api/paid/hello` returns HTTP 402; clients (e.g. `x402-fetch`) sign an EIP-3009 USDC authorization and retry. OpenPay verifies + settles via the Coinbase facilitator before returning content.

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
- **USDC balances are chain-specific** until chain-abstraction is your default UX. Optional Circle Gateway / CCTP V2 augmentation is available; see `docs/DEPLOY_CHECKLIST.md`.
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
- Per-browser local payment history + CSV export
- Smoother USDC chain selection UX
- Further Circle Gateway / CCTP V2 chain-abstraction research
- More x402 / agent payment examples
- Demand-driven additional chains and tokens

## License

MIT. Self-hosting and forking are fully permitted under MIT. The OpenPay brand and the `open-pay.jp` domain belong to the operator and are not part of the license grant.

---

Changelog: [CHANGELOG.md](./CHANGELOG.md) · Operator deploy guide: [docs/DEPLOY_CHECKLIST.md](./docs/DEPLOY_CHECKLIST.md)
