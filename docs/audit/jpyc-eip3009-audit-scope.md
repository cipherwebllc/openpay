# JPYC EIP-3009 ガスレス決済 — 外部監査スコープ & 監査向けドキュメント

> 対象システム: OpenPay の JPYC ガスレス決済(EIP-3009 中継立替 + forwarder 分割回収)
> branch: `feat/jpyc-eip3009-client` / 監査時点 HEAD: `b73de5d`
> 関連: `docs/plans/jpyc-relay-gas-recovery.md`(設計)、`docs/plans/jpyc-phase-b-hardening.md`(堅牢化)、
> memory: `jpyc-eip3009` / `gasless-legal-jp`

## 0. この文書の目的

mainnet で **実マネー(JPYC)を扱う前提**の外部監査のための、(1) 監査対象スコープの確定、
(2) アーキテクチャ・信頼前提・脅威モデル・不変条件・既知の制約・既存検証の提示。
監査人はまず §1(スコープ)→ §4(不変条件)→ §5(脅威モデル)→ §9(チェックリスト)を読めば足りる。

---

## 1. 監査スコープ

### 1.1 In scope(優先度順)

| # | 対象 | パス | LOC | 優先度 |
|---|------|------|-----|--------|
| A | **Forwarder コントラクト** (オンチェーン受領+分割) | `contracts/src/Eip3009Forwarder.sol` | 135 | **最高(実資金)** |
| B | relay オーケストレーション(recover) | `lib/relay/forwarderRecover.ts` | 210 | 高 |
| C | relay オーケストレーション(free) | `lib/relay/jpycRelay.ts` | 238 | 高 |
| D | self-host relayer(nonce/送信/ガス上限) | `lib/relay/selfHostRelayer.ts` | 216 | 高 |
| E | relay API route(検証+DI 配線+KV) | `app/api/relay/jpyc/route.ts` | 635 | 高 |
| F | intent/nonce 構築(client↔contract 共有) | `lib/relay/forwarderIntent.ts` | 110 | 中 |
| G | sig 分解/recover/calldata(server) | `lib/relay/forwarderSettle.ts` | 79 | 中 |
| H | EIP-3009 署名コア(client/server 共有) | `lib/jpycEip3009.ts` | 193 | 中 |
| I | client 署名 hook | `hooks/useJpycEip3009Payment.ts` | 172 | 中 |
| J | config(forwarder addr/fee 額) | `lib/relay/forwarderConfig.ts` | 26 | 低 |
| K | KV プリミティブ(idempotency/budget) | `lib/kv.ts`(関連部) | — | 低 |

合計 in-scope ≈ 2,000 LOC(うちコントラクトは 135 LOC)。

### 1.2 Out of scope

- **JPYC v3 トークン本体**(`0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29`・全 chain 同一)— 発行体が監査済。
  本システムは EIP-3009 `transferWithAuthorization` / `receiveWithAuthorization` と `authorizationState`、
  EIP-712 domain `{name:"JPY Coin", version:"1"}` を **既存仕様として信頼**する。
- OpenPay の他決済レール(USDC Pimlico/Circle Paymaster、cross-chain CCTP、EIP-7702)、UI/LP、freee 連携。
- インフラ(Upstash Redis、Gelato Relay、RPC プロバイダ)の内部実装。可用性・degrade 時の挙動は §5 で扱う。

---

## 2. システム概要

JPYC はガスレス用 Paymaster を持たないため、**EIP-3009 署名 1 つ**で「顧客→受取」を成立させ、
relayer(OpenPay の EOA)が POL ガスを立替えて中継する。ガス相当額は JPYC で**即時回収**する
(日本法配慮: OpenPay は gas を負担せず立替→回収。memory:gasless-legal-jp)。2 経路ある:

### 2.1 free モード(Phase A・回収なし)
`transferWithAuthorization(from→merchant, value)` を顧客が署名 → relayer が JPYC コントラクトに直接 submit。
gas 相当の回収はせず(Gelato 無料枠など実費≒0 前提の暫定)。現状 mainnet は recover を本命とする。

### 2.2 recover モード(本命・ガス回収あり)
顧客は **1 つの `receiveWithAuthorization`**(to = forwarder、value = merchantValue + feeValue)に署名。
relayer が `forwarder.settle(...)` を呼ぶ → forwarder が JPYC を受領 → `merchant` と `feeReceiver` に
**アトミックに分割送金**。分割の内容(誰にいくら)は EIP-3009 の **nonce にコミット**される:

```
nonce = keccak256(abi.encode(
  COMMIT_VERSION, from, merchant, merchantValue, feeReceiver, feeValue,
  validAfter, validBefore, intentSalt, block.chainid, address(forwarder)))
COMMIT_VERSION = keccak256("openpay.eip3009.forwarder.v1")
```

