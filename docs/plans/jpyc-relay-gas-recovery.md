# JPYC relay ガス回収 (forwarder 方式) — Phase 2 プラン

> Codex plan-review (2026-06-01) = **approve-with-changes** を反映済。末尾の
> 「§10 監査前 必須対応」が review 由来の確定変更点。

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

**前提検証済 (2026-06-01・verify-jpyc-eip3009.mjs)**: JPYC は `receiveWithAuthorization` に
Polygon / Amoy / Kaia 全対応（sig-accepted）+ payee ガード（caller≠payee → revert）確認。

## 1. 目標

EIP-3009 relay に **ガス相当額の JPYC 回収**を、**顧客 1 署名**を維持したまま追加する。
forwarder コントラクトが顧客の 1 署名で JPYC を受領し、`merchant` と `feeReceiver` に
アトミックに分割送金する。既存の `calcBreakdown` / `gasMode` / `networkFeeEquivalent`
（Option B 会計）と履歴・pending 機構を再利用する。flag-gate 維持・mainnet は audit +
Phase B 完了まで無効。

## 2. 分割の改竄防止（核心・Codex review 反映）

`receiveWithAuthorization` は **msg.sender == to** を要求 → forwarder 自身が `to`、relayer が
forwarder を呼ぶ（payee ガードでフロントラン無効化）。

EIP-3009 署名は `{from, to=forwarder, value, validAfter, validBefore, nonce}` のみ束縛し、
分割先 (`merchant`/`feeReceiver`/各額) は束縛しない → **nonce にコミットメントを埋める**:

```
nonce = keccak256(abi.encode(
  COMMIT_VERSION, from, merchant, merchantValue, feeReceiver, feeValue,
  validAfter, validBefore, intentSalt, block.chainid, address(this)   // forwarder
))
```

- **`intentSalt` (ランダム 32B) を必須**: 決定的 preimage だけだと「同一内容・同一期限の購入」が
  同じ nonce になり衝突する（ERC-3009 は from ごとに一意な nonce を要求）。salt で毎回一意化。
- `COMMIT_VERSION` prefix で将来の schema 変更に備える。
- forwarder は **`block.chainid` と `address(this)` を内部で使って再計算**（cross-chain / 別
  forwarder への replay 防止。EIP-712 domain も token+chainId を束縛済）。
- `settle` は split パラメタ + `intentSalt` を受け、**`nonce` と `value`(=merchantValue+feeValue)
  を内部導出**（別途 nonce/value 引数は取らない → パラメタ不整合を排除）。改竄すると nonce
  不一致で revert。`merchantValue + feeValue` を受領 value として `receiveWithAuthorization`。
- **front-run**: 誰でも submit できるが「署名どおりの分割」しか実行できず funds-safe
  （griefer は nonce を消費するだけで無害）。
- **透明性**: ウォレット署名 UI は「total JPYC → forwarder」表示（分割は nonce hash 内）。
  アプリ UI が breakdown を明示する。forwarder パターンの標準挙動。

## 3. 値・エッジケース

各 mode（`total = merchantValue + feeValue` を常に満たす）:
- customer: `total = amount + gasEquiv`, `merchantValue = amount`, `feeValue = gasEquiv`
- merchant: `total = amount`, `merchantValue = amount − gasEquiv`, `feeValue = gasEquiv`

- **merchant underflow**: `gasEquiv ≥ amount` なら送金不可 → reject（既存 `merchantUnderflow`）。
- `value == 0` / `merchantValue == 0` / `feeValue == 0` / zero-address は **server + contract 両方で reject**。
- `merchant == feeReceiver` の挙動を明示定義（合算 1 送金 or reject — contract test で固定）。
- **非カストディ**: 受領→分割は forwarder 内 1 tx アトミック。いずれかの leg が失敗すれば全 revert。
  「資金を保持しない」は正確には**「正常 settle 後は残高を残さない。誤って直接送られた JPYC は
  設計上回収不能（rescue 機能なし＝信頼前提を減らす）」**と明記。

