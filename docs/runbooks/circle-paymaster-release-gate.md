# Circle Paymaster 投入ゲート (Phase 1 / C5 release blocker)

> ステータス: **送信面ゲート通過 (testnet + Base mainnet)**。2026-05-30 に Base mainnet
> 実機で 3 leg PASS (下記「実行結果」)。段階リリース step 3 の受入基準を充足したため
> **Base mainnet に限り** `NEXT_PUBLIC_ENABLE_CIRCLE_PAYMASTER=1` 有効化可。他 chain は
> fee 実測前のため flag OFF 維持。
>
> 計画: `docs/plans/circle-paymaster-phase1.md` §5 (C5)、§6 (段階リリース)。

## 実行結果 (Base mainnet・2026-05-30)

`SMOKE_CHAIN=base SMOKE_MAINNET_OK=1` で 3 leg (Circle → Pimlico → Circle) すべて PASS。
pristine EOA (`delegateBefore=null`) が leg1/circle で 7702 委任 (→ `0xe6Cae83`) を
bootstrap し、`delegateAfter=0xe6Cae83…` を確認:

| leg | provider | paymaster | 実徴収 USDC | tx |
|-----|----------|-----------|------------|-----|
| 1 | circle | `0x0578…700Ec` (mainnet) | 0.012117 | `0x527224…b0e5e` |
| 2 | pimlico | `0x8888…2402` (erc20) | 0.003822 | `0x355306…1aaddd` |
| 3 | circle | `0x0578…700Ec` (mainnet) | 0.009384 | `0xb31b6f…73fc5e` |

- 実徴収 USDC ≪ permit 上限 2 USDC（C4 fee 整合 OK）。
- **観測**: Base mainnet で Circle のガス徴収 ≈ Pimlico の 3〜4倍 (Circle 10% surcharge +
  Circle 自身の fee)。絶対額はセント単位だが「Circle 優先はコスト最適でなく信頼性/公式
  サポート理由」という事実を記録。
- **pristine bootstrap の要点**: viem/permissionless は prepareUserOperation 段階で 7702
  authorization を stub 署名のまま送るため、明示署名 (`owner.signAuthorization`) して
  estimate/send に渡さないと bundler が `recovered signer != sender` で弾く。smoke は
  Circle leg を先頭にして spike 実証済の viem 経路で委任を張る (scripts 内で対応済)。

## 最短実行 (UI 不要・推奨)

```bash
# testnet (既定: Arbitrum Sepolia)
SMOKE_PRIVATE_KEY=0x<使い捨てtestnet鍵> \
  PIMLICO_API_KEY=<your-key> \
  node scripts/smoke-circle-crossswitch.mjs

# Base mainnet (実 USDC を消費・使い捨てウォレットのみ)
SMOKE_CHAIN=base SMOKE_MAINNET_OK=1 \
  SMOKE_RPC_URL=<専用 Base RPC (NEXT_PUBLIC_BASE_RPC_URL)> \
  SMOKE_PRIVATE_KEY=0x<使い捨て鍵> PIMLICO_API_KEY=<your-key> \
  SMOKE_ORIGIN=https://open-pay.jp \
  node scripts/smoke-circle-crossswitch.mjs

# Optimism / Polygon / Avalanche mainnet (実 USDC・fee 実測ゲート)
#   SMOKE_CHAIN を optimism / polygon / avalanche に変えるだけ。各 chain ごとに
#   その chain の実 USDC ~2 を使い捨てウォレットに入れて 1 回ずつ実行する。
SMOKE_CHAIN=optimism SMOKE_MAINNET_OK=1 \
  SMOKE_RPC_URL=<専用 RPC (NEXT_PUBLIC_OPTIMISM_RPC_URL)> \
  SMOKE_PRIVATE_KEY=0x<使い捨て鍵> PIMLICO_API_KEY=<your-key> \
  SMOKE_ORIGIN=https://open-pay.jp \
  node scripts/smoke-circle-crossswitch.mjs
```

