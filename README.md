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
| **JPYC** (v3, electronic payment instrument under Japan's revised Payment Services Act) | Polygon, Kaia |
| **USDC** (Circle native — bridged USDC.e is **not** supported) | Base, Arbitrum, Optimism, Polygon |

`NEXT_PUBLIC_NETWORK_ENV=testnet` swaps mainnets for Base / Arbitrum / Optimism Sepolia + Polygon Amoy + Kairos Testnet. Same chain slug, same QR shape.

### Kaia network — supported

JPYC officially launched on the Kaia network (chainId 8217) in May 2026, with JPYC EX supporting Kaia deposits / redemptions and JPYC Faucet covering Kairos testnet (2026-05-18). Combined with the LINE NEXT Unifi wallet adopting JPYC (2026-05-22) — bringing Web3-native JPYC payments to ~100M LINE users without installing a separate wallet app — OpenPay enables JPYC on Kaia as a merchant-selectable chain alongside Polygon. The JPYC v3 contract (`0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29`) is the same address as Polygon (cross-chain consistency, verified via `scripts/verify-kaia-jpyc.mjs`), and gasless flows go through Pimlico Kaia bundler + sponsorship paymaster (`scripts/verify-kaia-pimlico.mjs` confirms capability). Merchants select JPYC + Kaia in Step 1 of the QR generator just like they would Polygon. MAv2-delegated wallets (e.g. HashPort) currently route to other chains via a defensive UI guard since Pimlico Kaia does not support MAv2 at this time.

### Cross-chain USDC receive (Circle Gateway + CCTP V2) — phase 2 投入済 (2026-05-24)

Merchant が **受信 chain を 1 つ指定** すれば、Buyer は **任意の USDC 4 chain (Base / Arbitrum / Optimism / Polygon)** から支払い可能。OpenPay は buyer wallet 接続後に balance を 4 chain 並列 + Circle Gateway unified balance API で query し、最適 path を decision tree で自動選択:

| Decision | 経路 | latency | 前提 |
|---|---|---|---|
| **direct** | 既存 ERC20 transfer (同一 chain) | 0 (current UX 維持) | buyer が target chain で十分残高 |
| **gateway** | Circle Gateway burnIntent → attestation → mint | <500ms (deposit 済後) | buyer が事前 deposit 済 |
| **cctp-v2** | CCTP V2 Fast Transfer (per-tx burn-mint) | 8-20s | buyer が他 chain で USDC 保有 |
| **onramp** | 既存 `OnrampCta` | — | 残高なし fallback |

Merchant は QR 生成画面の高度な設定で **「他チェーンからの支払を許可」toggle** (default ON) を operate 可能。OFF 時は URL に `crossChain=false` が付き、Buyer 側 PaymentForm が cross-chain hint を出さない (同一 chain 直接送金のみ accept)。

**Buyer 側**: `/pay?to=...&token=usdc&amount=10&chain=base` で direct path 不可時に **CrossChainHint** が代替経路 (Gateway/CCTP V2) と「Pay with Circle Gateway」button を表示、click で sign + attest + mint まで自動。Merchant address は普通の EOA で着金する (非カストディアル維持)。

**Experimental demo route** (operator 検証用): `NEXT_PUBLIC_EXPERIMENTAL_CROSS_CHAIN_ENABLED=true` で `/[locale]/experimental/cross-chain-demo` が mount され、Gateway deposit + transfer を手動で 1 周検証できる。

**Incident kill switch**: `NEXT_PUBLIC_CROSS_CHAIN_DISABLED=true` で全 buyer に対し CrossChainHint を非表示化 (Circle attestation API 障害等で). **Next.js 仕様で `NEXT_PUBLIC_*` は build-time → Vercel auto rebuild ~2-5 min 待ち**。真の "instant disable" は Vercel Dashboard "Instant Rollback" (~10s) を first option として使う。詳細は [`docs/DEPLOY_CHECKLIST.md`](./docs/DEPLOY_CHECKLIST.md) §10.6b 参照。

**aggregator (1inch / LI.FI 等で USDT/ETH → USDC swap)** は明示的に未対応。2025 改正資金決済法 (2026 施行) の「暗号資産サービス仲介業 (媒介)」登録対象になるリスク濃厚のため、本機能は USDC ↔ USDC の chain abstraction に限定 (memory `reference_jp_crypto_intermediary_regulation`)。

詳細仕様 + operator 検証 checklist は [`docs/DEPLOY_CHECKLIST.md`](./docs/DEPLOY_CHECKLIST.md) §10、設計判断 + LARP audit 結果は `.claude/plans/cross-chain-usdc-receive.md` 参照。

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
| `PAYMENT_LOG_ADMIN_TOKEN` | Bearer token for `/api/log/payment/export` + `/api/log/payment/stats` |
| `X402_*` | x402 paid-API config (see next section) |
| `NEXT_PUBLIC_CIRCLE_GATEWAY_API_URL` / `NEXT_PUBLIC_CIRCLE_IRIS_API_URL` | Circle attestation API host override (default: NETWORK_ENV で mainnet/testnet 自動選択) |
| `NEXT_PUBLIC_CROSS_CHAIN_MAX_FEE_BPS` / `NEXT_PUBLIC_CROSS_CHAIN_BLOCK_OFFSET_DEFAULT` | Cross-chain fee cap (default 10 bps) / Gateway burnIntent block offset (default chain-aware: Polygon/Base/OP=600, Arbitrum=5000) |
| `NEXT_PUBLIC_EXPERIMENTAL_CROSS_CHAIN_ENABLED` | Experimental demo route mount control (default false) |
| `NEXT_PUBLIC_CROSS_CHAIN_DISABLED` | Incident kill switch for cross-chain UI (default empty = enabled). ⚠ Next.js NEXT_PUBLIC_* は build-time inline、auto rebuild ~2-5 min 必要 (instant disable には Vercel Dashboard "Instant Rollback" を使う) |

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

## Pimlico 残高アラート設定手順

OpenPay は Pimlico Sponsorship Paymaster の EntryPoint v0.7 deposit が枯渇すると JPYC sponsorship 経路が動かなくなる。GitHub Actions cron で 6h ごとに残高をチェックし、しきい値以下なら Slack/Discord 互換 webhook に通知する仕組みを `.github/workflows/pimlico-balance.yml` + `scripts/check-pimlico-balance.mjs` で提供する。

**必須 secrets** (GitHub Settings → Secrets and variables → Actions → New repository secret):

| Secret | 内容 |
|---|---|
| `PIMLICO_PAYMASTER_POLYGON` | Polygon mainnet 上の Pimlico paymaster address |
| `PIMLICO_PAYMASTER_BASE` | Base mainnet 上の Pimlico paymaster address |
| `ALERT_WEBHOOK_URL` | Slack incoming webhook or Discord webhook URL |

**任意 secrets** (chain を opt-in):

| Secret | 内容 | 未設定時の挙動 |
|---|---|---|
| `PIMLICO_PAYMASTER_KAIA` | Kaia mainnet 上の Pimlico paymaster address | Kaia の balance check を skip (Polygon/Base のみ実行) |
| `POLYGON_RPC_URL` | Polygon mainnet RPC URL | `https://polygon-rpc.com` (公開) |
| `BASE_RPC_URL` | Base mainnet RPC URL | `https://mainnet.base.org` (公開) |
| `KAIA_RPC_URL` | Kaia mainnet RPC URL | `https://public-en.node.kaia.io` (公開) |

**任意 variables** (Settings → Secrets and variables → Actions → Variables、しきい値の override):

| Variable | 既定 | 用途 |
|---|---|---|
| `ALERT_THRESHOLD_POL` | `5` | Polygon paymaster 残高がこの値 (POL) 以下で alert |
| `ALERT_THRESHOLD_ETH` | `0.01` | Base paymaster 残高がこの値 (ETH) 以下で alert |
| `ALERT_THRESHOLD_KAIA` | `5` | Kaia paymaster 残高がこの値 (KAIA) 以下で alert |

**動作**:

- 6h ごと (cron `0 */6 * * *`) に自動実行
- scheduled run で必須 secret 未設定なら graceful skip (本番投入前は workflow が fail メールを送らない)
- `workflow_dispatch` (Actions タブから手動 trigger) では必須 secret 未設定は明示的に fail
- alert 内容: 🚨 emoji + chain ごとの現在残高 + しきい値 + デポジット推奨メッセージ

新 chain を追加するときの手順:

1. `scripts/check-pimlico-balance.mjs` の `CHAIN_CONFIGS` array に entry を追加
2. `.github/workflows/pimlico-balance.yml` の `env:` block に新 secret/var を追加
3. 本 README 表に新 chain の secret/var 名を追記
4. `tests/scripts/check-pimlico-balance.test.ts` に当該 chain の case を追加

## Security / limitations

- Always verify recipient address, token, chain, and amount.
- Blockchain transactions are **irreversible**. There is **no chargeback**.
- Gasless payments depend on third-party infrastructure (Pimlico, x402 facilitator). Outages can affect availability.
- Network fee estimates may differ from actual on-chain cost.
- OpenPay is **not** a wallet, exchange, custodian, or redemption provider.
- x402 replay protection relies on the EIP-3009 token-contract nonce + facilitator. No nonce DB is kept server-side.
- Rate limiting / bot mitigation is **not** included — use Vercel BotID or a similar layer in front of paid endpoints.
- **Cross-chain** (Gateway / CCTP V2) は Circle attestation API への信頼に依存。attestation 取得後 mint まで完了する保証は Circle 側の SLA 次第。失敗時の depositor 救済は Gateway: 7-day trustless withdrawal、CCTP V2: attestation 取得後 24h+ 任意時点で再 mint 可能。
- **Supply chain risks**: 2026-05-24 時点で `npm audit --omit=dev` は **HIGH 0 / MOD 16 / LOW 13** (残 29 件は 2 root [`postcss@8.4.31` Next.js 内部 + `uuid <11.1.1` MetaMask/WalletConnect tree] からの transitive、実 exploit パスなし)。詳細は [`docs/SUPPLY_CHAIN_RISKS.md`](./docs/SUPPLY_CHAIN_RISKS.md)。

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
