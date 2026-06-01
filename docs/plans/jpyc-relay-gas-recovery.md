# JPYC relay ガス回収 (forwarder 方式) — Phase 2 プラン

## Context

自前 EIP-3009 relay (Phase A・commit 181fdac) は OpenPay の relayer EOA が POL ガスを
立替して `transferWithAuthorization` を broadcast する。Phase A は **free**（ガス相当額を
回収しない）だが、これは Gelato 無料枠（コスト≒0）前提の暫定であり、self-host で実 POL
コストが出る今は**確定仕様に反する**。

**確定仕様（ユーザ一貫指示）: OpenPay は POL を全額立替するが gas は負担しない。必ず gas
相当額を JPYC で回収する。** 既存 Pimlico/Circle ガスレスの `gasMode` 会計と同一:

| gasMode | 顧客支払 | 店主受取 | OpenPay |
|---|---|---|---|
| customer (顧客上乗せ) | 請求額 + gas相当(JPYC) | 満額 | POL立替 → 顧客上乗せ分を回収 |
| merchant (店主吸収) | 請求額のみ | 満額 − gas相当(JPYC) | POL立替 → 店主受取から回収 |

どちらも **店主は gasMode どおりの額を受取・OpenPay は損益分岐（立替を JPYC で回収）**。

**前提検証済 (2026-06-01・verify-jpyc-eip3009.mjs)**: JPYC は `receiveWithAuthorization` に
Polygon / Amoy / Kaia 全対応（sig-accepted）+ payee ガード（caller≠payee → revert）確認。
→ **forwarder の「1署名・1tx で受領して分割」が成立する。**

## 1. 目標

EIP-3009 relay に **ガス相当額の JPYC 回収**を、**顧客 1 署名**を維持したまま追加する。
forwarder コントラクトが顧客の 1 署名で JPYC を受領し、`merchant` と `feeReceiver` に
アトミックに分割送金する。既存の `calcBreakdown` / `gasMode` / `networkFeeEquivalent`
（Option B 会計）と履歴・pending 機構を再利用する。flag-gate 維持・mainnet は audit +
Phase B 完了まで無効。

## 2. 制約・依存・エッジケース

- `receiveWithAuthorization` は **msg.sender == to** を要求 → forwarder 自身が `to`、relayer が
  forwarder を呼ぶ。これでフロントラン防止（payee ガード）も得られる。
- **分割の改竄防止（核心）**: EIP-3009 署名は `{from, to=forwarder, value, validAfter,
  validBefore, nonce}` のみを束縛し、分割先 (`merchant`/`feeReceiver`/各額) は束縛しない。
  → **nonce にコミットメントを埋める**:
  `nonce = keccak256(abi.encode(from, merchant, merchantValue, feeReceiver, feeValue, deadline, chainId, forwarder))`。
  forwarder は relayer 提供の分割パラメタから nonce を再計算し `nonce == 提供 nonce` を require。
  さらに `merchantValue + feeValue == 受領 value` を require。**1 署名で分割を二重に束縛**でき、
  relayer は分割を改竄できない（改竄すると nonce 不一致で revert）。
  - リスク確認事項: EIP-3009 の nonce は「from ごとに一意な任意 bytes32」で良い（token は
    未使用チェックのみ）。コミットメント利用は仕様適合だが **audit で要確認**。
  - 透明性: ウォレット署名 UI には「total JPYC → forwarder」と出る（分割は nonce hash 内）。
    アプリ UI が breakdown を明示する。forwarder パターンの標準的挙動。
- **各 mode の値**（`total = merchantValue + feeValue` を常に満たす）:
  - customer: `total = amount + gasEquiv`, `merchantValue = amount`, `feeValue = gasEquiv`
  - merchant: `total = amount`, `merchantValue = amount − gasEquiv`, `feeValue = gasEquiv`
- **merchant mode underflow**: `gasEquiv ≥ amount` なら送金不可 → 既存 `merchantUnderflow` で reject。
- **gasEquiv (JPYC) の算定**: POL gas 見積 × POL/JPYC 価格 + margin、worst-case 上限付き
  （既存 `useGasQuote` の worst-case パターンを踏襲）。forwarder.settle 自体のガス（receive +
  transfer×2）は単純 transfer より高いので、見積に含める（やや再帰的・margin で吸収）。
- **非カストディ**: 受領→分割は forwarder 内で 1 tx アトミック。失敗時は全 revert、forwarder は
  資金を保持しない（owner なし・引き出し機能なし）。
- **チェーン**: Polygon (137) + Amoy (80002)。Kaia は後続（forwarder 再 deploy）。同一 JPYC addr。
- pending（broadcast 後未確定 → standard へ fallback させない）は Phase A の機構を再利用。

## 3. 既存パターン / API（再利用）

- `lib/fee.ts` `calcBreakdown(amount, token, mode, gasMode, gasAmount)`: gasMode 別の
  merchant/customer 額算定はそのまま使える（gasAmount = gasEquiv(JPYC)）。
- `gasReimbursement` / `networkFeeEquivalent`（Option B）: relay の feeValue を記録に流用。
- `useGasQuote`（worst-case 見積パターン）→ JPYC 建て gas 見積に応用。
- `lib/relay/jpycRelay.ts` DI コア + `selfHostRelayer.ts`: submit/poll は relayer が
  **forwarder.settle を sendTransaction する**形に拡張（顧客署名は forwarder への
  receiveWithAuthorization、外側 tx は relayer が署名）。