relayer が分割を改竄すると nonce が顧客署名と食い違い、token 側の署名検証(signer==from)で revert する
(コントラクトに追加の require 不要)。`receiveWithAuthorization` は `msg.sender == to` を強制するため、
payee ガード(他者が顧客署名を奪って別 to に流すフロントラン)が効く。

gasMode:
- `customer`(顧客上乗せ): 顧客が amount + gasEquiv を払い、merchant は満額、OpenPay が上乗せ分を回収。
- `merchant`(店主吸収): 顧客は amount のみ、merchant 受取 = amount − gasEquiv、OpenPay が差分を回収。

---

## 3. 信頼前提(Trust Model)

1. **ノンカストディ**: 顧客資金は顧客の EIP-3009 署名どおりにしか動かない。from/to/value/分割は顧客が署名済。
   forwarder は owner / upgrade / rescue を持たず、正常 settle 後は残高ゼロ(受領→分割が 1 tx・全 revert)。
2. **relayer 鍵が持つのは POL(native gas)のみ**。顧客 JPYC を動かす権限はない。
   - **鍵漏洩時の被害は POL 残高に限定**(顧客資金は安全)。攻撃者は relayer になりすませるが、
     実行できるのは「顧客が既に署名した authorization の中継」だけ(任意送金は不可)。
   - 漏洩時は relayer 鍵をローテーション + 残 POL を退避。forwarder の再 deploy は不要。
3. **feeValue / feeReceiver は server 権威**。client 値は信用せず、route が一致を強制(§4-B)。
4. **二重支払い防止の最終防壁は on-chain `authorizationState`**: 同一 authorization は token 上で
   高々 1 回しか execute されない。off-chain の idempotency / pending 設計はその上の多層防御。
5. mainnet では **KV(Upstash)必須**(§5 の fail-open 経路封鎖)。RPC は信頼するが応答喪失は想定(§5)。

---

## 4. セキュリティ上の不変条件(監査の主眼)

### 4.A コントラクト(`Eip3009Forwarder.sol`)
- **A1 funds-safe**: `settle` は `from!=0 / merchant!=0 / merchantValue!=0 / feeValue!=0 / intentSalt!=0 /
  merchant!=feeReceiver` を検証し、`value = merchantValue + feeValue`(solc 0.8 overflow チェック)を
  受領 → `safeTransfer(merchant, merchantValue)` + `safeTransfer(feeReceiver, feeValue)`。受領額 = 分割額の和。
- **A2 nonce-commit**: 上記 nonce 式が client/server(`forwarderIntent.ts`)と **バイト単位一致**であること
  (golden vector で fence)。改竄→署名検証 revert。
- **A3 payee ガード**: `receiveWithAuthorization(from, address(this), ...)` で `msg.sender==to` 強制。
- **A4 reentrancy**: `nonReentrant` + 受領→分割が単一 tx。途中失敗は全 revert(残高非保持)。
- **A5 replay**: token の `authorizationState[from][nonce]` が再実行を防ぐ(同一署名は 1 回のみ)。
- **A6 immutability**: `token` / `feeReceiver` は immutable、owner/upgrade/rescue/selfdestruct なし。
  → 誤送 JPYC は回収不能(信頼前提最小化の意図的トレードオフ)。
- **A7 イベント**: `Settled(from, nonce, merchant, merchantValue, feeReceiver, feeValue)` が会計・照合の source。

### 4.B relay サーバ(B–E)
- **B1 二重支払いゼロ**: broadcast 後の不確定は `relay_error` ではなく `pending` を返し、client を
  standard へ fallback させない(後で tx が確定すると二重支払いになるため)。`relay_error` は
  **broadcast されなかったことが確実な場合のみ**(残高不足/見積 revert/node 検証拒否/Gelato Cancelled 等)。
- **B2 fee 改竄不可**: route が `feeReceiver==env.feeReceiver` / `feeValue==server 権威額` / `merchantValue>0` /
  `merchant!=feeReceiver` / `total<=MAX` / 期限・有効窓 / 署名 recover==from / 残高>=total を submit 前に検証。
- **B3 nonce 衝突の安全吸収**(self-host): `getTransactionCount(pending)` + pre-sign(txHash 確定)+
  `sendRawTransaction`。送信エラー分類 `collision/known/fatal/uncertain`。collision/fatal は authState 再確認
  (RPC throw は 'unknown'→保守的 pending)。証明できない不確定は常に pending(fallback で二重送金しない)。
- **B4 idempotency**: `SET NX relay:idem:{chainId}:{from}:{nonce}`。重複 POST は submit 前に弾き pending。
  fail-safe(KV 設定済で応答不確定→duplicate)、KV 未設定のみ first(mainnet は KV 必須で塞ぐ)。