## 4. gasEquiv 価格（server 権威・Codex review 反映）

**価格と feeValue/feeReceiver の決定は server 権威**（client 提示は表示用のみ）。client が
`feeValue=0` や任意 feeReceiver を要求しても server が拒否する:

- server が **configured `feeReceiver`** を強制（client 値は信用しない）。
- gasEquiv = 実測 settle gas（receive + transfer×2 の固定 calldata 形状なので measured units が出せる）
  × POL/JPYC 価格 + 開示マージン。**`RELAYER_GAS_CAP=300_000`（現 selfHostRelayer・単純 transfer 用）
  は forwarder.settle 用に再計測した値へ更新**。
- server が **quote の range / TTL / 最小回収額 / 価格 stale 時の扱い / 混雑時 reject** を policy 化。
- マージンは**開示された固定の非返金バッファ**である旨を UI に明記（「損益分岐」は不正確なので使わない）。

## 5. forwarder コントラクト (Solidity・Codex review 反映)

最小・**immutable**・owner なし・upgrade なし（audit 面積最小化）。
- `constructor(immutable token, immutable feeReceiver)`。feeReceiver 変更は**新 forwarder を deploy**。
- `settle(from, merchant, merchantValue, feeReceiver_, feeValue, validAfter, validBefore, intentSalt, v, r, s)`:
  1. zero-address / value==0 / merchantValue==0 / feeValue==0 ガード、`feeReceiver_ == feeReceiver` 強制。
  2. `nonce = keccak256(...§2...)` を再計算。
  3. `value = merchantValue + feeValue`。
  4. `token.receiveWithAuthorization(from, address(this), value, validAfter, validBefore, nonce, v,r,s)`
     （msg.sender == to == forwarder ✓）。
  5. **`SafeERC20.safeTransfer`** で merchant / feeReceiver へ分割（plain transfer は false 返り値を
     黙殺しうるので不可）。
  6. `nonReentrant`（公式 ERC-3009 wrapper も採用。JPYC は upgradeable proxy で「hook 無し」を将来も
     保証できないため防御的に付与）。
  7. **`Settled` event**（indexed: `from, nonce, merchant, merchantValue, feeReceiver, feeValue`）を emit
     → 照合・ambiguous-send 回復に使う。
- immutable token address。proxy 実装の差し替えは**監視**（impl 変更検知）。

## 6. アーキテクチャ / データフロー

```
client:
  gasEquiv(JPYC) = server quote (実測 settle gas × POL/JPYC + 開示マージン・上限/TTL付)  ← 表示用
  calcBreakdown(gasMode) → {merchantValue, feeValue, total, customerPays}（表示用）
  intentSalt = random32
  nonce = keccak256(§2)
  sig = signTypedData(ReceiveWithAuthorization{from, to=forwarder, value=total, validAfter, validBefore, nonce})
  POST /api/relay/jpyc { merchant, merchantValue, feeValue, validAfter, validBefore, intentSalt, gasMode, sig }

server (route → jpycRelay コア):
  feeReceiver=configured を注入 / quote 再評価 (range/TTL/min) / feeValue>0 / merchantValue>0 /
  underflow / nonce==commit / recover==from / balance≥total / rate-limit / authorizationState 未使用
  relayer.sendTransaction → forwarder.settle(...)

forwarder.settle: §5（receive → safeTransfer×2・nonReentrant・Settled emit）

poll: waitForReceipt（pending 機構）。履歴: status + networkFeeEquivalent=feeValue。
```

## 7. 変更/新規ファイル

- **新規** `contracts/Eip3009Forwarder.sol` + Foundry テスト + deploy/verify script。
- **編集** `lib/relay/selfHostRelayer.ts` / `route.ts`: submit を forwarder.settle 呼出に。
  forwarder/feeReceiver を chain 別に解決。§2 検証（nonce 再計算・和・feeValue/merchantValue>0・
  feeReceiver 強制・quote 再評価）をコアに追加。settle gas で `RELAYER_GAS_CAP` 再計測。
