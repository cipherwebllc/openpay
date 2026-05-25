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

| Token | Merchant receiving chains | Buyer-pay-from chains (cross-chain ON) | Notes |
|---|---|---|---|
| **JPYC** (v3, Japan's electronic payment instrument under the revised Payment Services Act) | Polygon, Kaia | same (no cross-chain) | Gasless via Pimlico Sponsorship Paymaster |
| **USDC** (Circle native — bridged USDC.e is **not** supported) | Base, Arbitrum, Optimism, Polygon, **Ethereum L1** (5) | merchant 5 + **Avalanche C-Chain, Unichain** (7 total, via Circle Gateway) | Gasless via Pimlico ERC20 Paymaster on all 5 merchant chains (Ethereum L1 included since 2026-05). Avalanche / Unichain are buyer-source only (do not appear in merchant chain chooser) |

`NEXT_PUBLIC_NETWORK_ENV=testnet` swaps mainnets for Base / Arbitrum / Optimism Sepolia + Polygon Amoy + Kairos Testnet + Sepolia + Avalanche Fuji + Unichain Sepolia.

> **USDC balances are chain-specific.** The same wallet address can receive USDC on all five merchant chains, but each chain holds a separate balance. Optional chain-abstraction via Circle Gateway / CCTP V2 is available as an augmentation when the buyer's USDC is on a different chain than the merchant's selected chain (see [docs/DEPLOY_CHECKLIST.md §10](./docs/DEPLOY_CHECKLIST.md) for status and operator verification).

> **Cross-chain reach:** When the merchant enables cross-chain in the QR (default ON for USDC), customers can pay from any of **7 chains** — the 5 receiving chains plus Avalanche C-Chain and Unichain. The print poster lists all 7 so customers know up-front which wallet works. Circle Gateway forwards the value to the merchant's selected receiving chain (~5–30 seconds end-to-end depending on path).

> **Ethereum L1 caveat:** USDC payments on Ethereum L1 support both gasless (Pimlico ERC20 Paymaster, customer pays gas in USDC) and standard modes. L1 gas is still 1–3 orders of magnitude higher than L2 — pick Base / Arbitrum / Optimism / Polygon for routine small-ticket flows; reserve Ethereum L1 for the cases where the buyer or merchant has a hard requirement (e.g. SBI VC Trade USDC withdrawals are L1-only).

### Payment-page UX (cross-chain chain chooser)

When a customer scans a USDC QR and has USDC on multiple chains, the payment page shows a **source-chain chooser** with the per-chain trade-offs side-by-side:

- Chain name + the customer's USDC balance on that chain
- Path badge: **Direct** (same chain as merchant, no service fee) · **Fast (Gateway)** (Circle Gateway, ~5s) · **Standard (CCTP V2)** (~30s)
- Fee breakdown: USDC service fee + network gas token (e.g. `0.005 USDC + ガス代 (ETH)`) + ETA
- Pre-selected default = the auto-picked best path (direct preferred, else gateway, else CCTP V2), but the customer can override

The chooser is hidden when the customer has USDC on **only** the merchant's chain — in that case the regular Pay button handles it as a plain direct transfer. The chain abstraction layer is `lib/crossChain/*` (Circle Gateway + CCTP V2), see [`docs/DEPLOY_CHECKLIST.md §10`](./docs/DEPLOY_CHECKLIST.md) for the operator-verification status and [`docs/research/circle-12chain-addresses.md`](./docs/research/circle-12chain-addresses.md) for contract addresses + audit trail.

### Tip widget (creator surface)

Creators can embed a **Tip widget** (`/tip/[address]`) on their blog, portfolio, or GitHub README via a single `<iframe>` snippet. Same chain reach as the payment page:

- **JPYC** — receive tips on **Polygon or Kaia**. Default is Polygon; switch to Kaia in the creator dashboard chain chooser when generating the embed snippet.
- **USDC** — receive on any of **5 receiving chains** (Base / Arbitrum / Optimism / Polygon / Ethereum L1). Fans on different chains can still tip you via **cross-chain receive** (default ON) — Circle Gateway / CCTP V2 forwards the value to your selected chain. The same cross-chain path covers fans on Avalanche C-Chain and Unichain (the 2 buyer-only chains). Toggle cross-chain off in the dashboard if you want same-chain transfers only.

The widget is gasless-only (Pimlico sponsorship — OpenPay absorbs network gas, fans only spend the tip token). Creator-defined presets, custom thank-you message, optional webhook on success.

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
- **USDC balances are chain-specific.** The payment page chain chooser (Circle Gateway / CCTP V2) bridges them when the customer's source chain differs from the merchant's, but the chain abstraction itself has Circle as a dependency — outages on Circle's attestation API will disable cross-chain paths while same-chain direct transfers keep working. See `docs/DEPLOY_CHECKLIST.md §10` for the operator-verification status and kill-switch.
- **No rate limiting / bot mitigation** — front paid endpoints with Vercel BotID or similar.
- OpenPay is **not** a wallet, exchange, custodian, or redemption provider.

## Legal / disclaimer

OpenPay is **not** a wallet, exchange, custodian, or redemption provider. Users are responsible for complying with applicable laws and regulations in their jurisdiction.

- [Terms of Service / 利用規約](https://open-pay.jp/ja/terms)
- [Privacy Policy / プライバシーポリシー](https://open-pay.jp/ja/privacy)
- [Disclaimer / 免責事項](https://open-pay.jp/ja/disclaimer)
- [特定商取引法に基づく表記](https://open-pay.jp/ja/tokutei)

## Development workflow

OpenPay の変更は以下の 3 段階で進める。各段階の承認が次段階の前提。

### 1. 計画レビュー (plan review)

1. Opus が `plan mode` で実装計画を提示
2. `/gpt-plan-review` で GPT による独立 review を取得
3. 指摘点を計画に反映 (`/Users/masia/.claude/plans/*.md` を更新)
4. 再度 `/gpt-plan-review` を実行し、**approved** を得る

### 2. 実装レビュー (code review)

1. Opus が計画通りに実装
2. 関連する Playwright e2e + `node scripts/run-tests.mjs` で動作確認
3. `/gpt-review` で diff の独立 review を取得
4. 指摘点を実装に反映
5. 再度 `/gpt-review` を実行し、**approved** を得る

### 3. デプロイ (deploy)

1. `git commit` + `git push origin main`
2. Vercel が auto-deploy (typecheck / lint / build / bundle budget は CI で gating)
3. `docs/DEPLOY_CHECKLIST.md §3` の post-deploy smoke を実行

> 例外: hotfix 等で計画 review を省略する場合は commit message にその旨を明記。
> code review (`/gpt-review`) は省略しない。

## Roadmap

- More tested wallets + better wallet compatibility surface
- Improved merchant receipt verification UX
- Per-browser local payment history + CSV export
- Per-chain native-gas → USDC/JPY approximate conversion in the chain chooser (currently shows gas units + token symbol only)
- More x402 / agent payment examples
- Demand-driven additional chains and tokens
- Solana cross-chain (shelved 2026-05-24 pending Circle official confirmation that Solana is a supported **source** chain for the Forwarding Service — see [`docs/research/circle-forwarding-service.md`](./docs/research/circle-forwarding-service.md))

## License

MIT. Self-hosting and forking are fully permitted under MIT. The OpenPay brand and the `open-pay.jp` domain belong to the operator and are not part of the license grant.

---

Changelog: [CHANGELOG.md](./CHANGELOG.md) · Operator deploy guide: [docs/DEPLOY_CHECKLIST.md](./docs/DEPLOY_CHECKLIST.md)