- **B5 receipt 整合**: poll の receipt が待った hash と異なる(replacement)→ pending。
- **B6 経済性**: gas-cost ceiling は **署名済 maxFeePerGas** で評価。Sybil 用の日次予算(KV INCR)。

---

## 5. 脅威モデルと対応

| 脅威 | 対応 | 残リスク |
|------|------|----------|
| relayer 鍵漏洩 | 顧客資金は署名束縛で安全。被害は POL のみ。ローテで復旧。 | POL 枯渇 griefing(B4 で上限) |
| 分割/手数料の改竄(relayer) | nonce-commit + server 権威 feeValue/feeReceiver。 | — |
| 二重支払い(fallback 経路) | broadcast 不確定→pending(B1/B3/B5)+ on-chain authorizationState。 | 高 concurrency で pending 滞留(顧客再試行で成立) |
| リプレイ | on-chain authorizationState + intentSalt 一意化。 | — |
| フロントラン | payee ガード(msg.sender==to)。 | — |
| reentrancy | nonReentrant + アトミック分割。 | — |
| Sybil/DoS(POL 枯渇) | rate-limit + 日次予算 circuit breaker(B4)。 | 近似上限(応答喪失で早めに止まる=安全側) |
| ガス高騰で赤字 | gas-cost ceiling(署名 maxFeePerGas・B6)→ 超過は standard へ。 | ceiling 設定値の運用判断 |
| KV degrade | idempotency は fail-safe / 最終防壁は on-chain。**mainnet は KV 必須(503)**。 | KV 障害時は可用性低下(安全側) |
| RPC 応答喪失 | pre-sign で txHash 既知 → poll で pending 化。 | reconcile は手動/Explorer(自動は後続) |
| Gelato timeout(不確定) | 'error' でなく pending に倒す。Cancelled/Blacklisted/NotFound のみ relay_error。 | Gelato は deploy 時 fallback・mainnet 既定は self-host |

---

## 6. 既知の制約 / 受容リスク(監査人へ明示)

1. **単一 relayer の高 concurrency 限界**: 真に同時多数(実測: 同時 6)では `getPendingNonce`+2 リトライで
   全件は捌けず、捌けない分は **未 broadcast のまま保守的に pending**(顧客再試行で成立・安全な degrade)。
   実 QR 決済は時間分散するため alpha では稀。mainnet スケールでは単一 worker / nonce queue 化が後続課題
   (**安全性は不変**・throughput のみの問題)。
2. **fatal+unused→relay_error**: insufficient funds 等の pre-mempool 拒否 + authState 未使用なら standard へ
   fallback(正しい UX)。この安全性は **KV 設定済が前提**(同一 auth の二重 submit を idempotency が阻止)。
   → mainnet は KV 必須(未設定は 503 で拒否)で無条件化。
3. **誤送 JPYC は回収不能**(rescue 機能なし・A6)。
4. **自動 reconcile なし**: 応答喪失 pending は手動/Explorer 確認(自動デーモンは後続)。

---

## 7. 既存の検証(監査の出発点・再監査ではない)

- **Foundry**: `Eip3009Forwarder.t.sol` 14 テスト(分割正常系/各 guard/改竄→revert/reentrancy/golden vector)
  + `Eip3009Forwarder.fork.t.sol`(Amoy fork で **実 JPYC** に対する settle 検証)。solc 0.8.28・
  OZ v5.6.1 pin・optimizer 200。
- **Vitest**(relay DI コア): forwarderRecover 20 / jpycRelay 19 / selfHostRelayer 25 / forwarderIntent 4 /
  kv 20 = 88。全分岐を関数注入でカバー(viem/fetch/kv を mock せず)。
- **golden vector**: client(TS)の nonce == Solidity の `abi.encode` を固定値
  `0xf1e88a8b02d5ff7edf8990e30fc9679ad4be8ba70f76bdbeb6a49742a84d20ab` で fence。
- **Codex code-review**(B2–B5): P0×2 + P1×6 + P2×2 を指摘 → 2 ラウンド修正 + 最終確認で **全 CLOSED**
  (commits 97a0d28→7cebc29)。要点は §4-B に反映済。
- **Amoy 実 chain 検証**:
  - 並行 submit(B3): 同時 6 → 3 settle(連続 nonce・hole なし)/ 3 未 broadcast 保守 pending・
    二重 broadcast なし・二重支払いなし(`scripts/amoy-concurrent-settle.mjs`)。
  - idempotency(B2): 同一 auth 同時 2 POST → 1 success / 1 pending(未 broadcast・revert なし)・
    settle 1 回のみ・KV claim 確認(`scripts/amoy-idempotency.mjs`)。

---