- **編集** client: server quote 取得 + ReceiveWithAuthorization PaymentIntent builder（intentSalt・
  nonce commit）+ calcBreakdown gasMode 統合。Phase A 単純 transfer 経路を forwarder 経路に置換
  （flag-gate 維持）。マージン開示文言。
- **編集** 履歴: `networkFeeEquivalent = feeValue`（Option B 流用）。
- **新規** forwarder/feeReceiver address reference + `.env.local.example` 追記。

## 8. テスト戦略

- **contract (Foundry)**: intentSalt 違いで同一購入が別 nonce / 改竄（split 変更）で revert /
  両 gasMode 分割正当性 / receiveWithAuthorization 統合（Amoy fork）/ underflow・zero・value==0・
  merchant==feeReceiver / **false-return mock token で safeTransfer ガード** / nonReentrant /
  permissionless な exact-settle racing（無害確認）。
- **DI/コア**: nonce==commit・和・feeValue/merchantValue>0・feeReceiver 強制・quote range/TTL・balance。
- **Amoy 実 chain**: forwarder を Amoy deploy → 実 receiveWithAuthorization + 分割実行確認。
- **audit**: 顧客資金を扱うため mainnet 前に外部監査必須。
- typecheck / lint / run-tests / build / e2e。

## 9. 不明点 / リスク

- nonce-commitment（intentSalt 込み）の健全性を audit で確証。
- POL/JPYC 価格源（oracle or server 見積）と操作耐性（上限 + TTL + stale 扱い）。
- forwarder.settle のガス再計測（300k は単純 transfer 用で過小）。
- JPYC proxy 実装変更の監視（hook 無し前提の継続確認）。
- 監査コスト/期間（資金を扱う契約）。sub-cent 回収のための投資判断は済（仕様優先）。

## 10. 監査前 必須対応（Codex plan-review 反映）

- [ ] commitment に **ランダム `intentSalt`** を追加し、ABI-encode schema（COMMIT_VERSION・
      block.chainid・address(this) 含む）を確定・公開。
- [ ] **feeReceiver は immutable/configured**・**価格と feeValue は server 権威**で強制（range/TTL/最小）。
- [ ] **`SafeERC20.safeTransfer`** + **`nonReentrant`** + zero-address/value==0 ガード +
      `merchant==feeReceiver` 挙動定義。
- [ ] **`Settled` event** スキーマ確定（照合 + 回復用）。
- [ ] **ambiguous-send 回復**を Phase B 設計で解決:
      `selfHostRelayer.ts` の「throw = broadcast 前」前提は不十分（RPC が raw tx を受理して応答を
      失う経路が未対応 → fallback すると二重送金）。→ **broadcast 前に intent を永続化 + raw tx を
      pre-sign して txHash を既知化 + 応答喪失は pending 扱い + `Settled` ログで回復 + KV idempotency
      key=(chainId, forwarder, from, nonce)**。顧客 `intentSalt` と relayer EOA の tx-nonce allocator は別物として扱う。
- [ ] within-request の provider failover はしない（起動時確定・Codex 既出）。

## 11. 段階

1. 本プラン review 反映（完了）→ 必要なら再 review。
2. forwarder 契約 + Foundry テスト → Amoy deploy + 実 chain 検証。
3. client/route/履歴 統合（flag-gate）+ DI テスト。
4. 外部監査。
5. Phase B hardening（KV nonce allocator / idempotency / global gas cap / reorg / ambiguous-send 回復）。
6. mainnet 有効化（forwarder/feeReceiver address 投入 + flag ON）。

## 12. 却下 / 非対象

- **2 署名方式**: 顧客 2 署名で 1 署名 UX を損なう + relayer 2×gas（却下）。
- **free 継続（OpenPay 負担）**: 確定仕様に反する（却下）。
- **forwarder の upgrade/owner 機能**: audit 面積 + 信頼前提増のため非搭載（immutable）。
