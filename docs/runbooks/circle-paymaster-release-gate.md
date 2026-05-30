# Circle Paymaster 投入ゲート (Phase 1 / C5 release blocker)

> ステータス: **未通過 (flag OFF 維持)**。本ゲートを通すまで
> `NEXT_PUBLIC_ENABLE_CIRCLE_PAYMASTER` は本番で有効化しない。
>
> 計画: `docs/plans/circle-paymaster-phase1.md` §5 (C5)、§6 (段階リリース)。

## なぜ手動ゲートが必要か

Phase 1 の実装 (chunk 1–5) は unit / integration test で担保済みだが、以下は
**実機 (テストネット) でしか検証できない**:

- **EntryPoint 二系統の同一 EOA 往復**: JPYC = EntryPoint v0.7 (Pimlico)、
  USDC-circle = EntryPoint v0.8 (Circle)。委任先 impl は両系統とも
  `0xe6Cae83BdE06E4c305530e199D7217f42808555B` (spike 実証) だが、
  `accountDetection.ts` は delegate アドレスしか見ないため、**nonce 名前空間 /
  validation / paymaster データ差**は send 時にしか露見しない。delegate 一致 ≠
  両 EntryPoint で送信成功、を実 receipt で潰す。
- **Circle の実 USDC 徴収額**が表示 permitAmount 以内に収まるか
  (`useGasQuoteCircle` の surcharge 算定の妥当性)。
- **二重決済 FSM の応答ロスト復旧** (`lib/circlePending.ts` + `circleSend.ts`) が
  実 bundler timeout で意図通り動くか。

Phase 0 spike (`scripts/spike-circle-paymaster.mjs`、Arbitrum Sepolia) は
「Circle 単体が動く」ことは実証済 (= GO)。本ゲートはそれに **「同一 EOA で
Pimlico(v0.7) ↔ Circle(v0.8) を往復しても壊れない」** を足すもの。

## 前提

- **使い捨てテストネット EOA**（本番鍵・mainnet 鍵は絶対に使わない / memory:
  testnet は disposable key のみ）。
- Arbitrum Sepolia (Circle v0.8 + fee config 有り) の USDC 残高 ~1 USDC
  (https://faucet.circle.com)。
- JPYC sponsorship 対応テストネット (Polygon Amoy 等) の JPYC 残高。
- `NEXT_PUBLIC_PIMLICO_API_KEY` (origin 制限なしキー、または Origin ヘッダ送出)。

> 注: Circle が fee config を持つ testnet (arbitrumSepolia / baseSepolia) と JPYC
> sponsorship testnet (polygonAmoy 等) は別 chain。「往復」は **同一 EOA が**
> chain をまたいで両経路を成功させることを指す (同一 chain で両方を要求しない)。

## 手順

1. **flag を一時的に ON** にしたローカル/preview で実施 (本番 flag は触らない):
   ```
   NEXT_PUBLIC_ENABLE_CIRCLE_PAYMASTER=1 npm run dev
   ```
2. **(A) USDC-circle 経路 (EntryPoint v0.8)** — Arbitrum Sepolia:
   - `/pay` で USDC ガスレス決済を 1 件実行 (gas=customer)。
   - UI の gas help が **Circle Paymaster (公式)** 表記になっていること
     (`gasInfoUsdcCircle`、"Pimlico" が出ないこと)。
   - 送信成功 → 履歴に `provider=circle` / Circle ガス代 (USDC) 行が出ること。
   - Explorer で receipt を開き、UserOperationEvent の paymaster が
     allowlist の Circle v0.8 アドレス (`reference: circle-paymaster-addresses`)
     であること、customer→paymaster の USDC Transfer が permitAmount 以内であること。
3. **(B) JPYC 経路 (EntryPoint v0.7 / Pimlico sponsorship)** — 同一 EOA で
   Polygon Amoy 等:
   - `/pay` で JPYC ガスレス決済を 1 件実行 → 成功 → 履歴に `provider=pimlico`。
   - Circle 経路を一度通った後でも JPYC (v0.7) 送信が壊れないこと
     (nonce / validation regression が無い)。
4. **(A)→(B)→(A) を最低 1 往復**繰り返し、両方向で receipt 成功を確認。
5. **二重決済 FSM の応答ロスト挙動** (任意だが推奨):
   - Circle 送信中に機内モード/ネットワーク切断 → 再接続後にページ再読込 →
     `findRecoverable` が submitting を拾い、**二重送信せず** confirmed に至るか、
     または同一 op の冪等 rebroadcast で 1 回だけ着金することを確認。

## 受入基準 (すべて満たして初めて mainnet 有効化に進む)

- [ ] (A) Circle USDC 決済が receipt 成功、paymaster = allowlist アドレス。
- [ ] 実徴収 USDC (per-UserOp scope、`circleReceiptVerifier`) が表示 permitAmount 以内。
- [ ] (B) 同一 EOA の JPYC v0.7 決済が Circle 往復後も receipt 成功。
- [ ] 往復後に nonce/validation 由来の送信失敗が出ない。
- [ ] UI に "Pimlico" 名が circle 経路で残らない (gas help / 履歴)。
- [ ] (推奨) 応答ロスト → 復旧で二重決済が起きない。

## 段階リリース (ゲート通過後・計画 §6)

1. flag OFF 既定のまま投入済 (現状)。
2. testnet で本ゲート通過。
3. **Base mainnet のみ** で `NEXT_PUBLIC_ENABLE_CIRCLE_PAYMASTER=1`
   (Base は Circle fee=10% が docs 確認済)。**Base mainnet の実 receipt で徴収 USDC が
   表示 max 以内**であることを再実測 (計画 §5 fee 整合テスト)。
4. 問題なければ Arbitrum mainnet へ拡大。
5. fee config 未確認の chain (Polygon/Optimism/Avalanche/Unichain) は
   `CIRCLE_GAS_SURCHARGE_BPS` 未登録 = `resolveUsdcGaslessProvider` が pimlico に
   倒すため、自動的に Pimlico erc20 fallback のまま (有効化されない)。docs で
   per-chain fee が確認できた chain から surcharge config を追加して順次拡大。

## ロールバック

`NEXT_PUBLIC_ENABLE_CIRCLE_PAYMASTER` を未設定/0 に戻すだけで全 chain が
Pimlico erc20 経路に戻る (`paymasterMode='erc20'` 不変・法務 prose も両対応済)。
進行中の Circle 決済は `circlePending` の submitting record が残るので、復旧は
`findRecoverable` 経由で receipt 照会のみ (新規送信はしない)。
