# Circle Forwarding Service — Tier B research

**Date**: 2026-05-24
**Phase gate**: phase 4b-2 (Solana integration) Go/No-Go decision
**Status**: **No-Go (as currently defined in plan) / Conditional Go (if scope pivoted to "Solana-only-buyer support via Forwarding Service on EVM source")**

> ⚠ 重要訂正: phase plan が前提にしていた「**Solana を source として Forwarding Service が destination EVM で mint 代行する**」path は、**Circle 公式 launch 時点 (2026-01-22) の destination chain list に Solana が含まれていない** + 「Solana を source とした forwarding 経路」を docs / launch blog ともに **明示していない**。さらに Forwarding Service 自体が **2026-01-22 時点で testnet GA のみ** (mainnet 拡大は "H1 2026" 予告)。phase 4b-2 の "Forwarding Service が Solana → EVM の最後の壁を埋める" という前提は **現段階で公式裏付けなし**。

---

## TL;DR (1 段落 recommendation)

Circle Forwarding Service は **2026-01-22 に発表された CCTP V2 add-on** で、`depositForBurnWithHook` に "cctp-forward" マジックバイトを付けて burn すると Circle が destination chain で **mint を自動代行** するサービス。$0.20 flat の service fee + destination gas を sender が `maxFee` (USDC) で前払いする model。EVM 系 chain で testnet 完備、mainnet 拡大は 2026-H1 中の予告だが本評価時点 (2026-05-24) で **mainnet GA / 価格表 / production iris-api host への正式公開を確認できず**。**致命的問題: Circle 公式 docs / launch blog は Forwarding Service の destination chain として Solana を含むが、source chain として Solana を扱う記述・コード例ともに見当たらない**。技術的には Solana CCTP V2 program `TokenMessengerMinterV2` (`CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe`) に `deposit_for_burn_with_hook` instruction (Apache-2.0) が存在し、hook_data に "cctp-forward" を載せれば Circle が attestation を発行する物理的余地はあるが、**Circle が Solana 発の forwarding を正式サポートしている公式声明は本調査で発見できず**。さらに Phantom wallet 側は通常の Solana tx として sign するため raw bytes 警告問題はない (Solana wallet UX は問題なし)。**Recommendation: phase 4b-2 は現状 No-Go。Solana → EVM の Forwarding Service support について Circle に直接書面照会** (developers.circle.com support form) **して "Solana source + EVM destination が GA / roadmap / out-of-scope のどれか" の正式回答を得るまで着手保留**。

---

## 1. Existence / GA status

### 1.1 正式 product 名

**"Circle Forwarding Service for CCTP"** (= 単に "Forwarding Service" / "Crosschain Forwarding Service")。
- ✅ 公式 product として存在
- ✅ docs page あり: https://developers.circle.com/cctp/concepts/forwarding-service
- ✅ how-to guide あり: https://developers.circle.com/cctp/howtos/transfer-usdc-with-forwarding-service
- ✅ 公式 launch blog: https://www.circle.com/blog/introducing-our-new-crosschain-forwarding-service-now-integrated-into-cctp (**2026-01-22 公開**)

別名は使われていない (Cross-Chain Forwarder / Mint Relayer / Auto-mint 等は公式語彙ではない)。

### 1.2 GA / Beta / Alpha 状況

| 環境 | 状況 | 出典 |
|---|---|---|
| Testnet | ✅ 利用可能 (例: Base Sepolia → Avalanche Fuji の動作 sample 公式提供) | how-to guide (iris-api-sandbox URL 使用) |
| Mainnet | ⚠ "expanding to additional products by end of H1 2026" — **launch 時点で mainnet 全面 GA は明言なし** | launch blog (2026-01-22) |
| Production iris-api host (`iris-api.circle.com`) | サポートしているかは forwarding-service docs では未確認 | 一般 CCTP V2 API は production host 有り、forwarding 経路の production 公開は **UNKNOWN — needs direct Circle outreach** |

**現実態 (2026-05-24 時点)**: testnet GA、mainnet rollout 進行中だが Forwarding Service が production host で fully live かは公式裏付けなし。