## 8. デプロイ・パラメータ

- **constructor**: `Eip3009Forwarder(IERC20 token, address feeReceiver)`。両者 immutable。
  `token` = JPYC v3、`feeReceiver` = OpenPay 回収先(= `NEXT_PUBLIC_FEE_RECEIVER_ADDRESS`)。
  route の feeReceiver と一致必須(不一致だと署名検証が通らない)。
- **Amoy(testnet)deploy 済**: forwarder `0x752B7AaD0089286EB7b553d84D05233d80c9FCB4`(chainId 80002)。
- **mainnet(Polygon 137)**: 未 deploy。`contracts/script/DeployForwarder.s.sol` で別 deploy 予定。
  有効化条件(route が enforce): self-host + KV 設定 + `RELAY_MAX_GAS_COST_WEI` 設定(未設定は 503)。
- 1 件あたり上限 `RELAY_MAX_JPYC`(既定 5 万 JPYC)。手数料は固定 `NEXT_PUBLIC_RELAY_GAS_FEE_JPYC`(既定 2 JPYC・
  実費超過の差益あり=正直開示済)。

---

## 9. 監査人向けチェックリスト / 確認事項

**コントラクト(最優先)**
- [ ] `settle` の全 guard が網羅的か(value=0 / salt=0 / merchant==feeReceiver / zero addr)。抜けた攻撃面は?
- [ ] nonce 式が `forwarderIntent.ts` / `forwarderSettle.ts` と完全一致か(型・順序・chainid・address(this))。
- [ ] `merchantValue + feeValue` の overflow / 端数 / fee-on-transfer トークン挙動(JPYC は fee-on-transfer 無しだが前提確認)。
- [ ] `receiveWithAuthorization` の戻り値/失敗時に分割へ進まないか(revert 伝播)。
- [ ] reentrancy: SafeERC20 transfer 先がフックを持つ場合の影響(JPYC は単純 ERC20 だが一般化して評価)。
- [ ] 誰でも `settle` を呼べることの是非(payee ガード + nonce-commit で funds-safe との主張の検証)。

**relay サーバ**
- [ ] 「broadcast されたかの不確定はすべて pending、relay_error は未送信が確実な場合のみ」が全分岐で成立するか
      (selfHostRelayer の collision/known/fatal/uncertain + gelatoPoll の error/timeout)。
- [ ] feeValue/feeReceiver の server 権威化が全経路で破れないか(client が任意値を通せる隙が無いか)。
- [ ] idempotency の fail-safe / fail-open 境界(KV 未設定 vs 応答不確定)と mainnet KV 必須ガードの整合。
- [ ] nonce 衝突時の authState 再確認が二重送金を真に防ぐか(RPC throw=unknown→pending の保守性)。
- [ ] gas-cost ceiling が署名済 fee を見ているか(別 getGasPrice ではない)。

**運用**
- [ ] relayer 鍵管理・ローテーション手順。POL 枯渇監視。日次予算・rate-limit のしきい値。
- [ ] pending(応答喪失)の reconcile 運用(手動/Explorer)で十分か、自動化の必要性。

---

## 10. 再現手順(監査人用)

```bash
# コントラクト
~/.foundry/bin/forge test                      # 14 unit
AMOY_RPC_URL=https://rpc-amoy.polygon.technology \
  ~/.foundry/bin/forge test --match-contract Fork   # 実 JPYC fork

# relay コア(DI unit)
npx vitest run tests/lib/forwarderRecover.test.ts tests/lib/jpycRelay.test.ts \
  tests/lib/selfHostRelayer.test.ts tests/lib/forwarderIntent.test.ts tests/lib/kv.test.ts

# 実 chain(Amoy・要 .env.local: RELAYER_PRIVATE_KEY / KV / AMOY_TEST_BUYER_KEY[JPYC 保有])
node scripts/amoy-relay-readiness.mjs <buyer>           # 前提チェック
RELAY_URL=http://localhost:3000/api/relay/jpyc node scripts/amoy-concurrent-settle.mjs  # B3
RELAY_URL=http://localhost:3000/api/relay/jpyc node scripts/amoy-idempotency.mjs        # B2
```

---

## 11. 監査後の mainnet 有効化フロー(参考)

1. 監査指摘の反映 + 再確認。
2. `DeployForwarder.s.sol` で Polygon に forwarder deploy(constructor: JPYC, feeReceiver)。
3. `NEXT_PUBLIC_JPYC_FORWARDER_POLYGON` / KV / `RELAY_MAX_GAS_COST_WEI` を本番環境変数に設定。
4. 少額の実 chain E2E(本番 JPYC・小額)で settle + 回収 + idempotency を確認。
5. 段階的に上限(`RELAY_MAX_JPYC`)を引き上げ。