> **OP/Polygon/Avalanche は fee 実測ゲート**。gate 出力 JSON の見方:
> - `recommendedSurchargeBps` = 表示基準 (surcharge=0 の `displayBaseUsdc`) を Circle の実徴収まで
>   底上げする最小 surcharge + 300bps margin。**これが登録値**。`CIRCLE_GAS_SURCHARGE_BPS[<chainId>]`
>   に入れてから flag 有効化。登録まで `resolveUsdcGaslessProvider` は pimlico に倒れる (安全側)。
> - `circleVsPimlicoRatio` = Circle gas ÷ Pimlico gas (同 EOA・同 gate)。**有効化是非の判断材料**。
>   Pimlico は既に全 chain で安価に動くため、比が大きい chain は Circle にするとガス代が上がる
>   (Circle 優先は信頼性/公式サポート理由でコスト最適ではない)。
> - `markupVsActualGasBps` は診断のみ (L2 は actualGasCost に L1 data fee が含まれず過大に出る)。登録に使わない。
>
> ### 2026-05-31 実測結果
> | chain | gate | Circle gas | Pimlico gas | Circle÷Pimlico | 判定 |
> |-------|------|-----------|-------------|----------------|------|
> | Optimism (10) | ✅ PASS | ~0.0013 USDC | 0.00055 USDC | **~2.5×** | 有効化候補 (Base/Arb の 3-4× と同水準) |
> | Polygon (137) | ✅ PASS | ~0.038 USDC | 0.0065 USDC | **~5.8×** | コスト高 — 有効化は要判断 (Pimlico 維持が無難) |
> | Avalanche (43114) | ❌ FAIL | — | — | — | **7702 非互換**で有効化不可 (下記) |
>
> **Avalanche は ACP-209「EIP-7702 *style*」AA** で nonce/balance 扱いが canonical EIP-7702 と
> 異なり、標準 viem/permissionless/Pimlico 7702 スタックでは委任が張れず 3 leg とも AA23
> (validateUserOp revert)。Circle だけでなく **Pimlico 7702 経路も失敗**するため、現スタックでは
> Circle・Pimlico 7702 とも有効化不可。canonical 7702 対応 or Avalanche 専用 AA 経路ができるまで保留。
> (副次的論点: Avalanche の既存 gasless が pristine EOA の 7702 委任に依存していれば同様に動かない
> 可能性 — MAv2 等の deployed smart account 経路は別途要確認。)

> ⚠️ Base mainnet は実 USDC (~2 で十分・ガスはセント単位)。`SMOKE_MAINNET_OK=1` 必須。
> 公開 RPC (`mainnet.base.org`) は rate limit で 7702 bootstrap が壊れるため専用 RPC 必須。

鍵が無ければ `SMOKE_PRIVATE_KEY` 未設定で 1 度実行すると使い捨て鍵とアドレスが
表示される → その ADDRESS に Arbitrum Sepolia USDC を ~1 入れて (faucet.circle.com)
同じ鍵で再実行。スクリプトが **Pimlico → Circle → Pimlico の 3 leg** を同一 EOA で
送信し、receipt・徴収 USDC・委任先を検証して **PASS / FAIL** を出す (下記受入基準を自動判定)。
MetaMask への鍵インポートや flag 再起動は不要 (ローカル鍵が自前で 7702 委任を bootstrap)。

> UI で確認したい場合は末尾「UI で確認する場合」を参照 (要: 委任済 EOA のインポート)。

## なぜ手動ゲートが必要か

Phase 1 の実装 (chunk 1–5) は unit / integration test で担保済みだが、以下は
**実機 (テストネット) でしか検証できない**:

- **同一 EOA での paymaster 往復**: ⚠️ 重要な事実 — permissionless / viem の 7702
  SimpleAccount は **EntryPoint v0.8 専用**。よって本番 Pimlico 経路 (`simpleAccount.ts`)
  も Circle 経路も **同一の EntryPoint v0.8 + 同一 impl `0xe6Cae83…`** で、差は
  **paymaster だけ** (Pimlico ERC20 ↔ Circle Paymaster)。nonce 空間は単一なので
  「二系統 EntryPoint の nonce 衝突」懸念は実は無いが、**同一 EOA で paymaster を
  切替えても validation / 送信が連続成功するか**は実 receipt でしか確証できない。
  (注: `SmartAccountBundle.entryPointVersion='0.7'` タグは label の名残で不正確。
  実送信は v0.8。runtime は `provider` で分岐するため害は無いが、別途整理推奨。)