### 1.3 Solana → EVM Gateway flow との関係 ★最重要

phase 4b-2 plan が前提にしていた「**Solana 上 BurnIntent → Circle attestation → 自動で EVM の gatewayMint**」path は、**Circle Gateway** ではなく **CCTP V2 + Forwarding Service** の組合せ。Gateway と Forwarding Service は **別 product**:

- **Gateway** (`@circle-fin/unified-balance-kit`): pre-deposit → unified balance → 任意 chain で instant mint。**buyer 側 pre-deposit が必須** = OpenPay 本線非適合 (`circle-gateway-evaluation.md` §11.2)
- **Forwarding Service** (`@circle-fin/provider-cctp-v2` 経路または直接 contract 呼び出し): per-tx で burn-and-mint、Circle が destination 側 mint tx を自動 broadcast、source 側 finality を待つ

phase plan の "BurnIntent" 用語は **Gateway 側の語彙**。CCTP V2 + Forwarding Service には BurnIntent 概念はなく、source chain で `depositForBurnWithHook(hook_data = "cctp-forward" + dst_params)` を発行 → Circle が attestation 後に自動で destination mint。

### 1.4 Solana source + EVM destination の確証状況

**未確認**:
1. Forwarding Service docs (`concepts/forwarding-service`) の Solana 言及は **destination 側のみ**: 「When the destination blockchain is Solana, the `mintRecipient` parameter in `depositForBurnWithHook` must be the recipient's USDC Associated Token Account (ATA) address」(出典: 同 docs)
2. Launch blog (2026-01-22) の supported destination list: Arbitrum, Avalanche, Base, Ethereum, HyperEVM, Ink, Linea, Monad, OP Mainnet, Polygon PoS, Sei, Sonic, Unichain, World Chain — **Solana 不在**
3. How-to guide のコード例は Base Sepolia → Avalanche Fuji (両端 EVM)。Solana 発のサンプルは **本調査時点で存在を確認できず**