- `eth_signTypedData_v4`（ReceiveWithAuthorization typed data）: 任意ウォレットで 1 署名。
- 参照実装: `github.com/TheGreatAxios/eip3009-forwarder`（x402 整合）+ Coinbase `eip-3009` lib。

## 4. アーキテクチャ / データフロー

```
client:
  gasEquiv(JPYC) = quote(POL gas × POL/JPYC + margin, 上限付き)
  calcBreakdown(gasMode) → {merchantValue, feeValue=gasEquiv, total, customerPays}
  nonce = keccak256(from, merchant, merchantValue, feeReceiver, feeValue, deadline, chainId, forwarder)
  sig = signTypedData(ReceiveWithAuthorization{from, to=forwarder, value=total, validAfter, validBefore, nonce})
  POST /api/relay/jpyc { ...split params, total, sig }

server (route → jpycRelay コア):
  recover==from / nonce==commit(params) / merchantValue+feeValue==total / balance≥total /
  rate-limit / authorizationState 未使用 を検証
  relayer.sendTransaction → forwarder.settle(from, merchant, merchantValue, feeReceiver, feeValue,
                                              validAfter, validBefore, nonce, v, r, s)

forwarder.settle (on-chain, atomic):
  require nonce == keccak256(...)          // 分割改竄ガード
  require merchantValue + feeValue == value
  token.receiveWithAuthorization(from, address(this), value, ..., nonce, v,r,s)  // msg.sender==to==forwarder
  token.transfer(merchant, merchantValue)
  token.transfer(feeReceiver, feeValue)
  emit Settled(...)

poll: waitForReceipt (Phase A の pending 機構)。履歴: status + networkFeeEquivalent=feeValue。
```

## 5. 変更/新規ファイル

- **新規** `contracts/Eip3009Forwarder.sol`: 最小・immutable・owner なし・upgrade なし
  （audit 面積最小化）。`settle(...)` のみ + commitment 再計算 + receiveWithAuthorization +
  transfer×2 + event。資金非保持（全 revert on failure）。
- **新規** contracts のビルド/テスト基盤（Foundry 推奨）+ deploy script + verify。
- **編集** `lib/relay/selfHostRelayer.ts` / `route.ts`: submit を forwarder.settle 呼び出しに。
  forwarder address を chain 別 env/定数で解決。検証 (nonce commit / 和) をコアに追加。
- **編集** client（PaymentForm 等）: JPYC 建て gas 見積 + ReceiveWithAuthorization の
  PaymentIntent builder（nonce commit）+ calcBreakdown gasMode 統合。Phase A の単純 transfer
  経路を forwarder 経路に置換（flag-gate 維持）。
- **編集** 履歴: `networkFeeEquivalent = feeValue`（回収した gas 相当額）を記録（Option B 流用）。
- **新規** forwarder address の reference（deploy 後）+ `.env.local.example` 追記。
- テスト: contract unit（Foundry）+ DI/コア + Amoy fork。

## 6. テスト戦略

- **contract（Foundry）**: nonce-commit 改竄ガード（分割を変えると revert）/ 両 gasMode の
  分割正当性 / `receiveWithAuthorization` 統合（Amoy fork）/ merchant underflow reject /
  和不一致 revert / 資金非保持。
- **DI/コア**: nonce==commit・merchantValue+feeValue==total・balance の各分岐（既存 jpycRelay
  テスト様式）。
- **Amoy 実 chain**: forwarder を Amoy に deploy → 実 receiveWithAuthorization + 分割を実行確認。
- **audit**: 顧客資金を扱うため mainnet 前に外部監査必須。
- typecheck / lint / run-tests / build / e2e（Phase A と同様）。

## 7. 不明点 / リスク

- **nonce-commitment 束縛の健全性**: EIP-3009 nonce の自由度を commitment に使う設計が
  token 仕様と衝突しないこと（衝突なし想定だが audit で確証）。
- **POL/JPYC 価格源**: oracle（Chainlink 等）or サーバ見積。操作耐性 = worst-case 上限 + margin。
- **forwarder.settle のガス**: receive + transfer×2 で単純 transfer より高い → gasEquiv が
  forwarder 自体のガスを賄えるよう margin 設計（やや再帰）。
- **監査コスト/期間**: 資金を扱う契約 = 重い。sub-cent 回収のための投資判断は済（仕様優先）。
- **Phase B 依存**: mainnet 有効化は Phase B（KV nonce allocator / idempotency / global gas cap /
  reorg confirmation）+ audit 完了が前提。それまで env で無効。

## 8. 段階

1. 本プラン review（/gpt-plan-review 相当）。
2. forwarder 契約 + Foundry テスト → Amoy deploy + 実 chain 検証。
3. client/route/履歴 統合（flag-gate）+ DI テスト。
4. 外部監査。
5. Phase B hardening。
6. mainnet 有効化（forwarder address 投入 + flag ON）。

## 9. 却下 / 非対象

- **2 署名方式**: コントラクト不要だが顧客 2 署名（EIP-3009 を選んだ 1 署名 UX を損なう）+
  relayer 2×gas。forwarder の 1 署名を優先（却下）。
- **free 継続（OpenPay 負担）**: 確定仕様（負担しない）に反するため却下。
- **forwarder の upgrade/owner 機能**: audit 面積 + 信頼前提を増やすため非搭載（immutable）。
