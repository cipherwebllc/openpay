# Circle Gateway 評価レポート (research artifact)

**作成日**: 2026-05-22
**phase**: research (Tier B = 1 day equivalent)
**対象**: OpenPay の実験トラック (AI agent / x402 / chain abstraction) としての Circle Gateway 採用評価
**結論**: Conditional Go (実験トラック限定。本線 USDC 直接転送には不適合)

---

## 1. Executive Summary

Circle Gateway は **2025-08-19 mainnet GA 済み** の USDC 統一残高 (unified balance) プロダクト。OpenPay が使う 4 chain (**Polygon, Base, Arbitrum, Optimism**) 全部が mainnet サポート対象で、contract address は全 EVM chain で同一 (`0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE` mainnet)。**permissionless smart contract 直叩き path が公式に提供されており KYC 不要**、日本居住者を排除する条項なし、SDK は 3 日前更新で活性。fee は **0.5 bps + chain gas** (early access 期間 = ~2026-06-30 まで)。

ただし重要な caveat:
1. **x402 公式統合は proposal 段階 (live ではない)** — Coinbase facilitator は Gateway burnIntent を verify しないため、x402 連携には自前 facilitator が必要
2. **Deposit finality が L2 で 13-19 分** — Circle marketing の「<500ms」は deposit 後の transfer のみで、初回 deposit 時の UX は遅い
3. **EOA signature only** — OpenPay の HashPort wallet (Alchemy MAv2 + EIP-7702) との互換性は未検証
4. **SDK は ethers v5 系** (`@ethersproject/*`) で OpenPay の viem stack と部分混在
5. **Pre-deposit が必須の architecture** = customer → merchant の one-shot 決済 (OpenPay 本線) には適合せず

戦略的位置付け: **AI agent / x402 / chain abstraction の実験トラックとして PoC branch を 1 つ作る価値あり**。本線統合は (a) Coinbase facilitator の Gateway 対応, (b) HashPort SCA delegate での burnIntent sign 実機検証, (c) Circle SDK license terms 確認 の 3 gate を経てから検討。

---

## 2. 製品概要 (混同回避用)

OpenPay コンテキストで関連する Circle 製品を区別:

| 製品 | 性質 | KYC | OpenPay との関係 |
|---|---|---|---|
| **CCTP** (Cross-Chain Transfer Protocol) | permissionless smart contract burn-and-mint | 不要 | native USDC の前提 |
| **Circle Mint** | fiat ↔ USDC 法定通貨換金 | 必須 (KYB) | 無関係 |
| **Circle Wallets** | MPC custodial wallet サービス | dev KYB 必須 | 使わない |
| **Circle Gateway** ★今回対象 | 統一 USDC 残高 (pre-deposit → 任意 chain で消費) | 不要 (contract 直叩き path 公開) | 実験トラック候補 |

Gateway は CCTP V2 の上位 layer ではなく **別 architecture**: CCTP V2 が per-tx の burn-and-mint なのに対し、Gateway は事前 deposit → unified balance → 任意 chain で instant mint。詳細は §10 比較表参照。

---

## 3. KYC / 利用資格

### 3.1 確認済 facts