- **Circle の実 USDC 徴収額**が表示 permitAmount 以内に収まるか
  (`useGasQuoteCircle` の surcharge 算定の妥当性)。
- **二重決済 FSM の応答ロスト復旧** (`lib/circlePending.ts` + `circleSend.ts`) が
  実 bundler timeout で意図通り動くか (UI 経路のみ・スクリプトは送信成功面のみ)。

Phase 0 spike (`scripts/spike-circle-paymaster.mjs`、Arbitrum Sepolia) は
「Circle 単体が動く」ことは実証済 (= GO)。本ゲートはそれに **「同一 EOA で
Pimlico paymaster ↔ Circle paymaster を往復しても壊れない」** を足すもの
(`scripts/smoke-circle-crossswitch.mjs`)。

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

## UI で確認する場合 (補助・要: 委任済 EOA)

> ⚠️ 新規 MetaMask EOA は pristine (`detection.kind='none'`) で **standard mode に
> 倒れ Circle に行かない**。UI で Circle を踏むには **0xe6Cae83 に委任済の EOA**
> (= 上記スクリプト/spike を一度通した鍵) を MetaMask にインポートする必要がある。
> 委任が無い状態で確認したいだけなら**スクリプト経路を使う方が速い**。

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
3. **Base mainnet** で `NEXT_PUBLIC_ENABLE_CIRCLE_PAYMASTER=1` (2026-05-30 ゲート通過済)。
   ⚠️ **flag はグローバル** = ON にすると `CIRCLE_GAS_SURCHARGE_BPS` に載る全 mainnet
   chain で Circle が起動する。よって「どの chain を有効化するか」は **surcharge config への
   登録で制御**する (ゲート通過まで登録しない)。
4. **Arbitrum mainnet** (fee=10%・Circle dev docs で Arb/Base のみ 10% と確認): `SMOKE_CHAIN=arbitrum`
   で本 smoke ゲートを通過させ、`CIRCLE_GAS_SURCHARGE_BPS` に `[arbitrum.id]: 1000` を登録。
5. **10% 非適用 chain (Optimism/Polygon/Avalanche)**: smoke config 整備済
   (`SMOKE_CHAIN=optimism|polygon|avalanche`)。gate が `displayBaseUsdc` / `recommendedSurchargeBps`
   (表示基準を満たす最小 surcharge + 300bps margin) / `circleVsPimlicoRatio` (コスト competitiveness) を出す。
   **PASS かつ** 推奨値を `CIRCLE_GAS_SURCHARGE_BPS` に登録してから有効化 (C4)。未登録の間は
   `resolveUsdcGaslessProvider` が pimlico に倒すため自動的に Pimlico erc20 fallback。
   2026-05-31 実測 (上記「2026-05-31 実測結果」表):
   - **Optimism**: PASS・Circle ≈ Pimlico の ~2.5×。有効化候補。
   - **Polygon**: PASS だが Circle ≈ Pimlico の ~5.8× とコスト高。Pimlico 維持が無難 (要判断)。
   - **Avalanche**: ❌ ACP-209「7702 style」AA 非互換で 3 leg とも AA23・委任張れず。**有効化不可**
     (Circle/Pimlico 7702 とも)。canonical 7702 or 専用 AA 経路ができるまで保留。
   - **Ethereum L1 / Unichain は smoke 未整備**。L1 はガスが絶対額で高い (数$/tx) ため小額決済に
     不向き、Unichain は buyer-only で優先度低。必要になった時点で同様に config を足す。
   - 全 mainnet で USDC は **native** を使用 (Polygon も `0x3c49…`・USDC.e ではない)。
   - v0.8 paymaster は全 mainnet で `0x0578…700Ec` (deterministic)。gate が codehash を log するので
     Base と一致を確認後 `CIRCLE_PAYMASTER_CODEHASH` に登録すると本番の codehash 検証が効く。

## ロールバック

`NEXT_PUBLIC_ENABLE_CIRCLE_PAYMASTER` を未設定/0 に戻すだけで全 chain が
Pimlico erc20 経路に戻る (`paymasterMode='erc20'` 不変・法務 prose も両対応済)。
進行中の Circle 決済は `circlePending` の submitting record が残るので、復旧は
`findRecoverable` 経由で receipt 照会のみ (新規送信はしない)。