**技術的可能性**:
- ✅ Solana CCTP V2 program `TokenMessengerMinterV2` (`CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe`) は `deposit_for_burn_with_hook` instruction を実装済 (Apache-2.0 / 公式 source 確認: https://github.com/circlefin/solana-cctp-contracts/blob/master/programs/v2/token-messenger-minter-v2/src/token_messenger_v2/instructions/deposit_for_burn_with_hook.rs)
- ✅ `hook_data: Vec<u8>` を任意で渡せる
- ⚠ ただし Circle の attestation service が Solana 発の hook_data を **"cctp-forward" として認識する** かは公式仕様で明言なし

→ **理論上可能だが Circle が公式に "Solana source → EVM destination + Forwarding" を support しているとは確認できず**。要 Circle 直接照会。

---

## 2. Pricing

### 2.1 公式 fee 構造 (how-to / concepts docs より)

| 項目 | 金額 | source |
|---|---|---|
| **Service fee (flat)** | **$0.20 per transfer** ("All chains") | https://developers.circle.com/cctp/concepts/forwarding-service |
| **Destination chain gas** | 動的、destination 側 gas price 連動 (`forwardFee.low/med/high` で取得) | how-to guide |
| **CCTP protocol fee** | 別途 (Fast Transfer 用の minimum fee + flexible fee) | concepts docs |
| **Currency** | **USDC on source chain** (sender が `maxFee` パラメータに含めて burn 時に supply、Circle が destination で deduct) | how-to guide |
| **Who pays** | **Sender (buyer)** — destination で mint される額が "transfer amount − fees" になる | concepts docs: "Recipient receives net amount" |

### 2.2 動的 fee 取得 API

```
GET https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/{sourceDomain}/{destDomain}?forward=true
```

Response 例 (testnet):
```json
[
  {
    "finalityThreshold": 1000,
    "minimumFee": 1.3,
    "forwardFee": {
      "low": 206035,
      "med": 207543,
      "high": 209052
    }
  }
]
```

`forwardFee` は USDC 単位の最小桁 (6 decimals)。`forwardFee.med` = 207543 → **$0.207543** = destination gas + $0.20 service fee 程度を意味する (Avalanche Fuji destination 例)。

### 2.3 価格 fluctuation 注意

公式注記: "forwardFee values fluctuate based on destination chain gas prices. Make the query immediately before initiating your transfer" — buyer が UI で見積もりを見た時刻と burn tx 着金時刻の間に変動するため、**maxFee に buffer を持たせる必要**。

### 2.4 OpenPay UX への意味

- AI agent micropayment 用途 ($0.001-0.01) に対し $0.20 flat は **20-200% overhead** = AI agent には経済的に成立しない
- 通常の Solana → EVM 決済 ($5-50 想定) なら $0.20 fee = 0.4-4% で許容範囲
- ただし sender (= 顧客) が「$10 払ったのに $9.79 着金」のような **fee 透明化 UX** が必要 (OpenPay 既存 fee model = `project_fee_model.md` と整合性確認要)

---

## 3. API contract

### 3.1 API endpoint (testnet)

| 用途 | endpoint | method |
|---|---|---|
| Fee 見積もり | `https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/{src}/{dst}?forward=true` | GET |
| Message status / forward tx hash 取得 | `https://iris-api-sandbox.circle.com/v2/messages/{srcDomain}?transactionHash={burnTxHash}` | GET |

### 3.2 Production host

- 一般 CCTP V2 API の production host: `https://iris-api.circle.com` (確認済 from CCTP technical guide)
- **Forwarding Service が production host で公開されているかは forwarding 専用 docs に明示なし** = UNKNOWN, needs direct Circle outreach

### 3.3 Payload format

Forwarding Service 自体は **API call 不要**: source chain で `depositForBurnWithHook(amount, dstDomain, mintRecipient, dstCaller, maxFee, finalityThreshold, hook_data)` を発行するだけ。`hook_data` の先頭に "cctp-forward" マジックバイトを置けば Circle attestation サービスが自動 trigger。

具体 hook_data 仕様 (how-to guide より):
- マジックバイト: `cctp-forward` (ASCII)
- 続けて destination 側パラメータ encoding (recipient address, fee 上限 等)

### 3.4 同期 / 非同期

**完全非同期 (polling 必須)**:
1. Source で burn tx submit
2. Source finality 到達待ち (chain 依存: Polygon ~ 8 秒、Base/Arb/Op = 13-19 分、Solana ~ 12.8 秒 finalized commitment)
3. Circle attestation 取得
4. Circle が destination で mint tx を自動 submit
5. Client は `/v2/messages/{srcDomain}?transactionHash=...` を 2 秒間隔で polling、`forwardTxHash` field が現れたら完了

polling 例 (how-to guide のコード):
```typescript
let mintTx;
while (!mintTx) {
  const res = await fetch(
    `https://iris-api-sandbox.circle.com/v2/messages/6?transactionHash=${burnTx}`
  );
  const data = await res.json();
  if (data.messages?.[0]?.forwardTxHash) {
    mintTx = data.messages[0].forwardTxHash;
  } else {
    await new Promise(r => setTimeout(r, 2000));
  }
}
```

### 3.5 Auth

**Auth 不要 (testnet, GET endpoint)** — how-to guide は API key / OAuth ヘッダなしの単純 fetch を示している。これは CCTP V2 attestation API 全般の特性 (permissionless)。

### 3.6 Rate limit

**docs に明示なし** = UNKNOWN, needs direct Circle outreach。production 投入前に CCTP V2 API 全般の rate limit policy を Circle support に照会。

---

## 4. License / 商用利用条件

### 4.1 On-chain contracts (Apache-2.0)

- EVM 側 contracts: https://github.com/circlefin/evm-cctp-contracts (Apache-2.0)
- Solana 側 programs: https://github.com/circlefin/solana-cctp-contracts (Apache-2.0、最終 push 2026-04-03)
- **embedding 制約なし、商用利用 OK**

### 4.2 npm SDK

`@circle-fin/provider-cctp-v2` v1.8.2 (published 2026-05-18):
- **`license` field 不在** (npm registry 経由で確認、`license: None`)
- npm 慣例で UNLICENSED 相当 = 全権利留保
- 但し phase 1 の Gateway 実装 (`lib/crossChain/`) 同様、**viem + fetch で SDK を回避し直接実装可能** (decision doc §2.1 で同じ整理済)
- ABI fragments は公開 Solidity から factual 派生 (著作権非対象)
- 上記 SDK 回避戦略を取れば license 問題は依存しない

### 4.3 Service Terms (Circle Console)

- https://console.circle.com/legal/service-terms
- "Customer = you or your entity" — 個人 / 法人区別なし、3rd party 商用利用に明示禁止条項なし
- Acceptable Use Policy 制裁国除外: Cuba / Iran / North Korea / Crimea / Donetsk / Luhansk / Kherson / Zaporizhzhia (日本は対象外)
- **KYC 要件: forwarding service docs では KYC 明示要求なし**。CCTP V2 全般が permissionless contract path

### 4.4 OpenPay 非カストディアル設計との整合性

- ✅ buyer の funds が Circle custody に一切渡らない (burn-and-mint で在庫を持たない)
- ✅ recipient address を tx に直接埋め込む = merchant 直接着金可能
- ✅ Forwarding Service は purely 自動化 layer = カストディ性質を加えない

**判定: OpenPay 非カストディアル原則と矛盾なし**。

---

## 5. Solana wallet sign compatibility

### 5.1 sign 経路の構造

**重要: Phantom / Solflare が Solana CCTP V2 program を呼ぶ場合、署名対象は通常の Solana transaction (Anchor instruction 経由)**。EIP-712 や raw bytes signMessage は **不使用**。

具体的には:
- `TokenMessengerMinterV2` program の `deposit_for_burn_with_hook` instruction を Anchor IDL で呼ぶ
- params は Borsh-serialized struct (`#[repr(C)] AnchorDeserialize`)
- ユーザ wallet は通常の `signTransaction` で署名 — Phantom の見慣れた UI (program ID, accounts, SOL/SPL balance change preview)