- 公式 docs に「**Circle Gateway is fully permissionless, and you can start integrating with it immediately with no sign-up needed**」と明記 (source: https://developers.circle.com/gateway)
- `viem` + EOA private key 経路では Circle API key も不要、smart contract + attestation API のみで動作可能 (source: https://developers.circle.com/gateway/quickstarts/unified-balance)
- Acceptable Use Policy の restricted territories: Cuba / Iran / North Korea / Crimea / Donetsk / Luhansk / Kherson / Zaporizhzhia + 制裁国のみ。**日本は対象外** (source: https://www.circle.com/legal/acceptable-use-policy)
- Service Terms は KYC 文言を直接書かず「on-boarding policies」に委譲、個人 vs 法人の明示的区別なし。"Customer = you or your entity" として個人開発者 signup 想定 (source: https://console.circle.com/legal/service-terms)
- Circle Console アカウント取得は email 確認のみ、KYC 不要 (`CIRCLE_API_KEY` + `CIRCLE_ENTITY_SECRET` は quickstart 経路 = SDK 簡易使用時のみ必要)

### 3.2 Unverified / 注意点

- attestation API (`/v1/transfer`, `/v1/balances`) の **レート制限・地域別 access policy** は docs に明記なし。日本 IP から実機検証が必須
- Gateway 自体には Circle Mint / Wallets のような **KYB triggering 金額閾値** の言及なし。ただし TOS 上 Circle は「on-boarding policies」を後から bolt-on する余地を持っている

### 3.3 OpenPay への意味

個人開発者として PoC を実施可能。AI agent / 個人 user 想定のユースケースで Gateway を使うことに **規約上の障害は現時点で無い**。本番投入時に「Circle が attestation API を地域制限する可能性」を residual risk として認識すべき。

---

## 4. Chain サポート

公式 supported blockchains (source: https://developers.circle.com/gateway/references/supported-blockchains, https://developers.circle.com/gateway/references/contract-addresses):

### 4.1 Mainnet (12 chains)

Ethereum, Avalanche, OP, Arbitrum, Solana, Base, Polygon PoS, Unichain, Sonic, World Chain, Sei, HyperEVM

### 4.2 Testnet (13 chains)

Ethereum Sepolia, Avalanche Fuji, OP Sepolia, Arbitrum Sepolia, Solana Devnet, Base Sepolia, Polygon Amoy, Unichain Sepolia, Sonic Testnet, World Chain Sepolia, Sei Atlantic, HyperEVM Testnet, Arc Testnet (mainnet 未公開)

### 4.3 OpenPay 4 chain 対応状況

| Chain | Mainnet | Testnet |
|---|---|---|
| Polygon PoS | ✅ | ✅ (Amoy) |
| Base | ✅ | ✅ (Sepolia) |
| Arbitrum | ✅ | ✅ (Sepolia) |
| Optimism | ✅ | ✅ (Sepolia) |

4 chain すべて mainnet + testnet 両対応。

### 4.4 Contract addresses (全 EVM chain で同一)

- Mainnet GatewayWallet: `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE`
- Mainnet GatewayMinter: `0x2222222d7164433c4C09B0b0D809a9b52C04C205`
- Testnet GatewayWallet: `0x0077777d7EBA4688BDeF3E311b846F25870A19B9`
- Testnet GatewayMinter: `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B`

**実装上の意味**: chain ごとに contract address を持つ必要なし。`TOKEN_DEPLOYMENTS` のような config 不要。

---

## 5. Mainnet GA 状況

- **mainnet launch: 2025-08-19** (Circle X 公式: https://x.com/circle/status/1957789650174484867)
- 「early access period」と branding、**2026-06-30 23:59 ET まで** continue (source: https://www.circle.com/gateway, https://developers.circle.com/gateway/references/fees)
- production 推奨は wording 弱め: "live on mainnet" だが SLA / uptime guarantee は **公式コミット無し**
- Day-1 mainnet partners (10): Aori, Blockradar, Daimo, Dfns, Eco, Fireblocks, Particle Network, Rath Finance, Rockaway, Superform
- **Failsafe**: 7-day trustless withdrawal — Gateway API が落ちても 7 日後 depositor が contract から直接出金可能

### 5.1 OpenPay への意味

mainnet GA 済みだが「early access」名目なので **production 利用は self-risk**。OpenPay は実験トラック限定で testnet → mainnet beta の順に。SLA 未確定が長期化する場合、本線投入の判断は保留が妥当。

---

## 6. 価格 / Fee 構造

公式 fee table (source: https://developers.circle.com/gateway/references/fees):

| 項目 | 金額 |
|---|---|
| Cross-chain transfer fee | **0.005% (0.5 bps)** on amount (early access 中) |
| Source chain gas | $0.001 (Sei/Unichain) ~ $2.00 (Ethereum)。L2 は $0.01-0.10 想定 [unverified 具体値] |
| Forwarding service fee (Circle が destination chain gas を立替) | $0.20/tx flat + 相当 gas |
| Same-chain transfer (deposit/withdraw 同一 chain) | **無料** |
| Subscription / monthly | なし |
| Testnet | 無料想定 [unverified] |

### 6.1 試算

- 月 1 万 tx × 平均 $5 transfer → 0.5 bps × $50,000 = **$2.5/month + gas**
- per-tx fee: $5 × 0.00005 = $0.00025 + gas
- AI agent micropayment ($0.001 per call) の場合: fee は 0.5 bps × $0.001 = **$0.0000005** で fee は実質無視できる、gas が支配的

### 6.2 OpenPay への意味

x402 の per-call micropayment 用途 ($0.001-0.01 単価) で fee は実用範囲内。ただし L2 gas を depositor の unified balance から引かれる仕様 = sender の bookkeeping を考える必要あり。

---

## 7. x402 Protocol との統合状況

### 7.1 確認済 facts

- **x402 公式統合は live ではない (proposal 段階)** — Circle blog (2026) に「proposal を x402 GitHub に提出」と記載 (source: https://www.circle.com/blog/enabling-machine-to-machine-micropayments-with-gateway-and-usdc)
- Coinbase 公式 facilitator (CDP) の現サポート: ERC-20 payments on **Base, Polygon, Arbitrum, World, Solana** w/ USDC + EURC。**Gateway burnIntent 形式は verify/settle 対象外** (source: https://docs.cdp.coinbase.com/x402/core-concepts/facilitator)
- Circle 独自の x402 facilitator endpoint は公開されていない
- `@coinbase/x402-next`, `x402-fetch` packages に Gateway-specific integration なし [unverified, training-time]

### 7.2 OpenPay への意味

x402 alpha plan (`/.claude/plans/iridescent-munching-tower.md`) を実装する場合、**Coinbase facilitator は使うが Gateway は通らない**。Gateway を payment source に加えるなら:

- Option A: **自前 facilitator** 実装 (Gateway burnIntent 受信 → attestation 取得 → destination mint → x402 response)
- Option B: Coinbase facilitator の Gateway 対応を待つ (timeline 不明)

OpenPay が x402 alpha を進める順序 = Coinbase facilitator で動かす → 後日 Gateway plugin として A を実装、が現実的。

---

## 8. Latency / Settlement Timing

### 8.1 公式 marketing と実態

- 公式: **「<500ms cross-chain transfer」** (source: https://developers.circle.com/gateway/concepts/technical-guide)
- **重要 caveat**: この 500ms は **deposit finality 後の transfer 部分のみ**

### 8.2 Deposit finality (実際の UX 待ち時間)

| Chain | Finality |
|---|---|
| Polygon PoS | ~8 秒 (2-3 blocks) |
| Base | ~13-19 分 (ETH L1 finality 依存、約 65 blocks) |
| Arbitrum | ~13-19 分 (同上) |
| Optimism | ~13-19 分 (同上) |

source: https://developers.circle.com/cctp/concepts/finality-and-block-confirmations

### 8.3 Attestation 有効期間

- attestation: **10 分**
- burnIntent 自体に `maxBlockHeight` (期限) と `maxFee` (上限) 持つ → 失効・高 fee 時は invalid

### 8.4 Failure / API down 時

- **7-day fallback withdrawal**: Gateway attestation API が落ちても depositor が contract から直接出金可能

### 8.5 OpenPay への意味

「初回 deposit は L2 で 13-19 分待つ」のが UX の boundary。AI agent が事前に balance を温めておく前提なら問題なし。one-shot 決済 (customer → merchant 即時) には不適合 = **本線非適合の理論的根拠**。

---

## 9. EIP-712 BurnIntent Format

### 9.1 Domain

source: https://developers.circle.com/gateway/concepts/technical-guide

```json
{
  "name": "GatewayWallet",
  "version": "1",
  "chainId": <source chain ID>,
  "verifyingContract": "<mainnet 0x77777777... or testnet 0x0077777d...>"
}
```

### 9.2 BurnIntent Struct

```
BurnIntent {
  maxBlockHeight: uint256,     // source chain expire block
  maxFee:         uint256,     // Circle が collect できる最大 fee
  spec:           TransferSpec
}

TransferSpec {
  // source / destination domain, contracts, tokens, amounts
  // depositor, recipient, amount を含む
}
```

### 9.3 Signer 制約 ★OpenPay 重要事項

- **EOA signature only**
- SCA (Smart Contract Account) を使う場合は **EOA delegate を別途追加する必要**

### 9.4 OpenPay HashPort wallet との互換性 (要実機検証)

memory `project_hashport_target.md` の HashPort wallet 構成:
- Alchemy MAv2 で EIP-7702 EOA delegate

**理論上の対応可否**:
- EIP-7702 で EOA に delegated code を付ける場合、署名者は EOA のまま → Gateway の「EOA only」要件は **満たすはず**
- bare ERC-4337 SCA (UserOperation 経由) は EOA delegate 別途追加必須 → 通常の 4337 wallet (Pimlico SimpleAccount 等) は **delegate 経路の検証が必要**

→ Tier C (PoC) phase で **HashPort 実機検証** を必須項目に。

### 9.5 Audit

ChainSecurity 2025-07-08: https://6778953.fs1.hubspotusercontent-na1.net/hubfs/6778953/CCTP/%5BPublic%5D%20%5BChainSecurity%5D%20Circle_Gateway_audit.pdf

### 9.6 GitHub source

https://github.com/circlefin/evm-gateway-contracts (Apache-2.0, pushed 2026-01-23)

---

## 10. SDK / Library

### 10.1 公式 npm package

source: https://www.npmjs.com/package/@circle-fin/unified-balance-kit

| 項目 | 値 |
|---|---|
| Name | `@circle-fin/unified-balance-kit` |
| Latest version | 1.1.2 |
| Published | 2026-05-19 頃 (= 3 days ago, **極めて活性**) |
| Unpacked size | 1.8 MB |
| License | **Proprietary** ★要確認 |
| TypeScript types | あり |

### 10.2 Dependencies

- `@circle-fin/provider-gateway-v1@1.0.5`
- `@ethersproject/address`, `@ethersproject/bytes`, `@ethersproject/units` (= **ethers v5 系**)
- `@solana/web3.js@^1.98.4`
- `abitype@^1.1.0`, `bs58@6.0.0`, `zod@3.25.67`

### 10.3 OpenPay stack との適合性

- OpenPay は **viem 中心 stack** (viem 2.x + wagmi v2 + Pimlico)
- Circle SDK は `@ethersproject/*` 経由 = **bundle に ethers v5 の subpackages が追加される**
- 致命的ではないが bundle 増・cognitive overhead 増
- 代替: lower-level `@circle-fin/provider-gateway-v1` 単独で直接使う、または viem で contract + attestation API を素実装

### 10.4 License 注意点

`license: "Proprietary"` (npm package.json 上)。商用利用に制限がある可能性。**Circle に直接 license terms を確認すべき** (Tier C 前提条件)。

---

## 11. 競合技術との比較

公式比較: https://www.circle.com/blog/choosing-between-circle-gateway-and-cctp-with-forwarding-service-for-crosschain-usdc

| 観点 | Circle Gateway | CCTP V2 | LayerZero/Stargate | Across |
|---|---|---|---|---|
| 仕組み | pre-deposit → unified balance → instant mint | burn-and-mint (per-tx) | LP-based bridge | solver/auction |
| Transfer latency (deposit 済後) | <500ms | Fast Transfer: 秒〜分 | 分単位 | 秒〜分 |
| Deposit latency (L2) | 13-19 分 | 不要 (per-tx) | 不要 | 不要 |
| 中央集権度 | Circle attestation 必須 | Circle attestation 必須 | LayerZero oracles | permissionless solver |
| 用途 | unified balance, AI agent, x402 | one-shot transfer, payouts | 汎用 bridge | intent-based |
| Cost | 0.5 bps + gas | gas only (V2 fast は別途) | LP fee + gas | solver fee |
| Pre-funding | **必要** | 不要 | 不要 | 不要 |

### 11.1 Gateway の独自価値

「pre-deposit して unified balance を持つ → recipient chain 側に sender の USDC が無くても instant mint」。AI agent が **「どの chain でも消費できる pool」を持てる** ことが核心。

### 11.2 OpenPay 本線 (customer → merchant 即時決済) への不適合

- customer は買い物の瞬間にしか USDC 持っていない (pre-deposit overhead = UX 破綻)
- 「any chain で消費」の merits は merchant 側にあるが、merchant 側を Gateway custody にすると **直接着金 brand value (memory: `project_fee_model.md`) を毀損**

= **本線非適合 / 実験トラック適合** という当初仮説は完全に正しい。

---

## 12. 開発者体験 (DX)

- Developer dashboard: https://console.circle.com/signup (Circle 全製品共通 console)
- Sandbox: 公開 testnet で直接動作、`@circle-fin/unified-balance-kit` + testnet USDC faucet (https://faucet.circle.com/) で開始可能
- API key: Circle Console 登録のみ、KYC 不要
- Quickstart: https://developers.circle.com/gateway/quickstarts/unified-balance — 8 testnet 対応コード掲載
- LLM-friendly docs: https://developers.circle.com/llms.txt (= AI agent 統合との親和性高い)
- GitHub `circlefin/evm-gateway-contracts`: Apache-2.0, last commit 2026-01-23, stars 10 (official org なので stars 数は参考にならず)
- Audit (ChainSecurity 2025-07-08) 公開済

### 12.1 OpenPay への意味

PoC 開始の障壁は低い。Tier B research では testnet 経路の `curl` 検証まで実施せず、Tier C (PoC) phase の最初の sprint で 1 周動かせる粒度。

---

## 13. Sources Consulted

### Circle 公式
- https://developers.circle.com/gateway
- https://developers.circle.com/gateway/concepts/technical-guide
- https://developers.circle.com/gateway/quickstarts/unified-balance
- https://developers.circle.com/gateway/references/contract-addresses
- https://developers.circle.com/gateway/references/supported-blockchains
- https://developers.circle.com/gateway/references/fees
- https://developers.circle.com/cctp/concepts/finality-and-block-confirmations
- https://developers.circle.com/llms.txt
- https://www.circle.com/gateway
- https://www.circle.com/blog/circle-gateway-redefining-crosschain-ux
- https://www.circle.com/blog/a-practical-guide-to-building-with-circle-gateway
- https://www.circle.com/blog/enabling-machine-to-machine-micropayments-with-gateway-and-usdc
- https://www.circle.com/blog/choosing-between-circle-gateway-and-cctp-with-forwarding-service-for-crosschain-usdc
- https://www.circle.com/blog/nanopayments-powered-by-circle-gateway-is-now-live-on-mainnet
- https://www.circle.com/legal/acceptable-use-policy
- https://console.circle.com/legal/service-terms
- https://x.com/circle/status/1957789650174484867

### npm / GitHub
- https://www.npmjs.com/package/@circle-fin/unified-balance-kit
- https://github.com/circlefin/evm-gateway-contracts

### x402 / Coinbase
- https://docs.cdp.coinbase.com/x402/core-concepts/facilitator

### Audit
- https://6778953.fs1.hubspotusercontent-na1.net/hubfs/6778953/CCTP/%5BPublic%5D%20%5BChainSecurity%5D%20Circle_Gateway_audit.pdf

### Faucet
- https://faucet.circle.com/

---

## 14. Outstanding Unknowns (= residual research items)

Tier B research では確証取得できなかった item。Tier C (PoC) phase で実機検証する必要あり。

1. Circle attestation API の正式 base URL (host 名) — docs 上は path (`/v1/transfer`, `/v1/balances`) のみ
2. attestation API のレート制限・**日本 IP からの access policy**
3. Testnet 料金が無料か明示なし
4. Coinbase 公式 facilitator の Gateway 対応 timeline (`coinbase/x402#447` の内容)
5. Polygon / Base / Arbitrum / Optimism 各 chain の実測 attestation latency
6. Circle が独自 x402 facilitator を hosting する予定の有無
7. `@circle-fin/unified-balance-kit` の Proprietary license の正確な許諾範囲 (商用利用制限の有無)
8. **HashPort wallet (Alchemy MAv2 + EIP-7702 delegate) での burnIntent sign 実機成否** ★最重要

---

## 15. Go/No-Go Assessment

### 実験トラック (AI agent / x402 / chain abstraction) 用途: **Conditional Go**

**Pros (Go 寄り根拠)**:

1. mainnet GA 済み (2025-08-19), OpenPay 4 chain 全対応、contract address 全 EVM chain 同一 → 実装が直線的
2. **permissionless smart contract path 公式存在、KYC 不要、日本居住者 OK** → 個人開発者 PoC 可能
3. SDK 3 日前更新で極めて活性、testnet 経路完備 → PoC 2-3 日粒度
4. 0.5 bps + gas は AI agent micropayment として現実的
5. EIP-712 spec + ChainSecurity audit + Apache-2.0 contracts で transparency 確保

**Cons / Caveats**:

1. **x402 公式統合は proposal 段階** — Gateway を x402 source にするなら自前 facilitator 必須
2. **Deposit finality が L2 で 13-19 分** — "<500ms" marketing は誤読されやすい
3. **EOA signature only** — HashPort 互換性は実機検証必須
4. SDK が ethers v5 系 = viem stack と部分混在 (bundle bloat)
5. **Proprietary license** = 商用化想定なら license terms 確認必須
6. **Pre-deposit overhead** = OpenPay 本線非適合、demand-first 原則 (memory: `feedback_demand_first.md`) からも実験トラック限定を守るべき

### 本線投入の Gate

実験 → 本線昇格には以下 **3 つすべて** が条件:
- [ ] Coinbase 公式 facilitator の Gateway 対応 GA
- [ ] HashPort SCA delegate での burnIntent sign 実機成功
- [ ] Circle SDK license terms (商用利用) 確認 OK

### 結論

「AI agent / x402 / chain abstraction 用の実験トラックとして 1 つ PoC branch を作る」価値あり。**OpenPay 本線 (USDC 直接転送) 経路は今のまま CCTP / Gateway なしで継続が妥当**。

---

## 16. Next Step

→ `docs/research/circle-gateway-decision.md` (本 evaluation を踏まえた Go/No-Go 判断 + next phase scope) を参照。