### 5.2 Phantom UX に問題なし

- raw bytes `signMessage` (0xff prefix Gateway 仕様) は **使わない** = phase plan の懸念は不適用
- Phantom は recognized Solana programs について blue tick / 自然な preview を出す
- TokenMessengerMinterV2 は **circlefin org 公式** + 既に多数の Solana dApp で使用実績 → "unrecognized" 警告は出ない見込み (実機検証必要)

### 5.3 Anchor / Borsh の意味

phase plan の "BurnIntent serialization 形式 (Anchor / Borsh / raw bytes)" 質問への回答:
- **Anchor (Borsh)** が正解
- raw bytes 経路は不要
- Anchor IDL: https://github.com/circlefin/solana-cctp-contracts (target/idl/ 配下に生成される)

### 5.4 既知の wallet UX 問題

調査時点で **Phantom / Solflare 側の CCTP V2 関連 reported issue は発見できず**。検索結果は phantom + signMessage + raw bytes 関連の Ledger 連携問題 (Solana issue #35583) のみで、CCTP V2 program 経由なら無関係。

### 5.5 Sponsored CCTP Deposits (重要参考)

OpenZeppelin が 2025-12-12 監査完了した "Sponsored CCTP Deposits from Solana" program (https://www.openzeppelin.com/news/sponsored-cctp-deposits-from-solana-audit) は、operator が rent_fund PDA で **temporary account の rent を立替** することで **ユーザが SOL を持っていなくても Solana 発 CCTP burn を発行可能** にする design。

これは circlefin 公式 repo には **未取り込み** (確認: `programs/v2/` 配下は message-transmitter-v2 と token-messenger-minter-v2 の 2 つのみ、sponsored 系なし)。**3rd party (おそらく Squads / Daimo / similar) が開発した拡張**で、OpenZeppelin 監査済みだが Circle 公式運用ではない。

**OpenPay implications**:
- もし phase 4b-2 を進める場合、Solana-only ユーザ (SOL も持たない pure SPL USDC ユーザ) を救うには sponsored-cctp 系の operator (= OpenPay 自身か 3rd party) を運用する必要が出てくる可能性大
- これは phase 4b-2 の scope を「Circle Forwarding Service 統合」から「Solana-side sponsored deposit infrastructure + Forwarding」へ膨張させる重大な scope creep risk

---

## 6. Bundle size / dependency impact

### 6.1 OpenPay 既存 bundle baseline

(OpenPay は viem + wagmi v2 + Reown AppKit stack。Solana 系 dep は未導入と想定。)

### 6.2 必要となる Solana deps (npm registry 確認、2026-05-24)

| Package | Latest | License | Unpacked size | 用途 |
|---|---|---|---|---|
| `@solana/web3.js` | 1.98.4 (v2.0.0 は `next` tag のみ) | Apache-2.0 | **11.15 MB** | RPC client、transaction 構築 |
| `@solana/spl-token` | 0.4.14 | Apache-2.0 | 1.93 MB | SPL USDC balance / ATA |
| `@solana/wallet-adapter-react` | 0.15.39 | Apache-2.0 | 225 KB | Phantom/Solflare React adapter |
| `@coral-xyz/anchor` (Circle SDK 経由) | 0.31.x | Apache-2.0 | ~3-4 MB (推定) | TokenMessengerMinterV2 IDL 呼び出し |
| `@circle-fin/provider-cctp-v2` (optional) | 1.8.2 | **UNLICENSED** | 1.8 MB | Circle 公式 helper (回避可能) |
| Total (Circle SDK 抜き) | — | — | **~16-18 MB unpacked** | gzip 後で client bundle 1.5-2.5 MB 増の見込み |

### 6.3 @solana/web3.js v1 vs v2

- v1.x = 現行 stable (1.98.4, 2025-06-10 publish)
- v2.0.0 = `next` dist-tag のみ (未 stable promote)
- v2 は完全 tree-shakable、bundle 大幅縮減を狙った新 architecture だが **breaking** (Anchor / wallet-adapter / SPL Token 全部 v1 前提)
- **2026-05-24 時点で v1 採用が現実的**。phase 4b-2 着手なら v1。v2 待ちで scope を 1 年遅延させるか、v1 で着手して v2 移行を future scope とするか選択

### 6.4 OpenPay 既存 stack への影響

- viem 2.x stack と Solana stack は完全独立 (互換性問題なし)
- ただし bundle size 1.5-2.5 MB 増 (gzip 後) は **/pay route の初期 load を体感的に遅延** させる可能性
- 対策: dynamic import で Solana adapter を Solana chain 選択時のみ load、checkout chain selector で chain 確定後に lazy load

### 6.5 Tree-shaking 注意

`@solana/web3.js` v1 は CommonJS-ish exports で tree-shaking が弱い。実際の bundle 増は webpack-bundle-analyzer で測定必須 (Tier C の verification gate)。

---

## 7. Alternative paths if Forwarding Service is NOT viable

### 7.1 自前 relayer (OpenPay 運用 EOA が destination で gatewayMint / mintReceiver)

**Architecture**:
- OpenPay infrastructure に EOA を持つ ("OpenPay Relayer Wallet")
- 各 destination EVM chain で gas を充填して常駐
- buyer の Solana burn → Circle attestation を OpenPay backend が取得 → 同じ backend から `receiveMessage` (CCTP V2) を destination chain で呼ぶ

**Custody implications**:
- ✅ funds は relayer を経由しない (CCTP burn は recipient 直接 mint、relayer は単に message submit を gas pay するだけ)
- ⚠ ただし relayer EOA が「OpenPay 運用」となる以上、censorship resistance を主張できなくなる (= 「OpenPay が止めたら Solana ユーザの取引完了不可」)
- ⚠ relayer EOA の private key 管理 (HSM / KMS / Pimlico verifying paymaster pattern) が必須
- ⚠ Gas 残高 monitoring + auto-topup の運用負荷増
- ⚠ Relayer down 時の SLA: buyer 視点では「 burn 済だが mint されない」状態 → 残高凍結クレーム

**コスト試算**:
- 6 chain × 平均 $50 gas reserve × monthly refill = 月 $300-1000 オペレーション
- + monitoring/alerting infra
- + key management (AWS KMS で月 $1/key × 6 + $0.03/sign × tx 量)
- 結論: 月 1000 tx 規模で **$500-1500/月の固定コスト**、Forwarding Service の $0.20/tx pay-per-use と比べて損益分岐 = **月 2500-7500 tx**。

**Censorship resistance fallback**: buyer が CCTP V2 attestation を取得済の場合、Circle docs の "permissionless receive" path で **任意の third party が receiveMessage を呼べる** = OpenPay relayer が止まっても理論上は他の relayer (Hyperlane / LayerZero 連携の orchestrator 等) や buyer 自身 (EVM wallet 持ち) が救済可能。これを README で明示すれば censorship 懸念は緩和。

### 7.2 Buyer に EVM wallet も connect させる

**Architecture**: checkout flow で「Solana wallet で signature + EVM wallet で receive tx 発行」の **2-wallet 同時 connect** UI。

**Pros**:
- OpenPay 側に運用負荷ゼロ
- buyer の EVM wallet (例: MetaMask) が destination で gas 払う → fully self-custody

**Cons**:
- **UX 致命傷**: Solana-only buyer (= Phantom しか持たない typical Solana user) を救えない。pure SPL USDC ユーザを取り込む phase 4b-2 のそもそもの目的を否定
- Phantom + MetaMask 両方持つユーザは既に EVM 路線で OpenPay を使える = 4b-2 の addressable market が空集合
- → **戦略的に意味なし**

### 7.3 3rd-party relayer service

| 候補 | 状態 | 適合性 |
|---|---|---|
| **Squads / Daimo の sponsored-cctp** (OpenZeppelin 監査済) | mainnet deploy 状況不明、operator は Circle ではない | source 側 rent 立替で SOL-less Solana ユーザを救う設計、Forwarding Service と組合せ可能性あり、要 operator 直接照会 |
| **Wormhole CCTP Executor** | docs 存在 (https://wormhole.com/docs/protocol/infrastructure-guides/cctp-executor/) | CCTP attestation 後の destination mint を Wormhole infra が代行、Solana source 対応詳細要調査 |
| **LayerZero / Stargate** | Solana ↔ EVM USDC bridge live | non-native CCTP path (LP pool 経由) で OpenPay 「native USDC のみ」原則に反する。No-Go |
| **Across** | Solana support は 2025 後半に announce | similar caveat as LayerZero (solver-based、Circle 直接 burn-mint ではない) |

→ **Wormhole CCTP Executor が次善候補**。Tier B research で深掘りすべきだったが本 scope 外 = future research item。

### 7.4 推奨優先順位

1. **Circle Forwarding Service が Solana source を正式 support する** ことを直接照会で確認 → 確認できれば §3 の path で Tier C (PoC) 着手
2. ダメなら **Wormhole CCTP Executor** を Tier B 追加 research
3. それも No なら **自前 relayer (§7.1)** を costing して demand-first 判断 (= phase 4b-2 着手時点で Solana → EVM 月 2500 tx 以上の見込みがあるか)
4. 上記全部 No なら **phase 4b-2 完全 cancel**

---

## 8. Recommendation for OpenPay phase 4b-2

### 8.1 結論

**現状のままの plan 定義では No-Go**。

phase 4b-2 plan が前提にしている「Solana → EVM Gateway flow」は:
- (a) 用語が **Circle Gateway** と **CCTP Forwarding Service** を混同している
- (b) Forwarding Service の **Solana source 公式 support が docs / launch blog で確認できない**
- (c) Forwarding Service 自体が **mainnet GA 完了していない** (2026-01-22 launch は testnet、mainnet は H1 2026 expansion 予告)

このまま着手すると Tier C 実装中に「Solana source は forwarding 対象外」が判明し全部やり直しになるリスク大。

### 8.2 Conditional Go の条件 (Hard gates)

以下 **すべて Yes** で初めて phase 4b-2 (scope は適切に修正後) 着手可能:

- [ ] **Circle support に書面照会**して「Forwarding Service が Solana source → EVM destination を mainnet で公式 support しているか」の正式回答取得
  - 期待回答: "Yes, mainnet supported, see <docs URL>" → Go
  - "No / out of scope / future roadmap" → Wormhole Executor 検討に pivot
- [ ] mainnet host (`https://iris-api.circle.com`) で forwarding endpoint (`/v2/burn/USDC/fees/{src}/{dst}?forward=true`) が `200 OK` を返すこと (Solana source domain = 5 で実測)
- [ ] Circle attestation API の **日本 IP からの access policy** 確認 (前 evaluation §3.1 と同じ gate を継承)
- [ ] Phantom + TokenMessengerMinterV2 への `deposit_for_burn_with_hook` 呼び出しで wallet 警告なし sign 完了 (testnet で実機確認)
- [ ] phase 4b-2 plan を **Gateway 用語から CCTP Forwarding Service 用語へ書き直す** (BurnIntent → depositForBurnWithHook、gatewayMint → 自動 forward、etc.)

### 8.3 §5.1 hard gate (cross-chain-12chain-expansion.md) の解決状況

`cross-chain-12chain-expansion.md` 文書本体は本 worktree から発見できなかったが、phase plan 文脈から推測される §5.1 hard gates についての本調査での解決状況:

| Gate (推定) | 状況 | 根拠 |
|---|---|---|
| Forwarding Service の存在 / GA 確認 | **Partial** — testnet GA 確認、mainnet GA 未確認 | §1.2 |
| Pricing が経済的に成立 | **Conditional** — $0.20 flat は $5+ tx で成立、micropayment で破綻 | §2 |
| API contract が公開 / 実装可能 | **Yes** — REST + viem で実装可能、SDK 不要 | §3 |
| Solana wallet sign 可能 (Phantom) | **理論上 Yes** — 通常の Solana tx として sign、raw bytes 問題なし | §5 |
| Solana SOURCE での forwarding 公式 support | **No / Unknown** ★最重要未解決 | §1.4 |
| 非カストディアル設計と整合 | **Yes** | §4.4 |
| Bundle / dep impact 許容範囲 | **Yes** — gzip 後 1.5-2.5 MB 増、lazy load で軽減可能 | §6 |
| Sponsored deposit 経路 (SOL-less buyer 救済) | **Unknown** — Circle 公式 repo に未取り込み、3rd party 監査済 | §5.5 |

→ **最重要未解決 = Solana source forwarding の公式 support 確認**。これがダメなら他全 gate がクリアでも phase 4b-2 は意味を持たない。

### 8.4 Soft preferences

- Forwarding Service の mainnet rollout 完了 (H1 2026 = 2026-06-30 まで)
- Circle が x402 facilitator を出す場合、micropayment 用途に Forwarding Service 統合される可能性 → AI agent payment との合流戦略 (前 evaluation §7 と連結)

### 8.5 Tier C PoC 見積もり (Conditional Go の場合)

`circle-gateway-decision.md` §5 と同等粒度を想定:

| 項目 | 工数概算 |
|---|---|
| `lib/cctp-v2-forwarding/` namespace 設計 + Solana RPC client | 4-6h |
| `@solana/wallet-adapter-react` 統合 + Phantom connect UI | 3-4h |
| `deposit_for_burn_with_hook` 呼び出し (Anchor IDL 経由) | 4-6h |
| iris-api `/v2/messages` polling client (viem fetch) | 2-3h |
| testnet 1 往復 (Solana Devnet → Base Sepolia) | 4-6h |
| Bundle size 測定 + dynamic import 化 | 2-3h |
| README "experimental" section + cancellation 容易化 | 1-2h |
| **合計** | **20-30h (= 3-5 days)** |

Circle Gateway PoC (17-25h) より +3-5h は Solana stack 学習コスト分。

---

## 9. Outstanding unknowns (= residual research items)

Tier B で確証取得できなかった項目。Tier C 着手前 (= §8.2 hard gate) に Circle 直接照会で解消必要:

1. **Solana source + EVM destination + Forwarding Service** の正式 mainnet support 状況
2. Forwarding Service の **production host** (`iris-api.circle.com`) endpoint 公開状況
3. Forwarding Service の **rate limit policy**
4. **日本 IP からの access policy** (前 evaluation の継承)
5. CCTP V2 Solana program 経由 `depositForBurnWithHook` で hook_data に "cctp-forward" を載せた場合の Circle attestation 動作仕様
6. Sponsored CCTP Deposits (OpenZeppelin 監査) の **mainnet deployment 状況・operator identity・利用条件**
7. Wormhole CCTP Executor が Solana source + EVM destination で実装代替になるかの実態
8. Circle Forwarding Service の **SLA / uptime guarantee** (early access 期間も含めて明示なし)

---

## 10. Sources

すべて 2026-05-24 確認。

### Circle 公式 (Forwarding Service 直接関連)
- https://www.circle.com/blog/introducing-our-new-crosschain-forwarding-service-now-integrated-into-cctp (2026-01-22 launch blog)
- https://developers.circle.com/cctp/concepts/forwarding-service
- https://developers.circle.com/cctp/howtos/transfer-usdc-with-forwarding-service
- https://www.circle.com/blog/choosing-between-circle-gateway-and-cctp-with-forwarding-service-for-crosschain-usdc

### Circle 公式 (CCTP V2 / Solana)
- https://developers.circle.com/cctp/technical-guide
- https://developers.circle.com/cctp/references/solana-programs
- https://developers.circle.com/cctp/solana-programs
- https://developers.circle.com/cctp/supported-blockchains
- https://www.circle.com/blog/cctp-v2-new-pre-mint-address-for-usdc-on-solana
- https://www.circle.com/blog/cctp-version-updates
- https://www.circle.com/cross-chain-transfer-protocol
- https://x.com/circle/status/1936046383259083040 (CCTP V2 on Solana 公式 announce)

### GitHub (Apache-2.0 source)
- https://github.com/circlefin/solana-cctp-contracts (最終 push 2026-04-03)
- https://github.com/circlefin/solana-cctp-contracts/blob/master/programs/v2/token-messenger-minter-v2/src/token_messenger_v2/instructions/deposit_for_burn_with_hook.rs
- https://github.com/circlefin/evm-cctp-contracts
- https://github.com/circlefin/circle-cctp-crosschain-transfer (sample app)

### npm registry (直接 API 経由で確認)
- https://registry.npmjs.org/@circle-fin/provider-cctp-v2 (v1.8.2, 2026-05-18, license: None)
- https://registry.npmjs.org/@circle-fin/unified-balance-kit (v1.1.2, 2026-05-18, license: None)
- https://registry.npmjs.org/@solana/web3.js (v1.98.4 stable, v2.0.0 next)
- https://registry.npmjs.org/@solana/spl-token (v0.4.14, 2025-09-02)
- https://registry.npmjs.org/@solana/wallet-adapter-react (v0.15.39, 2025-06-10)

### Audit / 3rd party
- https://www.openzeppelin.com/news/sponsored-cctp-deposits-from-solana-audit (OZ audit 2025-12-12)
- https://wormhole.com/docs/protocol/infrastructure-guides/cctp-executor/

### Phantom wallet
- https://docs.phantom.com/solana/signing-a-message (Phantom signing docs)
- https://github.com/solana-labs/solana/issues/35583 (Ledger sign issue、本件 scope 外)

### 関連 OpenPay 既存資料
- `/Users/masia02/openpay/docs/research/circle-gateway-evaluation.md`
- `/Users/masia02/openpay/docs/research/circle-gateway-decision.md`
- `/Users/masia02/openpay/docs/research/circle-12chain-addresses.md`

### Legal / Terms
- https://www.circle.com/legal/acceptable-use-policy
- https://console.circle.com/legal/service-terms

---

## 11. Next action

1. **本書合意**: Phase 4b-2 を現状のまま着手しないことを user 承認
2. **Circle 直接照会**: developers.circle.com サポートフォーム経由で §8.2 の最重要 gate (Solana source forwarding 公式 support) を質問、回答待ち
3. **回答に応じ pivot**:
   - Yes → phase 4b-2 plan を CCTP Forwarding Service 用語へ書き直し → Tier C PoC plan 起草
   - No → Wormhole CCTP Executor Tier B research に pivot or 自前 relayer (§7.1) 費用対効果再評価
   - 未回答 (2 週間 SLA 超過) → demand-first 原則 (memory: `feedback_demand_first.md`) に基づき phase 4b-2 を **demand signal 発生まで shelve**
